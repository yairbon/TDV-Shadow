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
  makeBar,
  TIMEFRAME_MS,
  type Bar,
  type PriceScaleMode,
  type Timeframe,
} from '../data/types.js';
import { bindPointer, type PointerBindings } from '../interaction/pointer.js';
import { buildFrameInput, createAutoscaleCache, type FrameInput } from '../renderer/frame.js';
import { makePriceRange } from '../renderer/scale/priceScale.js';
import { computeLayout, type Layout, type Rect } from '../renderer/layout.js';
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
  drawLastPrice,
  drawMeasure,
  drawVolumeProfile,
  drawWatermark,
  type PlotStyles,
} from '../renderer/layers/annotationsLayer.js';
import { buildGeometry, type DrawingGeometry } from '../drawings/geometry.js';
import { hitTest, type Hit } from '../drawings/hitTest.js';
import { snapPixel, type SnapResult } from '../drawings/magnet.js';
import type { Anchor, MagnetMode } from '../drawings/types.js';
import { createDrawingStore, type DrawingStore } from '../drawings/store.js';
import { timeOf, type ChartType, type ChartTypeParams, type DerivedSeries } from '../charts/types.js';
import type { IndicatorId, IndicatorParams, VolumeProfileResult } from '../indicators/types.js';
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

/** Indicators that render in their own pane rather than over the price plot. */
const PANE_INDICATORS: ReadonlySet<IndicatorId> = new Set<IndicatorId>([
  'macd',
  'rsi',
  'stochastic',
  'atr',
  'volume',
]);

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
  /** Data-space anchor -> CSS pixel, through the live scales. */
  projectAnchor(anchor: Anchor): { readonly x: number; readonly y: number };
  readonly layout: () => Layout;
  readonly view: ViewStore;
  readonly snapshots: SnapshotSource;
  /** Applies a live tick and schedules a repaint. Never draws. */
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
  let handleCounter = 0;
  let lastGeometry: readonly DrawingGeometry[] = [];
  /** Alert pixel positions from the last frame — the same trick hit-testing drawings uses. */
  let lastAlertGeometry: readonly AlertGeometry[] = [];
  let priceZoom = 1;
  let priceInverted = false;
  let measure: { readonly from: Anchor; readonly to: Anchor } | null = null;
  let replayIndex: number | null = null;
  /** Memo for the truncated snapshot; slicing 100k bars every frame is not free. */
  let replayCache: { key: string; snapshot: Snapshot } | null = null;

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
    features.indicators.filter((i) => PANE_INDICATORS.has(i.id)).length;

  const relayout = (cssWidth: number, cssHeight: number): Layout =>
    computeLayout({
      width: Math.max(1, cssWidth),
      height: Math.max(1, cssHeight),
      ...LAYOUT_CHROME,
      extraPanes: paneCount(),
    });

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
      indicatorMemo.compute(indicator.handleId, revision, indicator.id, indicator.params, bars),
    );

    for (const { indicator, result } of overlays) {
      if (result.id === 'volume-profile') {
        drawVolumeProfile(ctx, result as VolumeProfileResult, overlayInput, priceScale);
        continue;
      }
      drawIndicatorOverlay(ctx, result, overlayInput, priceScale, indicator.styles);
    }

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
   * Volume is zero: a Renko brick is a price move, not a period, so there is no interval
   * whose volume it could report. §9 skips the pane when vMax is 0, which is the honest
   * outcome — better than summing an interval the brick does not represent.
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
    for (const brick of derived.bars) {
      const made = makeBar({
        t: timeOf(brick, source),
        o: brick.o,
        h: brick.h,
        l: brick.l,
        c: brick.c,
        v: 0,
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

    let input = buildFrameInput({
      snapshot: frameSnapshot,
      layout,
      theme,
      pricePrecision,
      overlays: [],
      pointer: pointer.pointer(),
      priceRange: null,
      priceScaleInverted: priceInverted,
      showGrid,
      timeZone,
      autoscaleCache,
    });

    // A dragged price axis scales the AUTOSCALED range around its own centre rather than
    // introducing a second source of truth for the range. Only rebuilt when actually
    // zoomed, so the common path still costs one buildFrameInput.
    if (priceZoom !== 1) {
      const centre = (input.priceScale.min + input.priceScale.max) / 2;
      const half = ((input.priceScale.max - input.priceScale.min) / 2) * priceZoom;
      input = buildFrameInput({
        snapshot: input.snapshot,
        layout,
        theme,
        pricePrecision,
        overlays: [],
        pointer: pointer.pointer(),
        priceRange: makePriceRange(centre - half, centre + half),
        priceScaleInverted: priceInverted,
        showGrid,
        timeZone,
        autoscaleCache,
      });
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
    if ((mask & DirtyFlags.Crosshair) !== 0) drawMeasureOverlay(input);
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
      features.chartType = type;
      features.chartParams = params ?? {};
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
        const result = indicatorMemo.compute(
          indicator.handleId,
          dataRevision(),
          indicator.id,
          indicator.params,
          bars,
        );
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
    setMeasure(next) {
      measure = next;
      scheduler.invalidate(DirtyFlags.Crosshair);
    },
    measure: () => measure,
    settings: () => ({ theme, timeZone, pricePrecision, showGrid, rightMargin }),
    updateSettings(patch) {
      theme = patch.theme ?? theme;
      timeZone = patch.timeZone ?? timeZone;
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
      if (!series.replaceLast(bar)) return;
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
      if (n === 0) return { count: 0, last: 0, mean: 0, p95: 0, max: 0 };
      const sorted = Array.from(frameTimes.subarray(0, n)).sort((a, b) => a - b);
      let total = 0;
      for (const value of sorted) total += value;
      return {
        count: n,
        last: frameTimes[(frameTimeCount - 1) % frameTimes.length],
        mean: total / n,
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
