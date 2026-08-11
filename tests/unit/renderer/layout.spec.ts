import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  layoutFromTheme,
  makeRect,
  rectBottom,
  rectContains,
  rectRight,
  type LayoutOptions,
} from '../../../src/renderer/layout.js';
import { DARK_THEME } from '../../../src/renderer/theme.js';

const base: LayoutOptions = {
  width: 800,
  height: 600,
  priceGutterWidth: 64,
  timeGutterHeight: 24,
  volumePaneFraction: 0.2,
  paneGap: 6,
  minPlotHeight: 80,
};

describe('layout', () => {
  it('reserves the gutters and gives the rest to the panes', () => {
    const layout = computeLayout(base);
    expect(rectRight(layout.content)).toBe(800 - 64);
    expect(rectBottom(layout.content)).toBe(600 - 24);
    expect(layout.priceGutter.left).toBe(rectRight(layout.content));
    expect(layout.priceGutter.width).toBe(64);
    expect(layout.timeGutter.top).toBe(rectBottom(layout.content));
    expect(layout.timeGutter.height).toBe(24);
  });

  it('stacks plot and volume without overlap and without a gap leak', () => {
    const layout = computeLayout(base);
    const volume = layout.volume;
    expect(volume).not.toBeNull();
    if (volume === null) return;
    expect(volume.height).toBe(Math.round(576 * 0.2));
    expect(volume.top).toBe(rectBottom(layout.plot) + 6);
    expect(rectBottom(volume)).toBe(rectBottom(layout.content));
    expect(layout.plot.width).toBe(volume.width);
  });

  it('drops the volume pane rather than squeezing the plot', () => {
    const layout = computeLayout({ ...base, height: 130 });
    expect(layout.volume).toBeNull();
    expect(layout.plot.height).toBe(130 - 24);
  });

  it('drops the volume pane when the fraction is zero', () => {
    expect(computeLayout({ ...base, volumePaneFraction: 0 }).volume).toBeNull();
    expect(layoutFromTheme(800, 600, DARK_THEME, false).volume).toBeNull();
    expect(layoutFromTheme(800, 600, DARK_THEME, true).volume).not.toBeNull();
  });

  it('keeps every boundary on a whole CSS pixel', () => {
    for (const [w, h] of [
      [801.4, 600.6],
      [1_279.5, 719.5],
      [640.2, 480.7],
    ]) {
      const layout = computeLayout({ ...base, width: w, height: h });
      for (const r of [layout.viewport, layout.content, layout.plot, layout.priceGutter, layout.timeGutter]) {
        expect(Number.isInteger(r.left)).toBe(true);
        expect(Number.isInteger(r.top)).toBe(true);
        expect(Number.isInteger(r.width)).toBe(true);
        expect(Number.isInteger(r.height)).toBe(true);
      }
    }
  });

  it('degrades to empty rects instead of negative ones on a tiny viewport', () => {
    const layout = computeLayout({ ...base, width: 20, height: 10 });
    for (const r of [layout.content, layout.plot, layout.priceGutter, layout.timeGutter]) {
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
    }
  });

  it('tests point containment on the closed rect', () => {
    const r = makeRect(10, 20, 100, 50);
    expect(rectContains(r, 10, 20)).toBe(true);
    expect(rectContains(r, 110, 70)).toBe(true);
    expect(rectContains(r, 9.9, 40)).toBe(false);
    expect(rectContains(r, 50, 70.1)).toBe(false);
  });
});
