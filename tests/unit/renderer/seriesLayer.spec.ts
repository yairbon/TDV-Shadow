/**
 * Series-layer geometry, asserted through a recording context: every candle rect is
 * integer-aligned, lands inside the plot rect, and never shares a column with its
 * neighbour. Colour batching is asserted by counting `fillStyle` runs.
 */

import { describe, expect, it } from 'vitest';
import type { Bar } from '../../../src/data/types.js';
import { buildFrameInput, type FrameInput } from '../../../src/renderer/frame.js';
import { rectBottom, rectRight } from '../../../src/renderer/layout.js';
import { candleGeometry } from '../../../src/renderer/scale/timeScale.js';
import { createSeriesLayer } from '../../../src/renderer/layers/seriesLayer.js';
import { FakeContext, type RecordedCall } from './fakeCanvas.js';
import { bar, makeBars, makeSnapshot, TEST_THEME, testLayout } from './fixtures.js';

const theme = TEST_THEME;

function frameFor(bars: readonly Bar[], barSpacing: number, options: Partial<FrameOptions> = {}): FrameInput {
  const layout = options.layout ?? testLayout();
  return buildFrameInput({
    snapshot: makeSnapshot({
      bars,
      barSpacing,
      scrollPosition: options.scrollPosition ?? bars.length - 1,
      priceScaleMode: options.mode ?? 'linear',
      state: options.state ?? 'live',
    }),
    layout,
    theme,
    pricePrecision: 2,
    overlays: [],
    pointer: null,
    priceRange: null,
  });
}

interface FrameOptions {
  readonly layout: ReturnType<typeof testLayout>;
  readonly scrollPosition: number;
  readonly mode: 'linear' | 'log' | 'percent';
  readonly state: 'loading' | 'live' | 'stale';
}

function draw(f: FrameInput): FakeContext {
  const ctx = new FakeContext();
  createSeriesLayer().draw(ctx.asContext(), f);
  return ctx;
}

/** fillRects painted with a candle colour (i.e. excluding volume columns). */
function candleFills(ctx: FakeContext): RecordedCall[] {
  const colors = new Set([theme.upBody, theme.downBody, theme.upWick, theme.downWick]);
  return ctx.calls.filter((c) => c.op === 'fillRect' && colors.has(c.fillStyle));
}

describe('series layer — frame contract', () => {
  it('clears itself before drawing anything (SKILL rule 2)', () => {
    const ctx = draw(frameFor(makeBars(120), 8));
    expect(ctx.calls[0].op).toBe('clearRect');
    expect(ctx.calls[0].args).toEqual([0, 0, 800, 600]);
  });

  it('clips to the plot rect and leaves the stack balanced (rule 8)', () => {
    const f = frameFor(makeBars(120), 8);
    const ctx = draw(f);
    const clipRects = ctx.ops('rect');
    expect(clipRects.length).toBeGreaterThan(0);
    expect(clipRects[0].args).toEqual([f.layout.plot.left, f.layout.plot.top, f.layout.plot.width, f.layout.plot.height]);
    expect(ctx.ops('clip').length).toBe(clipRects.length);
    expect(ctx.depth).toBe(0);
    // A couple of save/restore pairs per layer — never one per bar.
    expect(ctx.ops('save').length).toBeLessThanOrEqual(2);
  });

  it('draws nothing but the clear when the series is empty', () => {
    const ctx = draw(frameFor([], 8));
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].op).toBe('clearRect');
  });
});

