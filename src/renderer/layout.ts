/**
 * Pane geometry: plot rect, price gutter, time gutter, optional volume pane.
 *
 * All rects are CSS pixels in canvas-local coordinates (origin = canvas top-left),
 * which is the space every layer draws in after `surface.ts` applies the DPR
 * transform (RENDER_ALGORITHMS §1).
 *
 * Layout:
 *
 *     +--------------------------------+--------+
 *     |            plot                | price  |
 *     |                                | gutter |
 *     +--------------------------------+        |
 *     |            volume (optional)   |        |
 *     +--------------------------------+--------+
 *     |          time gutter           | corner |
 *     +--------------------------------+--------+
 */

import { asPixel, type Pixel } from '../data/types.js';
import type { Theme } from './theme.js';

export interface Rect {
  readonly left: Pixel;
  readonly top: Pixel;
  readonly width: Pixel;
  readonly height: Pixel;
}

export function makeRect(left: number, top: number, width: number, height: number): Rect {
  return Object.freeze({
    left: asPixel(left),
    top: asPixel(top),
    width: asPixel(Math.max(0, width)),
    height: asPixel(Math.max(0, height)),
  });
}

export function rectRight(r: Rect): number {
  return r.left + r.width;
}

export function rectBottom(r: Rect): number {
  return r.top + r.height;
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.left && x <= rectRight(r) && y >= r.top && y <= rectBottom(r);
}

export interface Layout {
  /** The whole canvas, CSS px. */
  readonly viewport: Rect;
  /** Plot + volume + the gap between them: everything left of the price gutter. */
  readonly content: Rect;
  /** Candles live here. This is the rect every series layer clips to (SKILL rule 8). */
  readonly plot: Rect;
  /** Volume subpanel (RENDER_ALGORITHMS §9), or null when there is no room for it. */
  readonly volume: Rect | null;
  /** Right-hand price axis gutter, spanning plot + volume. */
  readonly priceGutter: Rect;
  /** Bottom time axis gutter, spanning the content width. */
  readonly timeGutter: Rect;
}

export interface LayoutOptions {
  readonly width: number;
  readonly height: number;
  readonly priceGutterWidth: number;
  readonly timeGutterHeight: number;
  /** 0 (or too little room) drops the volume pane entirely. */
  readonly volumePaneFraction: number;
  readonly paneGap: number;
  readonly minPlotHeight: number;
}

/**
 * Splits a viewport into panes. Every boundary is rounded to a whole CSS pixel so
 * that gridlines and axis rules land on exact half-pixels after `snapLine`.
 */
export function computeLayout(o: LayoutOptions): Layout {
  const width = Math.max(0, Math.round(o.width));
  const height = Math.max(0, Math.round(o.height));

  const gutterW = Math.min(Math.round(Math.max(0, o.priceGutterWidth)), width);
  const gutterH = Math.min(Math.round(Math.max(0, o.timeGutterHeight)), height);

  const contentW = width - gutterW;
  const contentH = height - gutterH;

  const gap = Math.round(Math.max(0, o.paneGap));
  const fraction = Math.min(Math.max(o.volumePaneFraction, 0), 1);

  let plotH = contentH;
  let volumeH = 0;
  if (fraction > 0) {
    const candidate = Math.round(contentH * fraction);
    const remaining = contentH - candidate - gap;
    if (candidate >= 1 && remaining >= o.minPlotHeight) {
      volumeH = candidate;
      plotH = remaining;
    }
  }

  const plot = makeRect(0, 0, contentW, plotH);
  const volume = volumeH > 0 ? makeRect(0, plotH + gap, contentW, volumeH) : null;

  return Object.freeze({
    viewport: makeRect(0, 0, width, height),
    content: makeRect(0, 0, contentW, contentH),
    plot,
    volume,
    priceGutter: makeRect(contentW, 0, gutterW, contentH),
    timeGutter: makeRect(0, contentH, contentW, gutterH),
  });
}

/** Convenience wrapper: densities come from the theme, `showVolume` from the app. */
export function layoutFromTheme(
  width: number,
  height: number,
  theme: Theme,
  showVolume: boolean,
): Layout {
  const d = theme.density;
  return computeLayout({
    width,
    height,
    priceGutterWidth: d.priceGutterWidth,
    timeGutterHeight: d.timeGutterHeight,
    volumePaneFraction: showVolume ? d.volumePaneFraction : 0,
    paneGap: d.paneGap,
    minPlotHeight: d.minPlotHeight,
  });
}
