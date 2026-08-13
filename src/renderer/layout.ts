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

/**
 * A stacked pane shorter than this cannot show a readable series, so no requested
 * fraction is allowed to produce one. CSS px.
 */
export const PANE_MIN_HEIGHT = 24;

/** Ceiling on a single stacked pane, as a share of the content box. */
export const PANE_MAX_FRACTION = 0.8;

/** Default share of the content box taken by one indicator pane. */
const DEFAULT_PANE_FRACTION = 0.16;

/** Grab radius used by `dividerAt` when the caller does not supply one. CSS px. */
export const DIVIDER_TOLERANCE = 4;

export interface Layout {
  /** The whole canvas, CSS px. */
  readonly viewport: Rect;
  /** Plot + volume + the gap between them: everything left of the price gutter. */
  readonly content: Rect;
  /** Candles live here. This is the rect every series layer clips to (SKILL rule 8). */
  readonly plot: Rect;
  /** Volume subpanel (RENDER_ALGORITHMS §9), or null when there is no room for it. */
  readonly volume: Rect | null;
  /** Extra indicator panes, top to bottom. Empty when none fit or none were asked for. */
  readonly panes: readonly Rect[];
  /** Right-hand price axis gutter, spanning plot + volume. */
  readonly priceGutter: Rect;
  /**
   * Left-hand price gutter, or null when nothing is assigned to a second scale.
   *
   * Null rather than a zero-width rect so a caller cannot accidentally draw into it: an
   * empty gutter and an absent one are different states, and only one of them should have
   * axis labels rendered for it.
   */
  readonly leftPriceGutter: Rect | null;
  /** Bottom time axis gutter, spanning the content width. */
  readonly timeGutter: Rect;
}

export interface LayoutOptions {
  readonly width: number;
  readonly height: number;
  readonly priceGutterWidth: number;
  /** 0 (the default) means no left axis at all. */
  readonly leftPriceGutterWidth?: number;
  readonly timeGutterHeight: number;
  /** 0 (or too little room) drops the volume pane entirely. */
  readonly volumePaneFraction: number;
  readonly paneGap: number;
  readonly minPlotHeight: number;
  /**
   * Indicator panes stacked BELOW the volume pane, sharing the time axis. Panes are
   * dropped from the bottom up rather than squeezed once the price plot would fall under
   * `minPlotHeight` — a chart of unreadable slivers is worse than one with fewer panes.
   */
  readonly extraPanes?: number;
  /**
   * Height fractions of the content box, per stacked pane below the price plot, in
   * top-to-bottom order: the volume pane first when present, then indicator panes.
   * Absent (or short, or non-finite) entries fall back to the default sizing above.
   *
   * Supplying this switches the stack to the adjustable model: every requested pane is
   * clamped to [`PANE_MIN_HEIGHT`, `PANE_MAX_FRACTION`], and a stack that would starve
   * the price plot shrinks *as a whole* down to `minPlotHeight` instead of losing a pane.
   * Panes are only dropped — from the bottom up — once even `PANE_MIN_HEIGHT` each does
   * not fit, which keeps a visible pane's index equal to its index here.
   */
  readonly paneFractions?: readonly number[];
}

/** Heights of the stacked panes below the plot, before they are positioned. */
interface StackHeights {
  readonly volumeH: number;
  readonly paneHeights: readonly number[];
}

/** Today's sizing: a fixed slice each, dropped outright when the plot would starve. */
function defaultStack(
  contentH: number,
  gap: number,
  volumeFraction: number,
  extraPanes: number,
  minPlotHeight: number,
): StackHeights {
  let plotH = contentH;
  let volumeH = 0;
  if (volumeFraction > 0) {
    const candidate = Math.round(contentH * volumeFraction);
    const remaining = contentH - candidate - gap;
    if (candidate >= 1 && remaining >= minPlotHeight) {
      volumeH = candidate;
      plotH = remaining;
    }
  }

  // Each extra pane takes a slice of what is left, and only if the price plot keeps at
  // least `minPlotHeight` afterwards.
  const paneHeights: number[] = [];
  for (let i = 0; i < extraPanes; i++) {
    const paneH = Math.round(contentH * DEFAULT_PANE_FRACTION);
    if (paneH < 1 || plotH - (paneH + gap) < minPlotHeight) break;
    plotH -= paneH + gap;
    paneHeights.push(paneH);
  }
  return { volumeH, paneHeights };
}

/**
 * Shrinks a stack until the price plot keeps `minPlotHeight`. Panes shrink together,
 * proportionally and never below the floor; a pane is dropped from the bottom only when
 * the floor itself no longer fits. Returns heights summing to at most the budget.
 */
