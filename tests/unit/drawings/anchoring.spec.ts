import { describe, expect, it } from 'vitest';

import { makeBar, type Bar } from '../../../src/data/types.js';
import {
  buildGeometry,
  projectAnchor,
  unprojectPoint,
  type PlotBox,
  type PriceProjector,
  type TimeProjector,
} from '../../../src/drawings/geometry.js';
import { hitTest, distanceToSegment } from '../../../src/drawings/hitTest.js';
import { snapPixel } from '../../../src/drawings/magnet.js';
import { createDrawingStore } from '../../../src/drawings/store.js';
import { TOOL_DEFINITIONS } from '../../../src/drawings/tools.js';
import { DRAWING_KINDS, FIB_RETRACEMENT_LEVELS, type Anchor } from '../../../src/drawings/types.js';

const PLOT: PlotBox = { left: 0, top: 0, width: 1200, height: 600 };

/** §2 linear price projector, matching RENDER_ALGORITHMS. */
function linearPrice(min: number, max: number, plot: PlotBox = PLOT): PriceProjector {
  const m = plot.height / (max - min);
  return {
    y: (price) => plot.top + (max - price) * m,
    price: (y) => max - (y - plot.top) / m,
  };
}

/** §3 log projector — the case where price-space vs pixel-space math diverges. */
function logPrice(min: number, max: number, plot: PlotBox = PLOT): PriceProjector {
  const lMin = Math.log(min);
  const lMax = Math.log(max);
  const m = plot.height / (lMax - lMin);
  return {
    y: (price) => plot.top + (lMax - Math.log(price)) * m,
    price: (y) => Math.exp(lMax - (y - plot.top) / m),
  };
}

/** §5 time projector. */
function timeScale(scroll: number, spacing: number, plot: PlotBox = PLOT): TimeProjector {
  return {
    x: (i) => plot.left + plot.width - (scroll - i) * spacing,
    indexAt: (x) => scroll - (plot.left + plot.width - x) / spacing,
  };
}

function bars(n = 50): Bar[] {
  const out: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const close = price + Math.sin(i / 3) * 3;
    const made = makeBar({
      t: 1_754_870_400_000 + i * 60_000,
      o: price,
      h: Math.max(price, close) + 2,
      l: Math.min(price, close) - 2,
      c: close,
      v: 10,
    });
    if (made === null) throw new Error('bad fixture');
    out.push(made);
    price = close;
  }
  return out;
}

function anchorsFor(kind: (typeof DRAWING_KINDS)[number]): Anchor[] {
  const count = TOOL_DEFINITIONS[kind].anchorCount;
  return Array.from({ length: count }, (_, i) => ({
    barIndex: 10 + i * 7,
    price: 100 + i * 5,
  }));
}

describe('THE ANCHOR RULE — drawings live in data space', () => {
  it.each(DRAWING_KINDS)('%s round-trips its anchors through the scales', (kind) => {
    const price = linearPrice(80, 140);
    const time = timeScale(49, 12);
    for (const anchor of anchorsFor(kind)) {
      const recovered = unprojectPoint(projectAnchor(anchor, price, time), price, time);
      expect(recovered.barIndex).toBeCloseTo(anchor.barIndex, 9);
      expect(recovered.price).toBeCloseTo(anchor.price, 9);
    }
  });

  it.each([4, 12, 48])('round-trips at bar spacing %i', (spacing) => {
    const price = linearPrice(80, 140);
    const time = timeScale(49, spacing);
    const anchor: Anchor = { barIndex: 17.25, price: 123.456 };
    const recovered = unprojectPoint(projectAnchor(anchor, price, time), price, time);
    expect(recovered.barIndex).toBeCloseTo(anchor.barIndex, 9);
    expect(recovered.price).toBeCloseTo(anchor.price, 9);
  });

  it('round-trips on a LOG scale', () => {
    const price = logPrice(80, 140);
    const time = timeScale(49, 12);
    const anchor: Anchor = { barIndex: 17.25, price: 123.456 };
    const recovered = unprojectPoint(projectAnchor(anchor, price, time), price, time);
    expect(recovered.barIndex).toBeCloseTo(anchor.barIndex, 9);
    expect(recovered.price).toBeCloseTo(anchor.price, 6);
  });

  it('leaves data-space anchors untouched when the view changes', () => {
    const store = createDrawingStore();
    const drawing = store.add('trendline', [
      { barIndex: 5, price: 100 },
      { barIndex: 20, price: 120 },
    ]);

    const before = buildGeometry(drawing, linearPrice(80, 140), timeScale(49, 12), PLOT);
    const afterZoom = buildGeometry(drawing, linearPrice(90, 130), timeScale(30, 40), PLOT);

    // Pixels move…
    expect(afterZoom.segments[0].from.x).not.toBeCloseTo(before.segments[0].from.x, 3);
    // …anchors do not.
    expect(store.get(drawing.id)?.anchors).toEqual([
      { barIndex: 5, price: 100 },
      { barIndex: 20, price: 120 },
    ]);
  });
});