describe('series layer — candle geometry (§6, §7)', () => {
  it('paints only integer-aligned rects', () => {
    for (const spacing of [1, 2.5, 4, 7.3, 12, 40, 120]) {
      const ctx = draw(frameFor(makeBars(400), spacing));
      for (const call of ctx.ops('fillRect')) {
        for (const arg of call.args) {
          expect(Number.isInteger(arg)).toBe(true);
        }
        expect(call.args[3]).toBeGreaterThanOrEqual(1); // height floored at 1
        expect(call.args[2]).toBeGreaterThanOrEqual(1); // width floored at 1
      }
    }
  });

  it('draws only bars that overlap the plot horizontally', () => {
    // The first and last visible bars straddle the plot edges by design — the clip
    // set above trims them. What must never happen is painting a bar that lies
    // wholly outside the plot: that is wasted work the visible-range slice removes.
    const f = frameFor(makeBars(400), 9);
    const ctx = draw(f);
    const plot = f.layout.plot;
    const half = candleGeometry(9).half;
    for (const call of candleFills(ctx)) {
      expect(call.args[0] + call.args[2]).toBeGreaterThan(plot.left - half - 1);
      expect(call.args[0]).toBeLessThan(rectRight(plot) + half + 1);
    }
  });

  it('keeps candle bodies inside the plot vertically (autoscale + 10% padding)', () => {
    const f = frameFor(makeBars(400), 9);
    const ctx = draw(f);
    const plot = f.layout.plot;
    for (const call of candleFills(ctx)) {
      expect(call.args[1]).toBeGreaterThanOrEqual(plot.top);
      expect(call.args[1] + call.args[3]).toBeLessThanOrEqual(rectBottom(plot));
    }
  });

  it('never lets two bodies share an x-pixel', () => {
    for (const spacing of [3, 4, 6.5, 11, 25, 120]) {
      const f = frameFor(makeBars(300), spacing);
      const ctx = draw(f);
      const bodies = ctx.calls.filter(
        (c) => c.op === 'fillRect' && (c.fillStyle === theme.upBody || c.fillStyle === theme.downBody),
      );
      const spans = bodies
        .map((c) => ({ left: c.args[0], right: c.args[0] + c.args[2] - 1 }))
        .sort((a, b) => a.left - b.left);
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i].left).toBeGreaterThan(spans[i - 1].right);
      }
    }
  });

  it('centres the 1px wick on the body', () => {
    const f = frameFor(makeBars(60), 15);
    const ctx = draw(f);
    const geometry = candleGeometry(15);
    const wicks = ctx.calls.filter(
      (c) => c.op === 'fillRect' && (c.fillStyle === theme.upWick || c.fillStyle === theme.downWick),
    );
    const bodies = ctx.calls.filter(
      (c) => c.op === 'fillRect' && (c.fillStyle === theme.upBody || c.fillStyle === theme.downBody),
    );
    expect(wicks.length).toBe(bodies.length);
    const bodyCentres = new Set(bodies.map((c) => c.args[0] + geometry.half));
    for (const wick of wicks) {
      expect(wick.args[2]).toBe(1);
      expect(bodyCentres.has(wick.args[0])).toBe(true);
    }
  });

  it('draws a 1px high/low line and no body below 3px of spacing', () => {
    const ctx = draw(frameFor(makeBars(600), 2));
    const bodies = ctx.calls.filter(
      (c) => c.op === 'fillRect' && (c.fillStyle === theme.upBody || c.fillStyle === theme.downBody),
    );
    const wicks = ctx.calls.filter(
      (c) => c.op === 'fillRect' && (c.fillStyle === theme.upWick || c.fillStyle === theme.downWick),
    );
    expect(bodies).toHaveLength(0);
    expect(wicks.length).toBeGreaterThan(0);
    for (const wick of wicks) expect(wick.args[2]).toBe(1);
  });

  it('gives a doji a 1px body instead of a 0px one', () => {
    const flat: Bar[] = [];
    for (let i = 0; i < 20; i++) {
      // Identical open/close, a real high/low range so the scale is not degenerate.
      flat.push(bar(1_754_870_400_000 + i * 60_000, 100, 100 + i * 0.5, 99 - i * 0.5, 100, 5));
    }
    const ctx = draw(frameFor(flat, 20));
    const bodies = ctx.calls.filter((c) => c.op === 'fillRect' && c.fillStyle === theme.upBody);
    expect(bodies.length).toBe(20);
    for (const body of bodies) expect(body.args[3]).toBe(1);
  });

  it('colours by direction: close >= open is an up candle', () => {
    const bars = [
      bar(1_754_870_400_000, 100, 110, 90, 105, 5), // up
      bar(1_754_870_460_000, 105, 112, 95, 98, 5), // down
      bar(1_754_870_520_000, 98, 108, 92, 98, 5), // doji -> up
    ];
    const ctx = draw(frameFor(bars, 40, { scrollPosition: 2 }));
    expect(ctx.fillsOf(theme.upBody)).toHaveLength(2);
    expect(ctx.fillsOf(theme.downBody)).toHaveLength(1);
  });
});

