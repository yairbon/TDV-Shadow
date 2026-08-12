/**
 * FROZEN CONTRACT — the chart control surface (Phase 6).
 *
 * `window.__tdv` is the single seam through which an external agent drives the chart.
 * The MCP server (src/mcp/server.ts) is a thin proxy: every tool call becomes one
 * `page.evaluate` against this interface, so the agent-facing capability and the
 * browser-side implementation can never drift apart — they share this file.
 *
 * Two rules keep the surface honest:
 *
 *   Reads return the geometry the renderer ACTUALLY used for the last frame, not a
 *   recomputation. An agent asking "where is the trendline" must get the pixels that
 *   were painted, or it is debugging a different chart than the one on screen.
 *
 *   Writes go through the same stores as user input and then return the resulting
 *   state. There is no agent-only back door that skips validation, so a drawing an
 *   agent places obeys the same anchor rule as one a human drags.
 */

import type { ChartType } from '../charts/types.js';
import type { IndicatorId, IndicatorParams } from '../indicators/types.js';
import type { Anchor, DrawingKind, MagnetMode } from '../drawings/types.js';
import type { PriceScaleMode, Timeframe } from '../data/types.js';

export interface ViewportState {
  readonly scrollPosition: number;
  readonly barSpacing: number;
  readonly priceScaleMode: PriceScaleMode;
  readonly visibleFrom: number;
  readonly visibleTo: number;
  readonly visibleBars: number;
}

export interface ChartState {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly chartType: ChartType;
  readonly renderer: 'canvas2d' | 'webgl';
  readonly barCount: number;
  readonly viewport: ViewportState;
  readonly indicators: readonly IndicatorHandle[];
  readonly drawings: readonly DrawingHandle[];
  readonly frameCount: number;
  /**
   * Rolling frame-time statistics in CSS ms (10.1). p95 is the number the budget check
   * reads: the SKILL.md budget is about dropped frames, and a mean hides the tail that
   * drops them.
   */
  readonly frameStats: {
    readonly count: number;
    readonly last: number;
    readonly mean: number;
    readonly median: number;
    readonly p95: number;
    readonly max: number;
  };
}

export interface IndicatorHandle {
  readonly handleId: string;
  readonly id: IndicatorId;
  readonly params: IndicatorParams;
  readonly placement: 'overlay' | 'pane';
}

export interface DrawingHandle {
  readonly id: string;
  readonly kind: DrawingKind;
  readonly anchors: readonly Anchor[];
  /** Pixel positions of each anchor in the LAST rendered frame, for verification. */
  readonly anchorPixels: readonly { readonly x: number; readonly y: number }[];
}

/** One row of an indicator's values, as an agent would read a table. */
export interface IndicatorRow {
  readonly barIndex: number;
  readonly time: number;
  readonly values: Readonly<Record<string, number>>;
}

export interface OhlcvRow {
  readonly barIndex: number;
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Result of a spatial self-check — the assertion Phase 3 runs, exposed to agents. */
export interface IntegrityReport {
  /** Non-transparent pixels sampled from the series layer. Zero means a blank chart. */
  readonly painted: number;
  readonly candlesOverlap: boolean;
  readonly outsidePlot: number;
  readonly pageOverflowX: number;
  readonly pageOverflowY: number;
  readonly nonCanvasNodesInPlot: number;
  readonly backingStoreMatchesDpr: boolean;
  readonly ok: boolean;
}

/**
 * The control surface. Every method is synchronous against the last committed frame;
 * mutations schedule a repaint and return the state that will be rendered.
 */
export interface ChartControlApi {
  readonly version: string;

  getState(): ChartState;
  getIntegrityReport(): IntegrityReport;

  setSymbol(symbol: string, timeframe?: Timeframe): ChartState;
  setChartType(type: ChartType): ChartState;
  setPriceScaleMode(mode: PriceScaleMode): ChartState;
  setRenderer(renderer: 'canvas2d' | 'webgl'): ChartState;

  setBarSpacing(spacing: number): ViewportState;
  setScrollPosition(position: number): ViewportState;
  zoomAbout(anchorX: number, factor: number): ViewportState;
  panBars(deltaBars: number): ViewportState;
  fitVisibleRange(from: number, to: number): ViewportState;

  addIndicator(id: IndicatorId, params?: IndicatorParams): IndicatorHandle;
  removeIndicator(handleId: string): boolean;
  /** Reads the computed table; `from`/`to` clamp to the series. */
  readIndicator(handleId: string, from?: number, to?: number): readonly IndicatorRow[];

  drawShape(kind: DrawingKind, anchors: readonly Anchor[], magnet?: MagnetMode): DrawingHandle;
  updateDrawing(id: string, anchors: readonly Anchor[]): DrawingHandle | null;
  removeDrawing(id: string): boolean;
  listDrawings(): readonly DrawingHandle[];
  clearDrawings(): number;

  readOhlcv(from?: number, to?: number): readonly OhlcvRow[];
  /** Data-space -> pixel, through the live scales. For verifying anchoring. */
  projectAnchor(anchor: Anchor): { readonly x: number; readonly y: number };
  /** Pixel -> data-space. The inverse of `projectAnchor`. */
  unprojectPixel(x: number, y: number): Anchor;
}

declare global {
  interface Window {
    __tdv?: ChartControlApi;
  }
}

export const CONTROL_API_VERSION = '1.0.0';