describe('magnet', () => {
  const data = bars();
  const price = linearPrice(80, 140);
  const time = timeScale(49, 12);

  it('strong magnet lands EXACTLY on a wick tip, not near it', () => {
    const target = data[20];
    const y = price.y(target.h + 0.3);
    const x = time.x(20);
    const result = snapPixel(x, y, data, 'strong', price, time);
    expect(result.anchor.price).toBe(target.h);
    expect(result.target).toBe('high');
    expect(result.anchor.barIndex).toBe(20);
  });

  it('strong magnet picks the closest of the four OHLC values', () => {
    const target = data[20];
    const result = snapPixel(time.x(20), price.y(target.l - 0.2), data, 'strong', price, time);
    expect(result.anchor.price).toBe(target.l);
    expect(result.target).toBe('low');
  });

  it('weak magnet leaves a deliberate placement alone', () => {
    const target = data[20];
    const midway = (target.h + target.l) / 2;
    const result = snapPixel(time.x(20), price.y(midway), data, 'weak', price, time, 2);
    expect(result.target).toBeNull();
    expect(result.anchor.price).toBeCloseTo(midway, 9);
  });

  it('off magnet is a plain unproject', () => {
    const result = snapPixel(time.x(20), price.y(111.5), data, 'off', price, time);
    expect(result.target).toBeNull();
    expect(result.anchor.price).toBeCloseTo(111.5, 9);
  });

  it('weak magnet tolerance is measured in pixels, so zoom changes what snaps', () => {
    const target = data[20];
    // 0.1 price units: ~1px away on the wide scale (60 units over 600px) and ~15px away
    // on the tight one (4 units over 600px). With an 8px tolerance the wide view must
    // snap and the tight view must not — which only works because the pixel tolerance is
    // converted into a price distance through the live scale.
    const offset = 0.1;
    const wide = snapPixel(time.x(20), price.y(target.h + offset), data, 'weak', price, time, 8);

    const tightScale = linearPrice(118, 122);
    const tight = snapPixel(
      time.x(20),
      tightScale.y(target.h + offset),
      data,
      'weak',
      tightScale,
      time,
      8,
    );

    expect(wide.target).toBe('high');
    expect(tight.target).toBeNull();
  });
});

describe('Fibonacci levels', () => {
  const price = linearPrice(80, 140);
  const time = timeScale(49, 12);

  it('computes level prices in PRICE space', () => {
    const store = createDrawingStore();
    const drawing = store.add('fib-retracement', [
      { barIndex: 5, price: 100 },
      { barIndex: 25, price: 120 },
    ]);
    const geometry = buildGeometry(drawing, price, time, PLOT);
    geometry.levels.forEach((level, i) => {
      expect(level.price).toBeCloseTo(100 + 20 * FIB_RETRACEMENT_LEVELS[i], 9);
    });
  });

  it('spaces levels non-uniformly in pixels on a log scale', () => {
    // The proof that levels are computed in price space: on a log scale, equal price
    // steps are NOT equal pixel steps. Computing levels by interpolating pixels would
    // make these gaps identical and look correct on a linear chart only.
    const store = createDrawingStore();
    const drawing = store.add('fib-retracement', [
      { barIndex: 5, price: 60 },
      { barIndex: 25, price: 240 },
    ]);
    const geometry = buildGeometry(drawing, logPrice(50, 260), time, PLOT);
    const gaps: number[] = [];
    for (let i = 1; i < geometry.levels.length; i++) {
      gaps.push(Math.abs(geometry.levels[i].y - geometry.levels[i - 1].y));
    }
    const first = gaps[0];
    expect(gaps.some((g) => Math.abs(g - first) > 1)).toBe(true);
  });
});

