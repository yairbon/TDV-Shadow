import { describe, expect, it } from 'vitest';
import { createSeriesStore } from '../../../src/data/store/seriesStore.js';
import type { Series } from '../../../src/data/types.js';
import { bar, MINUTE, T0 } from './_helpers.js';

const store = (): ReturnType<typeof createSeriesStore> =>
  createSeriesStore({ symbol: 'BTCUSD', tf: '1m' });

describe('seriesStore — append-only', () => {
  it('starts empty, frozen and loading', () => {
    const s = store();
    expect(s.get().bars).toHaveLength(0);
    expect(s.get().state).toBe('loading');
    expect(s.get().lastSeq).toBe(-1);
    expect(Object.isFrozen(s.get())).toBe(true);
    expect(s.revision()).toBe(0);
  });

  it('appends strictly newer bars and bumps the revision each time', () => {
    const s = store();
    expect(s.append(bar(T0))).toBe(true);
    expect(s.append(bar(T0 + MINUTE))).toBe(true);
    expect(s.revision()).toBe(2);
    expect(s.get().bars.map((b) => b.t)).toEqual([T0, T0 + MINUTE]);
  });

  it('rejects an out-of-order or repeated bar open', () => {
    const s = store();
    s.append(bar(T0 + MINUTE));
    expect(s.append(bar(T0))).toBe(false);
    expect(s.append(bar(T0 + MINUTE))).toBe(false);
    expect(s.get().bars).toHaveLength(1);
    expect(s.rejected()).toBe(2);
    expect(s.revision()).toBe(1);
  });

  it('seeds from initialBars without a revision bump', () => {
    const seeded = createSeriesStore({
      symbol: 'BTCUSD',
      tf: '1m',
      initialBars: [bar(T0), bar(T0 + MINUTE)],
      state: 'live',
    });
    expect(seeded.get().bars).toHaveLength(2);
    expect(seeded.get().state).toBe('live');
    expect(seeded.revision()).toBe(0);
  });
});

describe('seriesStore — replaceLast never mutates a Bar (root mandate #4)', () => {
  it('swaps the reference and leaves the previous object untouched and frozen', () => {
    const s = store();
    s.append(bar(T0, 100, 110, 90, 105, 1));
    const previous = s.get().bars[0];
    const before = { t: previous.t, o: previous.o, h: previous.h, l: previous.l, c: previous.c, v: previous.v };

    expect(s.replaceLast(bar(T0, 100, 120, 90, 118, 3))).toBe(true);

    const current = s.get().bars[0];
    expect(current).not.toBe(previous);
    expect(current.h).toBe(120);
    expect(current.c).toBe(118);

    // The object anyone else may still be holding is bit-for-bit what it was.
    expect(Object.isFrozen(previous)).toBe(true);
    expect(previous.h).toBe(before.h);
    expect(previous.c).toBe(before.c);
    expect(previous.v).toBe(before.v);
    expect({ ...previous }).toEqual(before);
  });

  it('leaves the bars array identity alone, so snapshots stay O(1)', () => {
    const s = store();
    s.append(bar(T0));
    const before = s.get();

    s.replaceLast(bar(T0, 100, 130, 80, 120, 9));

    // Same array object (no copy on the hot path), new frozen Series wrapper.
    expect(s.get().bars).toBe(before.bars);
    expect(s.get()).not.toBe(before);
    expect(Object.isFrozen(s.get())).toBe(true);
  });

  it('refuses a bar that is not the current last bar open', () => {
    const s = store();
    s.append(bar(T0));
    expect(s.replaceLast(bar(T0 + MINUTE))).toBe(false);
    expect(s.rejected()).toBe(1);
    expect(s.revision()).toBe(1);
  });

  it('refuses to replace anything on an empty series', () => {
    const s = store();
    expect(s.replaceLast(bar(T0))).toBe(false);
    expect(s.get().bars).toHaveLength(0);
  });
});

describe('seriesStore — revision moves only on real content change', () => {
  it('ignores a tick that repeats the values already stored', () => {
    const s = store();
    s.append(bar(T0, 100, 110, 90, 105, 1));
    const revision = s.revision();
    const series = s.get();

    let notifications = 0;
    s.subscribe(() => {
      notifications += 1;
    });

    expect(s.replaceLast(bar(T0, 100, 110, 90, 105, 1))).toBe(false);
    expect(s.applyBar(bar(T0, 100, 110, 90, 105, 1))).toBe('unchanged');

    expect(s.revision()).toBe(revision);
    expect(s.get()).toBe(series);
    expect(notifications).toBe(0);
  });

  it('treats a state change as content — the renderer dims a stale series', () => {
    const s = store();
    const revision = s.revision();
    expect(s.setState('stale')).toBe(true);
    expect(s.revision()).toBe(revision + 1);
    expect(s.setState('stale')).toBe(false);
    expect(s.revision()).toBe(revision + 1);
  });

  it('treats lastSeq as bookkeeping — no revision bump, no repaint', () => {
    const s = store();
    s.append(bar(T0));
    const revision = s.revision();

    expect(s.setLastSeq(42)).toBe(true);
    expect(s.get().lastSeq).toBe(42);
    expect(s.revision()).toBe(revision);
    expect(s.setLastSeq(42)).toBe(false);
  });
});

