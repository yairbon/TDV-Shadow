import { describe, expect, it } from 'vitest';
import { asBarIndex, asPrice } from '../../../src/data/types.js';
import { buildFrameInput, type FrameInput } from '../../../src/renderer/frame.js';
import {
  drawOverlayLayer,
  overlayPriceExtent,
  type LineOverlay,
  type Overlay,
  type PriceLineOverlay,
} from '../../../src/renderer/layers/overlayLayer.js';
import { rectBottom, rectRight } from '../../../src/renderer/layout.js';
import { FakeContext } from './fakeCanvas.js';
import { makeBars, makeSnapshot, TEST_THEME, testLayout } from './fixtures.js';

const bars = makeBars(300);

/** A simple moving average, with the warm-up window left as nulls. */
function sma(period: number): LineOverlay {
  const values: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= period) sum -= bars[i - period].c;
    values.push(i >= period - 1 ? sum / period : null);
  }
  return { kind: 'line', color: '#ma', lineWidth: 1, values };
}

const priceLine: PriceLineOverlay = {
  kind: 'priceLine',
  color: '#alert',
  lineWidth: 1,
  price: asPrice(101),
  dash: [2, 2],
  label: '101.00',
};

function frame(overlays: readonly Overlay[]): FrameInput {
  return buildFrameInput({
    snapshot: makeSnapshot({ bars, barSpacing: 6 }),
    layout: testLayout(),
    theme: TEST_THEME,
    pricePrecision: 2,
    overlays,
    pointer: null,
    priceRange: null,
  });
}

function draw(f: FrameInput): FakeContext {
  const ctx = new FakeContext();
  drawOverlayLayer(ctx.asContext(), f);
  return ctx;
}

describe('overlay layer', () => {
  it('clears and returns when there is nothing to draw', () => {
    const ctx = draw(frame([]));
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].op).toBe('clearRect');
  });

  it('clips to the plot rect and balances the stack', () => {
    const f = frame([sma(20)]);
    const ctx = draw(f);
    expect(ctx.ops('rect')[0].args).toEqual([
      f.layout.plot.left,
      f.layout.plot.top,
      f.layout.plot.width,
      f.layout.plot.height,
    ]);
    expect(ctx.ops('clip')).toHaveLength(1);
    expect(ctx.depth).toBe(0);
  });

  it('breaks the polyline at gaps instead of bridging them', () => {
    const overlay = sma(20);
    const f = frame([overlay]);
    const ctx = draw(f);
    const moves = ctx.ops('moveTo');
    const lines = ctx.ops('lineTo');
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeGreaterThan(10);
    // Every visible point is either a move or a line, never dropped.
    const visible = Array.from(
      { length: f.visible.count },
      (_unused, i) => overlay.values[f.visible.from + i],
    ).filter((v) => v !== null);
    expect(moves.length + lines.length).toBe(visible.length);
  });

  it('snaps line x to bar centres and keeps y sub-pixel for smooth slopes', () => {
    const f = frame([sma(5)]);
    const ctx = draw(f);
    const centres = new Set<number>();
    for (let i: number = f.visible.from; i <= f.visible.to; i++) {
      centres.add(Math.round(f.timeScale.x(asBarIndex(i))) + 0.5);
    }
    for (const call of [...ctx.ops('moveTo'), ...ctx.ops('lineTo')]) {
      expect(centres.has(call.args[0])).toBe(true);
    }
    const ys = [...ctx.ops('lineTo')].map((c) => c.args[1]);
    expect(ys.some((y) => !Number.isInteger(y))).toBe(true);
  });

  it('draws a dashed price line across the plot and resets the dash', () => {
    const f = frame([priceLine]);
    const ctx = draw(f);
    const dashes = ctx.ops('setLineDash');
    expect(dashes.some((d) => d.args.length === 2)).toBe(true);
    expect(dashes[dashes.length - 1].args).toHaveLength(0);
    const move = ctx.ops('moveTo')[0];
    const line = ctx.ops('lineTo')[0];
    expect(move.args[0]).toBe(f.layout.plot.left);
    expect(line.args[0]).toBe(rectRight(f.layout.plot));
    expect(move.args[1]).toBe(line.args[1]);
    expect(Math.abs(move.args[1] % 1)).toBeCloseTo(0.5, 12); // 1px stroke
  });

  it('tags the price line in the gutter, outside the clip', () => {
    const f = frame([priceLine]);
    const ctx = draw(f);
    const tag = ctx.ops('fillText')[0];
    expect(tag.text).toBe('101.00');
    expect(tag.args[0]).toBeGreaterThanOrEqual(f.layout.priceGutter.left);
    const box = ctx.ops('fillRect')[0];
    expect(box.args[0]).toBe(f.layout.priceGutter.left);
    expect(box.args[0] + box.args[2]).toBeLessThanOrEqual(rectRight(f.layout.viewport));
    expect(box.args[1] + box.args[3]).toBeLessThanOrEqual(rectBottom(f.layout.viewport));
  });

  it('skips a price line that the log scale cannot represent', () => {
    const f = buildFrameInput({
      snapshot: makeSnapshot({ bars, barSpacing: 6, priceScaleMode: 'log' }),
      layout: testLayout(),
      theme: TEST_THEME,
      pricePrecision: 2,
      overlays: [{ ...priceLine, price: asPrice(-5) }],
      pointer: null,
      priceRange: null,
    });
    const ctx = draw(f);
    expect(ctx.ops('moveTo')).toHaveLength(0);
    expect(ctx.ops('fillText')).toHaveLength(0);
  });
});

describe('overlay extents feed autoscale (§4)', () => {
  it('covers the visible values of a line overlay', () => {
    const overlay = sma(20);
    const extent = overlayPriceExtent([overlay], asBarIndex(100), asBarIndex(150));
    expect(extent).not.toBeNull();
    if (extent === null) return;
    for (let i = 100; i <= 150; i++) {
      const v = overlay.values[i];
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(extent.min);
      expect(v).toBeLessThanOrEqual(extent.max);
    }
  });

  it('includes price lines and ignores the invisible slice', () => {
    const extent = overlayPriceExtent([priceLine], asBarIndex(0), asBarIndex(10));
    expect(extent?.min).toBe(101);
    expect(extent?.max).toBe(101);
  });

  it('returns null when nothing is visible', () => {
    expect(overlayPriceExtent([], asBarIndex(0), asBarIndex(10))).toBeNull();
    expect(overlayPriceExtent([sma(20)], asBarIndex(0), asBarIndex(2))).toBeNull();
  });

  it('widens the autoscaled range so the overlay stays on screen', () => {
    const spike: LineOverlay = {
      kind: 'line',
      color: '#spike',
      lineWidth: 1,
      values: bars.map(() => 500),
    };
    const withOverlay = frame([spike]);
    const without = frame([]);
    expect(withOverlay.priceScale.max).toBeGreaterThan(without.priceScale.max);
    expect(withOverlay.priceScale.max).toBeGreaterThanOrEqual(500);
  });
});
