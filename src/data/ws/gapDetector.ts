/**
 * Sequence-gap detection.
 *
 * `seq` is monotonic per (sym, tf) (ARCHITECTURE.md §3.2). A skip means the
 * gateway dropped frames on the way to us, so the bars behind those frames are
 * simply *unknown*. The recovery is a REST backfill from the last known-good
 * bar open; until that backfill is applied the series is `stale` and the
 * renderer draws it dimmed.
 *
 * A missing bar is NEVER interpolated (src/data/CLAUDE.md) — an invented candle
 * is a lie that survives into screenshots.
 */

import type { Timeframe, TimeMs } from '../types.js';
import { subscriptionKey } from './protocol.js';

export type SeqVerdict =
  /** First message seen for this (sym, tf); nothing to compare against. */
  | { readonly kind: 'first'; readonly seq: number }
  /** `seq === lastSeq + 1`. Apply the bar. */
  | { readonly kind: 'in-order'; readonly seq: number }
  /** `seq <= lastSeq`. A replay; drop it, the store already has it. */
  | { readonly kind: 'duplicate'; readonly seq: number; readonly lastSeq: number }
  /** `seq > lastSeq + 1`. Apply the bar, mark stale, backfill the hole. */
  | {
      readonly kind: 'gap';
      readonly seq: number;
      readonly lastSeq: number;
      /** How many frames were skipped (>= 1). */
      readonly missing: number;
      /** Bar open of the last good bar — the REST cursor. `null` if none yet. */
      readonly backfillFrom: TimeMs | null;
    }
  /** `seq` was not a non-negative integer. Counted and dropped. */
  | { readonly kind: 'invalid'; readonly seq: number };

export interface GapStats {
  readonly accepted: number;
  readonly duplicates: number;
  readonly gaps: number;
  readonly invalid: number;
  /** Keys currently stale (gap seen, backfill not yet reconciled). */
  readonly stale: number;
}

export interface GapDetector {
  /**
   * Records one bar frame. Pure bookkeeping — it never mutates the store and
   * never throws; the caller acts on the verdict.
   */
  observe(sym: string, tf: Timeframe, seq: number, barOpen: TimeMs): SeqVerdict;
  isStale(sym: string, tf: Timeframe): boolean;
  /** Last applied seq, or -1 before the first message (matches `Series.lastSeq`). */
  lastSeq(sym: string, tf: Timeframe): number;
  /** Bar open of the last good bar, or `null`. The backfill cursor. */
  lastGoodTime(sym: string, tf: Timeframe): TimeMs | null;
  /** Backfill applied: the hole is filled, the series is trustworthy again. */
  reconcile(sym: string, tf: Timeframe): void;
  /** Forget everything about a key — used on resubscribe, where seq may restart. */
  reset(sym: string, tf: Timeframe): void;
  resetAll(): void;
  stats(): GapStats;
}

interface KeyState {
  lastSeq: number;
  lastGoodT: TimeMs | null;
  stale: boolean;
}

const freshState = (): KeyState => ({ lastSeq: -1, lastGoodT: null, stale: false });

export function createGapDetector(): GapDetector {
  const states = new Map<string, KeyState>();
  let accepted = 0;
  let duplicates = 0;
  let gaps = 0;
  let invalid = 0;

  const stateFor = (key: string): KeyState => {
    const existing = states.get(key);
    if (existing !== undefined) return existing;
    const created = freshState();
    states.set(key, created);
    return created;
  };

  const peek = (sym: string, tf: Timeframe): KeyState | undefined =>
    states.get(subscriptionKey(sym, tf));

  const observe = (sym: string, tf: Timeframe, seq: number, barOpen: TimeMs): SeqVerdict => {
    if (!Number.isInteger(seq) || seq < 0) {
      invalid += 1;
      return { kind: 'invalid', seq };
    }

    const state = stateFor(subscriptionKey(sym, tf));
    const { lastSeq, lastGoodT } = state;

    if (lastSeq < 0) {
      accepted += 1;
      state.lastSeq = seq;
      state.lastGoodT = barOpen;
      return { kind: 'first', seq };
    }

    if (seq <= lastSeq) {
      duplicates += 1;
      return { kind: 'duplicate', seq, lastSeq };
    }

    if (seq === lastSeq + 1) {
      accepted += 1;
      state.lastSeq = seq;
      state.lastGoodT = barOpen;
      return { kind: 'in-order', seq };
    }

    // Skip. The frame in hand is real data and is still applied; what we do not
    // have is everything between `lastGoodT` and it.
    gaps += 1;
    state.lastSeq = seq;
    state.lastGoodT = barOpen;
    state.stale = true;
    return { kind: 'gap', seq, lastSeq, missing: seq - lastSeq - 1, backfillFrom: lastGoodT };
  };

  const isStale = (sym: string, tf: Timeframe): boolean => peek(sym, tf)?.stale ?? false;

  const lastSeqOf = (sym: string, tf: Timeframe): number => peek(sym, tf)?.lastSeq ?? -1;

  const lastGoodTime = (sym: string, tf: Timeframe): TimeMs | null =>
    peek(sym, tf)?.lastGoodT ?? null;

  const reconcile = (sym: string, tf: Timeframe): void => {
    const state = peek(sym, tf);
    if (state !== undefined) state.stale = false;
  };

  const reset = (sym: string, tf: Timeframe): void => {
    states.delete(subscriptionKey(sym, tf));
  };

  const resetAll = (): void => {
    states.clear();
  };

  const stats = (): GapStats => {
    let stale = 0;
    for (const state of states.values()) {
      if (state.stale) stale += 1;
    }
    return Object.freeze<GapStats>({ accepted, duplicates, gaps, invalid, stale });
  };

  return Object.freeze<GapDetector>({
    observe,
    isStale,
    lastSeq: lastSeqOf,
    lastGoodTime,
    reconcile,
    reset,
    resetAll,
    stats,
  });
}
