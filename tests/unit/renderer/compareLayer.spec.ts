/**
 * The comparison line.
 *
 * Asserted against the recorded call list rather than pixels: what matters is where the
 * path goes and, above all, where it BREAKS. A comparison whose secondary has no data for
 * part of the window must lift the pen there — joining across draws a straight line
 * through days the instrument did not exist, which reads as real data.
 */

import { describe, expect, it } from 'vitest';
import { asPixel } from '../../../src/data/types.js';
import {
  drawCompareSeries,
  type CompareDrawInput,
} from '../../../src/renderer/layers/compareLayer.js';
import type { Rect } from '../../../src/renderer/layout.js';
import { FakeContext, FAKE_CHAR_WIDTH } from './fakeCanvas.js';
import { TEST_THEME } from './fixtures.js';

const PLOT: Rect = {
  left: asPixel(50),
  top: asPixel(0),
  width: asPixel(400),
  height: asPixel(200),
};

const DX = 4;
const X0 = PLOT.left;

/** Percent → Y over [-100, 100] across the plot, so 0% is the middle. */
const y = (percent: number): number => PLOT.top + PLOT.height / 2 - percent;

function input(percent: readonly number[], overrides: Partial<CompareDrawInput> = {}) {
  const values = Float64Array.from(percent);
  return {
    percent: values,
    plot: PLOT,
    from: 0,
    to: values.length - 1,
    y,
    x: (i: number) => X0 + i * DX,
    x0: X0,
    dx: DX,
    color: '#compare',
    label: 'SPY',
    theme: TEST_THEME,
    ...overrides,
  } satisfies CompareDrawInput;
}

function draw(percent: readonly number[], overrides: Partial<CompareDrawInput> = {}): FakeContext {
  const ctx = new FakeContext();
  drawCompareSeries(ctx.asContext(), input(percent, overrides));
  return ctx;
}

describe('the path', () => {
  it('walks the values in order', () => {
    const ctx = draw([0, 10, -10]);
    expect(ctx.ops('moveTo').map((c) => c.args)).toEqual([[X0 + 0.5, y(0) + 0.5]]);
    expect(ctx.ops('lineTo').map((c) => c.args)).toEqual([
      [X0 + DX + 0.5, y(10) + 0.5],
      [X0 + 2 * DX + 0.5, y(-10) + 0.5],
    ]);
  });

  it('breaks the line at a gap rather than joining across it', () => {
    // Two runs either side of a hole. A single `moveTo` would mean the pen never lifted.
    const ctx = draw([0, 5, Number.NaN, Number.NaN, 20, 25]);
    expect(ctx.ops('moveTo')).toHaveLength(2);
    const starts = ctx.ops('moveTo').map((c) => c.args[0]);
    expect(starts).toEqual([X0 + 0.5, X0 + 4 * DX + 0.5]);
  });

  it('starts at the first real value when the series begins with a gap', () => {
    const ctx = draw([Number.NaN, Number.NaN, 7, 8]);
    expect(ctx.ops('moveTo').map((c) => c.args[0])).toEqual([X0 + 2 * DX + 0.5]);
  });

  it('snaps every point to the §7 half-pixel grid', () => {
    for (const call of [...draw([0, 3, 6]).ops('moveTo'), ...draw([0, 3, 6]).ops('lineTo')]) {
      expect(call.args[0] % 1).toBeCloseTo(0.5, 9);
      expect(call.args[1] % 1).toBeCloseTo(0.5, 9);
    }
  });

  it('takes its colour from the caller, not from a constant', () => {
    const ctx = draw([0, 1], { color: '#chosen' });
    expect(ctx.ops('stroke')[0].strokeStyle).toBe('#chosen');
  });
});

