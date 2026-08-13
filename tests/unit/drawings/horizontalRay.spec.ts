/**
 * horizontal-ray — one anchor, a horizontal line running RIGHT to the plot edge.
 *
 * The assertions that carry weight are the ones that separate it from the two tools it
 * would otherwise be indistinguishable from: it must NOT run left of its anchor (that is
 * `horizontal-line`), and its level label must sit at its own left end, the anchor, not at
 * `plot.left` (the bug `Level.x` exists to prevent).
 */

import { describe, expect, it } from 'vitest';

import { buildGeometry, buildPreviewGeometry } from '../../../src/drawings/geometry.js';
import { hitTest } from '../../../src/drawings/hitTest.js';
import { A, PLOT, logPrice, makeDrawing, price, time, zoomedTime } from './projectors.js';

const ray = (anchor = A) => buildGeometry(makeDrawing('horizontal-ray', [anchor]), price, time, PLOT);

describe('horizontal-ray geometry', () => {
  it('starts at the anchor and ends at the right plot edge', () => {
    const geometry = ray();

    expect(geometry.complete).toBe(true);
    expect(geometry.segments).toEqual([{ from: { x: 672, y: 400 }, to: { x: 1200, y: 400 } }]);
  });

  it('does not extend LEFT of the anchor', () => {
    // The whole difference from `horizontal-line`, which spans the full plot width.
    const geometry = ray();
    const line = buildGeometry(makeDrawing('horizontal-line', [A]), price, time, PLOT);

    expect(geometry.segments[0].from.x).toBe(672);
    expect(line.segments[0].from.x).toBe(PLOT.left);
    expect(geometry.segments[0].from.x).toBeGreaterThan(line.segments[0].from.x);
  });

  it('is exactly horizontal', () => {
    const geometry = ray();
    expect(geometry.segments[0].from.y).toBe(geometry.segments[0].to.y);
    expect(geometry.segments[0].from.y).toBe(price.y(A.price));
  });

  it('labels its level at its OWN left end, not the plot edge', () => {
    const geometry = ray();

    expect(geometry.levels).toEqual([{ price: 100, y: 400, label: '100.00', x: 672 }]);
    expect(geometry.levels[0].x).not.toBe(PLOT.left);
  });

  it('marks its single anchor as a draggable point', () => {
    expect(ray().points).toEqual([{ x: 672, y: 400 }]);
  });

  it('follows the anchor when the view zooms — the anchor rule', () => {
    const drawing = makeDrawing('horizontal-ray', [A]);
    const before = buildGeometry(drawing, price, time, PLOT);
    const after = buildGeometry(drawing, price, zoomedTime, PLOT);

    // bar 5 sits at 672px at 12px/bar and at 200px at 40px/bar…
    expect(before.segments[0].from.x).toBe(672);
    expect(after.segments[0].from.x).toBe(200);
    // …and both still stop at the right edge, at the same price row.
    expect(after.segments[0].to.x).toBe(1200);
    expect(after.segments[0].from.y).toBe(400);
    expect(drawing.anchors).toEqual([A]);
  });

  it('projects its price through the LOG scale, not through a cached pixel', () => {
    const geometry = buildGeometry(makeDrawing('horizontal-ray', [A]), logPrice, time, PLOT);

    expect(geometry.segments[0].from.y).toBeCloseTo(logPrice.y(100), 9);
    expect(geometry.segments[0].from.y).not.toBeCloseTo(price.y(100), 3);
    expect(geometry.levels[0].y).toBeCloseTo(logPrice.y(100), 9);
  });
});

describe('horizontal-line, the tool the ray is contrasted with', () => {
  it('emits its level at the plot edge and on the projected price row', () => {
    // Filling a hole found by mutation testing while adding the ray: nothing asserted
    // `horizontal-line`'s level numerically, so shifting its `y` by a pixel stayed green.
    const geometry = buildGeometry(makeDrawing('horizontal-line', [A]), price, time, PLOT);

    expect(geometry.levels).toEqual([{ price: 100, y: 400, label: '100.00', x: PLOT.left }]);
    expect(geometry.levels[0].y).toBe(price.y(A.price));
  });
});

describe('horizontal-ray hit testing', () => {
  const geometry = ray();

  it('hits a click on the ray, right of the anchor', () => {
    expect(hitTest({ x: 900, y: 400 }, [geometry], 6)).toHaveLength(1);
  });

  it('misses a click 20px above the ray', () => {
    expect(hitTest({ x: 900, y: 420 }, [geometry], 6)).toHaveLength(0);
  });

  it('misses a click LEFT of the anchor on the same price row', () => {
    // A `horizontal-line` in the same place would hit here; the ray must not.
    expect(hitTest({ x: 100, y: 400 }, [geometry], 6)).toHaveLength(0);
    const line = buildGeometry(makeDrawing('horizontal-line', [A]), price, time, PLOT);
    expect(hitTest({ x: 100, y: 400 }, [line], 6)).toHaveLength(1);
  });

  it('reports the anchor grabbed at the start of the ray', () => {
    expect(hitTest({ x: 672, y: 400 }, [geometry], 6)[0].anchorIndex).toBe(0);
  });

  it('reports no anchor for a grab on the body', () => {
    expect(hitTest({ x: 900, y: 400 }, [geometry], 6)[0].anchorIndex).toBe(-1);
  });
});

describe('horizontal-ray preview', () => {
  it('paints a full ray the moment the tool is armed, before any click', () => {
    const geometry = buildPreviewGeometry('horizontal-ray', [], A, price, time, PLOT);

    expect(geometry.complete).toBe(false);
    expect(geometry.segments).toEqual([{ from: { x: 672, y: 400 }, to: { x: 1200, y: 400 } }]);
    expect(geometry.points).toEqual([{ x: 672, y: 400 }]);
  });

  it('tracks the cursor', () => {
    const low = buildPreviewGeometry('horizontal-ray', [], A, price, time, PLOT);
    const high = buildPreviewGeometry(
      'horizontal-ray',
      [],
      { barIndex: 20, price: 120 },
      price,
      time,
      PLOT,
    );

    expect(low.segments[0].from).toEqual({ x: 672, y: 400 });
    expect(high.segments[0].from).toEqual({ x: 852, y: 200 });
  });
});
