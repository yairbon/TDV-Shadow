/**
 * price-range — two anchors, a box, and the move between them as Δprice and Δ%.
 *
 * The load-bearing assertion is the LOG one: the annotation is derived from the anchor
 * PRICES, so switching the scale must move the box and leave the text character-for-
 * character identical. An implementation that measured the box's pixel height instead
 * would pass every linear test here and fail that one.
 */

import { describe, expect, it } from 'vitest';

import { buildGeometry, buildPreviewGeometry } from '../../../src/drawings/geometry.js';
import { hitTest } from '../../../src/drawings/hitTest.js';
import type { Anchor } from '../../../src/drawings/types.js';
import { A, B, PLOT, logPrice, makeDrawing, price, time, zoomedTime } from './projectors.js';

const range = (from: Anchor, to: Anchor, params = {}) =>
  buildGeometry(makeDrawing('price-range', [from, to], params), price, time, PLOT);

describe('price-range geometry', () => {
  it('boxes the two anchors', () => {
    const geometry = range(A, B);

    expect(geometry.complete).toBe(true);
    expect(geometry.box).toEqual({ x0: 672, y0: 200, x1: 852, y1: 400 });
    expect(geometry.segments).toEqual([]);
  });

  it('normalises the box whichever way it is dragged', () => {
    expect(range(B, A).box).toEqual({ x0: 672, y0: 200, x1: 852, y1: 400 });
  });

  it('annotates an up move with a signed delta and percentage', () => {
    // 100 -> 120 is +20.00, and 20/100 = +20.00%.
    expect(range(A, B).labels).toEqual([{ x: 762, y: 300, text: '+20.00 (+20.00%)' }]);
  });

  it('annotates a down move with the sign carried by both numbers', () => {
    // 120 -> 90 is -30.00 against a start of 120, i.e. -25.00%.
    const geometry = range(B, { barIndex: 35, price: 90 });
    expect(geometry.labels[0].text).toBe('-30.00 (-25.00%)');
  });

  it('is not symmetric: the percentage is relative to where the move STARTED', () => {
    // The bug this rules out: dividing by the wrong end, or by the box height.
    const up = range({ barIndex: 5, price: 100 }, { barIndex: 20, price: 200 });
    const down = range({ barIndex: 5, price: 200 }, { barIndex: 20, price: 100 });

    expect(up.labels[0].text).toBe('+100.00 (+100.00%)');
    expect(down.labels[0].text).toBe('-100.00 (-50.00%)');
  });

  it('honours the precision param on the price delta', () => {
    const geometry = range(A, { barIndex: 20, price: 100.125 }, { precision: 3 });
    expect(geometry.labels[0].text).toBe('+0.125 (+0.13%)');
  });

  it('omits the percentage against a zero start instead of reporting Infinity', () => {
    const geometry = range({ barIndex: 5, price: 0 }, { barIndex: 20, price: 20 });
    expect(geometry.labels[0].text).toBe('+20.00');
  });

  it('places the annotation at the centre of the box', () => {
    const geometry = range(A, B);
    const box = geometry.box;
    if (box === null) throw new Error('price-range must have a box');
    expect(geometry.labels[0].x).toBe((box.x0 + box.x1) / 2);
    expect(geometry.labels[0].y).toBe((box.y0 + box.y1) / 2);
  });

  it('keeps both anchors grabbable', () => {
    expect(range(A, B).points).toEqual([
      { x: 672, y: 400 },
      { x: 852, y: 200 },
    ]);
  });
});

describe('price-range and the anchor rule', () => {
  const drawing = makeDrawing('price-range', [A, B]);

  it('reads the same on a LOG scale, where only the box moves', () => {
    const linear = buildGeometry(drawing, price, time, PLOT);
    const logged = buildGeometry(drawing, logPrice, time, PLOT);

    expect(logged.labels[0].text).toBe(linear.labels[0].text);
    expect(logged.box).not.toEqual(linear.box);
    expect(logged.box?.y0).toBeCloseTo(logPrice.y(120), 9);
    expect(logged.box?.y1).toBeCloseTo(logPrice.y(100), 9);
  });

  it('re-derives its box when the view zooms, and keeps its anchors', () => {
    const after = buildGeometry(drawing, price, zoomedTime, PLOT);

    expect(after.box).toEqual({ x0: 200, y0: 200, x1: 800, y1: 400 });
    expect(after.labels[0].text).toBe('+20.00 (+20.00%)');
    expect(drawing.anchors).toEqual([A, B]);
  });
});

describe('price-range hit testing', () => {
  const geometry = range(A, B);

  it('hits a click on the box border', () => {
    expect(hitTest({ x: 762, y: 400 }, [geometry], 6)).toHaveLength(1);
  });

  it('misses a click inside the box, away from any border', () => {
    expect(hitTest({ x: 762, y: 300 }, [geometry], 6)).toHaveLength(0);
  });

  it('misses a click outside the box', () => {
    expect(hitTest({ x: 762, y: 450 }, [geometry], 6)).toHaveLength(0);
  });
});

describe('price-range preview', () => {
  it('measures live while the second corner is being dragged', () => {
    const first = buildPreviewGeometry('price-range', [A], B, price, time, PLOT);
    const second = buildPreviewGeometry('price-range', [A], { barIndex: 20, price: 110 }, price, time, PLOT);

    expect(first.complete).toBe(false);
    expect(first.labels[0].text).toBe('+20.00 (+20.00%)');
    expect(second.labels[0].text).toBe('+10.00 (+10.00%)');
    expect(first.box).not.toEqual(second.box);
  });
});
