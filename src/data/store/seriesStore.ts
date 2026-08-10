/**
 * The series of record for one (symbol, timeframe).
 *
 * Rules this file exists to enforce (root mandate #4, src/data/CLAUDE.md):
 *  - bars are append-only; the array is never copied on the hot path, so
 *    `snapshot()` stays O(1) (snapshot.ts) — the array reference is shared, the
 *    Bar objects inside it are frozen and never edited;
 *  - `replaceLast` swaps the reference of the last element for a *new* frozen
 *    Bar. The previous object is left untouched and still frozen — anything
 *    holding it (a mid-flight frame, an indicator) keeps a valid value;
 *  - `revision` increments only on a real content change. A tick that repeats
 *    the values already stored costs nothing and wakes no renderer.
 */

import type { Bar, Series, SeriesState, Timeframe } from '../types.js';

export type ApplyResult =
  | 'appended'
  /** Same bar open, new values — the live-tick path. */
  | 'replaced'
  /** Identical content already stored; no revision bump, no notify. */
  | 'unchanged'
  /** Older than the last bar: out of order, dropped and counted. */
  | 'rejected';

export interface SeriesStoreOptions {
  readonly symbol: string;
  readonly tf: Timeframe;
  /** Must already be ascending by `t`; out-of-order bars are dropped. */
  readonly initialBars?: readonly Bar[];
  readonly state?: SeriesState;
}

export interface SeriesStore {
  readonly symbol: string;
  readonly tf: Timeframe;
  /** Frozen `Series`; the same object until content changes. */
  get(): Series;
  revision(): number;
  /** Bars rejected for being out of order. */
  rejected(): number;
  /** Strictly-newer bar only. */
  append(bar: Bar): boolean;
  appendMany(bars: readonly Bar[]): number;
  /** Same `t` as the current last bar only. */
  replaceLast(bar: Bar): boolean;
  /** Live-tick entry point: appends or replaces depending on the bar open. */
  applyBar(bar: Bar, seq?: number): ApplyResult;
  /**
   * Backfill reconcile: splices historical/gap-filling bars in by `t`.
   * Off the hot path — this is the one operation that rebuilds the array.
   * Incoming bars win over stored ones with the same `t` (REST is the source of
   * record for closed bars). Returns the number of bars added or corrected.
   */
  merge(bars: readonly Bar[]): number;
  setState(state: SeriesState): boolean;
  setLastSeq(seq: number): boolean;
  /** Returns an unsubscribe function. Safe to call during a notify. */
  subscribe(listener: (series: Series) => void): () => void;
}

const sameContent = (a: Bar, b: Bar): boolean =>
  a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;

export function createSeriesStore(options: SeriesStoreOptions): SeriesStore {
  const { symbol, tf } = options;

  // The one mutable array in the data layer. It is never handed out except
  // inside a frozen `Series`, and its elements are frozen Bars.
  let bars: Bar[] = [];
  let state: SeriesState = options.state ?? 'loading';
  let lastSeq = -1;
  let revision = 0;
  let rejected = 0;

  for (const bar of options.initialBars ?? []) {
    if (bars.length > 0 && bar.t <= bars[bars.length - 1].t) {
      rejected += 1;
      continue;
    }
    bars.push(bar);
  }

  let series: Series = Object.freeze<Series>({ symbol, tf, bars, state, lastSeq });
  const listeners = new Set<(series: Series) => void>();

  const rebuild = (): void => {
    series = Object.freeze<Series>({ symbol, tf, bars, state, lastSeq });
  };

  /** One content change: new frozen Series, revision++, notify. */
  const commit = (): void => {
    revision += 1;
    rebuild();
    if (listeners.size === 0) return;
    for (const listener of [...listeners]) listener(series);
  };

  const lastBar = (): Bar | null => (bars.length === 0 ? null : bars[bars.length - 1]);

  const append = (bar: Bar): boolean => {
    const last = lastBar();
    if (last !== null && bar.t <= last.t) {
      rejected += 1;
      return false;
    }
    bars.push(bar);
    commit();
    return true;
  };

  const appendMany = (incoming: readonly Bar[]): number => {
    let added = 0;
    for (const bar of incoming) {
      const last = bars.length === 0 ? null : bars[bars.length - 1];
      if (last !== null && bar.t <= last.t) {
        rejected += 1;
        continue;
      }
      bars.push(bar);
      added += 1;
    }
    if (added > 0) commit();
    return added;
  };

  const replaceLast = (bar: Bar): boolean => {
    const last = lastBar();
    if (last === null || bar.t !== last.t) {
      rejected += 1;
      return false;
    }
    if (sameContent(last, bar)) return false;
    // Reference swap, not mutation: `last` survives untouched and frozen.
    bars[bars.length - 1] = bar;
    commit();
    return true;
  };

  const applyBar = (bar: Bar, seq?: number): ApplyResult => {
    let seqChanged = false;
    if (seq !== undefined && seq !== lastSeq) {
      lastSeq = seq;
      seqChanged = true;
    }

    const last = lastBar();
    if (last === null || bar.t > last.t) {
      bars.push(bar);
      commit();
      return 'appended';
    }
    if (bar.t === last.t) {
      if (sameContent(last, bar)) {
        if (seqChanged) rebuild();
        return 'unchanged';
      }
      bars[bars.length - 1] = bar;
      commit();
      return 'replaced';
    }
    rejected += 1;
    if (seqChanged) rebuild();
    return 'rejected';
  };

  const merge = (incoming: readonly Bar[]): number => {
    if (incoming.length === 0) return 0;

    const byTime = new Map<number, Bar>();
    for (const bar of bars) byTime.set(bar.t, bar);

    let changed = 0;
    for (const bar of incoming) {
      const existing = byTime.get(bar.t);
      if (existing !== undefined && sameContent(existing, bar)) continue;
      byTime.set(bar.t, bar);
      changed += 1;
    }
    if (changed === 0) return 0;

    // New array, so any Series already handed out keeps the array it was built
    // with. This is the only place the array identity changes.
    bars = [...byTime.values()].sort((a, b) => a.t - b.t);
    commit();
    return changed;
  };

  const setState = (next: SeriesState): boolean => {
    if (state === next) return false;
    state = next;
    // Visible content: the renderer dims a stale series.
    commit();
    return true;
  };

  const setLastSeq = (seq: number): boolean => {
    if (!Number.isInteger(seq) || seq === lastSeq) return false;
    lastSeq = seq;
    // Bookkeeping only — no pixel depends on it, so no revision bump.
    rebuild();
    return true;
  };

  const subscribe = (listener: (series: Series) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return Object.freeze<SeriesStore>({
    symbol,
    tf,
    get: () => series,
    revision: () => revision,
    rejected: () => rejected,
    append,
    appendMany,
    replaceLast,
    applyBar,
    merge,
    setState,
    setLastSeq,
    subscribe,
  });
}
