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
import { asBarIndex, type Bar, type Timeframe } from '../data/types.js';
import { bindPointer, type PointerBindings } from '../interaction/pointer.js';
import { buildFrameInput, createAutoscaleCache, type FrameInput } from '../renderer/frame.js';
import { computeLayout, type Layout, type Rect } from '../renderer/layout.js';
import { candleGeometry } from '../renderer/scale/timeScale.js';
import { maxVolume } from '../renderer/scale/volumeScale.js';
import { createGlSeriesLayer, supportsMode } from '../renderer/webgl/glSeriesLayer.js';
import { createChartRenderer, type LayerContexts } from '../renderer/index.js';
import { createScheduler, DirtyFlags, type DirtyMask } from '../renderer/scheduler.js';
import { createSurface, type Surface } from '../renderer/surface.js';
import { DARK_THEME, type Theme } from '../renderer/theme.js';
import { createChartCanvases, type ChartCanvases, type LayerName } from '../ui/chartCanvas.js';

export type RendererMode = 'canvas2d' | 'webgl';

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
  const theme = o.theme ?? DARK_THEME;
  const canvases = createChartCanvases(o.container);

  const series = createSeriesStore({
    symbol: o.symbol,
    tf: o.tf,
    initialBars: o.bars,
    state: 'live',
  });
  const view = createViewStore({
    barSpacing: o.barSpacing ?? 8,
    scrollPosition: Math.max(0, o.bars.length - 1),
  });
  const snapshots = createSnapshotSource(series, view);
  const renderer = createChartRenderer();
  const autoscaleCache = createAutoscaleCache();

  let layout: Layout = computeLayout({
    width: Math.max(1, o.container.clientWidth),
    height: Math.max(1, o.container.clientHeight),
    ...LAYOUT_CHROME,
  });
  let lastInput: FrameInput | null = null;
  let frameCount = 0;

  // --- surfaces -----------------------------------------------------------
  const onResize = (cssWidth: number, cssHeight: number): void => {
    layout = computeLayout({
      width: Math.max(1, cssWidth),
      height: Math.max(1, cssHeight),
      ...LAYOUT_CHROME,
    });
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

  let glUnsupportedWarned = false;

  const drawGlSeries = (input: FrameInput): void => {
    if (glLayer === null) return;
    if (!supportsMode(input.snapshot.priceScaleMode)) {
      if (!glUnsupportedWarned) {
        glUnsupportedWarned = true;
        // Honest failure: the GPU path implements the linear transform only, and
        // silently drawing a linear chart while the view asks for log would lie.
        console.warn(
          `[tdv-shadow] WebGL series layer supports the linear price scale only; ` +
            `'${input.snapshot.priceScaleMode}' needs the Canvas2D renderer.`,
        );
      }
      return;
    }
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

  // --- the single draw entrypoint ----------------------------------------
  const frame = (mask: DirtyMask): void => {
    const input = buildFrameInput({
      snapshot: snapshots.snapshot(),
      layout,
      theme,
      pricePrecision: o.pricePrecision ?? 2,
      overlays: [],
      pointer: pointer.pointer(),
      priceRange: null,
      autoscaleCache,
    });
    if (glLayer === null) {
      renderer.render(mask, contexts, input);
    } else {
      renderer.render(mask & ~DirtyFlags.Series, contexts, input);
      if ((mask & DirtyFlags.Series) !== 0) drawGlSeries(input);
    }
    lastInput = input;
    frameCount += 1;
    o.container.dispatchEvent(
      new CustomEvent('chart:rendered', { bubbles: true, detail: { frame: frameCount } }),
    );
  };

  const scheduler = createScheduler({ frame });

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
    pushTick(bar: Bar): void {
      if (series.replaceLast(bar)) scheduler.invalidate(DirtyFlags.Series | DirtyFlags.Overlay);
    },
    geometry,
    dispose(): void {
      containerObserver?.disconnect();
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