describe('seriesStore — applyBar (the live tick path)', () => {
  it('appends a new bar open, replaces the current one, rejects an old one', () => {
    const s = store();
    expect(s.applyBar(bar(T0), 1)).toBe('appended');
    expect(s.applyBar(bar(T0, 100, 111, 90, 106), 2)).toBe('replaced');
    expect(s.applyBar(bar(T0 + MINUTE), 3)).toBe('appended');
    expect(s.applyBar(bar(T0), 4)).toBe('rejected');

    expect(s.get().bars).toHaveLength(2);
    expect(s.get().lastSeq).toBe(4);
    expect(s.rejected()).toBe(1);
  });
});

describe('seriesStore — subscribe', () => {
  it('notifies with the new frozen series and unsubscribes cleanly', () => {
    const s = store();
    const seen: Series[] = [];
    const lengths: number[] = [];
    const off = s.subscribe((series) => {
      seen.push(series);
      lengths.push(series.bars.length);
    });

    s.append(bar(T0));
    s.append(bar(T0 + MINUTE));
    off();
    s.append(bar(T0 + 2 * MINUTE));

    expect(lengths).toEqual([1, 2]);
    expect(seen).toHaveLength(2);
    expect(Object.isFrozen(seen[1])).toBe(true);
    expect(seen[1].lastSeq).toBe(-1);
  });

  it('hands listeners the live append-only array — which is why snapshots are per-frame', () => {
    const s = store();
    const seen: Series[] = [];
    s.subscribe((series) => seen.push(series));

    s.append(bar(T0));
    s.append(bar(T0 + MINUTE));

    // Deliberate: `bars` is one growing array, shared by reference so that
    // `snapshot()` stays O(1). A Series is only valid for the frame it was read
    // in — the frozen *Bar objects* are what never change.
    expect(seen[0].bars).toBe(s.get().bars);
    expect(seen[0].bars).toHaveLength(2);
  });

  it('survives a listener unsubscribing during a notify', () => {
    const s = store();
    let calls = 0;
    const off = s.subscribe(() => {
      calls += 1;
      off();
    });
    s.subscribe(() => {
      calls += 1;
    });

    s.append(bar(T0));
    s.append(bar(T0 + MINUTE));
    expect(calls).toBe(3);
  });
});

describe('seriesStore — merge (gap backfill reconcile)', () => {
  it('splices missing bars in ascending order and corrects revised ones', () => {
    const s = store();
    s.appendMany([bar(T0), bar(T0 + 4 * MINUTE)]);
    const revision = s.revision();

    const changed = s.merge([
      bar(T0 + 3 * MINUTE),
      bar(T0 + MINUTE),
      bar(T0 + 2 * MINUTE),
      bar(T0, 100, 115, 90, 112, 7), // corrected close for a bar we already had
    ]);

    expect(changed).toBe(4);
    expect(s.get().bars.map((b) => b.t)).toEqual([
      T0,
      T0 + MINUTE,
      T0 + 2 * MINUTE,
      T0 + 3 * MINUTE,
      T0 + 4 * MINUTE,
    ]);
    expect(s.get().bars[0].c).toBe(112);
    expect(s.revision()).toBe(revision + 1);
  });

  it('is a no-op when the backfill only repeats what is already stored', () => {
    const s = store();
    s.appendMany([bar(T0), bar(T0 + MINUTE)]);
    const revision = s.revision();
    const bars = s.get().bars;

    expect(s.merge([bar(T0), bar(T0 + MINUTE)])).toBe(0);
    expect(s.revision()).toBe(revision);
    expect(s.get().bars).toBe(bars);
  });

  it('hands out a fresh array so an already-issued Series keeps its own', () => {
    const s = store();
    s.appendMany([bar(T0), bar(T0 + 2 * MINUTE)]);
    const issued = s.get();

    s.merge([bar(T0 + MINUTE)]);

    expect(issued.bars).toHaveLength(2);
    expect(s.get().bars).toHaveLength(3);
    expect(s.get().bars).not.toBe(issued.bars);
  });
});
