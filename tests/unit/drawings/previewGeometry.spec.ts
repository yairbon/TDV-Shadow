/**
 * Live preview geometry — the shape as it would be if the user clicked right now.
 *
 * The bug this exists to prevent: placing a trendline produced identical painted output
 * before the first click, after the first click and while moving to the second, because
 * the in-progress anchors never reached the renderer and `buildGeometry` answers a short
 * anchor list with nothing at all. So the load-bearing assertions here are the ones that
 * would have been RED then — a segment that actually runs from the pinned anchor to the
 * cursor, and a preview that CHANGES when the cursor moves.
 *
 * Numbers, not "something was produced": the projectors below are the §2/§5 transforms
 * with round pixel values, so every expected coordinate is written out in full.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPreviewGeometry,
  constrainToAngle,
  projectAnchor,
  PREVIEW_ID,
  type PlotBox,
  type Point,
  type PriceProjector,
  type TimeProjector,
} from '../../../src/drawings/geometry.js';
import { TOOL_DEFINITIONS } from '../../../src/drawings/tools.js';
import { DRAWING_KINDS, FIB_RETRACEMENT_LEVELS, type Anchor } from '../../../src/drawings/types.js';

const PLOT: PlotBox = { left: 0, top: 0, width: 1200, height: 600 };

/** §2 linear price projector: 60 price units over 600px, so y(140) = 0 and y(80) = 600. */
const price: PriceProjector = {
  y: (p) => (140 - p) * 10,
  price: (y) => 140 - y / 10,
};

/** §3 log projector — where price-space and pixel-space maths diverge. */
const logPrice: PriceProjector = {
  y: (p) => (Math.log(260) - Math.log(p)) * (600 / (Math.log(260) - Math.log(50))),
  price: (y) => Math.exp(Math.log(260) - y / (600 / (Math.log(260) - Math.log(50)))),
};

/** §5 time projector: 12px per bar, bar 49 at the right edge. */
const time: TimeProjector = {
  x: (i) => 1200 - (49 - i) * 12,
  indexAt: (x) => 49 - (1200 - x) / 12,
};

const A: Anchor = { barIndex: 5, price: 100 }; // -> (672, 400)
const B: Anchor = { barIndex: 20, price: 120 }; // -> (852, 200)
const C: Anchor = { barIndex: 35, price: 90 }; // -> (1032, 500)

describe('buildPreviewGeometry — the rubber band exists', () => {
  it('runs a segment from the placed anchor to the cursor', () => {
    const geometry = buildPreviewGeometry('trendline', [A], B, price, time, PLOT);

    expect(geometry.segments).toHaveLength(1);
    expect(geometry.segments[0].from).toEqual({ x: 672, y: 400 });
    expect(geometry.segments[0].to).toEqual({ x: 852, y: 200 });
  });

  it('moves when the cursor moves', () => {
    // The assertion that would have caught the shipped bug: before the fix every cursor
    // position produced the same (empty) geometry and the same painted pixels.
    const first = buildPreviewGeometry('trendline', [A], B, price, time, PLOT);
    const second = buildPreviewGeometry('trendline', [A], C, price, time, PLOT);

    expect(first.segments[0].to).toEqual({ x: 852, y: 200 });
    expect(second.segments[0].to).toEqual({ x: 1032, y: 500 });
    expect(first.segments[0].to).not.toEqual(second.segments[0].to);
    // …and the pinned end does not move with it.
    expect(second.segments[0].from).toEqual(first.segments[0].from);
  });

  it('marks the cursor even when nothing has been clicked yet', () => {
    const geometry = buildPreviewGeometry('trendline', [], B, price, time, PLOT);

    expect(geometry.points).toEqual([{ x: 852, y: 200 }]);
  });

  it('tracks the cursor with zero anchors placed', () => {
    const armed = buildPreviewGeometry('rectangle', [], B, price, time, PLOT);
    const moved = buildPreviewGeometry('rectangle', [], C, price, time, PLOT);

    expect(armed.points[0]).not.toEqual(moved.points[0]);
  });

  it('lists placed anchors first and the cursor last, with no padding copies', () => {
    // The renderer's contract: last point is floating, the rest are pinned. A pitchfork
    // needs three anchors but only two are known here — padding must not leak into
    // `points`, or the cursor grows a pinned-looking handle on top of itself.
    const geometry = buildPreviewGeometry('pitchfork', [A], B, price, time, PLOT);

    expect(geometry.points).toEqual([
      { x: 672, y: 400 },
      { x: 852, y: 200 },
    ]);
  });

  it('carries the preview id, which no store drawing can hold', () => {
    expect(buildPreviewGeometry('ray', [A], B, price, time, PLOT).id).toBe(PREVIEW_ID);
  });
});

