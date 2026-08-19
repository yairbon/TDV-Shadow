/**
 * The join: store -> scheduler -> renderer. This is the file Phase 2 was missing —
 * both halves composed correctly in memory but nothing drove them against a real canvas.
 *
 * Mandate #3 is enforced structurally here: every input path (pointer, resize, tick)
 * calls `scheduler.invalidate(mask)` and returns. The ONLY call to `renderer.render`
 * is inside the scheduler's frame callback.
 */

import { createSeriesStore, type SeriesStore } from '../data/store/seriesStore.js';
import { createSnapshotSource, type SnapshotSource } from '../data/store/snapshot.js';
import type { Snapshot } from '../data/types.js';
import { createViewStore, type ViewStore } from '../data/store/viewStore.js';
import {
  asBarIndex,
  asPixel,
  asPrice,
  asTimeMs,
  makeBar,
  TIMEFRAME_MS,
  type Bar,
  type PriceScaleMode,
  type TimeMs,
  type Timeframe,
} from '../data/types.js';
import { bindPointer, type PointerBindings } from '../interaction/pointer.js';
import { buildFrameInput, createAutoscaleCache, type FrameInput } from '../renderer/frame.js';
import { makePriceRange, type PriceRange } from '../renderer/scale/priceScale.js';
import type { Overlay } from '../renderer/layers/overlayLayer.js';
import { offsetMinutes } from '../renderer/scale/timezone.js';
import { previousSessionClose } from '../data/agg/previousClose.js';
import {
  computeLayout,
  dividerAt,
  resizePane,
  type Layout,
  type PaneDivider,
  type Rect,
} from '../renderer/layout.js';
import { candleGeometry, MIN_BAR_SPACING } from '../renderer/scale/timeScale.js';
import { maxVolume } from '../renderer/scale/volumeScale.js';
import { createGlSeriesLayer } from '../renderer/webgl/glSeriesLayer.js';
import { drawDerivedSeries } from '../renderer/layers/derivedSeriesLayer.js';
import { createAlertStore, type Alert, type AlertStore } from './alerts.js';
import {
  drawAlerts,
  drawDrawings,
  type AlertGeometry,
  drawIndicatorOverlay,
  drawIndicatorPane,
  type PaneCompanion,
  drawLastPrice,
  drawMeasure,
  drawVolumeProfile,
  drawWatermark,
  type PlotStyles,
} from '../renderer/layers/annotationsLayer.js';
import {
  buildGeometry,
  buildPreviewGeometry,
  constrainToAngle,
  type DrawingGeometry,
} from '../drawings/geometry.js';
import { drawPlacementPreview } from '../renderer/layers/previewLayer.js';
import { hitTest, type Hit } from '../drawings/hitTest.js';
import { snapPixel, type SnapResult } from '../drawings/magnet.js';
import type { Anchor, DrawingKind, MagnetMode } from '../drawings/types.js';
import { createDrawingStore, type DrawingStore } from '../drawings/store.js';
import { timeOf, type ChartType, type ChartTypeParams, type DerivedSeries } from '../charts/types.js';
import { indexAtTime, remapIndex } from '../charts/remap.js';
import { alignByTime, rebase, type ComparisonSeries } from '../charts/compare.js';
import { drawCompareSeries } from '../renderer/layers/compareLayer.js';
import type {
  IndicatorId,
  IndicatorParams,
  IndicatorResult,
  VolumeProfileResult,
} from '../indicators/types.js';
import { computeIndicator, getIndicator } from '../indicators/registry.js';
import { deriveOver, parseIndicatorSource } from '../indicators/derived.js';
import {
  createFeatureState,
  createIndicatorMemo,
  createSeriesMemo,
  splitByPlacement,
  type ActiveIndicator,
} from './features.js';
import { createChartRenderer, type LayerContexts } from '../renderer/index.js';
import { createScheduler, DirtyFlags, type DirtyMask } from '../renderer/scheduler.js';
import { createSurface, type Surface } from '../renderer/surface.js';
import { DARK_THEME, type Theme } from '../renderer/theme.js';
import type { TimeZone } from '../renderer/scale/timezone.js';
import { createChartCanvases, type ChartCanvases, type LayerName } from '../ui/chartCanvas.js';
import { snapLine } from '../renderer/pixel.js';

/**
 * Indicators that render in their own pane rather than over the price plot.
 *
 * Read from each definition's own `placement` rather than listed here. A hand-kept list
 * is a list that goes stale, and this one had: the six pane indicators added in Tier 3
 * computed correctly, printed their values in the legend, and were allocated no pane to
 * draw in — visible only as a legend row for a plot that was nowhere on the chart.
 */
const isPaneIndicator = (id: IndicatorId): boolean => getIndicator(id).placement === 'pane';

export type RendererMode = 'canvas2d' | 'webgl';

/** Presentation settings that change no data and force no rebuild. */
export interface ChartSettings {
  readonly theme: Theme;
  /** IANA zone for time LABELS (10.2). The data stays UTC epoch ms. */
  readonly timeZone: TimeZone;
  /** Decimal cap for price labels. */
  readonly pricePrecision: number;
  readonly showGrid: boolean;
  /** Empty bars kept to the right of the newest one when snapped to realtime. */
  readonly rightMargin: number;
  /**
   * Draw a dashed line at the previous session's close, as TradingView does.
   *
   * On by default: it is the level every other price on the chart is read against, and a
   * chart without it makes the reader estimate today's move by eye.
   */
  readonly showPreviousClose: boolean;
}

export interface ChartOptions {
  readonly container: HTMLElement;
  readonly symbol: string;
  readonly tf: Timeframe;
  readonly bars: readonly Bar[];
  readonly barSpacing?: number;
  readonly theme?: Theme;
  readonly pricePrecision?: number;
  /**
   * 'webgl' moves ONLY the series layer to the GPU (RENDER_ALGORITHMS §11). Grid,
   * axes, overlays and crosshair stay Canvas2D either way, and Canvas2D remains the
   * reference implementation. Linear price scale only.
   */
  readonly renderer?: RendererMode;
  readonly priceScaleMode?: PriceScaleMode;
  /** Restored pane heights (Tier 2 resizable panes). Absent means the default split. */
  readonly paneFractions?: readonly number[];
  /** Restores pan/zoom across a renderer swap, which has to rebuild the chart. */
  readonly scrollPosition?: number;
  readonly chartType?: ChartType;
}

/**
 * Rolling frame-time statistics.
 *
 * p95 rather than the mean: the budget in skills/chart-render/SKILL.md is about dropped
 * frames, and a mean hides exactly the tail that drops them.
 */
/** The view half of a Snapshot — everything except the series. */
function viewFieldsOf(snapshot: Snapshot): Omit<Snapshot, 'series'> {
  return {
    scrollPosition: snapshot.scrollPosition,
    barSpacing: snapshot.barSpacing,
    priceScaleMode: snapshot.priceScaleMode,
    revision: snapshot.revision,
  };
}

/** Counters for work that is O(series length) and therefore must be memoised. */
export interface WorkStats {
  /** Chart-type transforms actually run (cache misses). */
  readonly seriesTransforms: number;
  /** Indicator computations actually run (cache misses). */
  readonly indicatorComputes: number;
  /** GL instance-buffer uploads. */
  readonly glUploads: number;
}

