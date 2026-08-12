/**
 * Where a level label lands.
 *
 * `drawDrawings` used to write every level label at `plot.left + 6` no matter where the
 * drawing was, so a fib placed on the right of the chart labelled itself over on the far
 * left, on top of the legend and pointing at nothing. The label belongs at the level's own
 * left edge — clamped, because that edge can be off-screen in either direction and the
 * layer clips to the plot, so an unclamped label is silently truncated instead.
 *
 * Asserted here rather than in the Playwright suite because the placement is arithmetic:
 * `FakeContext` records the exact x passed to `fillText`, where a screenshot could only
 * say "some ink is roughly over there".
 */

import { describe, expect, it } from 'vitest';
import { asPixel } from '../../../src/data/types.js';
import type { DrawingGeometry } from '../../../src/drawings/geometry.js';
import { drawDrawings } from '../../../src/renderer/layers/annotationsLayer.js';
import type { Rect } from '../../../src/renderer/layout.js';
import { FakeContext, FAKE_CHAR_WIDTH } from './fakeCanvas.js';
import { TEST_THEME } from './fixtures.js';

const PLOT: Rect = {
  left: asPixel(60),
  top: asPixel(0),
  width: asPixel(800),
  height: asPixel(400),
};
const LABEL = '0.618 (101.00)';

/** A two-level drawing whose levels run from `x0` to `x1`. */
function fib(x0: number, x1: number): DrawingGeometry {
  const levels = [
    { price: 101, y: 100, label: LABEL, x: x0 },
    { price: 102, y: 200, label: LABEL, x: x0 },
  ];
  return {
    id: 'd1',
    kind: 'fib-retracement',
    style: {
      colorToken: 'drawing.primary',
      lineWidth: 1,
      dash: [],
      opacity: 1,
      showLabels: true,
    },
    complete: true,
    segments: levels.map((l) => ({ from: { x: x0, y: l.y }, to: { x: x1, y: l.y } })),
    levels,
    points: [
      { x: x0, y: 100 },
      { x: x1, y: 200 },
    ],
    labels: [],
    box: null,
  };
}

function labelXs(geometry: DrawingGeometry): number[] {
  const ctx = new FakeContext();
  drawDrawings(ctx.asContext(), [geometry], PLOT, TEST_THEME, null);
  return ctx
    .ops('fillText')
    .filter((call) => call.text === LABEL)
    .map((call) => call.args[0]);
}

const right = PLOT.left + PLOT.width;
const labelWidth = LABEL.length * FAKE_CHAR_WIDTH;

describe('level labels', () => {
  it('sits at the level’s own left edge, not the plot’s', () => {
    const xs = labelXs(fib(500, 700));
    expect(xs).toHaveLength(2);
    for (const x of xs) expect(x).toBe(506);
  });

  it('is not pinned to the plot edge — moving the drawing moves the label', () => {
    // The whole bug in one assertion: before the fix both of these were `plot.left + 6`.
    expect(labelXs(fib(200, 400))[0]).not.toBe(labelXs(fib(500, 700))[0]);
  });

  it('clamps to the plot when the level starts off the left edge', () => {
    // A drawing anchored hundreds of bars before the visible window projects to a large
    // negative x. Unclamped the label is drawn off-canvas and simply disappears.
    for (const x of labelXs(fib(-4000, 300))) expect(x).toBe(PLOT.left + 6);
  });

  it('keeps the whole label inside the plot when the level starts near the right edge', () => {
    // The layer clips to the plot, so an unclamped label here is cut off mid-word.
    for (const x of labelXs(fib(right - 20, right))) {
      expect(x + labelWidth).toBeLessThanOrEqual(right);
      expect(x).toBeGreaterThanOrEqual(PLOT.left);
    }
  });

  it('draws no labels at all when the style turns them off', () => {
    const geometry = fib(500, 700);
    const off: DrawingGeometry = {
      ...geometry,
      style: { ...geometry.style, showLabels: false },
    };
    expect(labelXs(off)).toHaveLength(0);
  });
});