describe('buildPreviewGeometry — never mistakable for a real drawing', () => {
  it.each(DRAWING_KINDS)('%s previews as incomplete', (kind) => {
    const needed = TOOL_DEFINITIONS[kind].anchorCount;
    for (let placed = 0; placed < needed; placed++) {
      const anchors = Array.from({ length: placed }, (_, i) => ({
        barIndex: 5 + i * 7,
        price: 100 + i * 4,
      }));
      expect(buildPreviewGeometry(kind, anchors, B, price, time, PLOT).complete).toBe(false);
    }
  });

  it('is incomplete even when every anchor the tool needs is already placed', () => {
    // Belt and braces: the flag is what keeps the preview out of hit-testing and undo, so
    // it must not depend on how many anchors happen to be in hand.
    expect(buildPreviewGeometry('trendline', [A, B], C, price, time, PLOT).complete).toBe(false);
  });
});

describe('buildPreviewGeometry — reuses the real per-kind maths', () => {
  it('extends a ray preview to the plot edge', () => {
    // (672,400) heading (180,-200): the top edge is reached at t=2, before the right edge
    // at t≈2.93. A duplicated switch would almost certainly have stopped at the cursor.
    const geometry = buildPreviewGeometry('ray', [A], B, price, time, PLOT);

    expect(geometry.segments[0].from).toEqual({ x: 672, y: 400 });
    expect(geometry.segments[0].to).toEqual({ x: 1032, y: 0 });
  });

  it('spans the plot for a horizontal line the moment the tool is armed', () => {
    const geometry = buildPreviewGeometry('horizontal-line', [], B, price, time, PLOT);

    expect(geometry.segments).toEqual([{ from: { x: 0, y: 200 }, to: { x: 1200, y: 200 } }]);
  });

  it('computes fib preview levels in PRICE space', () => {
    const geometry = buildPreviewGeometry('fib-retracement', [A], B, price, time, PLOT);

    expect(geometry.levels).toHaveLength(FIB_RETRACEMENT_LEVELS.length);
    geometry.levels.forEach((level, i) => {
      expect(level.price).toBeCloseTo(100 + 20 * FIB_RETRACEMENT_LEVELS[i], 9);
      expect(level.y).toBeCloseTo(price.y(level.price), 9);
    });
  });

  it('spaces fib preview levels non-uniformly in pixels on a log scale', () => {
    // Equal price steps are not equal pixel steps on a log axis. If the preview
    // interpolated pixels these gaps would all be identical.
    const geometry = buildPreviewGeometry(
      'fib-retracement',
      [{ barIndex: 5, price: 60 }],
      { barIndex: 25, price: 240 },
      logPrice,
      time,
      PLOT,
    );
    const gaps: number[] = [];
    for (let i = 1; i < geometry.levels.length; i++) {
      gaps.push(Math.abs(geometry.levels[i].y - geometry.levels[i - 1].y));
    }
    expect(gaps.some((g) => Math.abs(g - gaps[0]) > 1)).toBe(true);
  });

  it('gives a rectangle preview a box, normalised whichever way it is dragged', () => {
    const geometry = buildPreviewGeometry('rectangle', [B], A, price, time, PLOT);

    expect(geometry.box).toEqual({ x0: 672, y0: 200, x1: 852, y1: 400 });
  });

  it('previews a three-anchor pitchfork from one placed anchor without throwing', () => {
    const geometry = buildPreviewGeometry('pitchfork', [A], B, price, time, PLOT);

    // Degenerate but valid: median plus both parallels, every coordinate finite.
    expect(geometry.segments).toHaveLength(3);
    for (const segment of geometry.segments) {
      expect(Number.isFinite(segment.from.x)).toBe(true);
      expect(Number.isFinite(segment.to.y)).toBe(true);
    }
  });

  it('previews an Elliott impulse mid-count', () => {
    const geometry = buildPreviewGeometry('elliott-impulse', [A, B], C, price, time, PLOT);

    // Five anchors' worth of points, so four segments; the first two are the real legs.
    expect(geometry.segments).toHaveLength(4);
    expect(geometry.segments[0]).toEqual({ from: { x: 672, y: 400 }, to: { x: 852, y: 200 } });
    expect(geometry.segments[1]).toEqual({ from: { x: 852, y: 200 }, to: { x: 1032, y: 500 } });
    expect(geometry.points).toHaveLength(3);
  });

  it.each(DRAWING_KINDS)('%s previews with something to paint from one anchor', (kind) => {
    const geometry = buildPreviewGeometry(kind, [A], B, price, time, PLOT);
    const painted =
      geometry.segments.length + geometry.levels.length + geometry.labels.length > 0 ||
      geometry.box !== null;

    // The whole point of the feature: unlike `empty()`, a preview always has ink.
    expect(painted).toBe(true);
    expect(geometry.points.length).toBeGreaterThan(0);
  });
});

