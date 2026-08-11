/**
 * Renderer entry point.
 *
 * `src/app/` wires: store -> scheduler.invalidate(mask) -> rAF -> `render()`.
 * Nothing below this module knows what a store, a socket or an element is.
 */

import { drawCrosshairLayer } from './layers/crosshairLayer.js';
import { drawGridLayer } from './layers/gridLayer.js';
import { drawOverlayLayer } from './layers/overlayLayer.js';
import { createSeriesLayer, type SeriesLayer } from './layers/seriesLayer.js';
import type { FrameInput } from './frame.js';
import { DirtyFlags, type DirtyMask } from './scheduler.js';

/** One stacked canvas per layer, back to front (SKILL "Frame lifecycle"). */
export interface LayerContexts {
  readonly grid: CanvasRenderingContext2D;
  readonly series: CanvasRenderingContext2D;
  readonly overlay: CanvasRenderingContext2D;
  readonly crosshair: CanvasRenderingContext2D;
}

export interface ChartRenderer {
  /** The single draw entrypoint. Call it only from the scheduler's frame callback. */
  render(mask: DirtyMask, contexts: LayerContexts, input: FrameInput): void;
}

class LayeredChartRenderer implements ChartRenderer {
  readonly #series: SeriesLayer = createSeriesLayer();

  render(mask: DirtyMask, contexts: LayerContexts, input: FrameInput): void {
    if ((mask & DirtyFlags.Grid) !== 0) drawGridLayer(contexts.grid, input);
    if ((mask & DirtyFlags.Series) !== 0) this.#series.draw(contexts.series, input);
    if ((mask & DirtyFlags.Overlay) !== 0) drawOverlayLayer(contexts.overlay, input);
    if ((mask & DirtyFlags.Crosshair) !== 0) drawCrosshairLayer(contexts.crosshair, input);
  }
}

/** Holds the reusable geometry buffers, so create it once per chart, not per frame. */
export function createChartRenderer(): ChartRenderer {
  return new LayeredChartRenderer();
}

export {
  buildFrameInput,
  createAutoscaleCache,
  type AutoscaleCache,
  type FrameInput,
  type FrameInputOptions,
  type PointerState,
} from './frame.js';
export { computeLayout, layoutFromTheme, makeRect, rectBottom, rectContains, rectRight } from './layout.js';
export type { Layout, LayoutOptions, Rect } from './layout.js';
export { fillSpan, snapFill, snapLine, snapStroke } from './pixel.js';
export { createScheduler, DirtyFlags } from './scheduler.js';
export type { DirtyMask, FrameFn, Scheduler, SchedulerOptions } from './scheduler.js';
export { createSurface } from './surface.js';
export type { Surface, SurfaceOptions } from './surface.js';
export { DARK_THEME, LIGHT_THEME } from './theme.js';
export type { Density, Theme, Typography } from './theme.js';
export {
  autoscale,
  expandDegenerate,
  makePriceRange,
  makePriceScale,
  percentBase,
} from './scale/priceScale.js';
export type { PriceRange, PriceScale } from './scale/priceScale.js';
export {
  candleBodyWidth,
  candleGeometry,
  clampBarSpacing,
  makeTimeScale,
  MAX_BAR_SPACING,
  MIN_BAR_SPACING,
  panBy,
  zoomAbout,
} from './scale/timeScale.js';
export type { CandleGeometry, TimeScale, ViewTransform, VisibleRange } from './scale/timeScale.js';
export { makeVolumeScale, maxVolume } from './scale/volumeScale.js';
export type { VolumeScale } from './scale/volumeScale.js';
export {
  chooseTimeUnit,
  formatPrice,
  niceStep,
  priceTicks,
  tickDecimals,
  timeTicks,
} from './scale/ticks.js';
export type { PriceTick, TimeTick, TimeUnit } from './scale/ticks.js';
export { drawGridLayer } from './layers/gridLayer.js';
export { createSeriesLayer } from './layers/seriesLayer.js';
export type { SeriesLayer } from './layers/seriesLayer.js';
export { drawOverlayLayer, overlayPriceExtent } from './layers/overlayLayer.js';
export type { LineOverlay, Overlay, PriceLineOverlay } from './layers/overlayLayer.js';
export { drawCrosshairLayer } from './layers/crosshairLayer.js';
