import { describe, expect, it } from 'vitest';
import { buildFrameInput, type FrameInput } from '../../../src/renderer/frame.js';
import { drawGridLayer } from '../../../src/renderer/layers/gridLayer.js';
import { rectBottom, rectRight } from '../../../src/renderer/layout.js';
import { FakeContext } from './fakeCanvas.js';
import { makeBars, makeSnapshot, TEST_THEME, testLayout } from './fixtures.js';

function frame(barSpacing = 8, volumeFraction = 0.22): FrameInput {
  return buildFrameInput({
    snapshot: makeSnapshot({ bars: makeBars(500), barSpacing }),
    layout: testLayout(800, 600, volumeFraction),
    theme: TEST_THEME,
    pricePrecision: 2,
    overlays: [],
    pointer: null,
    priceRange: null,
  });
}

function draw(f: FrameInput): FakeContext {
  const ctx = new FakeContext();
  drawGridLayer(ctx.asContext(), f);
  return ctx;
}

describe('grid layer', () => {
  it('clears and repaints the background every frame (SKILL rule 2)', () => {
    const ctx = draw(frame());
    expect(ctx.calls[0].op).toBe('clearRect');
    expect(ctx.calls[0].args).toEqual([0, 0, 800, 600]);
    expect(ctx.calls[1].op).toBe('fillRect');
    expect(ctx.calls[1].args).toEqual([0, 0, 800, 600]);
    expect(ctx.calls[1].fillStyle).toBe(TEST_THEME.background);
  });

  it('clips gridlines to the content rect and restores the stack', () => {
    const f = frame();
    const ctx = draw(f);
    const clipRect = ctx.ops('rect')[0];
    expect(clipRect.args).toEqual([
      f.layout.content.left,
      f.layout.content.top,
      f.layout.content.width,
      f.layout.content.height,
    ]);
    expect(ctx.ops('clip')).toHaveLength(1);
    expect(ctx.depth).toBe(0);
  });

  it('puts every 1px rule on a half pixel (§7)', () => {
    const ctx = draw(frame());
    for (const call of [...ctx.ops('moveTo'), ...ctx.ops('lineTo')]) {
      const [x, y] = call.args;
      const onHalfX = Math.abs(Math.abs(x % 1) - 0.5) < 1e-9;
      const onHalfY = Math.abs(Math.abs(y % 1) - 0.5) < 1e-9;
      // Exactly one axis is offset: horizontal rules snap y, vertical rules snap x.
      expect(onHalfX !== onHalfY).toBe(true);
      expect(Number.isInteger(onHalfX ? y : x)).toBe(true);
    }
  });

  it('keeps horizontal gridlines inside the plot and verticals inside the content', () => {
    const f = frame();
    const ctx = draw(f);
    for (const call of [...ctx.ops('moveTo'), ...ctx.ops('lineTo')]) {
      const [x, y] = call.args;
      expect(x).toBeGreaterThanOrEqual(f.layout.content.left);
      expect(x).toBeLessThanOrEqual(rectRight(f.layout.viewport));
      expect(y).toBeGreaterThanOrEqual(f.layout.viewport.top);
      expect(y).toBeLessThanOrEqual(rectBottom(f.layout.viewport));
    }
  });

  it('draws price labels inside the price gutter only', () => {
    const f = frame();
    const ctx = draw(f);
    const gutter = f.layout.priceGutter;
    const priceLabels = ctx.ops('fillText').filter((c) => c.args[0] >= gutter.left);
    expect(priceLabels.length).toBeGreaterThan(2);
    for (const label of priceLabels) {
      expect(label.args[0]).toBeGreaterThanOrEqual(gutter.left);
      expect(label.args[0]).toBeLessThan(rectRight(gutter));
      expect(label.args[1]).toBeGreaterThanOrEqual(f.layout.plot.top);
      expect(label.args[1]).toBeLessThanOrEqual(rectBottom(f.layout.plot));
      expect(Number.isInteger(label.args[1])).toBe(true);
      expect(Number.isFinite(Number(label.text))).toBe(true);
    }
  });

  it('draws time labels inside the time gutter only', () => {
    const f = frame();
    const ctx = draw(f);
    const gutter = f.layout.timeGutter;
    const timeLabels = ctx.ops('fillText').filter((c) => c.args[1] > gutter.top);
    expect(timeLabels.length).toBeGreaterThan(0);
    for (const label of timeLabels) {
      expect(label.args[1]).toBeGreaterThan(gutter.top);
      expect(label.args[1]).toBeLessThanOrEqual(rectBottom(gutter));
      expect(label.args[0]).toBeGreaterThanOrEqual(gutter.left);
      expect(label.args[0]).toBeLessThanOrEqual(rectRight(gutter));
    }
  });

  it('separates the volume pane with a rule when the pane exists', () => {
    const withVolume = frame(8, 0.22);
    const pane = withVolume.layout.volume;
    expect(pane).not.toBeNull();
    if (pane === null) return;
    const ctx = draw(withVolume);
    const separators = ctx
      .ops('moveTo')
      .filter((c) => Math.abs(c.args[1] - (Math.round(pane.top) + 0.5)) < 1e-9);
    expect(separators.length).toBeGreaterThan(0);
  });

  it('survives a viewport with no room for the plot', () => {
    const f = buildFrameInput({
      snapshot: makeSnapshot({ bars: makeBars(50) }),
      layout: testLayout(64, 24),
      theme: TEST_THEME,
      pricePrecision: 2,
      overlays: [],
      pointer: null,
      priceRange: null,
    });
    expect(() => draw(f)).not.toThrow();
  });

  it('labels percent mode with signed percentages', () => {
    const f = buildFrameInput({
      snapshot: makeSnapshot({ bars: makeBars(200), priceScaleMode: 'percent' }),
      layout: testLayout(),
      theme: TEST_THEME,
      pricePrecision: 2,
      overlays: [],
      pointer: null,
      priceRange: null,
    });
    const ctx = draw(f);
    const gutterLabels = ctx.ops('fillText').filter((c) => c.args[0] >= f.layout.priceGutter.left);
    expect(gutterLabels.length).toBeGreaterThan(0);
    for (const label of gutterLabels) {
      expect(label.text.endsWith('%')).toBe(true);
      expect(/^[+-]/.test(label.text)).toBe(true);
    }
  });
});
