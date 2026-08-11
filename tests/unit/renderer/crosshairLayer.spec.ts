import { describe, expect, it } from 'vitest';
import { asBarIndex, asPixel } from '../../../src/data/types.js';
import { buildFrameInput, type FrameInput, type PointerState } from '../../../src/renderer/frame.js';
import { drawCrosshairLayer } from '../../../src/renderer/layers/crosshairLayer.js';
import { rectBottom, rectRight } from '../../../src/renderer/layout.js';
import { FakeContext } from './fakeCanvas.js';
import { makeBars, makeSnapshot, TEST_THEME, testLayout } from './fixtures.js';

function frame(pointer: PointerState | null, barSpacing = 12): FrameInput {
  return buildFrameInput({
    snapshot: makeSnapshot({ bars: makeBars(400), barSpacing }),
    layout: testLayout(),
    theme: TEST_THEME,
    pricePrecision: 2,
    overlays: [],
    pointer,
    priceRange: null,
  });
}

function draw(f: FrameInput): FakeContext {
  const ctx = new FakeContext();
  drawCrosshairLayer(ctx.asContext(), f);
  return ctx;
}

describe('crosshair layer — RENDER_ALGORITHMS §10', () => {
  it('clears and draws nothing when the pointer is away', () => {
    const ctx = draw(frame(null));
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].op).toBe('clearRect');
  });

  it('clears and draws nothing when the pointer is over a gutter', () => {
    const f = frame({ x: 790, y: 300 });
    const ctx = draw(f);
    expect(ctx.ops('moveTo')).toHaveLength(0);
    expect(ctx.calls[0].op).toBe('clearRect');
  });

  it('snaps the vertical rule to the nearest bar centre', () => {
    const f = frame({ x: 401.7, y: 220 });
    const ctx = draw(f);
    const index = Math.round(f.timeScale.indexAt(asPixel(401.7)));
    const expected = Math.round(f.timeScale.x(asBarIndex(index))) + 0.5;
    const vertical = ctx.ops('moveTo')[0];
    expect(vertical.args[0]).toBe(expected);
    expect(Math.abs(vertical.args[0] - 401.7)).toBeLessThanOrEqual(f.timeScale.barSpacing / 2 + 0.5);
  });

  it('lets the horizontal rule follow the raw pointer, snapped to a half pixel', () => {
    const f = frame({ x: 400, y: 220.4 });
    const ctx = draw(f);
    const horizontal = ctx.ops('moveTo')[1];
    expect(horizontal.args[1]).toBe(220.5);
  });

  it('spans the content rect in both directions', () => {
    const f = frame({ x: 400, y: 220 });
    const ctx = draw(f);
    const content = f.layout.content;
    const [vStart, hStart] = ctx.ops('moveTo');
    const [vEnd, hEnd] = ctx.ops('lineTo');
    expect(vStart.args[1]).toBe(content.top);
    expect(vEnd.args[1]).toBe(rectBottom(content));
    expect(hStart.args[0]).toBe(content.left);
    expect(hEnd.args[0]).toBe(rectRight(content));
  });

  it('is dashed and leaves the dash state clean', () => {
    const ctx = draw(frame({ x: 400, y: 220 }));
    const dashes = ctx.ops('setLineDash');
    expect(dashes[0].args).toEqual([...TEST_THEME.crosshairDash]);
    expect(ctx.depth).toBe(0);
  });

  it('labels the price at the raw pointer y, not at the snapped bar', () => {
    const f = frame({ x: 400, y: 220.4 });
    const ctx = draw(f);
    const gutter = f.layout.priceGutter;
    const label = ctx.ops('fillText').find((c) => c.args[0] >= gutter.left);
    expect(label).toBeDefined();
    if (label === undefined) return;
    const expected: number = f.priceScale.price(asPixel(220.4));
    expect(Number(label.text)).toBeCloseTo(expected, 2);
    expect(label.text.split('.')[1]).toHaveLength(2); // pricePrecision = 2
  });

  it('labels the time of the snapped bar in the time gutter', () => {
    const f = frame({ x: 401.7, y: 220 });
    const ctx = draw(f);
    const gutter = f.layout.timeGutter;
    const label = ctx.ops('fillText').find((c) => c.args[1] > gutter.top);
    expect(label).toBeDefined();
    if (label === undefined) return;
    expect(label.text).toMatch(/^\d{2} [A-Z][a-z]{2} \d{2}:\d{2}$/);
  });

  it('keeps both tags inside their gutters, even at the edges', () => {
    for (const pointer of [
      { x: 1, y: 1 },
      { x: 735, y: 575 },
      { x: 400, y: 300 },
    ]) {
      const f = frame(pointer);
      const ctx = draw(f);
      for (const box of ctx.ops('fillRect')) {
        const [x, y, w, h] = box.args;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(rectRight(f.layout.viewport));
        expect(y + h).toBeLessThanOrEqual(rectBottom(f.layout.viewport) + 1);
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
      }
    }
  });

  it('still tracks the pointer when the series is empty', () => {
    const f = buildFrameInput({
      snapshot: makeSnapshot({ bars: [] }),
      layout: testLayout(),
      theme: TEST_THEME,
      pricePrecision: 2,
      overlays: [],
      pointer: { x: 300, y: 200 },
      priceRange: null,
    });
    const ctx = draw(f);
    expect(ctx.ops('moveTo')[0].args[0]).toBe(300.5);
    expect(ctx.ops('fillText').some((c) => c.args[1] > f.layout.timeGutter.top)).toBe(false);
  });
});
