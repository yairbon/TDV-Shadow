/**
 * Frame input assembly, and the §4 rule that autoscale is recomputed only when the
 * visible range or the underlying bars change.
 *
 * The snapshot's `bars` array is shared by reference with the store, so `revision`
 * is the only sound change signal — these tests pin that down, including the case
 * where the array mutates underneath a stale revision.
 */

import { describe, expect, it } from 'vitest';
import { asBarIndex, type Bar, type Snapshot } from '../../../src/data/types.js';
import {
  buildFrameInput,
  createAutoscaleCache,
  type FrameInputOptions,
} from '../../../src/renderer/frame.js';
import { makePriceRange } from '../../../src/renderer/scale/priceScale.js';
import { bar, makeBars, makeSnapshot, TEST_THEME, testLayout } from './fixtures.js';

function options(snapshot: Snapshot, extra: Partial<FrameInputOptions> = {}): FrameInputOptions {
  return {
    snapshot,
    layout: testLayout(),
    theme: TEST_THEME,
    pricePrecision: 2,
    overlays: [],
    pointer: null,
    priceRange: null,
    ...extra,
  };
}

describe('buildFrameInput', () => {
  it('derives both scales and the visible range from the snapshot', () => {
    const bars = makeBars(300);
    const f = buildFrameInput(options(makeSnapshot({ bars, barSpacing: 9, scrollPosition: 299 })));
    expect(f.timeScale.barSpacing).toBe(9);
    expect(f.timeScale.scrollPosition).toBe(299);
    expect(f.visible.to).toBe(299);
    expect(f.visible.isEmpty).toBe(false);
    expect(f.priceScale.mode).toBe('linear');
    expect(f.timeframeMs).toBe(60_000);
  });

  it('reads the view state from the snapshot rather than keeping its own copy', () => {
    const bars = makeBars(300);
    const a = buildFrameInput(options(makeSnapshot({ bars, barSpacing: 4, scrollPosition: 120 })));
    const b = buildFrameInput(options(makeSnapshot({ bars, barSpacing: 20, scrollPosition: 260 })));
    expect(a.timeScale.barSpacing).not.toBe(b.timeScale.barSpacing);
    expect(a.visible.count).toBeGreaterThan(b.visible.count);
  });

  it('honours an explicit price range over autoscale', () => {
    const f = buildFrameInput(
      options(makeSnapshot({ bars: makeBars(50) }), { priceRange: makePriceRange(10, 20) }),
    );
    expect(f.priceScale.min).toBe(10);
    expect(f.priceScale.max).toBe(20);
  });

  it('produces a usable frame for an empty series', () => {
    const f = buildFrameInput(options(makeSnapshot({ bars: [] })));
    expect(f.visible.isEmpty).toBe(true);
    expect(Number.isFinite(f.priceScale.min)).toBe(true);
    expect(f.priceScale.max).toBeGreaterThan(f.priceScale.min);
  });

  it('picks the timeframe length for the snapshot timeframe', () => {
    expect(buildFrameInput(options(makeSnapshot({ tf: '1d' }))).timeframeMs).toBe(86_400_000);
    expect(buildFrameInput(options(makeSnapshot({ tf: '4h' }))).timeframeMs).toBe(14_400_000);
  });
});

describe('autoscale cache — §4', () => {
  it('recomputes only when the revision or the visible slice changes', () => {
    const cache = createAutoscaleCache();
    let computes = 0;
    const compute = (): ReturnType<typeof makePriceRange> => {
      computes++;
      return makePriceRange(1, 2);
    };

    cache.range(7, asBarIndex(0), asBarIndex(50), compute);
    cache.range(7, asBarIndex(0), asBarIndex(50), compute);
    cache.range(7, asBarIndex(0), asBarIndex(50), compute);
    expect(computes).toBe(1);

    cache.range(8, asBarIndex(0), asBarIndex(50), compute); // new revision
    expect(computes).toBe(2);

    cache.range(8, asBarIndex(1), asBarIndex(50), compute); // panned
    expect(computes).toBe(3);

    cache.range(8, asBarIndex(1), asBarIndex(60), compute); // zoomed
    expect(computes).toBe(4);

    cache.clear();
    cache.range(8, asBarIndex(1), asBarIndex(60), compute);
    expect(computes).toBe(5);
  });

  it('does not autoscale again on a pointer-move frame', () => {
    const cache = createAutoscaleCache();
    const bars = makeBars(300);
    const snapshot = makeSnapshot({ bars, barSpacing: 9, scrollPosition: 299 });
    const first = buildFrameInput(options(snapshot, { autoscaleCache: cache }));
    const second = buildFrameInput(
      options(snapshot, { autoscaleCache: cache, pointer: { x: 100, y: 100 } }),
    );
    // Same frozen range object handed back, not a recomputed equal one.
    expect(second.priceScale.min).toBe(first.priceScale.min);
    expect(second.priceScale.max).toBe(first.priceScale.max);
  });

  it('never uses array identity or length as the change signal', () => {
    // The store hands out ONE live bars array; a new revision is the only proof that
    // its contents changed. Mutating the array behind a stale revision must not be
    // observable — that is precisely the diff that would silently lie.
    const cache = createAutoscaleCache();
    const live: Bar[] = makeBars(120);
    const stale = {
      series: Object.freeze({ symbol: 'BTCUSD', tf: '1m' as const, bars: live, state: 'live' as const, lastSeq: 1 }),
      scrollPosition: 119,
      barSpacing: 9,
      priceScaleMode: 'linear' as const,
      revision: 5,
    };
    const before = buildFrameInput(options(Object.freeze(stale), { autoscaleCache: cache }));

    live.push(bar(live[live.length - 1].t + 60_000, 100, 5_000, 1, 4_000, 10));
    const after = buildFrameInput(options(Object.freeze({ ...stale }), { autoscaleCache: cache }));
    expect(after.priceScale.max).toBe(before.priceScale.max);

    // Bump the revision the way the store does, and the new extreme is picked up.
    const fresh = buildFrameInput(
      options(Object.freeze({ ...stale, revision: 6, scrollPosition: 120 }), { autoscaleCache: cache }),
    );
    expect(fresh.priceScale.max).toBeGreaterThan(before.priceScale.max);
  });
});