describe('hit testing', () => {
  const price = linearPrice(80, 140);
  const time = timeScale(49, 12);

  it('hits a click on the line and misses one 20px away', () => {
    const store = createDrawingStore();
    const drawing = store.add('trendline', [
      { barIndex: 5, price: 100 },
      { barIndex: 25, price: 100 },
    ]);
    const geometry = buildGeometry(drawing, price, time, PLOT);
    const onLine = geometry.segments[0].from;

    expect(hitTest({ x: onLine.x + 40, y: onLine.y }, [geometry], 6)).toHaveLength(1);
    expect(hitTest({ x: onLine.x + 40, y: onLine.y + 20 }, [geometry], 6)).toHaveLength(0);
  });

  it('returns the nearest of two overlapping drawings first', () => {
    const store = createDrawingStore();
    const near = store.add('horizontal-line', [{ barIndex: 0, price: 100 }]);
    const far = store.add('horizontal-line', [{ barIndex: 0, price: 100.4 }]);
    const geometries = [far, near].map((d) => buildGeometry(d, price, time, PLOT));
    const hits = hitTest({ x: 600, y: price.y(100) }, geometries, 20);
    expect(hits[0].id).toBe(near.id);
  });

  it('reports which anchor was grabbed, for dragging', () => {
    const store = createDrawingStore();
    const drawing = store.add('trendline', [
      { barIndex: 5, price: 100 },
      { barIndex: 25, price: 120 },
    ]);
    const geometry = buildGeometry(drawing, price, time, PLOT);
    const hits = hitTest(geometry.points[1], [geometry], 6);
    expect(hits[0].anchorIndex).toBe(1);
  });

  it('measures distance to a segment, not to its infinite line', () => {
    const d = distanceToSegment({ x: 200, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(d).toBeCloseTo(100, 9);
  });
});

describe('store', () => {
  it('round-trips through JSON losslessly', () => {
    const store = createDrawingStore();
    store.add('fib-retracement', [
      { barIndex: 1, price: 10 },
      { barIndex: 9, price: 20 },
    ]);
    store.add('trendline', [
      { barIndex: 2, price: 11 },
      { barIndex: 8, price: 19 },
    ]);

    const json = store.toJSON();
    const restored = createDrawingStore();
    expect(restored.loadJSON(json)).toBe(2);
    expect(JSON.parse(restored.toJSON())).toEqual(JSON.parse(json));
  });

  it('does not reuse ids after a restore', () => {
    const store = createDrawingStore();
    store.add('trendline', [
      { barIndex: 1, price: 10 },
      { barIndex: 2, price: 11 },
    ]);
    const restored = createDrawingStore();
    restored.loadJSON(store.toJSON());
    const added = restored.add('ray', [
      { barIndex: 3, price: 12 },
      { barIndex: 4, price: 13 },
    ]);
    expect(restored.list().filter((d) => d.id === added.id)).toHaveLength(1);
  });

  it('bumps revision only on real changes', () => {
    const store = createDrawingStore();
    const before = store.revision();
    store.add('trendline', [
      { barIndex: 1, price: 10 },
      { barIndex: 2, price: 11 },
    ]);
    expect(store.revision()).toBeGreaterThan(before);
    const afterAdd = store.revision();
    expect(store.remove('nope')).toBe(false);
    expect(store.revision()).toBe(afterAdd);
  });

  it('refuses to move a locked drawing', () => {
    const store = createDrawingStore();
    const drawing = store.add('trendline', [
      { barIndex: 1, price: 10 },
      { barIndex: 2, price: 11 },
    ]);
    store.update(drawing.id, { locked: true });
    const moved = store.update(drawing.id, { anchors: [{ barIndex: 99, price: 99 }] });
    expect(moved?.anchors[0].barIndex).toBe(1);
  });

  it('marks a drawing incomplete until it has all its anchors', () => {
    const store = createDrawingStore();
    const partial = store.add('pitchfork', [{ barIndex: 1, price: 10 }]);
    const geometry = buildGeometry(partial, linearPrice(80, 140), timeScale(49, 12), PLOT);
    expect(geometry.complete).toBe(false);
    expect(geometry.segments).toHaveLength(0);
  });
});
