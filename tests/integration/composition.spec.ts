/**
 * Independent composition test — written by the integrating session, not by either
 * subagent, and deliberately not reusing their test helpers.
 *
 * Subagent A built src/data and Subagent B built src/renderer in isolated worktrees.
 * Each proved its own half against its own fixtures. Nothing until now has wired the
 * real store to the real renderer and checked that a frame comes out spatially sane,
 * so this file is the first evidence that the two halves actually compose.
 *
 * The oracle is RENDER_ALGORITHMS.md, re-derived here rather than imported from the
 * renderer: asserting `bw === candleBodyWidth(s)` would only prove the code equals
 * itself. Every expectation below is computed from the spec's own arithmetic.
 */

import { describe, expect, it } from 'vitest';

import {
  asPrice,
  createSeriesStore,
  createSnapshotSource,
  createViewStore,
  makeBar,
  type Bar,
} from '../../src/data/index.js';
import { buildFrameInput } from '../../src/renderer/frame.js';
import { computeLayout, createChartRenderer, DARK_THEME, DirtyFlags } from '../../src/renderer/index.js';

// --------------------------------------------------------------------------
// A recording 2D context. Minimal on purpose — no dependency on the renderer's
// own fake, so a bug in that fake cannot hide a bug in the renderer.
// --------------------------------------------------------------------------

interface Call {
  readonly m: string;
  readonly a: readonly number[];
}

interface Recorder {
  readonly ctx: CanvasRenderingContext2D;
  readonly calls: Call[];
}

function recorder(width: number, height: number): Recorder {
  const calls: Call[] = [];
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop): unknown {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'canvas') return { width, height };
      if (prop === 'measureText') return (t: string): { width: number } => ({ width: t.length * 7 });
      if (prop === 'createLinearGradient') {
        return (): { addColorStop: () => void } => ({ addColorStop: (): void => undefined });
      }
      return (...args: unknown[]): void => {
        calls.push({ m: prop, a: args.filter((x): x is number => typeof x === 'number') });
      };
    },
    set: () => true,
  };
  const ctx = new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

// Deterministic bars — a seeded LCG, so a failure is always reproducible.
function makeBars(count: number, startMs: number, stepMs: number): Bar[] {
  let seed = 0x2f6e2b1;
  const rnd = (): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open * (1 + (rnd() - 0.5) * 0.02);
    const high = Math.max(open, close) * (1 + rnd() * 0.005);
    const low = Math.min(open, close) * (1 - rnd() * 0.005);
    const bar = makeBar({
      t: startMs + i * stepMs,
      o: open,
      h: high,
      l: low,
      c: close,
      v: Math.floor(rnd() * 1000),
    });
    if (bar === null) throw new Error(`fixture generated an invalid bar at ${String(i)}`);
    bars.push(bar);
    price = close;
  }
  return bars;
}

const START = 1_754_870_400_000;
const STEP = 60_000;
const WIDTH = 1280;
const HEIGHT = 720;

interface Rendered {
  readonly calls: Call[];
  readonly plot: { left: number; top: number; width: number; height: number };
  readonly barSpacing: number;
}

function renderOnce(barCount: number, barSpacing: number): Rendered {
  const bars = makeBars(barCount, START, STEP);
  const series = createSeriesStore({ symbol: 'BTCUSD', tf: '1m', initialBars: bars, state: 'live' });
  const view = createViewStore({ barSpacing, scrollPosition: barCount - 1 });
  const source = createSnapshotSource(series, view);

  const layout = computeLayout({
    width: WIDTH,
    height: HEIGHT,
    priceGutterWidth: 64,
    timeGutterHeight: 28,
    volumePaneFraction: 0,
    paneGap: 4,
    minPlotHeight: 80,
  });

  const grid = recorder(WIDTH, HEIGHT);
  const seriesRec = recorder(WIDTH, HEIGHT);
  const overlay = recorder(WIDTH, HEIGHT);
  const crosshair = recorder(WIDTH, HEIGHT);

  const input = buildFrameInput({
    snapshot: source.snapshot(),
    layout,
    theme: DARK_THEME,
    pricePrecision: 2,
    overlays: [],
    pointer: null,
    priceRange: null,
  });

  createChartRenderer().render(
    DirtyFlags.All,
    { grid: grid.ctx, series: seriesRec.ctx, overlay: overlay.ctx, crosshair: crosshair.ctx },
    input,
  );

  return {
    calls: seriesRec.calls,
    plot: {
      left: layout.plot.left,
      top: layout.plot.top,
      width: layout.plot.width,
      height: layout.plot.height,
    },
    barSpacing,
  };
}

const fills = (calls: readonly Call[]): Call[] => calls.filter((c) => c.m === 'fillRect' && c.a.length === 4);

