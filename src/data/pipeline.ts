/**
 * The seam that makes the §3.2 rule real:
 * "a skip triggers `rest/history` backfill from the last known good `t` and
 *  marks the series `stale` until reconciled."
 *
 * WS bar -> gap check -> coalescing buffer -> store, with a REST backfill fired
 * on the side when the sequence skips. It owns no timers and no frames: the
 * frame owner calls `flush()` once per rAF (ARCHITECTURE.md §2).
 */

import type { Timeframe, TimeMs } from './types.js';
import { asTimeMs } from './types.js';
import type { Codec } from './codec.js';
import { createCodec } from './codec.js';
import type { BarEvent } from './ws/client.js';
import type { GapDetector, GapStats } from './ws/gapDetector.js';
import { createGapDetector } from './ws/gapDetector.js';
import { subscriptionKey } from './ws/protocol.js';
import type { HistoryTransport } from './rest/history.js';
import { backfillGap } from './rest/history.js';
import type { FlushStats, StoreResolver, TickBuffer } from './store/tickBuffer.js';
import { createTickBuffer } from './store/tickBuffer.js';

/** The window a pending recovery covers: `[oldest good bar, newest seen bar]`. */
interface BackfillWindow {
  readonly from: TimeMs;
  readonly to: TimeMs;
}

export interface PipelineStats {
  readonly received: number;
  readonly duplicates: number;
  readonly invalid: number;
  readonly gaps: number;
  readonly backfills: number;
  readonly backfillFailures: number;
  readonly reconciled: number;
}

export interface BarPipelineOptions {
  readonly resolve: StoreResolver;
  /** Omit to run without REST recovery: a gap then leaves the series `stale`. */
  readonly transport?: HistoryTransport;
  readonly gapDetector?: GapDetector;
  readonly codec?: Codec;
  readonly onPending?: () => void;
  readonly onBackfillError?: (error: unknown) => void;
  readonly pageLimit?: number;
}

export interface BarPipeline {
  /** Wire this to `WsClient.onBar`. Never throws. */
  handleBar(event: BarEvent): void;
  /** Drains coalesced ticks into the stores. Call once per frame. */
  flush(): FlushStats;
  readonly buffer: TickBuffer;
  gaps(): GapStats;
  stats(): PipelineStats;
  /** Resolves once every in-flight backfill has settled (tests, teardown). */
  settled(): Promise<void>;
  /** Forget sequence state — call on resubscribe, where `seq` may restart. */
  reset(symbol: string, tf: Timeframe): void;
}

export function createBarPipeline(options: BarPipelineOptions): BarPipeline {
  const detector = options.gapDetector ?? createGapDetector();
  const codec = options.codec ?? createCodec();
  const buffer = createTickBuffer(
    options.onPending === undefined
      ? { resolve: options.resolve }
      : { resolve: options.resolve, onPending: options.onPending },
  );

  const inFlight = new Map<string, Promise<void>>();
  const pendingWindows = new Map<string, BackfillWindow>();
  let received = 0;
  let duplicates = 0;
  let invalid = 0;
  let gaps = 0;
  let backfills = 0;
  let backfillFailures = 0;
  let reconciled = 0;

  const markLiveIfLoading = (symbol: string, tf: Timeframe): void => {
    const store = options.resolve(symbol, tf);
    if (store !== null && store.get().state === 'loading') store.setState('live');
  };

  /**
   * Queues `[lastGood, thisBar]` for recovery and starts draining if nothing is
   * already running for this series. A gap that lands while a fetch is in
   * flight widens the queued window instead of stacking a parallel request —
   * one recovery at a time per series, and the drain loop only stops once
   * nothing is left. Reconciling before that would clear `stale` with a hole
   * still open.
   *
   * On failure the series stays `stale`, which is the honest state: the
   * renderer dims it rather than drawing a hole as if it were flat.
   */
  function requestBackfill(event: BarEvent, from: TimeMs): void {
    const transport = options.transport;
    if (transport === undefined) return; // no REST wired: the series stays stale

    const { symbol, tf } = event;
    const key = subscriptionKey(symbol, tf);
    const queued = pendingWindows.get(key);
    pendingWindows.set(
      key,
      queued === undefined
        ? { from, to: event.bar.t }
        : { from: asTimeMs(Math.min(queued.from, from)), to: asTimeMs(Math.max(queued.to, event.bar.t)) },
    );

    if (inFlight.has(key)) return;

    const run = (async (): Promise<void> => {
      try {
        for (;;) {
          // Not named `window`: nothing in src/data may shadow a DOM global.
          const recovery = pendingWindows.get(key);
          if (recovery === undefined) break;
          pendingWindows.delete(key);
          backfills += 1;
          const result = await backfillGap(
            transport,
            {
              sym: symbol,
              tf,
              from: recovery.from,
              to: recovery.to,
              ...(options.pageLimit !== undefined ? { pageLimit: options.pageLimit } : {}),
            },
            codec,
          );
          options.resolve(symbol, tf)?.merge(result.bars);
        }
        detector.reconcile(symbol, tf);
        reconciled += 1;
        const store = options.resolve(symbol, tf);
        if (store !== null && store.get().state === 'stale') store.setState('live');
      } catch (error: unknown) {
        backfillFailures += 1;
        pendingWindows.delete(key);
        options.onBackfillError?.(error);
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
  }

  const handleBar = (event: BarEvent): void => {
    received += 1;
    const verdict = detector.observe(event.symbol, event.tf, event.seq, event.bar.t);

    switch (verdict.kind) {
      case 'duplicate':
        duplicates += 1;
        return;
      case 'invalid':
        invalid += 1;
        return;
      case 'gap': {
        gaps += 1;
        const store = options.resolve(event.symbol, event.tf);
        store?.setState('stale');
        buffer.push({
          symbol: event.symbol,
          tf: event.tf,
          bar: event.bar,
          seq: event.seq,
          final: event.final,
        });
        if (verdict.backfillFrom !== null) requestBackfill(event, verdict.backfillFrom);
        return;
      }
      case 'first':
      case 'in-order':
        markLiveIfLoading(event.symbol, event.tf);
        buffer.push({
          symbol: event.symbol,
          tf: event.tf,
          bar: event.bar,
          seq: event.seq,
          final: event.final,
        });
        return;
    }
  };

  const settled = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight.values()]);
    }
  };

  return Object.freeze<BarPipeline>({
    handleBar,
    flush: () => buffer.flush(),
    buffer,
    gaps: () => detector.stats(),
    stats: () =>
      Object.freeze<PipelineStats>({
        received,
        duplicates,
        invalid,
        gaps,
        backfills,
        backfillFailures,
        reconciled,
      }),
    settled,
    reset: (symbol, tf) => {
      detector.reset(symbol, tf);
    },
  });
}
