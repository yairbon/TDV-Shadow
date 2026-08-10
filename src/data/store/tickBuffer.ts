/**
 * Back-pressure between the socket and the store (ARCHITECTURE.md §2).
 *
 * A busy instrument can emit dozens of updates for the same bar between two
 * frames. Writing each one straight through would bump `revision` dozens of
 * times and hand the scheduler dozens of "dirty" edges for pixels that are
 * identical. So ticks land in a pending map keyed by (symbol, timeframe, bar
 * open) — a later tick for the same bar overwrites the earlier one — and the
 * frame drains it exactly once.
 *
 * The guarantee: **at most one `replaceLast` per bar reaches the store per
 * frame**, and a burst that crosses a bar close still delivers the closed bar,
 * because a different bar open is a different key.
 *
 * `flush()` is called by the frame owner (renderer's scheduler) at frame start.
 * Nothing here draws, and nothing here calls `requestAnimationFrame` — the data
 * layer must not know the renderer exists (mandate #3, ESLint boundary rule).
 */

import type { Bar, Timeframe } from '../types.js';
import type { ApplyResult, SeriesStore } from './seriesStore.js';

export interface PendingTick {
  readonly symbol: string;
  readonly tf: Timeframe;
  readonly bar: Bar;
  /** Stream sequence, forwarded to `Series.lastSeq`. */
  readonly seq: number;
  /** `true` when the gateway marked the bar closed. */
  readonly final: boolean;
}

export interface FlushStats {
  readonly applied: number;
  readonly appended: number;
  readonly replaced: number;
  readonly unchanged: number;
  readonly rejected: number;
  /** Ticks whose (symbol, tf) has no store — dropped, counted, never thrown. */
  readonly unrouted: number;
}

export interface TickBuffer {
  /** Coalescing enqueue. Never touches the store. */
  push(tick: PendingTick): void;
  /** Drains the pending map into the stores, oldest bar first. */
  flush(): FlushStats;
  /** Ticks currently waiting (== distinct bars, not distinct messages). */
  pending(): number;
  /** Ticks swallowed by coalescing since construction — the back-pressure win. */
  coalesced(): number;
  clear(): void;
}

export type StoreResolver = (symbol: string, tf: Timeframe) => SeriesStore | null;

export interface TickBufferOptions {
  readonly resolve: StoreResolver;
  /**
   * Called when the buffer goes from empty to non-empty — the hook `app/` wires
   * to `scheduler.invalidate(mask)`. Fired once per drained batch, not once per
   * tick, so a burst can never queue frames.
   */
  readonly onPending?: () => void;
}

const tickKey = (symbol: string, tf: Timeframe, t: number): string =>
  `${symbol}|${tf}|${String(t)}`;

export function createTickBuffer(options: TickBufferOptions): TickBuffer {
  const pendingTicks = new Map<string, PendingTick>();
  let coalesced = 0;

  const push = (tick: PendingTick): void => {
    const key = tickKey(tick.symbol, tick.tf, tick.bar.t);
    const wasEmpty = pendingTicks.size === 0;
    if (pendingTicks.has(key)) coalesced += 1;
    pendingTicks.set(key, tick);
    if (wasEmpty) options.onPending?.();
  };

  const flush = (): FlushStats => {
    let appended = 0;
    let replaced = 0;
    let unchanged = 0;
    let rejected = 0;
    let unrouted = 0;

    if (pendingTicks.size === 0) {
      return Object.freeze<FlushStats>({
        applied: 0,
        appended,
        replaced,
        unchanged,
        rejected,
        unrouted,
      });
    }

    // Insertion order is already ascending for a well-behaved stream; sorting
    // makes the closed-bar-then-new-bar case order-independent.
    const batch = [...pendingTicks.values()].sort((a, b) => a.bar.t - b.bar.t);
    pendingTicks.clear();

    for (const tick of batch) {
      const store = options.resolve(tick.symbol, tick.tf);
      if (store === null) {
        unrouted += 1;
        continue;
      }
      const result: ApplyResult = store.applyBar(tick.bar, tick.seq);
      switch (result) {
        case 'appended':
          appended += 1;
          break;
        case 'replaced':
          replaced += 1;
          break;
        case 'unchanged':
          unchanged += 1;
          break;
        case 'rejected':
          rejected += 1;
          break;
      }
    }

    return Object.freeze<FlushStats>({
      applied: appended + replaced,
      appended,
      replaced,
      unchanged,
      rejected,
      unrouted,
    });
  };

  return Object.freeze<TickBuffer>({
    push,
    flush,
    pending: () => pendingTicks.size,
    coalesced: () => coalesced,
    clear: () => {
      pendingTicks.clear();
    },
  });
}
