import { describe, expect, it } from 'vitest';
import { asBarIndex, asPixel } from '../../../src/data/types.js';
import { makeRect } from '../../../src/renderer/layout.js';
import {
  clampBarSpacing,
  makeTimeScale,
  MAX_BAR_SPACING,
  MIN_BAR_SPACING,
  panBy,
  zoomAbout,
} from '../../../src/renderer/scale/timeScale.js';

const plot = makeRect(0, 0, 700, 500);
const offsetPlot = makeRect(37, 12, 613, 500);

describe('time scale — RENDER_ALGORITHMS §5', () => {
  it('places the scroll position at the right edge of the plot', () => {
    const scale = makeTimeScale(120, 8, plot);
    expect(scale.x(asBarIndex(120))).toBe(plot.left + plot.width);
    expect(scale.x(asBarIndex(119))).toBe(plot.left + plot.width - 8);
  });

  it('honours a plot that does not start at x = 0', () => {
    const scale = makeTimeScale(50, 10, offsetPlot);
    expect(scale.x(asBarIndex(50))).toBe(offsetPlot.left + offsetPlot.width);
    expect(scale.x(asBarIndex(45))).toBe(offsetPlot.left + offsetPlot.width - 50);
  });

  it('round-trips X⁻¹(X(i)) across the index domain and the spacing range', () => {
    for (const s of [0.5, 1, 3.25, 8, 17.5, 60, 120]) {
      const scale = makeTimeScale(4_321.75, s, offsetPlot);
      for (let i = 0; i <= 5_000; i += 137) {
        const back = scale.indexAt(scale.x(asBarIndex(i)));
        expect(Math.abs(back - i)).toBeLessThan(1e-9);
      }
    }
  });

  it('round-trips X(X⁻¹(x)) across the plot width', () => {
    const scale = makeTimeScale(300.25, 6.5, offsetPlot);
    for (let step = 0; step <= 100; step++) {
      const x = asPixel(offsetPlot.left + (offsetPlot.width * step) / 100);
      const back: number = scale.x(asBarIndex(scale.indexAt(x)));
      expect(Math.abs(back - x)).toBeLessThan(1e-9);
    }
  });

  it('clamps bar spacing to [0.5, 120]', () => {
    expect(clampBarSpacing(0.01)).toBe(MIN_BAR_SPACING);
    expect(clampBarSpacing(10_000)).toBe(MAX_BAR_SPACING);
    expect(clampBarSpacing(Number.NaN)).toBe(MIN_BAR_SPACING);
    expect(clampBarSpacing(7)).toBe(7);
  });
});

describe('visible index range — §5', () => {
  it('clamps to [0, n - 1]', () => {
    const scale = makeTimeScale(199, 8, plot); // 700px / 8 ≈ 87.5 bars visible
    const range = scale.visibleRange(200);
    expect(range.isEmpty).toBe(false);
    expect(range.from).toBeGreaterThanOrEqual(0);
    expect(range.to).toBe(199);
    expect(range.from).toBe(Math.max(0, Math.floor(scale.indexAt(asPixel(plot.left)))));
    expect(range.count).toBe(range.to - range.from + 1);
  });

  it('clamps the left edge to 0 when scrolled past the first bar', () => {
    const scale = makeTimeScale(20, 8, plot);
    const range = scale.visibleRange(200);
    expect(range.from).toBe(0);
    expect(range.to).toBe(20); // ceil(X⁻¹(right)) = ceil(k) = 20, well inside n - 1
  });

  it('reports empty for an empty series', () => {
    const range = makeTimeScale(0, 8, plot).visibleRange(0);
    expect(range.isEmpty).toBe(true);
    expect(range.count).toBe(0);
  });

  it('reports empty when the series is scrolled entirely out of view', () => {
    const scrolledPast = makeTimeScale(-50, 8, plot).visibleRange(100);
    expect(scrolledPast.isEmpty).toBe(true);
    const scrolledBefore = makeTimeScale(5_000, 8, plot).visibleRange(100);
    expect(scrolledBefore.isEmpty).toBe(true);
  });

  it('covers the full plot width: the first bar is at or left of P.l', () => {
    const scale = makeTimeScale(400.4, 11, plot);
    const range = scale.visibleRange(1_000);
    expect(scale.x(range.from)).toBeLessThanOrEqual(plot.left);
    expect(scale.x(range.to)).toBeGreaterThanOrEqual(plot.left + plot.width);
  });
});

describe('zoom about an anchor — §5', () => {
  const cases: readonly { readonly anchor: number; readonly factor: number; readonly s: number }[] = [
    { anchor: 0, factor: 1.25, s: 8 },
    { anchor: 350, factor: 1.25, s: 8 },
    { anchor: 700, factor: 1.25, s: 8 },
    { anchor: 123.5, factor: 0.8, s: 20 },
    { anchor: 640, factor: 4, s: 2 },
    { anchor: 17, factor: 0.1, s: 30 },
  ];

  it('keeps the bar under the cursor pinned to the cursor pixel', () => {
    for (const c of cases) {
      const scale = makeTimeScale(1_000.25, c.s, plot);
      const anchorIndex = scale.indexAt(asPixel(c.anchor));
      const next = zoomAbout(scale, asPixel(c.anchor), c.factor);
      const zoomed = makeTimeScale(next.scrollPosition, next.barSpacing, plot);
      expect(Math.abs(zoomed.x(asBarIndex(anchorIndex)) - c.anchor)).toBeLessThan(1e-9);
    }
  });

  it('keeps the anchor pinned even when the zoom clamps at the limits', () => {
    const scale = makeTimeScale(500, MAX_BAR_SPACING, plot);
    const anchorIndex = scale.indexAt(asPixel(400));
    const next = zoomAbout(scale, asPixel(400), 8);
    expect(next.barSpacing).toBe(MAX_BAR_SPACING);
    const zoomed = makeTimeScale(next.scrollPosition, next.barSpacing, plot);
    expect(Math.abs(zoomed.x(asBarIndex(anchorIndex)) - 400)).toBeLessThan(1e-9);
  });

  it('zooming in shows fewer bars, zooming out shows more', () => {
    const scale = makeTimeScale(1_000, 8, plot);
    const before = scale.visibleRange(2_000).count;
    const inward = zoomAbout(scale, asPixel(350), 2);
    const outward = zoomAbout(scale, asPixel(350), 0.5);
    expect(makeTimeScale(inward.scrollPosition, inward.barSpacing, plot).visibleRange(2_000).count).toBeLessThan(
      before,
    );
    expect(
      makeTimeScale(outward.scrollPosition, outward.barSpacing, plot).visibleRange(2_000).count,
    ).toBeGreaterThan(before);
  });
});

describe('pan — §5', () => {
  it('dragging right reveals older bars', () => {
    const scale = makeTimeScale(1_000, 8, plot);
    const panned = panBy(scale, 80);
    expect(panned.scrollPosition).toBe(990);
    expect(panned.barSpacing).toBe(8);
  });

  it('translates the chart by exactly the drag distance', () => {
    const scale = makeTimeScale(1_000, 8, plot);
    const before: number = scale.x(asBarIndex(950));
    const panned = panBy(scale, -37.5);
    const after: number = makeTimeScale(panned.scrollPosition, panned.barSpacing, plot).x(asBarIndex(950));
    expect(after - before).toBeCloseTo(-37.5, 9);
  });
});
