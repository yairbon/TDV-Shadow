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
import { createChartRenderer, type LayerContexts } from '../renderer/index.js';
import { createScheduler, DirtyFlags, type DirtyMask } from '../renderer/scheduler.js';
import { createSurface, type Surface } from '../renderer/surface.js';
import { DARK_THEME, type Theme } from '../renderer/theme.js';
import { createChartCanvases, type ChartCanvases, type LayerName } from '../ui/chartCanvas.js';

export interface ChartOptions {
  readonly container: HTMLElement;
  readonly symbol: string;
  readonly tf: Timeframe;
  readonly bars: readonly Bar[];
  readonly barSpacing?: number;
  readonly theme?: Theme;
  readonly pricePrecision?: number;
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
  const surfaces = {
    grid: createSurface(canvases.canvases.grid, noObserve),
    series: createSurface(canvases.canvases.series, noObserve),
    overlay: createSurface(canvases.canvases.overlay, noObserve),
    crosshair: createSurface(canvases.canvases.crosshair, noObserve),
  } satisfies Record<LayerName, Surface>;

  const applySize = (cssWidth: number, cssHeight: number): void => {
    const w = Math.max(1, Math.floor(cssWidth));
    const h = Math.max(1, Math.floor(cssHeight));
    for (const surface of Object.values(surfaces)) surface.resize(w, h);
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
    series: surfaces.series.ctx,
    overlay: surfaces.overlay.ctx,
    crosshair: surfaces.crosshair.ctx,
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
    renderer.render(mask, contexts, input);
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
      for (const surface of Object.values(surfaces)) surface.dispose();
      canvases.dispose();
    },
  };
}

function sizeOf(canvas: HTMLCanvasElement): { width: number; height: number } {
  return { width: canvas.width, height: canvas.height };
}

export { createChartCanvases, type ChartCanvases };
