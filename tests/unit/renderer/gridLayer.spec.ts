import { describe, expect, it } from 'vitest';
import { asPrice } from '../../../src/data/types.js';
import { buildFrameInput, type FrameInput } from '../../../src/renderer/frame.js';
import { drawGridLayer } from '../../../src/renderer/layers/gridLayer.js';
import { computeLayout, rectBottom, rectRight } from '../../../src/renderer/layout.js';
import { DARK_THEME } from '../../../src/renderer/theme.js';
import { FAKE_CHAR_WIDTH, FakeContext } from './fakeCanvas.js';
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

  describe('the left axis', () => {
    // The fixture series trades near 100; the second scale is put somewhere it cannot be
    // confused with it, so a label sourced from the wrong scale is unmistakable.
    const LEFT_MIN = 700;
    const LEFT_MAX = 780;

    function twoScales(): FrameInput {
      return buildFrameInput({
        snapshot: makeSnapshot({ bars: makeBars(200) }),
        layout: computeLayout({
          width: 800,
          height: 600,
          priceGutterWidth: DARK_THEME.density.priceGutterWidth,
          leftPriceGutterWidth: 64,
          timeGutterHeight: DARK_THEME.density.timeGutterHeight,
          volumePaneFraction: 0.22,
          paneGap: DARK_THEME.density.paneGap,
          minPlotHeight: DARK_THEME.density.minPlotHeight,
        }),
        theme: TEST_THEME,
        pricePrecision: 2,
        overlays: [],
        pointer: null,
        priceRange: null,
        leftPriceRange: { min: asPrice(LEFT_MIN), max: asPrice(LEFT_MAX) },
      });
    }

    const leftLabels = (ctx: FakeContext, f: FrameInput): string[] => {
      const gutter = f.layout.leftPriceGutter;
      if (gutter === null) return [];
      return ctx
        .ops('fillText')
        .filter((c) => c.args[0] <= rectRight(gutter))
        .map((c) => c.text);
    };

    it('reads in its own prices, not the primary scale’s', () => {
      const f = twoScales();
      const labels = leftLabels(draw(f), f);
      expect(labels.length).toBeGreaterThan(2);
      for (const text of labels) {
        const value = Number(text);
        expect(Number.isNaN(value)).toBe(false);
        expect(value).toBeGreaterThanOrEqual(LEFT_MIN);
        expect(value).toBeLessThanOrEqual(LEFT_MAX);
      }
    });

    it('places each label at the y its own scale projects that price to', () => {
      const f = twoScales();
      const scale = f.leftPriceScale;
      if (scale === null) throw new Error('expected a second scale');
      const placed = draw(f)
        .ops('fillText')
        .filter((c) => c.args[0] <= rectRight(f.layout.leftPriceGutter ?? f.layout.plot));
      expect(placed.length).toBeGreaterThan(2);
      for (const call of placed) {
        // Round trip: the number written and the row it was written on must agree, or the
        // axis is a decoration rather than a reading of the series beside it.
        expect(call.args[1]).toBeCloseTo(Math.round(scale.y(asPrice(Number(call.text)))), 0);
      }
    });

    it('right-aligns against the plot so the numbers sit beside their data', () => {
      const f = twoScales();
      const gutter = f.layout.leftPriceGutter;
      if (gutter === null) throw new Error('expected a left gutter');
      const ctx = draw(f);
      const aligns = ctx.ops('fillText').filter((c) => c.args[0] <= rectRight(gutter));
      for (const call of aligns) {
        expect(call.textAlign).toBe('right');
        // Right-aligned text grows leftwards from its x, so the x alone says nothing about
        // where the glyphs land: the whole label has to fit inside the gutter, and it has
        // to end against the plot edge rather than float in the middle of the gutter.
        const width = call.text.length * FAKE_CHAR_WIDTH;
        expect(call.args[0] - width).toBeGreaterThanOrEqual(gutter.left);
        expect(rectRight(gutter) - call.args[0]).toBeLessThanOrEqual(
          TEST_THEME.density.labelPaddingX + 1,
        );
      }
      // …and the right gutter keeps its own, opposite alignment.
      const right = ctx.ops('fillText').filter((c) => c.args[0] >= f.layout.priceGutter.left);
      expect(right.length).toBeGreaterThan(0);
      for (const call of right) expect(call.textAlign).toBe('left');
    });

    it('stays absolute when the primary is read as a percentage', () => {
      // Inheriting the primary's mode would relabel the second series as a percent of a
      // base it never had, and place it by a log of prices that are not on this axis.
      const f = buildFrameInput({
        snapshot: makeSnapshot({ bars: makeBars(200), priceScaleMode: 'percent' }),
        layout: computeLayout({
          width: 800,
          height: 600,
          priceGutterWidth: DARK_THEME.density.priceGutterWidth,
          leftPriceGutterWidth: 64,
          timeGutterHeight: DARK_THEME.density.timeGutterHeight,
          volumePaneFraction: 0.22,
          paneGap: DARK_THEME.density.paneGap,
          minPlotHeight: DARK_THEME.density.minPlotHeight,
        }),
        theme: TEST_THEME,
        pricePrecision: 2,
        overlays: [],
        pointer: null,
        priceRange: null,
        leftPriceRange: { min: asPrice(LEFT_MIN), max: asPrice(LEFT_MAX) },
      });
      expect(f.leftPriceScale?.mode).toBe('linear');
      const labels = leftLabels(draw(f), f);
      expect(labels.length).toBeGreaterThan(2);
      for (const text of labels) {
        expect(text).not.toContain('%');
        expect(Number(text)).toBeGreaterThanOrEqual(LEFT_MIN);
      }
      // The two ends of the domain land on the two ends of the plot, so a mode that
      // compressed one of them logarithmically would be caught here too.
      const scale = f.leftPriceScale;
      if (scale === null) throw new Error('expected a second scale');
      expect(scale.y(asPrice(LEFT_MAX))).toBeCloseTo(f.layout.plot.top, 6);
      expect(scale.y(asPrice((LEFT_MIN + LEFT_MAX) / 2))).toBeCloseTo(
        f.layout.plot.top + f.layout.plot.height / 2,
        6,
      );
    });

    it('draws no left axis at all when there is no second range', () => {
      const f = frame();
      expect(f.leftPriceScale).toBeNull();
      expect(f.layout.leftPriceGutter).toBeNull();
      const ctx = draw(f);
      const strays = ctx.ops('fillText').filter((c) => c.args[0] < f.layout.plot.left);
      expect(strays).toHaveLength(0);
    });
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