describe('data + renderer compose into a spatially sane frame', () => {
  it('clears the series layer before drawing anything (SKILL rule 2)', () => {
    const { calls } = renderOnce(300, 12);
    const first = calls.find((c) => c.m === 'clearRect' || c.m === 'fillRect');
    expect(first?.m).toBe('clearRect');
  });

  it('draws candles at all', () => {
    const { calls } = renderOnce(300, 12);
    expect(fills(calls).length).toBeGreaterThan(50);
  });

  it('never emits a zero-height rect — a doji must still be 1px (SKILL rule 5)', () => {
    const { calls } = renderOnce(300, 12);
    for (const c of fills(calls)) {
      expect(c.a[3]).toBeGreaterThanOrEqual(1);
      expect(c.a[2]).toBeGreaterThanOrEqual(1);
    }
  });

  it('emits only integer-aligned fills (SKILL rule 5)', () => {
    const { calls } = renderOnce(300, 12);
    for (const c of fills(calls)) {
      for (const n of c.a) expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('establishes a clip to exactly the plot rect before any fill (SKILL rule 8)', () => {
    const { calls, plot } = renderOnce(300, 12);
    const firstFill = calls.findIndex((c) => c.m === 'fillRect');
    const clipAt = calls.findIndex((c) => c.m === 'clip');
    const rectAt = calls.findIndex((c) => c.m === 'rect');

    expect(clipAt).toBeGreaterThanOrEqual(0);
    expect(clipAt).toBeLessThan(firstFill);
    // The clip region must be the plot rect itself — a wrong rect here would let the
    // series bleed into the price/time gutters while still "having a clip".
    expect(calls[rectAt].a).toEqual([plot.left, plot.top, plot.width, plot.height]);
  });

  it('only lets partially-scrolled edge bars exceed the plot, and only by one bar', () => {
    // Bars straddling the plot edge legitimately extend past it and are cut by the
    // clip above. What must NOT happen is a fill landing far outside, which would
    // mean the visible-range slice (RENDER_ALGORITHMS §5) is wrong.
    const { calls, plot, barSpacing } = renderOnce(300, 12);
    const slack = barSpacing * 2;
    for (const c of fills(calls)) {
      const [x, y, w, h] = c.a as [number, number, number, number];
      expect(x).toBeGreaterThanOrEqual(plot.left - slack);
      expect(x + w).toBeLessThanOrEqual(plot.left + plot.width + slack);
      expect(y).toBeGreaterThanOrEqual(plot.top - slack);
      expect(y + h).toBeLessThanOrEqual(plot.top + plot.height + slack);
    }
  });

  it('never overlaps two candle bodies horizontally (RENDER_ALGORITHMS §6)', () => {
    for (const s of [3, 4, 6, 8, 12, 20, 47, 120]) {
      const { calls } = renderOnce(300, s);
      // Bodies are the wider-than-1px fills; wicks are exactly 1px wide.
      const bodies = fills(calls).filter((c) => c.a[2] > 1);
      const spans = bodies
        .map((c) => ({ x0: c.a[0], x1: c.a[0] + c.a[2] }))
        .sort((a, b) => a.x0 - b.x0);
      // Group by column: identical x0 means the same bar (body drawn once).
      const unique = spans.filter((sp, i) => i === 0 || sp.x0 !== spans[i - 1].x0);
      for (let i = 1; i < unique.length; i++) {
        expect(unique[i].x0).toBeGreaterThanOrEqual(unique[i - 1].x1);
      }
    }
  });

  it('respects the spec-derived body width, recomputed independently', () => {
    for (const s of [4, 6, 8, 12, 20, 47, 120]) {
      // RENDER_ALGORITHMS §6, transcribed from the doc rather than imported:
      const bw0 = Math.floor(s * 0.8);
      let expected = Math.max(1, Math.min(bw0, Math.floor(s) - 1));
      if (expected % 2 === 0) expected -= 1;
      if (expected < 1) expected = 1;

      const { calls } = renderOnce(300, s);
      const widths = new Set(fills(calls).filter((c) => c.a[2] > 1).map((c) => c.a[2]));
      expect([...widths]).toEqual([expected]);
    }
  });

  it('drops to 1px line mode below 3px of spacing (RENDER_ALGORITHMS §6)', () => {
    const { calls } = renderOnce(300, 2);
    for (const c of fills(calls)) expect(c.a[2]).toBe(1);
  });
});

describe('live tick path survives the seam', () => {
  it('bumps revision and redraws after replaceLast, without mutating the old bar', () => {
    const bars = makeBars(50, START, STEP);
    const series = createSeriesStore({ symbol: 'BTCUSD', tf: '1m', initialBars: bars, state: 'live' });
    const view = createViewStore({ barSpacing: 12, scrollPosition: 49 });
    const source = createSnapshotSource(series, view);

    const before = source.snapshot();
    const lastBefore = before.series.bars[before.series.bars.length - 1];
    const closeBefore = lastBefore.c;

    const tick = makeBar({
      t: lastBefore.t,
      o: lastBefore.o,
      h: Math.max(lastBefore.h, lastBefore.c + 5),
      l: lastBefore.l,
      c: lastBefore.c + 5,
      v: lastBefore.v + 1,
    });
    expect(tick).not.toBeNull();
    if (tick === null) return;

    expect(series.replaceLast(tick)).toBe(true);

    // Mandate #4: the previous Bar object itself is untouched and still frozen.
    expect(lastBefore.c).toBe(closeBefore);
    expect(Object.isFrozen(lastBefore)).toBe(true);

    const after = source.snapshot();
    expect(after.revision).not.toBe(before.revision);
    expect(after.series.bars[after.series.bars.length - 1].c).toBe(asPrice(closeBefore + 5));
  });
});