export interface FrameStats {
  readonly count: number;
  readonly last: number;
  readonly mean: number;
  /** p50. The typical frame — robust to the odd GC pause the mean is not. */
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

/** Per-candle geometry actually used for the last frame — the Phase 3 assertion hook. */
export interface CandleGeometryDump {
  readonly index: number;
  readonly centreX: number;
  readonly width: number;
  readonly mode: 'body' | 'line';
}

export interface GeometryDump {
  readonly dpr: number;
  readonly plot: Rect;
  /**
   * The volume pane, or null when the layout has no room for one.
   *
   * Exposed because it is the only band of the series layer that no `candles` entry
   * describes, so without it a test cannot tell "the volume pane is empty" from "the
   * volume pane is somewhere else".
   */
  readonly volume: Rect | null;
  readonly backingStore: Readonly<Record<LayerName, { width: number; height: number }>>;
  readonly cssSize: { width: number; height: number };
  readonly visible: { from: number; to: number; count: number };
  /**
   * Bars in the index space that was RENDERED. For a resampling chart type this is the
   * brick count, which is the whole point of 10.3 and not something the source series
   * can answer.
   */
  readonly barCount: number;
  readonly candles: readonly CandleGeometryDump[];
  readonly frameCount: number;
}

/** A drawing mid-placement: what is pinned, and where the cursor is. */
export interface Placement {
  readonly kind: DrawingKind;
  /** Anchors already clicked. Empty means the tool is armed but nothing is pinned. */
  readonly placed: readonly Anchor[];
  /** Where the cursor is now, in DATA space — the anchor rule holds for the preview too. */
  readonly cursor: Anchor;
}

export interface Chart {
  readonly series: SeriesStore;
  readonly drawings: DrawingStore;
  readonly alerts: AlertStore;
  /** Fired alerts, in order, since the listener was attached (9.2). */
  onAlert(listener: (alert: Alert) => void): () => void;
  /** Alert nearest `y` within `tolerance` CSS px, for dragging. */
  alertAt(y: number, tolerance?: number): Alert | null;
  /** Active chart type; resampling types are excluded from the app picker (see below). */
  chartType(): ChartType;
  setChartType(type: ChartType, params?: ChartTypeParams): void;
  addIndicator(id: IndicatorId, params?: IndicatorParams, styles?: PlotStyles): ActiveIndicator;
  /**
   * Re-parameterises or re-styles a live indicator in place, keeping its handle and its
   * position in the pane stack. Replacing it with a remove+add would move a pane
   * indicator to the bottom of the stack every time a period changed.
   */
  updateIndicator(
    handleId: string,
    patch: { readonly params?: IndicatorParams; readonly styles?: PlotStyles },
  ): ActiveIndicator | null;
  removeIndicator(handleId: string): boolean;
  listIndicators(): readonly ActiveIndicator[];
  /**
   * The computed result for one live indicator, exactly as the renderer sees it.
   *
   * Exposed because an indicator's values are not a function of its id and params alone —
   * one reading another indicator's output is resolved against the live stack — so a
   * caller that recomputed from the handle would report a different curve from the one on
   * screen. It was doing precisely that.
   */
  indicatorResult(handleId: string): IndicatorResult | null;
  /**
   * The handle of the pane this indicator is drawn into, or null when it has its own home
   * (its own pane, or the price plot).
   *
   * `placement` alone stopped being the answer once an indicator could be computed from
   * another: an SMA is an overlay, but an SMA of an RSI is drawn in the RSI's pane, and
   * nothing outside the frame loop could say so.
   */
  indicatorPaneHost(handleId: string): string | null;
  /** Geometry of every drawing in the last frame — used for anchor verification. */
  drawingGeometry(): readonly DrawingGeometry[];
  /**
   * Hit-tests the drawings against the LAST PAINTED geometry. Pixels, because "near the
   * cursor" is a pixel notion — a price tolerance feels tight zoomed out and loose in.
   */
  hitTestAt(x: number, y: number, tolerance?: number): Hit | null;
  /** Indicator readouts at a bar, for the legend. */
  indicatorValuesAt(index: number): readonly {
    readonly handleId: string;
    readonly label: string;
    readonly values: readonly { readonly key: string; readonly value: number }[];
  }[];
  /** Vertical price-axis zoom: >1 compresses the range, <1 expands it. */
  setPriceZoom(factor: number): void;
  /** §2.1 price-axis inversion — high prices at the bottom. */
  setPriceInverted(on: boolean): void;
  priceInverted(): boolean;
  /** Chart settings that used to require a full rebuild. */
  settings(): ChartSettings;
  updateSettings(patch: Partial<ChartSettings>): void;
  /**
   * Replay (9.3): renders the series as it stood at `index`, or live when null.
   *
   * A VIEW truncation, never a data mutation — the store stays append-only and the bars
   * beyond the cursor are still there, which is what makes stepping forward free and
   * leaving replay instant.
   */
  setReplayAt(index: number | null): void;
  replayAt(): number | null;
  /**
   * The measurement ruler (9.1). Anchors are in DATA space like every drawing, so a
   * measurement taken then zoomed still spans the same bars and the same prices.
   */
  /**
   * The drawing being placed right now, or null when nothing is being placed.
   *
   * Anchors already clicked plus wherever the cursor is. The chart owns this so the
   * renderer can paint it: before, the in-progress anchors lived only in the app shell
   * and nothing on the canvas knew a drawing was underway, so clicking the first point
   * of a trendline changed not a single pixel.
   */
  setPlacement(placement: Placement | null): void;
  /**
   * Overlays a second instrument's relative performance, or clears it.
   *
   * The chart does not fetch: the caller owns loading, so this takes bars. Both series
   * are re-based to 0% at the left edge of the view and drawn against the SAME axis, via
   * the primary's own price scale — see `compareY` for why that is the honest choice.
   */
  setCompare(compare: { readonly symbol: string; readonly bars: readonly Bar[] } | null): void;
  /**
   * How the comparison is drawn: as a percent of the primary on the shared axis, or in
   * its own prices against a second axis on the left.
   *
   * Percent is the default because it is what makes two instruments comparable at all —
   * AAPL near 300 and SPY near 770 on one price axis flattens whichever has the smaller
   * range. Own-scale exists for reading the compared instrument's actual prices.
   */
  setCompareScale(scale: 'percent' | 'own'): void;
  compareScale(): 'percent' | 'own';
  /**
   * The domain the last frame gave the left axis, or null when there is no second scale.
   *
   * Reported rather than recomputed on demand: the axis is autoscaled from the aligned
   * comparison memo, which only exists as of the frame that built it, so anything derived
   * here after the fact would be answering about a different window than the one on screen.
   */
  leftPriceRange(): PriceRange | null;
  /**
   * The pane divider within `tolerance` px of `y`, or null — for the cursor and for
   * starting a drag. Y is CSS px relative to the chart container.
   */
  dividerAt(y: number, tolerance?: number): PaneDivider | null;
  /** Drags divider `index` to `y`, relaying out. Clamped; a no-op if nothing moves. */
  dragDivider(index: number, y: number): void;
  /** Current pane heights, or null while they are still the default split. */
  paneFractions(): readonly number[] | null;
  resetPanes(): void;
  compareSymbol(): string | null;
  setMeasure(measure: { readonly from: Anchor; readonly to: Anchor } | null): void;
  measure(): { readonly from: Anchor; readonly to: Anchor } | null;
  priceZoom(): number;
  resetPriceZoom(): void;
  /** True when the view has been scrolled away from the newest bar. */
  isScrolledBack(): boolean;
  scrollToRealtime(): void;
  /** Re-fits the whole series to the pane. */
  fitAll(): void;
  /** CSS pixel (relative to the container) -> data-space anchor, with optional magnet. */
  pickAnchor(x: number, y: number, magnet?: MagnetMode): SnapResult;
  /**
   * `to`, rotated to the nearest 45° about `from` — TradingView's Shift behaviour.
   *
   * Lives on the chart because the snap is a PIXEL property: the same two anchors
   * subtend a different visual angle at every zoom and on a log scale, so constraining
   * in data space would drift off 45° as soon as the user zoomed. The projectors are
   * here, so the conversion happens here.
   */
  constrainAnchor(from: Anchor, to: Anchor): Anchor;
  /** Data-space anchor -> CSS pixel, through the live scales. */
  projectAnchor(anchor: Anchor): { readonly x: number; readonly y: number };
  readonly layout: () => Layout;
  readonly view: ViewStore;
  readonly snapshots: SnapshotSource;
  /**
   * Places the crosshair from ANOTHER chart (10.4 sync), by TIME. Null clears it, and
   * the chart's own pointer always wins.
   *
   * Not by pixel, because panes show different symbols at different zooms and a shared
   * pixel points at unrelated bars. Not by bar index either, which is what this used to
   * take: index `i` is only the same moment in two panes when both hold the same series
   * at the same timeframe. Point one pane at 5m and another at 1H, or put a Renko series
   * next to candles, and the synced line lands somewhere arbitrary — or off the end of a
   * shorter series, where it does not appear at all. Time is the only coordinate the
   * panes genuinely share; each one converts it to its own index.
   */
  setExternalTime(time: TimeMs | null): void;
  /**
   * The moment at an index of the space this chart is RENDERING — brick time under a
   * resampling type, bar time otherwise. Null when the index is off the end.
   *
   * This is the other half of `setExternalTime`: the pane under the cursor converts its
   * index to a time, the others convert that time back to their own index.
   */
  timeAtIndex(index: number): TimeMs | null;
  /**
   * Applies a live bar and schedules a repaint. Never draws.
   *
   * Replaces the last bar when the open matches and appends when it is newer, so the
   * same call carries both a tick inside the current bar and the roll into the next one.
   * An older bar, or one identical to what is stored, is dropped.
   */
  pushTick(bar: Bar): void;
  geometry(): GeometryDump | null;
  /** Rolling frame-time statistics in CSS ms — the 10.1 budget check reads these. */
  frameStats(): FrameStats;
  resetFrameStats(): void;
  /**
   * How much O(series) work has actually been done, as counters.
   *
   * Wall-clock alone cannot distinguish "the renderer recomputes everything each frame"
   * from "this machine is slow"; these can. They are the deterministic half of the 10.1
   * budget check.
   */
  workStats(): WorkStats;
  dispose(): void;
}

const LAYOUT_CHROME = {
  priceGutterWidth: 68,
  timeGutterHeight: 28,
  volumePaneFraction: 0.22,
  paneGap: 6,
  minPlotHeight: 80,
} as const;

export function createChart(o: ChartOptions): Chart {
  // Mutable so chart settings can change colours, precision, grid and right margin
  // without tearing the chart down. Rebuilding lost pan, zoom, selection and history.
  let theme = o.theme ?? DARK_THEME;
  let pricePrecision = o.pricePrecision ?? 2;
  let showGrid = true;
  let rightMargin = 2;
  let timeZone: TimeZone = 'UTC';
  let showPreviousClose = true;
  const canvases = createChartCanvases(o.container);

  const series = createSeriesStore({
    symbol: o.symbol,
    tf: o.tf,
    initialBars: o.bars,
    state: 'live',
  });
  const view = createViewStore({
    barSpacing: o.barSpacing ?? 8,
    scrollPosition: o.scrollPosition ?? Math.max(0, o.bars.length - 1),
    priceScaleMode: o.priceScaleMode ?? 'linear',
  });
  const snapshots = createSnapshotSource(series, view);
  const renderer = createChartRenderer();
  const autoscaleCache = createAutoscaleCache();

  const features = createFeatureState();
  features.chartType = o.chartType ?? 'candles';
  const drawings = createDrawingStore();
  const alerts = createAlertStore();
  const alertListeners = new Set<(alert: Alert) => void>();
  const seriesMemo = createSeriesMemo();
  const indicatorMemo = createIndicatorMemo();

  /**
   * One indicator's result, computed over the chart's bars or over another indicator's.
   *
   * `params.source` normally names a price field; when it reads `"<handleId>:<plotKey>"`
   * it names a plot of an indicator ALREADY on the chart, whose output is fed in as the
   * price series (see `derived.ts`).
   *
   * The source must sit EARLIER in the stack than the indicator reading it. That single
   * rule makes a cycle structurally impossible rather than something to detect and
   * recover from, and it matches how the feature is reached: you apply an indicator to
   * one that is already there. A source that is missing, later in the stack, or names a
   * plot that does not exist falls back to the chart's own bars — a wrong curve is worse
   * than an unsurprising one.
   */
  /**
   * The indicator whose output `indicator` reads, or null when it reads price.
   *
   * The source must sit EARLIER in the stack than the indicator reading it. That single
   * rule makes a cycle structurally impossible rather than something to detect and
   * recover from, and it matches how the feature is reached: you apply an indicator to
   * one that is already there. A source that is missing, later in the stack, or names a
   * plot that does not exist falls back to price — a wrong curve is worse than a plain one.
   */
  const parentOf = (
    indicator: ActiveIndicator,
  ): { readonly parent: ActiveIndicator; readonly plotKey: string } | null => {
    const source = parseIndicatorSource(indicator.params.source);
    if (source === null) return null;
    const stack = features.indicators;
    const parentAt = stack.findIndex((i) => i.handleId === source.handleId);
    if (parentAt < 0) return null;
    const selfAt = stack.findIndex((i) => i.handleId === indicator.handleId);
    if (selfAt >= 0 && parentAt >= selfAt) return null;
    return { parent: stack[parentAt], plotKey: source.plotKey };
  };

  /**
   * Cache key for an indicator, INCLUDING everything it is computed from.
   *
   * Recursive, and that is the point: a child's own params do not change when its parent's
   * period does, and neither do a grandchild's when the grandparent's does. Keying one
   * level up would leave a three-deep stack serving a curve derived from a series that no
   * longer exists.
   */
  const keyFor = (indicator: ActiveIndicator): string => {
    const link = parentOf(indicator);
    return link === null
      ? indicatorMemo.keyOf(indicator.id, indicator.params)
      : indicatorMemo.keyOf(indicator.id, indicator.params, keyFor(link.parent));
  };

  /**
   * The pane-placed indicator whose rect this one should share, or null for its own home.
   *
   * An overlay indicator draws wherever its SOURCE lives. A moving average of an RSI is in
   * the RSI's units, so drawing it over the price plot puts it hundreds of points off the
   * visible range — clipped away entirely, which is how it first shipped. An indicator
   * with a pane of its own (an RSI of an SMA) keeps that pane: its units are its own.
   */
  const paneHostOf = (indicator: ActiveIndicator): ActiveIndicator | null => {
    if (getIndicator(indicator.id).placement === 'pane') return null;
    const link = parentOf(indicator);
    if (link === null) return null;
    return getIndicator(link.parent.id).placement === 'pane' ? link.parent : paneHostOf(link.parent);
  };

  /** One indicator's result, over the chart's bars or over another indicator's output. */
  const resultFor = (
    indicator: ActiveIndicator,
    bars: readonly Bar[],
    revision: number,
  ): IndicatorResult => {
    const link = parentOf(indicator);
    if (link === null) {
      return indicatorMemo.compute(
        indicator.handleId,
        revision,
        indicator.id,
        indicator.params,
        bars,
      );
    }
    const parentResult = resultFor(link.parent, bars, revision);
    return indicatorMemo.memo(indicator.handleId, revision, keyFor(indicator), () => {
      const derived = deriveOver(bars, parentResult, link.plotKey, (over) =>
        computeIndicator(indicator.id, over, indicator.params),
      );
      return derived ?? computeIndicator(indicator.id, bars, indicator.params);
    });
  };
  let handleCounter = 0;
  let lastGeometry: readonly DrawingGeometry[] = [];
  /** Alert pixel positions from the last frame — the same trick hit-testing drawings uses. */
  let lastAlertGeometry: readonly AlertGeometry[] = [];
  let priceZoom = 1;
  let priceInverted = false;
  let measure: { readonly from: Anchor; readonly to: Anchor } | null = null;
  let placement: Placement | null = null;
  let compare: { readonly symbol: string; readonly bars: readonly Bar[] } | null = null;
  let compareScale: 'percent' | 'own' = 'percent';
  /** What `leftRange` returned on the last frame; see the handle's doc comment. */
  let lastLeftRange: PriceRange | null = null;
  /**
   * Memo for the aligned comparison.
   *
   * `alignByTime` is O(n + m) but that is still 200k operations at full history, and it
   * only changes when the data or the compared instrument does — never merely because the
   * user panned. The rebase is keyed separately because it DOES change with the view.
   */
  let compareCache: {
    key: string;
    baseIndex: number;
    aligned: ComparisonSeries;
    based: ComparisonSeries;
  } | null = null;
  let externalPointerTime: number | null = null;
  let replayIndex: number | null = null;
  /** Memo for the truncated snapshot; slicing 100k bars every frame is not free. */
  let replayCache: { key: string; snapshot: Snapshot } | null = null;
  /** Memo for the rendered index space's timestamps, keyed on the snapshot's identity. */
  let renderedTimesCache: { snapshot: Snapshot; times: readonly number[] } | null = null;

  /**
   * Identity of the DATA a memo depends on: the bars, and how far replay has truncated
   * them. Deliberately not `snapshot.revision`, which is a combined series+view counter
   * and therefore changes on every pan and every zoom — keying the chart-type transform,
   * the indicator computations and the GL instance upload on it meant none of those
   * memos ever hit while the user was scrolling. At 100k bars that alone was ~9.5ms per
   * frame, most of the budget, for work whose inputs had not changed.
   */
  let dataRev = 0;
  let lastSeriesRev = -1;
  let lastReplayRev: number | null = -1;
  const dataRevision = (): number => {
    const current = series.revision();
    if (current !== lastSeriesRev || replayIndex !== lastReplayRev) {
      lastSeriesRev = current;
      lastReplayRev = replayIndex;
      dataRev += 1;
    }
    return dataRev;
  };

  /**
   * User-chosen heights for the stacked panes, or null for the default split.
   *
   * Null rather than the computed defaults so that "never dragged" stays distinguishable
   * from "dragged back to roughly the default": the former must keep following the
   * default rules as panes are added and removed, and the latter must not.
   */
  let paneFractions: readonly number[] | null = o.paneFractions ?? null;

  const layoutOptions = (cssWidth: number, cssHeight: number) => ({
    width: Math.max(1, cssWidth),
    height: Math.max(1, cssHeight),
    ...LAYOUT_CHROME,
    extraPanes: paneCount(),
    ...(paneFractions === null ? {} : { paneFractions }),
    // Reserved only when a comparison is actually being read in its own units. An axis
    // with nothing assigned to it is dead width taken from the plot.
    leftPriceGutterWidth: compare !== null && compareScale === 'own' ? LAYOUT_CHROME.priceGutterWidth : 0,
  });

  let layout: Layout = computeLayout({
    width: Math.max(1, o.container.clientWidth),
    height: Math.max(1, o.container.clientHeight),
    ...LAYOUT_CHROME,
  });
  let cssSize = { width: o.container.clientWidth, height: o.container.clientHeight };
  let lastInput: FrameInput | null = null;
  let frameCount = 0;
  /** Ring buffer of frame durations; fixed size so measuring never allocates. */
  const frameTimes = new Float64Array(240);
  let frameTimeCount = 0;

  // --- surfaces -----------------------------------------------------------
  /** Pane indicators each get their own rect; the count drives the layout. */
  const paneCount = (): number =>
    features.indicators.filter((i) => isPaneIndicator(i.id)).length;

  const relayout = (cssWidth: number, cssHeight: number): Layout =>
    computeLayout(layoutOptions(cssWidth, cssHeight));

  const onResize = (cssWidth: number, cssHeight: number): void => {
    layout = relayout(cssWidth, cssHeight);
    scheduler.invalidate(DirtyFlags.All); // never draws — mandate #3
  };

  // autoObserve is off for every layer: a per-canvas ResizeObserver would have each
  // layer watching the element whose backing store it also writes, and four of them
  // would race. The container is the single source of truth for size, so it is
  // observed once here and all four layers are resized together.
  const noObserve = { onResize: () => undefined, autoObserve: false } as const;
  const useGl = (o.renderer ?? 'canvas2d') === 'webgl';

  // A canvas can hold exactly one context type, so in GL mode the series canvas gets a
  // webgl2 context and no Surface. Its backing store is then sized here instead of by
  // Surface — same §1 rule, different owner.
  const glLayer = useGl ? createGlSeriesLayer(canvases.canvases.series) : null;

  const surfaces = {
    grid: createSurface(canvases.canvases.grid, noObserve),
    series: useGl ? null : createSurface(canvases.canvases.series, noObserve),
    overlay: createSurface(canvases.canvases.overlay, noObserve),
    crosshair: createSurface(canvases.canvases.crosshair, noObserve),
  } satisfies Record<LayerName, Surface | null>;

  const liveSurfaces = (): Surface[] =>
    Object.values(surfaces).filter((s): s is Surface => s !== null);

  const applySize = (cssWidth: number, cssHeight: number): void => {
    const w = Math.max(1, Math.floor(cssWidth));
    const h = Math.max(1, Math.floor(cssHeight));
    cssSize = { width: w, height: h };
    for (const surface of liveSurfaces()) surface.resize(w, h);
    if (glLayer !== null) {
      const canvas = canvases.canvases.series;
      const ratio = window.devicePixelRatio;
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    onResize(w, h);
  };

  const containerObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            applySize(entry.contentRect.width, entry.contentRect.height);
          }
        });
  containerObserver?.observe(o.container);

  const contexts: LayerContexts = {
    grid: surfaces.grid.ctx,
    // In GL mode the series canvas has no 2D context. The Series bit is stripped from
    // the mask below, so the renderer never touches this slot; the overlay context
    // stands in only to satisfy the shape.
    series: surfaces.series?.ctx ?? surfaces.overlay.ctx,
    overlay: surfaces.overlay.ctx,
    crosshair: surfaces.crosshair.ctx,
  };

  const drawGlSeries = (input: FrameInput): void => {
    if (glLayer === null) return;
    const bars = input.snapshot.series.bars;
    const { visible, priceScale } = input;
    glLayer.draw({
      bars,
      from: visible.from,
      to: visible.to,
      plot: input.layout.plot,
      volume: input.layout.volume,
      priceMin: priceScale.min,
      priceMax: priceScale.max,
      scaleMode: input.snapshot.priceScaleMode,
      inverted: priceInverted,
      volumeMax: visible.isEmpty ? 0 : maxVolume(bars, visible.from, visible.to),
      barSpacing: input.timeScale.barSpacing,
      scrollPosition: input.timeScale.scrollPosition,
      theme,
      revision: dataRevision(),
      cssWidth: surfaces.grid.cssWidth,
      cssHeight: surfaces.grid.cssHeight,
      dpr: surfaces.grid.ratio,
    });
  };

  /**
   * Indicator plots and drawings, painted onto the overlay layer AFTER the renderer has
   * cleared it. Pane indicators take over the volume pane rect: one pane at a time keeps
   * the layout honest without inventing a pane-stacking system the layout does not have.
   */
  /**
   * Draws the comparison overlay, if one is set.
   *
   * Both instruments are re-based to 0% at the LEFT EDGE of the visible window, and the
   * comparison's percent is projected back through the primary's own price scale — the
   * price the primary would be at, had it moved by that percent from the same base. That
   * is what makes one axis honest for two instruments: AAPL near 300 and SPY near 770 on
   * one linear price scale would flatten whichever has the smaller range into a straight
   * line. Going through the existing scale rather than inventing a second one also means
   * log mode and axis inversion apply to the comparison for free.
   */
  const drawComparison = (
    ctx: CanvasRenderingContext2D,
    input: FrameInput,
    overlayInput: { x(index: number): number; readonly x0: number; readonly dx: number },
  ): void => {
    const active = compare;
    if (active === null) return;
    const bars = input.snapshot.series.bars;
    if (bars.length === 0) return;

    // The base is the visible window's left edge, so the reading is "since what you can
    // see" — which is what a comparison is for, and why the key includes it: a pan that
    // moves the left edge genuinely changes the answer, while a pan that does not must
    // not rebuild a 100k array.
    const baseIndex = input.visible.from;
    const key = `${String(dataRevision())}:${active.symbol}:${String(active.bars.length)}`;
    const cached = compareCache;
    const hit = cached !== null && cached.key === key ? cached : null;
    const aligned = hit === null ? alignByTime(bars, active.bars) : hit.aligned;
    const based = hit !== null && hit.baseIndex === baseIndex ? hit.based : rebase(aligned, baseIndex);
    compareCache = { key, baseIndex, aligned, based };
    if (based.from < 0) return;

    const basePrice = bars[Math.min(bars.length - 1, Math.max(0, baseIndex))].c;
    if (!(basePrice > 0)) return;

    // Two ways to read the same series. On the shared axis it is projected back through
    // the PRIMARY's scale as "the price the primary would be at, had it moved this much";
    // on its own axis it is drawn in its own prices, which is what the left gutter labels.
    const left = input.leftPriceScale;
    const y =
      left === null
        ? (percent: number) => input.priceScale.y(asPrice(basePrice * (1 + percent / 100)))
        : (percent: number) => left.y(asPrice(based.base * (1 + percent / 100)));

    drawCompareSeries(ctx, {
      percent: based.percent,
      plot: input.layout.plot,
      from: input.visible.from,
      to: input.visible.to,
      y,
      x: (i) => overlayInput.x(i),
      x0: overlayInput.x0,
      dx: overlayInput.dx,
      color: theme.downBody,
      label: active.symbol,
      theme,
    });
  };

  const drawAnnotations = (input: FrameInput, mask: DirtyMask): void => {
    if ((mask & DirtyFlags.Overlay) === 0) return;
    const ctx = surfaces.overlay.ctx;
    const bars = input.snapshot.series.bars;
    const revision = dataRevision();

    const overlayInput = {
      plot: input.layout.plot,
      theme,
      from: input.visible.from,
      to: input.visible.to,
      x: (i: number) => input.timeScale.x(asBarIndex(i)),
      // §5 as an affine pair, for the dense paths: X(i) = P.l + P.w - (k - i) * s.
      x0:
        input.layout.plot.left +
        input.layout.plot.width -
        input.timeScale.scrollPosition * input.timeScale.barSpacing,
      dx: input.timeScale.barSpacing,
    };
    const priceScale = { y: (value: number) => input.priceScale.y(asPrice(value)) };

    const { overlays, panes } = splitByPlacement(features.indicators, (indicator) =>
      resultFor(indicator, bars, revision),
    );

    // Overlays that belong in someone else's pane are taken out of the price plot and
    // handed to that pane below.
    const adopted = new Map<string, PaneCompanion[]>();
    const priceOverlays: { indicator: ActiveIndicator; result: IndicatorResult }[] = [];
    for (const entry of overlays) {
      const host = paneHostOf(entry.indicator);
      if (host === null) {
        priceOverlays.push(entry);
        continue;
      }
      const list = adopted.get(host.handleId) ?? [];
      list.push({ result: entry.result, styles: entry.indicator.styles });
      adopted.set(host.handleId, list);
    }

    for (const { indicator, result } of priceOverlays) {
      if (result.id === 'volume-profile') {
        drawVolumeProfile(ctx, result as VolumeProfileResult, overlayInput, priceScale);
        continue;
      }
      drawIndicatorOverlay(ctx, result, overlayInput, priceScale, indicator.styles);
    }

    drawComparison(ctx, input, overlayInput);

    // One rect per pane indicator, stacked under the volume pane. Panes beyond what the
    // layout could fit are simply not drawn rather than overlapping each other.
    const rects = input.layout.panes;
    const geometry = candleGeometry(input.timeScale.barSpacing);
    for (let i = 0; i < panes.length && i < rects.length; i++) {
      const rect = rects[i];
      ctx.save();
      ctx.fillStyle = theme.background;
      ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
      ctx.strokeStyle = theme.axisLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.left, snapLine(rect.top));
      ctx.lineTo(rect.left + rect.width, snapLine(rect.top));
      ctx.stroke();
      ctx.restore();

      drawIndicatorPane(
        ctx,
        panes[i].result,
        overlayInput,
        rect,
        geometry.width,
        panes[i].indicator.styles,
        adopted.get(panes[i].indicator.handleId) ?? [],
      );

      // Pane title, so three stacked oscillators are still tellable apart.
      ctx.save();
      ctx.font = theme.typography.font;
      ctx.fillStyle = theme.axisText;
      ctx.textBaseline = 'top';
      ctx.fillText(panes[i].indicator.id.toUpperCase(), rect.left + 6, rect.top + 4);
      ctx.restore();
    }

    // `visible: false` is part of the store contract and reachable through loadJSON, but
    // nothing honoured it — a restored hidden drawing painted anyway. Filtering here also
    // keeps it out of `lastGeometry`, so a hidden shape cannot be hit-tested either.
    const geometries = drawings.list().filter((drawing) => drawing.visible).map((drawing) =>
      buildGeometry(
        drawing,
        { y: (price) => input.priceScale.y(asPrice(price)), price: (y) => input.priceScale.price(asPixel(y)) },
        { x: (i) => input.timeScale.x(asBarIndex(i)), indexAt: (x) => input.timeScale.indexAt(asPixel(x)) },
        input.layout.plot,
      ),
    );
    lastGeometry = geometries;
    drawDrawings(ctx, geometries, input.layout.plot, theme, drawings.selected());

    lastAlertGeometry = alerts.forSymbol(o.symbol).map((alert) => ({
      id: alert.id,
      y: input.priceScale.y(asPrice(alert.price)),
      price: alert.price,
      triggered: alert.triggered,
    }));
    drawAlerts(
      ctx,
      lastAlertGeometry,
      input.layout.plot,
      input.layout.priceGutter,
      theme,
      pricePrecision,
    );

    if (bars.length > 0) {
      const last = bars[bars.length - 1];
      drawLastPrice(
        ctx,
        last.c,
        last.c >= last.o,
        input.layout.plot,
        input.layout.priceGutter,
        theme,
        priceScale,
        pricePrecision,
      );
    }
  };

  /**
   * The measurement ruler, painted after the crosshair layer has been cleared.
   *
   * Elapsed time comes from the BAR TIMES when both ends land on real bars, and falls
   * back to `bars * timeframeMs` only past the end of the series — where the ruler is
   * measuring into empty space and there is no bar to read a time from.
   */
  /**
   * Paints the drawing being placed, on the CROSSHAIR layer.
   *
   * That layer, not the overlay: mandate #2 says every frame clears its layer, and the
   * crosshair already clears and repaints on every pointer move — which is exactly the
   * cadence a shape that follows the cursor needs. The overlay only repaints when the
   * data or the committed annotations change, so a rubber band drawn there would smear.
   */
  const drawPlacementOverlay = (input: FrameInput): void => {
    const active = placement;
    if (active === null) return;
    const geometry = buildPreviewGeometry(
      active.kind,
      active.placed,
      active.cursor,
      { y: (p) => input.priceScale.y(asPrice(p)), price: (y) => input.priceScale.price(asPixel(y)) },
      {
        x: (i) => input.timeScale.x(asBarIndex(i)),
        indexAt: (x) => input.timeScale.indexAt(asPixel(x)),
      },
      input.layout.plot,
    );
    drawPlacementPreview(surfaces.crosshair.ctx, geometry, input.layout.plot, theme);
  };

  const drawMeasureOverlay = (input: FrameInput): void => {
    const m = measure;
    if (m === null) return;
    const bars = input.snapshot.series.bars;
    const project = (anchor: Anchor): { x: number; y: number } => ({
      x: input.timeScale.x(asBarIndex(anchor.barIndex)),
      y: input.priceScale.y(asPrice(anchor.price)),
    });

    const barCount = Math.round(m.to.barIndex - m.from.barIndex);
    const priceDelta = m.to.price - m.from.price;
    const percentDelta = m.from.price === 0 ? 0 : (priceDelta / m.from.price) * 100;

    const i0 = Math.round(m.from.barIndex);
    const i1 = Math.round(m.to.barIndex);
    const inRange = (i: number): boolean => i >= 0 && i < bars.length;
    const spanMs =
      inRange(i0) && inRange(i1)
        ? bars[i1].t - bars[i0].t
        : barCount * TIMEFRAME_MS[input.snapshot.series.tf];

    drawMeasure(
      surfaces.crosshair.ctx,
      {
        from: project(m.from),
        to: project(m.to),
        priceDelta,
        percentDelta,
        bars: Math.abs(barCount),
        elapsed: formatElapsed(Math.abs(spanMs)),
        pricePrecision,
      },
      input.layout.plot,
      theme,
    );
  };

  // --- the single draw entrypoint ----------------------------------------
  /**
   * The snapshot the renderer sees: the live one, or a prefix of it during replay.
   *
   * Truncating here rather than at each layer means autoscale, the visible range, the
   * indicators and the drawings all agree about where the series ends — an indicator that
   * kept computing past the replay cursor would leak the future into the past.
   */
  const visibleSnapshot = (): Snapshot => {
    const base = snapshots.snapshot();
    const index = replayIndex;
    if (index === null) return base;

    const end = Math.max(0, Math.min(base.series.bars.length - 1, Math.round(index)));
    const key = `${String(base.revision)}:${String(end)}`;
    const hit = replayCache;
    if (hit !== null && hit.key === key) return hit.snapshot;

    const snapshot: Snapshot = Object.freeze({
      ...base,
      series: Object.freeze({ ...base.series, bars: base.series.bars.slice(0, end + 1) }),
    });
    replayCache = { key, snapshot };
    return snapshot;
  };

  /**
   * Renders a resampling chart type (Renko, Kagi, P&F, Line Break, Range) in ITS OWN
   * index space (10.3).
   *
   * These types produce a different number of bars than the source, which is why they
   * were kept out of the picker: the axis, the autoscale, the crosshair and the drawings
   * all index the snapshot, so a source-indexed axis under a derived-indexed series
   * mislabels every bar. Rebuilding the snapshot from the derived bars — with each one's
   * timestamp resolved back through `sourceIndex` — makes every consumer agree, because
   * there is exactly one index space again rather than two.
   *
   * A brick's volume is the sum of the source bars it spans; see the loop below.
   */
  let resampledCache: { key: string; snapshot: Snapshot } | null = null;
  const resampledSnapshot = (base: Snapshot, derived: DerivedSeries, key: string): Snapshot => {
    const hit = resampledCache;
    if (hit !== null && hit.key === key) {
      // Only the view fields can have changed; the bars are keyed and identical.
      return Object.freeze({ ...hit.snapshot, ...viewFieldsOf(base) });
    }
    const source = base.series.bars;
    const bars: Bar[] = [];
    // Volume is the SUM of the source bars the brick spans, not zero.
    //
    // A brick covers (previous brick's sourceIndex, this brick's sourceIndex], so that
    // sum is exactly the volume traded while the brick formed — well defined, and what
    // every volume-weighted indicator needs. Zeroing it (the first attempt here) made the
    // volume pane vanish and left VWAP, Volume and Volume Profile silently producing
    // nothing on five of the fourteen chart types.
    let previousSource = -1;
    for (const brick of derived.bars) {
      const end = Math.min(source.length - 1, brick.sourceIndex);
      let volume = 0;
      for (let i = Math.max(0, previousSource + 1); i <= end; i++) volume += source[i].v;
      previousSource = end;

      const made = makeBar({
        t: timeOf(brick, source),
        o: brick.o,
        h: brick.h,
        l: brick.l,
        c: brick.c,
        v: volume,
      });
      if (made !== null) bars.push(made);
    }
    const snapshot: Snapshot = Object.freeze({
      ...base,
      series: Object.freeze({ ...base.series, bars }),
    });
    resampledCache = { key, snapshot };
    return snapshot;
  };

  /**
   * Timestamp per index for a chart type, without rendering it.
   *
   * This is the index space a switch is moving between: the source bar times when the
   * type preserves index space, and the derived bars' resolved times when it does not.
   */
  /**
   * Timestamp per index of the snapshot that was RENDERED, cached on its identity.
   *
   * `indexTimes` below answers the same question for a chart type that is not on screen,
   * which is what a type switch needs. This one is for the frame: the snapshot is
   * memoised on the data revision, so the array is rebuilt when the data changes rather
   * than once per frame — a synced crosshair over 100k bars must not allocate a 100k
   * array every time the sibling pane's pointer moves.
   */
  const renderedTimes = (snapshot: Snapshot): readonly number[] => {
    const cached = renderedTimesCache;
    if (cached !== null && cached.snapshot === snapshot) return cached.times;
    const times = snapshot.series.bars.map((bar) => bar.t as number);
    renderedTimesCache = { snapshot, times };
    return times;
  };

  const indexTimes = (type: ChartType, params: ChartTypeParams): number[] => {
    const source = series.get().bars;
    const derived = seriesMemo.compute(dataRevision(), type, params, source);
    if (derived.preservesIndexSpace) return source.map((bar) => bar.t);
    return derived.bars.map((brick) => timeOf(brick, source));
  };

  /**
   * Carries the VISIBLE TIME WINDOW across an index-space change.
   *
   * The view is `(scrollPosition, barSpacing)` in bars, and a resampling type has far
   * fewer of them: 900 minutes become ~50 bricks. Leaving the view alone left the whole
   * series crammed into the far left of an otherwise empty plot, drawn at a spacing meant
   * for 900 bars — which is what a chart type "not working" looks like.
   *
   * Both edges of the window are converted, then the spacing is whatever makes that many
   * bars fill the plot. The user keeps looking at the same stretch of time.
   */
  const remapView = (from: readonly number[], to: readonly number[]): void => {
    if (from.length < 2 || to.length < 2) return;
    const input = lastInput;
    if (input === null) return;

    const width = input.layout.plot.width;
    if (width <= 0) return;
    const left = remapIndex(from, to, input.visible.from);
    const right = remapIndex(from, to, input.visible.to);
    const span = Math.max(1, right - left);

    view.update({
      barSpacing: Math.min(120, Math.max(MIN_BAR_SPACING, width / span)),
      scrollPosition: right + rightMargin,
    });
  };

  /** Moves every index-anchored annotation from one index space to another. */
  const remapAnnotations = (from: readonly number[], to: readonly number[]): void => {
    if (from.length < 2 || to.length < 2) return;
    for (const drawing of drawings.list()) {
      const anchors = drawing.anchors.map((a) => ({
        barIndex: remapIndex(from, to, a.barIndex),
        price: a.price,
      }));
      drawings.update(drawing.id, { anchors });
    }
    const active = measure;
    if (active !== null) {
      measure = {
        from: { barIndex: remapIndex(from, to, active.from.barIndex), price: active.from.price },
        to: { barIndex: remapIndex(from, to, active.to.barIndex), price: active.to.price },
      };
    }
  };

  /**
   * The pointer the frame paints from: this chart's own if the cursor is over it, else a
   * synced index from a sibling pane projected through THIS chart's own scales.
   */
  const framePointer = (): { readonly x: number; readonly y: number } | null => {
    const own = pointer.pointer();
    if (own !== null) return own;
    const time = externalPointerTime;
    const input = lastInput;
    if (time === null || input === null) return null;
    const times = renderedTimes(input.snapshot);
    if (times.length === 0) return null;
    // Outside this chart's history entirely — a 1H pane next to a 1m one covers a wider
    // span, so a moment can genuinely have no bar here. Drawing at the clamped edge
    // would claim the cursor is somewhere it is not.
    if (time < times[0] || time > times[times.length - 1]) return null;
    // y is parked outside the plot: a synced crosshair marks a moment in time, and there
    // is no honest price to put a horizontal line at on a different instrument.
    return { x: input.timeScale.x(asBarIndex(indexAtTime(times, time))), y: -1 };
  };

  /**
   * Autoscaled domain for the left axis: the compared instrument's own visible range.
   *
   * Computed from the aligned VALUES rather than from its raw bars, because only the
   * aligned array knows which of its bars fall inside the primary's visible window — the
   * two calendars do not line up, which is the whole reason alignment exists.
   */
  const leftRange = (input: FrameInput): PriceRange | undefined => {
    const active = compare;
    if (active === null || compareScale !== 'own') return undefined;
    const cached = compareCache;
    if (cached === null) return undefined;

    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const values = cached.aligned.values;
    const to = Math.min(values.length - 1, input.visible.to);
    for (let i = Math.max(0, input.visible.from); i <= to; i++) {
      const v = values[i];
      if (Number.isNaN(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
    const pad = (hi - lo) * 0.1;
    return makePriceRange(asPrice(lo - pad), asPrice(hi + pad));
  };

  const frame = (mask: DirtyMask): void => {
    const started = performance.now();
    const baseSnapshot = visibleSnapshot();
    const revisionKey = dataRevision();
    const derivedSeries = seriesMemo.compute(
      revisionKey,
      features.chartType,
      features.chartParams,
      baseSnapshot.series.bars,
    );
    const frameSnapshot = derivedSeries.preservesIndexSpace
      ? baseSnapshot
      : resampledSnapshot(
          baseSnapshot,
          derivedSeries,
          `${String(revisionKey)}:${features.chartType}:${JSON.stringify(features.chartParams)}`,
        );

    /**
     * The previous session's close, as a dashed line with a tag in the price gutter.
     *
     * Built from `frameSnapshot`, so on a resampling chart type it is the previous session
     * of the BRICKS on screen rather than of the source bars — which is what a line drawn
     * across those bricks has to mean.
     *
     * The overlay channel already existed, complete with dashes, a gutter tag and inclusion
     * in autoscale (§4), and had never been handed a single overlay. This is its first
     * caller.
     */
    const previousCloseOverlays = (): Overlay[] => {
      if (!showPreviousClose) return [];
      const bars = frameSnapshot.series.bars;
      // The zone offset is resolved at the LAST bar: that is the session the line is
      // "previous" to, and it is the only instant whose offset can change which day the
      // comparison lands on.
      const offset =
        bars.length === 0 ? 0 : offsetMinutes(timeZone, bars[bars.length - 1].t) * 60_000;
      const close = previousSessionClose(bars, frameSnapshot.series.tf, offset);
      if (close === null) return [];
      return [
        {
          kind: 'priceLine',
          color: theme.axisText,
          lineWidth: 1,
          price: asPrice(close),
          dash: [3, 3],
          label: close.toFixed(pricePrecision),
        },
      ];
    };

    /**
     * One place that knows every field of the frame, so a rebuild cannot silently drop
     * one. It has bitten this function before: rebuilding for a dragged price axis
     * without re-passing the left range blanked the second axis mid-drag while the layout
     * still held its width open.
     */
    const build = (priceRange: PriceRange | null, left: PriceRange | undefined): FrameInput =>
      buildFrameInput({
        snapshot: frameSnapshot,
        layout,
        theme,
        pricePrecision,
        overlays: previousCloseOverlays(),
        pointer: framePointer(),
        priceRange,
        priceScaleInverted: priceInverted,
        showGrid,
        timeZone,
        autoscaleCache,
        ...(left === undefined ? {} : { leftPriceRange: left }),
      });

    // The left domain depends on the aligned comparison, which is memoised on the frame
    // before it — so on the first frame after a symbol or scale change there is nothing
    // to scale from yet and the axis is simply absent for that one frame.
    let input = build(null, undefined);
    const left = leftRange(input);
    lastLeftRange = left ?? null;
    if (left !== undefined) input = build(null, left);

    // A dragged price axis scales the AUTOSCALED range around its own centre rather than
    // introducing a second source of truth for the range. Only rebuilt when actually
    // zoomed, so the common path still costs one buildFrameInput.
    if (priceZoom !== 1) {
      const centre = (input.priceScale.min + input.priceScale.max) / 2;
      const half = ((input.priceScale.max - input.priceScale.min) / 2) * priceZoom;
      input = build(makePriceRange(centre - half, centre + half), left);
    }
    const derived = derivedSeries;
    // The built-in series layer draws candles from the raw bars. Any other chart type is
    // drawn here instead, so its Series bit is stripped exactly as the GL path does.
    const customSeries = features.chartType !== 'candles';

    if (glLayer === null) {
      renderer.render(customSeries ? mask & ~DirtyFlags.Series : mask, contexts, input);
    } else {
      renderer.render(mask & ~DirtyFlags.Series, contexts, input);
      if ((mask & DirtyFlags.Series) !== 0 && !customSeries) drawGlSeries(input);
    }

    // In GL mode the series canvas holds a webgl2 context for life, so a Canvas2D chart
    // type cannot be painted onto it. It goes to the overlay instead — under the drawings
    // and the crosshair, over the grid, which is the same stacking order as normal.
    // Before this, switching to any non-candle type with ?gl=1 simply drew nothing.
    const customTarget = surfaces.series?.ctx ?? surfaces.overlay.ctx;
    const customBit = surfaces.series === null ? DirtyFlags.Overlay : DirtyFlags.Series;
    if (customSeries && (mask & customBit) !== 0) {
      drawDerivedSeries(customTarget, {
        series: derived,
        plot: input.layout.plot,
        viewport: input.layout.viewport,
        volume: input.layout.volume,
        theme,
        x: (i) => input.timeScale.x(asBarIndex(i)),
        y: (price) => input.priceScale.y(asPrice(price)),
        barSpacing: input.timeScale.barSpacing,
        // One index space now: a resampling type's snapshot IS its derived bars, so the
        // visible range applies directly instead of drawing the whole series every frame.
        from: input.visible.from,
        to: input.visible.to,
      });
    }

    if ((mask & DirtyFlags.Grid) !== 0) {
      drawWatermark(surfaces.grid.ctx, o.symbol, o.tf, input.layout.plot, theme);
    }
    drawAnnotations(input, mask);
    if ((mask & DirtyFlags.Crosshair) !== 0) {
      drawMeasureOverlay(input);
      drawPlacementOverlay(input);
    }
    lastInput = input;
    frameCount += 1;
    frameTimes[frameTimeCount % frameTimes.length] = performance.now() - started;
    frameTimeCount += 1;
    o.container.dispatchEvent(
      new CustomEvent('chart:rendered', { bubbles: true, detail: { frame: frameCount } }),
    );
  };

  const scheduler = createScheduler({ frame });

  // Programmatic view changes (price-scale mode, scripted zoom) must repaint too —
  // without this only pointer input would, and toggling the scale would appear frozen.
  const unsubscribeView = view.subscribe(() => {
    scheduler.invalidate(DirtyFlags.All);
  });

  // Same gap on the drawing store: adding a shape bumped its revision but scheduled no
  // frame, so a drawing only appeared once something ELSE forced a repaint. It looked
  // like it worked because a zoom or pan usually followed.
  const unsubscribeDrawings = drawings.subscribe(() => {
    scheduler.invalidate(DirtyFlags.Overlay);
  });

  const unsubscribeAlerts = alerts.subscribe(() => {
    scheduler.invalidate(DirtyFlags.Overlay);
  });

  // --- input --------------------------------------------------------------
  const pointer: PointerBindings = bindPointer({
    target: canvases.hitTarget,
    view,
    plot: () => layout.plot,
    onViewChange: () => {
      scheduler.invalidate(DirtyFlags.Grid | DirtyFlags.Series | DirtyFlags.Overlay);
    },
    onPointerChange: () => {
      scheduler.invalidate(DirtyFlags.Crosshair);
    },
  });

  // Size the layers to the container before the first paint.
  applySize(o.container.clientWidth, o.container.clientHeight);

  /**
   * Bars in the index space actually being RENDERED.
   *
   * For a resampling chart type that is the brick count, not the source bar count, and
   * everything that positions the view — fit, jump-to-realtime, the scrolled-back badge —
   * has to use it or those controls aim at an index that is not on screen.
   */
  const renderedBarCount = (): number =>
    lastInput === null ? series.get().bars.length : lastInput.snapshot.series.bars.length;

  const geometry = (): GeometryDump | null => {
    const input = lastInput;
    if (input === null) return null;
    const { timeScale, visible } = input;
    const candles: CandleGeometryDump[] = [];
    if (!visible.isEmpty) {
      const g = candleGeometry(timeScale.barSpacing);
      for (let i = visible.from; i <= visible.to; i++) {
        candles.push({
          index: i,
          centreX: timeScale.x(asBarIndex(i)),
          width: g.width,
          mode: g.mode,
        });
      }
    }
    const backing = {
      grid: sizeOf(canvases.canvases.grid),
      series: sizeOf(canvases.canvases.series),
      overlay: sizeOf(canvases.canvases.overlay),
      crosshair: sizeOf(canvases.canvases.crosshair),
    };
    return {
      dpr: surfaces.grid.ratio,
      plot: input.layout.plot,
      volume: input.layout.volume,
      backingStore: backing,
      cssSize: { width: surfaces.grid.cssWidth, height: surfaces.grid.cssHeight },
      visible: { from: visible.from, to: visible.to, count: visible.count },
      barCount: input.snapshot.series.bars.length,
      candles,
      frameCount,
    };
  };

  return {
    series,
    view,
    snapshots,
    drawings,
    alerts,
    onAlert(listener) {
      alertListeners.add(listener);
      return () => alertListeners.delete(listener);
    },
    alertAt(y, tolerance = 6) {
      let best: { id: string; distance: number } | null = null;
      for (const entry of lastAlertGeometry) {
        const distance = Math.abs(entry.y - y);
        if (distance > tolerance) continue;
        if (best === null || distance < best.distance) best = { id: entry.id, distance };
      }
      return best === null ? null : alerts.get(best.id);
    },
    chartType: () => features.chartType,
    setChartType(type, params) {
      // Anchors are remapped through TIME across the switch. Without this a drawing on
      // bar 400 of the source lands on brick 400 of a Renko series — a different moment
      // entirely — which reads as the annotations having been lost.
      const before = indexTimes(features.chartType, features.chartParams);
      features.chartType = type;
      features.chartParams = params ?? {};
      const after = indexTimes(type, features.chartParams);
      remapAnnotations(before, after);
      remapView(before, after);
      scheduler.invalidate(DirtyFlags.All);
    },
    addIndicator(id, params = {}, styles = {}) {
      handleCounter += 1;
      const indicator: ActiveIndicator = {
        handleId: `i${String(handleCounter)}`,
        id,
        params,
        styles,
      };
      features.indicators = [...features.indicators, indicator];
      layout = relayout(cssSize.width, cssSize.height);
      scheduler.invalidate(DirtyFlags.All);
      return indicator;
    },
    updateIndicator(handleId, patch) {
      const index = features.indicators.findIndex((i) => i.handleId === handleId);
      if (index < 0) return null;
      const current = features.indicators[index];
      const next: ActiveIndicator = {
        ...current,
        params: patch.params ?? current.params,
        styles: patch.styles ?? current.styles,
      };
      features.indicators = [
        ...features.indicators.slice(0, index),
        next,
        ...features.indicators.slice(index + 1),
      ];
      scheduler.invalidate(DirtyFlags.All);
      return next;
    },
    removeIndicator(handleId) {
      const next = features.indicators.filter((i) => i.handleId !== handleId);
      if (next.length === features.indicators.length) return false;
      features.indicators = next;
      layout = relayout(cssSize.width, cssSize.height);
      scheduler.invalidate(DirtyFlags.All);
      return true;
    },
    listIndicators: () => features.indicators,

    indicatorPaneHost(handleId) {
      const indicator = features.indicators.find((i) => i.handleId === handleId);
      if (indicator === undefined) return null;
      return paneHostOf(indicator)?.handleId ?? null;
    },

    indicatorResult(handleId) {
      const indicator = features.indicators.find((i) => i.handleId === handleId);
      if (indicator === undefined) return null;
      // The same snapshot the frame draws from, so replay and resampling agree with
      // what is on screen rather than reading the untrimmed store.
      return resultFor(indicator, visibleSnapshot().series.bars, dataRevision());
    },
    drawingGeometry: () => lastGeometry,
    hitTestAt(x, y, tolerance = 7) {
      const hits = hitTest({ x, y }, lastGeometry, tolerance);
      return hits.length === 0 ? null : hits[0];
    },
    indicatorValuesAt(index) {
      const input = lastInput;
      if (input === null) return [];
      const bars = input.snapshot.series.bars;
      const i = Math.min(bars.length - 1, Math.max(0, Math.round(index)));
      return features.indicators.map((indicator) => {
        const result = resultFor(indicator, bars, dataRevision());
        return {
          handleId: indicator.handleId,
          label: `${indicator.id.toUpperCase()}${
            indicator.params.period === undefined ? '' : ` ${String(indicator.params.period)}`
          }`,
          values: result.plots.map((plot) => ({
            key: plot.key,
            value: result.values[plot.key][i],
          })),
        };
      });
    },
    setPriceZoom(factor) {
      const next = Math.min(6, Math.max(0.2, factor));
      if (next === priceZoom) return;
      priceZoom = next;
      scheduler.invalidate(DirtyFlags.All);
    },
    priceZoom: () => priceZoom,
    setPriceInverted(on) {
      if (on === priceInverted) return;
      priceInverted = on;
      scheduler.invalidate(DirtyFlags.All);
    },
    priceInverted: () => priceInverted,
    setReplayAt(index) {
      const next = index === null ? null : Math.max(0, Math.round(index));
      if (next === replayIndex) return;
      replayIndex = next;
      // All, not Series: autoscale, the axes and every overlay depend on where the
      // series now ends.
      scheduler.invalidate(DirtyFlags.All);
    },
    replayAt: () => replayIndex,
    timeAtIndex(index) {
      const input = lastInput;
      if (input === null) return null;
      const times = renderedTimes(input.snapshot);
      const i = Math.round(index);
      if (i < 0 || i >= times.length) return null;
      return asTimeMs(times[i]);
    },
    setExternalTime(time) {
      const next = time === null ? null : Number(time);
      if (next === externalPointerTime) return;
      externalPointerTime = next;
      scheduler.invalidate(DirtyFlags.Crosshair);
    },
    constrainAnchor(from, to) {
      const input = lastInput;
      if (input === null) return to;
      const project = (a: Anchor): { x: number; y: number } => ({
        x: input.timeScale.x(asBarIndex(a.barIndex)),
        y: input.priceScale.y(asPrice(a.price)),
      });
      const snapped = constrainToAngle(project(from), project(to));
      return {
        barIndex: input.timeScale.indexAt(asPixel(snapped.x)),
        price: input.priceScale.price(asPixel(snapped.y)),
      };
    },
    dividerAt: (y, tolerance) => dividerAt(layout, y, tolerance),
    dragDivider(index, y) {
      const next = resizePane(layout, layoutOptions(cssSize.width, cssSize.height), index, y);
      // Reference equality is not enough — `resizePane` returns a fresh array every call —
      // so compare element-wise and skip the relayout when the drag changed nothing. A
      // clamped drag fires on every pointer move and would otherwise repaint continuously.
      const same =
        paneFractions !== null &&
        paneFractions.length === next.length &&
        paneFractions.every((v, i) => v === next[i]);
      if (same) return;
      paneFractions = next;
      layout = relayout(cssSize.width, cssSize.height);
      scheduler.invalidate(DirtyFlags.All);
    },
    paneFractions: () => paneFractions,
    resetPanes() {
      if (paneFractions === null) return;
      paneFractions = null;
      layout = relayout(cssSize.width, cssSize.height);
      scheduler.invalidate(DirtyFlags.All);
    },
    setCompare(next) {
      compare = next;
      compareCache = null;
      // All, not Overlay: an own-scale comparison changes the LAYOUT (a left gutter
      // appears or goes), which every layer's rects depend on.
      layout = relayout(cssSize.width, cssSize.height);
      scheduler.invalidate(DirtyFlags.All);
    },
    setCompareScale(next) {
      if (next === compareScale) return;
      compareScale = next;
      layout = relayout(cssSize.width, cssSize.height);
      scheduler.invalidate(DirtyFlags.All);
    },
    compareScale: () => compareScale,
    leftPriceRange: () => lastLeftRange,
    compareSymbol: () => compare?.symbol ?? null,
    setPlacement(next) {
      placement = next;
      scheduler.invalidate(DirtyFlags.Crosshair);
    },
    setMeasure(next) {
      measure = next;
      scheduler.invalidate(DirtyFlags.Crosshair);
    },
    measure: () => measure,
    settings: () => ({ theme, timeZone, pricePrecision, showGrid, rightMargin, showPreviousClose }),
    updateSettings(patch) {
      theme = patch.theme ?? theme;
      timeZone = patch.timeZone ?? timeZone;
      if ((patch.showPreviousClose ?? showPreviousClose) !== showPreviousClose) {
        showPreviousClose = !showPreviousClose;
        // The autoscale cache is keyed on (revision, from, to) and deliberately excludes
        // the overlays, so its contract says a caller that SWAPS the overlay set must
        // clear it. Toggling this setting does exactly that: without the clear, hiding a
        // line that was widening the range leaves the axis padded for a line that is no
        // longer drawn, until some unrelated edit bumps the revision.
        autoscaleCache.clear();
      }
      pricePrecision = patch.pricePrecision ?? pricePrecision;
      showGrid = patch.showGrid ?? showGrid;
      rightMargin = patch.rightMargin ?? rightMargin;
      scheduler.invalidate(DirtyFlags.All);
    },
    resetPriceZoom() {
      if (priceZoom === 1) return;
      priceZoom = 1;
      scheduler.invalidate(DirtyFlags.All);
    },
    isScrolledBack() {
      return view.get().scrollPosition < renderedBarCount() - 1 - 0.5;
    },
    scrollToRealtime() {
      view.setScrollPosition(renderedBarCount() - 1 + rightMargin);
    },
    fitAll() {
      const count = renderedBarCount();
      if (count < 2) return;
      const width = layout.plot.width;
      // Floored at the zoom limit, not at 1.5: with §5.1 aggregation a 100k-bar history
      // genuinely fits, and clamping to 1.5 made "fit all" show the last 2% of it.
      view.update({
        barSpacing: Math.min(120, Math.max(MIN_BAR_SPACING, (width * 0.92) / count)),
        scrollPosition: count - 1 + rightMargin,
      });
    },
    pickAnchor(x, y, magnet = 'off') {
      const input = lastInput;
      if (input === null) {
        return { anchor: { barIndex: 0, price: 0 }, target: null, barIndex: -1 };
      }
      return snapPixel(
        x,
        y,
        input.snapshot.series.bars,
        magnet,
        { y: (price) => input.priceScale.y(asPrice(price)), price: (py) => input.priceScale.price(asPixel(py)) },
        { x: (i) => input.timeScale.x(asBarIndex(i)), indexAt: (px) => input.timeScale.indexAt(asPixel(px)) },
      );
    },
    projectAnchor(anchor) {
      const input = lastInput;
      if (input === null) return { x: 0, y: 0 };
      return {
        x: input.timeScale.x(asBarIndex(anchor.barIndex)),
        y: input.priceScale.y(asPrice(anchor.price)),
      };
    },
    layout: () => layout,
    pushTick(bar: Bar): void {
      // `applyBar`, not `replaceLast`: a live source eventually crosses a bar boundary,
      // and `replaceLast` answers a new bar open with `false` — so the series would sit
      // frozen on the last bar of the first minute while prices kept arriving, looking
      // like a stalled feed rather than a dropped bar.
      const result = series.applyBar(bar);
      if (result === 'unchanged' || result === 'rejected') return;
      scheduler.invalidate(DirtyFlags.Series | DirtyFlags.Overlay);
      // Alerts are checked HERE rather than in a timer: the tick is the only moment new
      // price information exists, and polling would either miss bars or re-check the
      // same one hundreds of times.
      for (const fired of alerts.observe(o.symbol, bar)) {
        for (const listener of alertListeners) listener(fired);
      }
    },
    geometry,
    frameStats() {
      const n = Math.min(frameTimeCount, frameTimes.length);
      if (n === 0) return { count: 0, last: 0, mean: 0, median: 0, p95: 0, max: 0 };
      const sorted = Array.from(frameTimes.subarray(0, n)).sort((a, b) => a - b);
      let total = 0;
      for (const value of sorted) total += value;
      return {
        count: n,
        last: frameTimes[(frameTimeCount - 1) % frameTimes.length],
        mean: total / n,
        median: sorted[Math.floor(n / 2)],
        p95: sorted[Math.min(n - 1, Math.floor(n * 0.95))],
        max: sorted[n - 1],
      };
    },
    workStats: () => ({
      seriesTransforms: seriesMemo.misses(),
      indicatorComputes: indicatorMemo.misses(),
      glUploads: glLayer?.uploads() ?? 0,
    }),
    resetFrameStats() {
      frameTimeCount = 0;
      frameTimes.fill(0);
    },
    dispose(): void {
      containerObserver?.disconnect();
      unsubscribeView();
      unsubscribeDrawings();
      unsubscribeAlerts();
      pointer.dispose();
      scheduler.dispose();
      for (const surface of liveSurfaces()) surface.dispose();
      glLayer?.dispose();
      canvases.dispose();
    },
  };
}

function sizeOf(canvas: HTMLCanvasElement): { width: number; height: number } {
  return { width: canvas.width, height: canvas.height };
}

export { createChartCanvases, type ChartCanvases };

/** "3d 4h", "2h 15m", "45m", "30s" — the largest two units that matter. */
function formatElapsed(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${String(Math.round(ms / 1000))}s`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${String(days)}d ${String(hours)}h` : `${String(days)}d`;
  if (hours > 0) return rest > 0 ? `${String(hours)}h ${String(rest)}m` : `${String(hours)}h`;
  return `${String(rest)}m`;
}
