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
import { createViewStore, type ViewStore } from '../data/store/viewStore.js';
import {
  asBarIndex,
  asPixel,
  asPrice,
  TIMEFRAME_MS,
  type Bar,
  type PriceScaleMode,
  type Timeframe,
} from '../data/types.js';
import { bindPointer, type PointerBindings } from '../interaction/pointer.js';
import { buildFrameInput, createAutoscaleCache, type FrameInput } from '../renderer/frame.js';
import { makePriceRange } from '../renderer/scale/priceScale.js';
import { computeLayout, type Layout, type Rect } from '../renderer/layout.js';
import { candleGeometry } from '../renderer/scale/timeScale.js';
import { maxVolume } from '../renderer/scale/volumeScale.js';
import { createGlSeriesLayer } from '../renderer/webgl/glSeriesLayer.js';
import { drawDerivedSeries } from '../renderer/layers/derivedSeriesLayer.js';
import {
  drawDrawings,
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
import type { ChartType, ChartTypeParams } from '../charts/types.js';
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
  readonly candles: readonly CandleGeometryDump[];
  readonly frameCount: number;
}

export interface Chart {
  readonly series: SeriesStore;
  readonly drawings: DrawingStore;
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
  const seriesMemo = createSeriesMemo();
  const indicatorMemo = createIndicatorMemo();
  let handleCounter = 0;
  let lastGeometry: readonly DrawingGeometry[] = [];
  let priceZoom = 1;
  let priceInverted = false;
  let measure: { readonly from: Anchor; readonly to: Anchor } | null = null;

  let layout: Layout = computeLayout({
    width: Math.max(1, o.container.clientWidth),
    height: Math.max(1, o.container.clientHeight),
    ...LAYOUT_CHROME,
  });
  let cssSize = { width: o.container.clientWidth, height: o.container.clientHeight };
  let lastInput: FrameInput | null = null;
  let frameCount = 0;

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
      revision: input.snapshot.revision,
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
    const revision = input.snapshot.revision;

    const overlayInput = {
      plot: input.layout.plot,
      theme,
      from: input.visible.from,
      to: input.visible.to,
      x: (i: number) => input.timeScale.x(asBarIndex(i)),
    };
    const priceScale = { y: (value: number) => input.priceScale.y(asPrice(value)) };

    const { overlays, panes } = splitByPlacement(features.indicators, (indicator) =>
      indicatorMemo(indicator.handleId, revision, indicator.id, indicator.params, bars),
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
  const frame = (mask: DirtyMask): void => {
    let input = buildFrameInput({
      snapshot: snapshots.snapshot(),
      layout,
      theme,
      pricePrecision,
      overlays: [],
      pointer: pointer.pointer(),
      priceRange: null,
      priceScaleInverted: priceInverted,
      showGrid,
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
        autoscaleCache,
      });
    }
    const snapshot = input.snapshot;
    const bars = snapshot.series.bars;
    const derived = seriesMemo(snapshot.revision, features.chartType, features.chartParams, bars);
    // The built-in series layer draws candles from the raw bars. Any other chart type is
    // drawn here instead, so its Series bit is stripped exactly as the GL path does.
    const customSeries = features.chartType !== 'candles';

    if (glLayer === null) {
      renderer.render(customSeries ? mask & ~DirtyFlags.Series : mask, contexts, input);
    } else {
      renderer.render(mask & ~DirtyFlags.Series, contexts, input);
      if ((mask & DirtyFlags.Series) !== 0 && !customSeries) drawGlSeries(input);
    }

    if (customSeries && (mask & DirtyFlags.Series) !== 0 && surfaces.series !== null) {
      drawDerivedSeries(surfaces.series.ctx, {
        series: derived,
        plot: input.layout.plot,
        theme,
        // Derived index space: for resampling types the Nth brick is not the Nth bar.
        x: (i) => input.timeScale.x(asBarIndex(i)),
        y: (price) => input.priceScale.y(asPrice(price)),
        barSpacing: input.timeScale.barSpacing,
        from: derived.preservesIndexSpace ? input.visible.from : 0,
        to: derived.preservesIndexSpace ? input.visible.to : derived.bars.length - 1,
      });
    }

    if ((mask & DirtyFlags.Grid) !== 0) {
      drawWatermark(surfaces.grid.ctx, o.symbol, o.tf, input.layout.plot, theme);
    }
    drawAnnotations(input, mask);
    if ((mask & DirtyFlags.Crosshair) !== 0) drawMeasureOverlay(input);
    lastInput = input;
    frameCount += 1;
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
      candles,
      frameCount,
    };
  };

  return {
    series,
    view,
    snapshots,
    drawings,
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
        const result = indicatorMemo(
          indicator.handleId,
          input.snapshot.revision,
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
    setMeasure(next) {
      measure = next;
      scheduler.invalidate(DirtyFlags.Crosshair);
    },
    measure: () => measure,
    settings: () => ({ theme, pricePrecision, showGrid, rightMargin }),
    updateSettings(patch) {
      theme = patch.theme ?? theme;
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
      const count = series.get().bars.length;
      return view.get().scrollPosition < count - 1 - 0.5;
    },
    scrollToRealtime() {
      view.setScrollPosition(series.get().bars.length - 1 + rightMargin);
    },
    fitAll() {
      const count = series.get().bars.length;
      if (count < 2) return;
      const width = layout.plot.width;
      view.update({
        barSpacing: Math.min(120, Math.max(1.5, (width * 0.92) / count)),
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
      if (series.replaceLast(bar)) scheduler.invalidate(DirtyFlags.Series | DirtyFlags.Overlay);
    },
    geometry,
    dispose(): void {
      containerObserver?.disconnect();
      unsubscribeView();
      unsubscribeDrawings();
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
