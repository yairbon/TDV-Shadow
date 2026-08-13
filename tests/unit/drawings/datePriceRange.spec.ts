/**
 * date-price-range — the same box as the other two range tools, annotated with BOTH
 * measurements.
 *
 * The assertions worth having are the ones a "combined" tool gets wrong: the two rows must
 * be the price row and the span row (not the same row twice), they must not share a y (or
 * they overprint), and each must keep the invariance of the tool it came from — the price
 * text unchanged by a log scale, the span text unchanged by a zoom.
 */

import { describe, expect, it } from 'vitest';

import { buildGeometry, buildPreviewGeometry } from '../../../src/drawings/geometry.js';
import { hitTest } from '../../../src/drawings/hitTest.js';
import { TIMEFRAME_MS } from '../../../src/data/types.js';
import type { Anchor, Drawing } from '../../../src/drawings/types.js';
import { A, B, PLOT, logPrice, makeDrawing, price, time, zoomedTime } from './projectors.js';

const both = (from: Anchor, to: Anchor, params: Drawing['params'] = {}) =>
  buildGeometry(makeDrawing('date-price-range', [from, to], params), price, time, PLOT);

describe('date-price-range geometry', () => {
  it('boxes the two anchors like the other range tools', () => {
    const geometry = both(A, B);

    expect(geometry.complete).toBe(true);
    expect(geometry.box).toEqual({ x0: 672, y0: 200, x1: 852, y1: 400 });
    expect(geometry.segments).toEqual([]);
  });

  it('annotates the price move and the bar span, in that order', () => {
    const geometry = both(A, B, { barMs: TIMEFRAME_MS['1h'] });

    expect(geometry.labels).toHaveLength(2);
    expect(geometry.labels[0].text).toBe('+20.00 (+20.00%)');
    expect(geometry.labels[1].text).toBe('15 bars, 15h');
  });

  it('stacks the two rows around the centre so they cannot overprint', () => {
    const geometry = both(A, B);
    const box = geometry.box;
    if (box === null) throw new Error('date-price-range must have a box');
    const centreY = (box.y0 + box.y1) / 2;

    expect(geometry.labels[0].x).toBe((box.x0 + box.x1) / 2);
    expect(geometry.labels[1].x).toBe(geometry.labels[0].x);
    expect(geometry.labels[0].y).toBeLessThan(centreY);
    expect(geometry.labels[1].y).toBeGreaterThan(centreY);
    expect(geometry.labels[1].y - geometry.labels[0].y).toBeGreaterThanOrEqual(11);
  });

  it('matches the two single-measurement tools exactly, text for text', () => {
    const params = { barMs: TIMEFRAME_MS['15m'], precision: 3 };
    const combined = both(A, B, params);
    const priceOnly = buildGeometry(makeDrawing('price-range', [A, B], params), price, time, PLOT);
    const dateOnly = buildGeometry(makeDrawing('date-range', [A, B], params), price, time, PLOT);

    expect(combined.labels[0].text).toBe(priceOnly.labels[0].text);
    expect(combined.labels[1].text).toBe(dateOnly.labels[0].text);
    expect(combined.labels[0].text).toBe('+20.000 (+20.00%)');
    expect(combined.labels[1].text).toBe('15 bars, 3h 45m');
  });

  it('emits exactly one row when it is the only tool asked for', () => {
    // Guards the branch: the single-measurement kinds must not grow a second row.
    expect(
      buildGeometry(makeDrawing('price-range', [A, B]), price, time, PLOT).labels,
    ).toHaveLength(1);
    expect(buildGeometry(makeDrawing('date-range', [A, B]), price, time, PLOT).labels).toHaveLength(
      1,
    );
  });

  it('reports a down move with both signs and still counts bars forwards', () => {
    const geometry = both(B, { barIndex: 35, price: 90 }, { barMs: TIMEFRAME_MS['1d'] });

    expect(geometry.labels[0].text).toBe('-30.00 (-25.00%)');
    expect(geometry.labels[1].text).toBe('15 bars, 15d');
  });
});

describe('date-price-range keeps both invariances', () => {
  const drawing = makeDrawing('date-price-range', [A, B], { barMs: TIMEFRAME_MS['1h'] });

  it('reads the same price move on a LOG scale, where the box moves', () => {
    const linear = buildGeometry(drawing, price, time, PLOT);
    const logged = buildGeometry(drawing, logPrice, time, PLOT);

    expect(logged.labels[0].text).toBe(linear.labels[0].text);
    expect(logged.box).not.toEqual(linear.box);
  });

  it('reads the same bar span after a zoom, where the box also moves', () => {
    const linear = buildGeometry(drawing, price, time, PLOT);
    const zoomed = buildGeometry(drawing, price, zoomedTime, PLOT);

    expect(zoomed.labels[1].text).toBe(linear.labels[1].text);
    expect(zoomed.box).not.toEqual(linear.box);
    expect(drawing.anchors).toEqual([A, B]);
  });
});

describe('date-price-range hit testing', () => {
  const geometry = both(A, B);

  it('hits a click on the box border', () => {
    expect(hitTest({ x: 852, y: 300 }, [geometry], 6)).toHaveLength(1);
  });

  it('misses a click in the middle, where the annotations are', () => {
    expect(hitTest({ x: 762, y: 300 }, [geometry], 6)).toHaveLength(0);
  });
});

describe('date-price-range preview', () => {
  it('measures both axes live while the second corner is dragged', () => {
    const preview = buildPreviewGeometry('date-price-range', [A], B, price, time, PLOT);

    expect(preview.complete).toBe(false);
    expect(preview.labels[0].text).toBe('+20.00 (+20.00%)');
    expect(preview.labels[1].text).toBe('15 bars');
    expect(preview.box).toEqual({ x0: 672, y0: 200, x1: 852, y1: 400 });
  });
});