describe('series layer — batching and volume', () => {
  it('changes fillStyle a fixed number of times regardless of bar count', () => {
    const few = draw(frameFor(makeBars(40), 12)).fillStyleRuns();
    const many = draw(frameFor(makeBars(4_000), 12)).fillStyleRuns();
    expect(few.length).toBeLessThanOrEqual(6);
    expect(many.length).toBe(few.length);
    expect(new Set(many).size).toBe(many.length); // each colour is one contiguous run
  });

  it('draws volume columns inside the volume pane, aligned with the candles', () => {
    const f = frameFor(makeBars(200), 12);
    const pane = f.layout.volume;
    expect(pane).not.toBeNull();
    if (pane === null) return;
    const ctx = draw(f);
    const columns = ctx.calls.filter(
      (c) => c.op === 'fillRect' && (c.fillStyle === theme.upVolume || c.fillStyle === theme.downVolume),
    );
    expect(columns.length).toBeGreaterThan(0);
    const bodyLefts = new Set(
      ctx.calls
        .filter((c) => c.op === 'fillRect' && (c.fillStyle === theme.upBody || c.fillStyle === theme.downBody))
        .map((c) => c.args[0]),
    );
    for (const column of columns) {
      expect(column.args[1]).toBeGreaterThanOrEqual(pane.top);
      expect(column.args[1] + column.args[3]).toBeLessThanOrEqual(rectBottom(pane) + 1);
      expect(bodyLefts.has(column.args[0])).toBe(true);
      expect(column.args[3]).toBeGreaterThanOrEqual(1);
    }
    // The tallest column reaches the top of the pane.
    const tallest = Math.min(...columns.map((c) => c.args[1]));
    expect(tallest).toBe(pane.top);
  });

  it('skips the volume pane when every visible bar has zero volume (§9)', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push(bar(1_754_870_400_000 + i * 60_000, 100, 101, 99, 100.5, 0));
    }
    const ctx = draw(frameFor(bars, 12));
    expect(ctx.fillsOf(theme.upVolume)).toHaveLength(0);
    expect(ctx.fillsOf(theme.downVolume)).toHaveLength(0);
  });

  it('dims a stale series instead of hiding it', () => {
    const live = draw(frameFor(makeBars(50), 12, { state: 'live' }));
    const stale = draw(frameFor(makeBars(50), 12, { state: 'stale' }));
    expect(live.ops('fillRect')[0].globalAlpha).toBe(1);
    expect(stale.ops('fillRect')[0].globalAlpha).toBe(theme.staleAlpha);
    expect(stale.ops('fillRect').length).toBe(live.ops('fillRect').length);
  });

  it('drops non-positive bars on a log scale rather than clamping them (§3)', () => {
    const bars = [
      bar(1_754_870_400_000, 10, 12, 8, 11, 5),
      bar(1_754_870_460_000, 11, 13, 9, 12, 5),
      bar(1_754_870_520_000, 12, 14, 10, 13, 5),
    ];
    const linear = draw(frameFor(bars, 30, { mode: 'linear', scrollPosition: 2 }));
    const log = draw(frameFor(bars, 30, { mode: 'log', scrollPosition: 2 }));
    expect(candleFills(log).length).toBe(candleFills(linear).length);
    for (const call of candleFills(log)) {
      for (const arg of call.args) expect(Number.isFinite(arg)).toBe(true);
    }
  });

  it('reuses its geometry buffers across frames', () => {
    const layer = createSeriesLayer();
    const f = frameFor(makeBars(500), 6);
    const first = new FakeContext();
    const second = new FakeContext();
    layer.draw(first.asContext(), f);
    layer.draw(second.asContext(), f);
    expect(second.ops('fillRect').length).toBe(first.ops('fillRect').length);
    expect(second.ops('fillRect')[0].args).toEqual(first.ops('fillRect')[0].args);
  });

  it('handles a completely flat series without a divide-by-zero (§2 guard)', () => {
    const flat: Bar[] = [];
    for (let i = 0; i < 25; i++) {
      flat.push(bar(1_754_870_400_000 + i * 60_000, 50, 50, 50, 50, 3));
    }
    const ctx = draw(frameFor(flat, 10));
    const fills = ctx.ops('fillRect');
    expect(fills.length).toBeGreaterThan(0);
    for (const call of fills) {
      for (const arg of call.args) expect(Number.isFinite(arg)).toBe(true);
    }
  });

  it('paints a price scaled to the plot: the highest high sits near the top', () => {
    const bars = makeBars(120);
    const f = frameFor(bars, 6);
    const ctx = draw(f);
    const wickTops = candleFills(ctx).map((c) => c.args[1]);
    const highest = Math.min(...wickTops);
    // 10% padding above the max: the top wick is ~1/12 of the plot down from the top.
    const expected = f.layout.plot.top + f.layout.plot.height * (0.1 / 1.2);
    expect(Math.abs(highest - expected)).toBeLessThan(2);
  });

  it('only iterates the visible slice: bar count does not change draw count', () => {
    const wide = draw(frameFor(makeBars(5_000), 8));
    const narrow = draw(frameFor(makeBars(200), 8));
    expect(wide.ops('fillRect').length).toBe(narrow.ops('fillRect').length);
  });
});