function fitStack(
  heights: readonly number[],
  contentH: number,
  gap: number,
  minPlotHeight: number,
): number[] {
  const out = heights.slice();
  const floor = Math.min(PANE_MIN_HEIGHT, Math.max(0, contentH));
  while (out.length > 0) {
    const n = out.length;
    const budget = contentH - gap * n - minPlotHeight;
    if (budget >= n * floor) {
      let total = 0;
      for (const h of out) total += h;
      if (total <= budget) return out;
      // `total > budget >= n * floor >= 0`, so the split below never divides by zero and
      // never lands under the floor: every pane survives, just smaller.
      const extra = budget - n * floor;
      let given = 0;
      for (let i = 0; i < n; i++) {
        const share = Math.floor((extra * out[i]) / total);
        out[i] = floor + share;
        given += share;
      }
      // Truncation leaves fewer than `n` pixels over; hand them to the top panes.
      for (let i = 0, left = extra - given; i < n && left > 0; i++, left--) out[i] += 1;
      return out;
    }
    out.pop();
  }
  return out;
}

/** Adjustable sizing: caller-supplied fractions, clamped, then fitted to the box. */
function requestedStack(
  contentH: number,
  gap: number,
  volumeFraction: number,
  extraPanes: number,
  minPlotHeight: number,
  fractions: readonly number[],
): StackHeights {
  const hasVolume = volumeFraction > 0;
  const defaults: number[] = [];
  if (hasVolume) defaults.push(volumeFraction);
  for (let i = 0; i < extraPanes; i++) defaults.push(DEFAULT_PANE_FRACTION);

  const ceiling = Math.floor(contentH * PANE_MAX_FRACTION);
  const floor = Math.min(PANE_MIN_HEIGHT, Math.max(0, ceiling));
  const heights = defaults.map((fallback, i) => {
    const asked = fractions.at(i);
    const f = asked === undefined || !Number.isFinite(asked) ? fallback : asked;
    return Math.min(Math.max(Math.round(contentH * f), floor), Math.max(floor, ceiling));
  });

  const fitted = fitStack(heights, contentH, gap, minPlotHeight);
  if (!hasVolume) return { volumeH: 0, paneHeights: fitted };
  return { volumeH: fitted.length > 0 ? fitted[0] : 0, paneHeights: fitted.slice(1) };
}

/**
 * Splits a viewport into panes. Every boundary is rounded to a whole CSS pixel so
 * that gridlines and axis rules land on exact half-pixels after `snapLine`.
 */
export function computeLayout(o: LayoutOptions): Layout {
  const width = Math.max(0, Math.round(o.width));
  const height = Math.max(0, Math.round(o.height));

  const gutterW = Math.min(Math.round(Math.max(0, o.priceGutterWidth)), width);
  // The left gutter eats into the content the same way the right one does, and is capped
  // so the two together can never leave a negative plot width.
  const leftW = Math.min(
    Math.round(Math.max(0, o.leftPriceGutterWidth ?? 0)),
    Math.max(0, width - gutterW - 1),
  );
  const gutterH = Math.min(Math.round(Math.max(0, o.timeGutterHeight)), height);

  const contentW = width - gutterW - leftW;
  const contentH = height - gutterH;

  const gap = Math.round(Math.max(0, o.paneGap));
  const fraction = Math.min(Math.max(o.volumePaneFraction, 0), 1);
  const requested = Math.max(0, Math.floor(o.extraPanes ?? 0));

  const asked = o.paneFractions;
  const { volumeH, paneHeights } =
    asked === undefined
      ? defaultStack(contentH, gap, fraction, requested, o.minPlotHeight)
      : requestedStack(contentH, gap, fraction, requested, o.minPlotHeight, asked);

  let plotH = contentH;
  if (volumeH > 0) plotH -= volumeH + gap;
  for (const paneH of paneHeights) plotH -= paneH + gap;

  // Positions depend on the final plot height, so lay them out after it settles.
  let cursor = plotH + gap;
  const volume = volumeH > 0 ? makeRect(leftW, cursor, contentW, volumeH) : null;
  if (volumeH > 0) cursor += volumeH + gap;
  const placed = paneHeights.map((paneH) => {
    const rect = makeRect(leftW, cursor, contentW, paneH);
    cursor += paneH + gap;
    return rect;
  });

  const plot = makeRect(leftW, 0, contentW, plotH);

  return Object.freeze({
    viewport: makeRect(0, 0, width, height),
    content: makeRect(leftW, 0, contentW, contentH),
    plot,
    volume,
    panes: Object.freeze(placed),
    priceGutter: makeRect(leftW + contentW, 0, gutterW, contentH),
    leftPriceGutter: leftW > 0 ? makeRect(0, 0, leftW, contentH) : null,
    timeGutter: makeRect(leftW, contentH, contentW, gutterH),
  });
}