describe('constrainToAngle', () => {
  const origin: Point = { x: 100, y: 100 };
  const diagonal = 100 * Math.SQRT1_2;

  const CASES: readonly (readonly [string, Point, Point])[] = [
    ['east', { x: 240, y: 118 }, { x: 200, y: 100 }],
    ['south-east', { x: 190, y: 210 }, { x: 100 + diagonal, y: 100 + diagonal }],
    ['south', { x: 118, y: 240 }, { x: 100, y: 200 }],
    ['south-west', { x: 10, y: 190 }, { x: 100 - diagonal, y: 100 + diagonal }],
    ['west', { x: -40, y: 112 }, { x: 0, y: 100 }],
    ['north-west', { x: 10, y: 10 }, { x: 100 - diagonal, y: 100 - diagonal }],
    ['north', { x: 112, y: -40 }, { x: 100, y: 0 }],
    ['north-east', { x: 210, y: 10 }, { x: 100 + diagonal, y: 100 - diagonal }],
  ];

  it.each(CASES)('snaps an off-axis drag to %s', (_name, to, expected) => {
    const snapped = constrainToAngle(origin, to);
    const length = Math.hypot(to.x - origin.x, to.y - origin.y);

    expect(snapped.x).toBeCloseTo(origin.x + (expected.x - origin.x) * (length / 100), 9);
    expect(snapped.y).toBeCloseTo(origin.y + (expected.y - origin.y) * (length / 100), 9);
  });

  it('is stable on a vector that is already axis-aligned', () => {
    expect(constrainToAngle(origin, { x: 100, y: 180 })).toEqual({ x: 100, y: 180 });
    expect(constrainToAngle(origin, { x: 40, y: 100 })).toEqual({ x: 40, y: 100 });
  });

  it('is stable on a vector that is already diagonal', () => {
    const snapped = constrainToAngle(origin, { x: 150, y: 50 });
    expect(snapped.x).toBeCloseTo(150, 9);
    expect(snapped.y).toBeCloseTo(50, 9);
  });

  it('produces equal pixel runs on a diagonal — the definition of 45°', () => {
    const snapped = constrainToAngle(origin, { x: 260, y: 220 });
    expect(Math.abs(snapped.x - origin.x)).toBeCloseTo(Math.abs(snapped.y - origin.y), 9);
  });

  it('preserves the drag length rather than projecting onto the axis', () => {
    const to = { x: 240, y: 118 };
    const snapped = constrainToAngle(origin, to);
    expect(Math.hypot(snapped.x - origin.x, snapped.y - origin.y)).toBeCloseTo(
      Math.hypot(to.x - origin.x, to.y - origin.y),
      9,
    );
  });

  it('leaves a zero-length vector alone instead of returning NaN', () => {
    expect(constrainToAngle(origin, origin)).toEqual(origin);
  });

  it('snaps in pixel space, so the same anchors constrain differently at two zooms', () => {
    // An angle is what the user sees. Constraining the data-space vector instead would make
    // "45°" mean a different picture at every bar spacing.
    const wide: TimeProjector = { x: (i) => i * 40, indexAt: (x) => x / 40 };
    const tight: TimeProjector = { x: (i) => i * 4, indexAt: (x) => x / 4 };
    const from = projectAnchor(A, price, wide);
    const to = projectAnchor(B, price, wide);
    const snappedWide = constrainToAngle(from, to);
    const snappedTight = constrainToAngle(
      projectAnchor(A, price, tight),
      projectAnchor(B, price, tight),
    );

    // 600px right, 200px up at 40px/bar: nearest 45° is due east, so y is pinned.
    expect(snappedWide.y).toBeCloseTo(from.y, 9);
    expect(snappedWide.x).toBeGreaterThan(from.x);
    // The very same anchors at 4px/bar are 60px right, 200px up: nearest 45° is due north,
    // so x is pinned instead. Data-space snapping could not tell these two apart.
    expect(snappedTight.x).toBeCloseTo(projectAnchor(A, price, tight).x, 9);
    expect(snappedTight.y).toBeLessThan(projectAnchor(A, price, tight).y);
  });
});
