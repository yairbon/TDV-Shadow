/**
 * An indicator drawn in another indicator's pane.
 *
 * A moving average of an RSI is in the RSI's units. Drawn over the price plot it sits
 * hundreds of points below the visible range and is clipped away entirely — which is how
 * it first worked, values correct and nothing on screen. It belongs in the RSI's pane, on
 * the RSI's scale, in a colour that is not the RSI's.
 */

import { describe, expect, it } from 'vitest';
import { asPixel } from '../../../src/data/types.js';
import {
  drawIndicatorPane,
  resolveToken,
  type OverlayInput,
  type PaneCompanion,
} from '../../../src/renderer/layers/annotationsLayer.js';
import type { Rect } from '../../../src/renderer/layout.js';
import { snapLine } from '../../../src/renderer/pixel.js';
import type { IndicatorResult } from '../../../src/indicators/types.js';
import { FakeContext } from './fakeCanvas.js';
import { TEST_THEME } from './fixtures.js';

const PANE: Rect = {
  left: asPixel(0),
  top: asPixel(100),
  width: asPixel(400),
  height: asPixel(100),
};

const INPUT: OverlayInput = {
  plot: PANE,
  theme: TEST_THEME,
  from: 0,
  to: 9,
  x: (i) => i * 8 + 4,
  x0: 4,
  dx: 8,
};

/** A pane indicator with no declared bounds, so its pane autoscales. */
function series(id: string, key: string, values: number[], bounds: [number, number] | null = null): IndicatorResult {
  return {
    id: id as IndicatorResult['id'],
    placement: 'pane',
    plots: [{ key, label: key, style: 'line', colorToken: 'overlayLine' }],
    values: { [key]: Float64Array.from(values) },
    scaleBounds: bounds,
    guides: [],
    warmup: 0,
  };
}

const HOST = series('rsi', 'rsi', [10, 90, 20, 80, 30, 70, 40, 60, 45, 55]);
const COMPANION: PaneCompanion = {
  result: series('sma', 'sma', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]),
  styles: {},
};

function draw(companions: readonly PaneCompanion[], host = HOST): FakeContext {
  const ctx = new FakeContext();
  drawIndicatorPane(ctx.asContext(), host, INPUT, PANE, 6, {}, companions);
  return ctx;
}

/** Y coordinates of every stroked point, in draw order. */
const strokeYs = (ctx: FakeContext): number[] =>
  [...ctx.ops('moveTo'), ...ctx.ops('lineTo')].map((call) => call.args[1]);

describe('a companion in a shared pane', () => {
  it('is drawn, not silently dropped', () => {
    const alone = draw([]).ops('lineTo').length;
    const shared = draw([COMPANION]).ops('lineTo').length;
    expect(shared).toBeGreaterThan(alone);
  });

  it('sits on the host’s scale, inside the host’s rect', () => {
    // The whole point. A companion given its own scale would be drawn at a height that
    // has nothing to do with the line it describes.
    const ys = strokeYs(draw([COMPANION]));
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(PANE.top - 1);
      expect(y).toBeLessThanOrEqual(PANE.top + PANE.height + 1);
    }
  });

  it('lands where the host’s scale puts its value', () => {
    // The companion is flat at 50; the host spans 10..90 with §4's 10% padding, so 50 is
    // the midpoint of the padded range and the flat line runs down the pane's middle.
    const companionYs = draw([COMPANION])
      .ops('lineTo')
      .slice(-9)
      .map((call) => call.args[1]);
    // snapLine's half pixel (§7): a 1px stroke sits ON a pixel, not straddling two.
    for (const y of companionYs) expect(y).toBe(snapLine(PANE.top + PANE.height / 2));
  });

  it('widens the autoscale when it runs outside the host’s range', () => {
    // A companion off the top of the host's range must not be clipped: the pane belongs to
    // everything in it, not to whichever indicator was added first.
    const high: PaneCompanion = { result: series('sma', 'sma', Array.from({ length: 10 }, () => 200)), styles: {} };
    const ys = strokeYs(draw([high]));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(PANE.top - 1);
      expect(y).toBeLessThanOrEqual(PANE.top + PANE.height + 1);
    }
  });

  it('respects declared bounds rather than stretching them', () => {
    // An RSI's 0..100 is a statement about the indicator, not an observation about this
    // window, so a companion does not get to move it.
    const bounded = series('rsi', 'rsi', [10, 90, 20, 80, 30, 70, 40, 60, 45, 55], [0, 100]);
    const flat: PaneCompanion = { result: series('sma', 'sma', Array.from({ length: 10 }, () => 50)), styles: {} };
    const ys = draw([flat], bounded)
      .ops('lineTo')
      .slice(-9)
      .map((call) => call.args[1]);
    // 50 of 0..100 is exactly the pane's middle, snapped per §7.
    for (const y of ys) expect(y).toBe(snapLine(PANE.top + PANE.height / 2));
  });

  it('is a different colour from the line it was derived from', () => {
    // Both declare `overlayLine` — an SMA says the same thing whether it smooths an RSI or
    // a price — so without a shift the pane shows one colour drawn twice.
    const ctx = draw([COMPANION]);
    const colors = ctx.ops('stroke').map((call) => call.strokeStyle);
    const hostColor = resolveToken(TEST_THEME, 'overlayLine');
    expect(colors).toContain(hostColor);
    expect(colors.filter((c) => c === hostColor).length).toBeLessThan(colors.length);
  });

  it('leaves a companion that already differs alone', () => {
    const distinct: PaneCompanion = {
      result: {
        ...series('sma', 'sma', Array.from({ length: 10 }, () => 50)),
        plots: [{ key: 'sma', label: 'sma', style: 'line', colorToken: 'indicatorLineAlt' }],
      },
      styles: {},
    };
    const colors = draw([distinct]).ops('stroke').map((call) => call.strokeStyle);
    expect(colors).toContain(resolveToken(TEST_THEME, 'indicatorLineAlt'));
  });

  it('honours a user override on the companion, over any automatic shift', () => {
    const styled: PaneCompanion = {
      result: series('sma', 'sma', Array.from({ length: 10 }, () => 50)),
      styles: { sma: { color: '#ff00ff' } },
    };
    const colors = draw([styled]).ops('stroke').map((call) => call.strokeStyle);
    expect(colors).toContain('#ff00ff');
  });

  it('draws the host first, so a derived line sits on top of its source', () => {
    const ctx = draw([COMPANION]);
    const strokes = ctx.ops('stroke');
    expect(strokes.length).toBeGreaterThanOrEqual(2);
    expect(strokes[0].strokeStyle).toBe(resolveToken(TEST_THEME, 'overlayLine'));
  });

  it('behaves exactly as before when there is nothing to adopt', () => {
    // The default must be a no-op: every existing pane goes through this path.
    const withEmpty = draw([]);
    const ctx = new FakeContext();
    drawIndicatorPane(ctx.asContext(), HOST, INPUT, PANE, 6, {});
    expect(withEmpty.calls.map((c) => c.op)).toEqual(ctx.calls.map((c) => c.op));
    expect(withEmpty.depth).toBe(0);
  });
});