export interface PaneDivider {
  /** Index into the stacked panes BELOW the plot: 0 is the first divider under the plot. */
  readonly index: number;
  /** Y of the divider line, CSS px. */
  readonly y: number;
}

/**
 * The panes below the plot, top to bottom — the same order `paneFractions` indexes,
 * except after a pane was dropped for lack of room (see `LayoutOptions.paneFractions`).
 */
function stackedRects(layout: Layout): Rect[] {
  return layout.volume === null ? [...layout.panes] : [layout.volume, ...layout.panes];
}

/** The divider within `tolerance` px of `y`, or null. */
export function dividerAt(
  layout: Layout,
  y: number,
  tolerance = DIVIDER_TOLERANCE,
): PaneDivider | null {
  const stack = stackedRects(layout);
  const reach = Math.max(0, tolerance);
  let found: PaneDivider | null = null;
  let best = Number.POSITIVE_INFINITY;
  let above: Rect = layout.plot;
  for (let i = 0; i < stack.length; i++) {
    const pane = stack[i];
    // The line sits mid-gap, so a divider is equidistant from the two panes it splits.
    const line = (rectBottom(above) + pane.top) / 2;
    const distance = Math.abs(y - line);
    if (distance <= reach && distance < best) {
      best = distance;
      found = Object.freeze({ index: i, y: line });
    }
    above = pane;
  }
  return found;
}

/**
 * The fractions that result from dragging divider `index` to `y`.
 *
 * Pure: takes the current layout and returns new fractions, clamped. Only the divider's
 * own two neighbours move — the pane below it and whatever is above (the price plot for
 * divider 0, otherwise the pane above) — so the rest of the stack holds still and the
 * total is preserved. Feed the result back as `LayoutOptions.paneFractions`.
 *
 * `options` must be the options that produced `layout`; `minPlotHeight` and `paneGap`
 * are read from it. Heights are whole pixels, so the returned fractions reproduce
 * exactly these heights when the box has not been resized — dragging back to where you
 * started restores the fractions you started with. A drag past a limit clamps: neither
 * neighbour ever inverts or drops below its floor.
 */
export function resizePane(
  layout: Layout,
  options: LayoutOptions,
  index: number,
  y: number,
): readonly number[] {
  const stack = stackedRects(layout);
  const contentH = layout.content.height;
  const fractions = stack.map((rect) => (contentH > 0 ? rect.height / contentH : 0));
  if (contentH <= 0 || index < 0 || index >= stack.length) return Object.freeze(fractions);

  const gap = Math.round(Math.max(0, options.paneGap));
  const lower = stack[index];
  const upper = index === 0 ? layout.plot : stack[index - 1];
  const upperFloor = index === 0 ? Math.max(0, options.minPlotHeight) : PANE_MIN_HEIGHT;
  const ceiling = Math.floor(contentH * PANE_MAX_FRACTION);

  // The two neighbours share this many pixels, whatever the divider does.
  const shared = rectBottom(lower) - upper.top - gap;
  // Floor of the lower pane, raised when the upper pane would breach its own ceiling.
  const lowerFloor = index === 0 ? PANE_MIN_HEIGHT : Math.max(PANE_MIN_HEIGHT, shared - ceiling);
  // …but never more than the pair actually has, so the upper pane cannot go negative.
  const lowerCeiling = Math.min(
    Math.max(Math.min(ceiling, shared - upperFloor), lowerFloor),
    Math.max(0, shared),
  );
  const lowerH = Math.min(
    Math.max(Math.round(rectBottom(lower) - (y + gap / 2)), lowerFloor),
    lowerCeiling,
  );

  const next = fractions.slice();
  next[index] = lowerH / contentH;
  if (index > 0) next[index - 1] = (shared - lowerH) / contentH;
  return Object.freeze(next);
}

/**
 * Convenience wrapper: densities come from the theme, `showVolume` from the app.
 * `paneFractions` is the user's dragged sizing, if any — omit it for the default stack.
 */
export function layoutFromTheme(
  width: number,
  height: number,
  theme: Theme,
  showVolume: boolean,
  paneFractions?: readonly number[],
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
    ...(paneFractions === undefined ? {} : { paneFractions }),
  });
}
