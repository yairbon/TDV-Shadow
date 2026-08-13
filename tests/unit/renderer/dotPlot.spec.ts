/**
 * A `dots` plot is dots, and a stroked path is not an acceptable substitute for it.
 *
 * The parabolic SAR jumps from above price to below it on every reversal. Stroked as a
 * path, that jump is drawn as a near-vertical line across the candles — a line the
 * indicator does not have and which reads as a signal. Before `dots` was handled,
 * `drawIndicatorOverlay` stroked anything that was not a histogram, so PSAR shipped as a
 * connected zig-zag.
 *
 * Asserted here rather than in a screenshot because the distinction is in which primitive
 * is called: `FakeContext` sees `arc` against `lineTo`, where a screenshot at 1px line
 * widths would struggle to tell a dense run of dots from a line through them.
 */

import { describe, expect, it } from 'vitest';
import { asPixel } from '../../../src/data/types.js';
import {
  drawIndicatorOverlay,
  type OverlayInput,
  type PlotScale,
} from '../../../src/renderer/layers/annotationsLayer.js';
import type { Rect } from '../../../src/renderer/layout.js';
import type { IndicatorResult, PlotSpec } from '../../../src/indicators/types.js';
import { FakeContext } from './fakeCanvas.js';
import { TEST_THEME } from './fixtures.js';

const PLOT: Rect = {
  left: asPixel(0),
  top: asPixel(0),
  width: asPixel(400),
  height: asPixel(200),
};

const BAR_SPACING = 8;

const INPUT: OverlayInput = {
  plot: PLOT,
  theme: TEST_THEME,
  from: 0,
  to: 9,
  x: (i) => i * BAR_SPACING + 4,
  x0: 4,
  dx: BAR_SPACING,
};

const SCALE: PlotScale = { y: (value) => 200 - value };

/** SAR-shaped data: above price, then a reversal to below it. */
const VALUES = Float64Array.from([120, 122, 124, 126, 60, 62, 64, 66, Number.NaN, 70]);

function result(style: PlotSpec['style']): IndicatorResult {
  return {
    id: 'psar',
    placement: 'overlay',
    plots: [{ key: 'psar', label: 'PSAR', style, colorToken: 'overlayLine' }],
    values: { psar: VALUES },
    scaleBounds: null,
    guides: [],
    warmup: 0,
  };
}

function draw(style: PlotSpec['style']): FakeContext {
  const ctx = new FakeContext();
  drawIndicatorOverlay(ctx.asContext(), result(style), INPUT, SCALE);
  return ctx;
}

describe('a dots plot', () => {
  it('marks each bar instead of connecting them', () => {
    const ctx = draw('dots');
    // Nine values, one NaN: nine dots and no path between them.
    expect(ctx.ops('arc')).toHaveLength(9);
    expect(ctx.ops('lineTo')).toHaveLength(0);
    expect(ctx.ops('moveTo')).toHaveLength(0);
  });

  it('skips the gaps rather than dotting them at zero', () => {
    const ctx = draw('dots');
    const xs = ctx.ops('arc').map((call) => call.args[0]);
    // Integer centres: a filled disc is snapped as a fill, not offset like a 1px stroke.
    for (const x of xs) expect(Number.isInteger(x)).toBe(true);
    // Index 8 is NaN, so its column carries no dot while its neighbours do.
    expect(xs).not.toContain(8 * BAR_SPACING + 4);
    expect(xs).toContain(7 * BAR_SPACING + 4);
    expect(xs).toContain(9 * BAR_SPACING + 4);
  });

  it('puts each dot on the value its own scale projects', () => {
    const ctx = draw('dots');
    for (const call of ctx.ops('arc')) {
      const index = Math.round((call.args[0] - INPUT.x0) / INPUT.dx);
      expect(call.args[1]).toBeCloseTo(Math.round(SCALE.y(VALUES[index])), 0);
      // A radius, not a degenerate point.
      expect(call.args[2]).toBeGreaterThan(0);
    }
  });

  it('is a different picture from the same data stroked as a line', () => {
    // The pin that matters: if this ever passes with the two identical, `dots` has stopped
    // being handled and PSAR is a zig-zag again.
    const dots = draw('dots');
    const line = draw('line');
    expect(line.ops('arc')).toHaveLength(0);
    expect(line.ops('lineTo').length).toBeGreaterThan(0);
    expect(dots.ops('arc').length).toBeGreaterThan(0);
  });
});