describe('nothing to draw', () => {
  it('paints nothing at all when the overlap is empty', () => {
    const ctx = draw([Number.NaN, Number.NaN], { from: -1, to: -1 });
    expect(ctx.calls).toHaveLength(0);
  });

  it('paints nothing for an empty series', () => {
    expect(draw([]).calls).toHaveLength(0);
  });

  it('leaves the context exactly as it found it', () => {
    const ctx = draw([0, 5, Number.NaN, 10]);
    expect(ctx.depth).toBe(0);
  });

  it('clips to the plot before drawing', () => {
    const ctx = draw([0, 1]);
    const rect = ctx.ops('rect')[0];
    expect(rect.args).toEqual([PLOT.left, PLOT.top, PLOT.width, PLOT.height]);
    expect(ctx.calls.findIndex((c) => c.op === 'clip')).toBeLessThan(
      ctx.calls.findIndex((c) => c.op === 'stroke'),
    );
  });
});

describe('density reduction (§5.1)', () => {
  /** More bars than the plot is wide, with one spike in the middle of a column. */
  const many = (n: number, spikeAt: number): number[] =>
    Array.from({ length: n }, (_, i) => (i === spikeAt ? 90 : 0));

  it('keeps a spike that one point per column would lose', () => {
    const n = PLOT.width * 3;
    const spikeAt = Math.floor(n / 2);
    const ctx = draw(many(n, spikeAt), { dx: PLOT.width / n, x0: X0 });

    const ys = [...ctx.ops('lineTo'), ...ctx.ops('moveTo')].map((c) => c.args[1]);
    // The spike's own Y has to appear. Sampling one bar per column would drop it unless
    // the spike happened to be the sampled bar.
    expect(ys).toContain(y(90) + 0.5);
  });

  it('emits two points per column rather than one per bar', () => {
    const n = PLOT.width * 3;
    const ctx = draw(many(n, 10), { dx: PLOT.width / n, x0: X0 });
    // Bounded by the plot's width, not by the bar count: 2 per column plus the opening
    // move. Drawing every bar would be n - 1 lineTo calls.
    expect(ctx.ops('lineTo').length).toBeLessThanOrEqual(2 * PLOT.width + 2);
    expect(ctx.ops('lineTo').length).toBeLessThan(n - 1);
  });

  it('still breaks at a gap when reducing', () => {
    const n = PLOT.width * 3;
    const values = many(n, 10);
    for (let i = 100; i < 400; i++) values[i] = Number.NaN;
    const ctx = draw(values, { dx: PLOT.width / n, x0: X0 });
    expect(ctx.ops('moveTo').length).toBeGreaterThan(1);
  });
});

describe('the label', () => {
  it('sits at the end of the LINE, not at a fixed plot edge', () => {
    // `drawDrawings` shipped exactly that bug for level labels. Here the line stops a
    // quarter of the way across, so a label at the right gutter would point at nothing.
    const values = [0, 5, 10, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN];
    const ctx = draw(values);
    const label = ctx.ops('fillText').find((c) => c.text === 'SPY');
    expect(label).toBeDefined();
    expect(label?.args[0]).toBeCloseTo(X0 + 2 * DX + 0.5 + 6, 9);
  });

  it('is clamped inside the plot when the line ends at the right edge', () => {
    // The layer clips to the plot, so an unclamped label is silently truncated.
    const n = 120;
    const values = Array.from({ length: n }, () => 0);
    const ctx = draw(values);
    const label = ctx.ops('fillText').find((c) => c.text === 'SPY');
    const width = 'SPY'.length * FAKE_CHAR_WIDTH;
    expect(label?.args[0]).toBeLessThanOrEqual(PLOT.left + PLOT.width - width);
    expect(label?.args[0]).toBeGreaterThanOrEqual(PLOT.left);
  });

  it('is clamped vertically too', () => {
    const ctx = draw([0, 1000]);
    const label = ctx.ops('fillText').find((c) => c.text === 'SPY');
    expect(label?.args[1]).toBeGreaterThanOrEqual(PLOT.top);
    expect(label?.args[1]).toBeLessThanOrEqual(PLOT.top + PLOT.height);
  });

  it('is omitted when there is no label to draw', () => {
    expect(draw([0, 1], { label: '' }).ops('fillText')).toHaveLength(0);
  });
});
