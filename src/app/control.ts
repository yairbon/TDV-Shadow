/**
 * Page-side implementation of `window.__tdv` (src/mcp/controlApi.ts).
 *
 * The rule from the contract, honoured here: reads report what the renderer ACTUALLY
 * used for the last frame. `drawingGeometry()` and `geometry()` come from the frame that
 * was painted, not from a fresh recomputation — otherwise an agent verifying a drawing's
 * position would be inspecting a chart that was never on screen.
 *
 * Writes go through the same stores the toolbar and pointer use. There is no agent-only
 * path that skips validation.
 */

import type { Chart } from './bootstrap.js';
import type { ChartType } from '../charts/types.js';
import type { IndicatorId, IndicatorParams } from '../indicators/types.js';
import type { Anchor, DrawingKind, MagnetMode } from '../drawings/types.js';
import type { PriceScaleMode, Timeframe } from '../data/types.js';
import type {
  ChartControlApi,
  ChartState,
  DrawingHandle,
  IndicatorRow,
  IntegrityReport,
  OhlcvRow,
  ViewportState,
} from '../mcp/controlApi.js';
import { CONTROL_API_VERSION } from '../mcp/controlApi.js';
import { computeIndicator } from '../indicators/registry.js';
import { candleGeometry } from '../renderer/scale/timeScale.js';

export interface ControlContext {
  symbol: string;
  timeframe: Timeframe;
  /** Swaps the loaded series. Supplied by main.ts, which owns chart construction. */
  switchSymbol?: (symbol: string) => void;
  /** Symbols this build can actually load. */
  available?: readonly string[];
}

export function installControlApi(getChart: () => Chart | null, context: ControlContext): void {
  const require = (): Chart => {
    const chart = getChart();
    if (chart === null) throw new Error('chart is not initialised');
    return chart;
  };

  const viewport = (): ViewportState => {
    const chart = require();
    const view = chart.view.get();
    const dump = chart.geometry();
    return {
      scrollPosition: view.scrollPosition,
      barSpacing: view.barSpacing,
      priceScaleMode: view.priceScaleMode,
      visibleFrom: dump?.visible.from ?? 0,
      visibleTo: dump?.visible.to ?? 0,
      visibleBars: dump?.visible.count ?? 0,
    };
  };

  const drawingHandles = (): readonly DrawingHandle[] => {
    const chart = require();
    const geometries = chart.drawingGeometry();
    return chart.drawings.list().map((drawing) => {
      const geometry = geometries.find((g) => g.id === drawing.id);
      return {
        id: drawing.id,
        kind: drawing.kind,
        anchors: drawing.anchors,
        // Pixels from the painted frame, not a recomputation.
        anchorPixels: geometry?.points.map((p) => ({ x: p.x, y: p.y })) ?? [],
      };
    });
  };

  const state = (): ChartState => {
    const chart = require();
    const dump = chart.geometry();
    return {
      symbol: context.symbol,
      timeframe: context.timeframe,
      chartType: chart.chartType(),
      renderer: chart.geometry() === null ? 'canvas2d' : rendererOf(chart),
      barCount: chart.series.get().bars.length,
      viewport: viewport(),
      indicators: chart.listIndicators().map((i) => ({
        handleId: i.handleId,
        id: i.id,
        params: i.params,
        placement: computeIndicator(i.id, [], i.params).placement,
      })),
      drawings: drawingHandles(),
      frameCount: dump?.frameCount ?? 0,
    };
  };

  const rendererOf = (chart: Chart): 'canvas2d' | 'webgl' => {
    void chart;
    const canvas = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="series"]');
    // A canvas holds one context type for life, so asking for '2d' is a reliable probe.
    return canvas !== null && canvas.getContext('2d') === null ? 'webgl' : 'canvas2d';
  };

  const api: ChartControlApi = {
    version: CONTROL_API_VERSION,

    getState: state,

    getIntegrityReport(): IntegrityReport {
      const chart = require();
      const dump = chart.geometry();
      if (dump === null) {
        return {
          candlesOverlap: false,
          outsidePlot: 0,
          pageOverflowX: 0,
          pageOverflowY: 0,
          nonCanvasNodesInPlot: 0,
          backingStoreMatchesDpr: false,
          ok: false,
        };
      }

      const sorted = [...dump.candles].sort((a, b) => a.centreX - b.centreX);
      let overlap = false;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].centreX - sorted[i].width / 2 < sorted[i - 1].centreX + sorted[i - 1].width / 2 + 1 - 1e-9) {
          overlap = true;
          break;
        }
      }

      const plot = dump.plot;
      const slack = chart.view.get().barSpacing * 2;
      const outside = dump.candles.filter(
        (c) => c.centreX < plot.left - slack || c.centreX > plot.left + plot.width + slack,
      ).length;

      const host = document.querySelector('#chart');
      const nonCanvas = host === null ? 0 : [...host.querySelectorAll('*')].filter((el) => el.tagName !== 'CANVAS').length;

      const expectedW = Math.round(dump.cssSize.width * dump.dpr);
      const expectedH = Math.round(dump.cssSize.height * dump.dpr);
      const dprOk = Object.values(dump.backingStore).every(
        (size) => size.width === expectedW && size.height === expectedH,
      );

      const overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const overflowY = document.documentElement.scrollHeight - document.documentElement.clientHeight;

      return {
        candlesOverlap: overlap,
        outsidePlot: outside,
        pageOverflowX: overflowX,
        pageOverflowY: overflowY,
        nonCanvasNodesInPlot: nonCanvas,
        backingStoreMatchesDpr: dprOk,
        ok: !overlap && outside === 0 && nonCanvas === 0 && dprOk && overflowX <= 0 && overflowY <= 0,
      };
    },

    setSymbol(symbol: string, timeframe?: Timeframe): ChartState {
      const switcher = context.switchSymbol;
      const known = context.available ?? [];
      if (switcher === undefined || !known.includes(symbol)) {
        // Refuse rather than relabel. Returning the previous bars under a new name is a
        // lie the calling agent cannot detect; an error naming the loadable symbols is
        // something it can act on.
        throw new Error(
          `unknown symbol '${symbol}'. This build ships a fixed snapshot; available: ${known.join(', ')}`,
        );
      }
      switcher(symbol);
      context.symbol = symbol;
      if (timeframe !== undefined) context.timeframe = timeframe;
      return state();
    },

    setChartType(type: ChartType): ChartState {
      require().setChartType(type);
      return state();
    },

    setPriceScaleMode(mode: PriceScaleMode): ChartState {
      require().view.setPriceScaleMode(mode);
      return state();
    },

    setRenderer(): ChartState {
      // Switching renderer rebuilds the chart, which would invalidate this closure's
      // handle. main.ts owns that swap; exposing it here would hand back a stale chart.
      throw new Error('setRenderer is driven by the toolbar; use the UI or reload with ?gl=1');
    },

    setBarSpacing(spacing: number): ViewportState {
      require().view.setBarSpacing(spacing);
      return viewport();
    },

    setScrollPosition(position: number): ViewportState {
      require().view.setScrollPosition(position);
      return viewport();
    },

    zoomAbout(anchorX: number, factor: number): ViewportState {
      const chart = require();
      const view = chart.view.get();
      const plot = chart.layout().plot;
      const index = view.scrollPosition - (plot.left + plot.width - anchorX) / view.barSpacing;
      const spacing = Math.min(120, Math.max(0.5, view.barSpacing * factor));
      chart.view.update({
        barSpacing: spacing,
        scrollPosition: index + (plot.left + plot.width - anchorX) / spacing,
      });
      return viewport();
    },

    panBars(deltaBars: number): ViewportState {
      require().view.scrollBy(deltaBars);
      return viewport();
    },

    fitVisibleRange(from: number, to: number): ViewportState {
      const chart = require();
      const plot = chart.layout().plot;
      const span = Math.max(1, to - from + 1);
      const spacing = Math.min(120, Math.max(0.5, plot.width / span));
      chart.view.update({ barSpacing: spacing, scrollPosition: to });
      return viewport();
    },

    addIndicator(id: IndicatorId, params: IndicatorParams = {}) {
      const indicator = require().addIndicator(id, params);
      return {
        handleId: indicator.handleId,
        id: indicator.id,
        params: indicator.params,
        placement: computeIndicator(id, [], params).placement,
      };
    },

    removeIndicator(handleId: string): boolean {
      return require().removeIndicator(handleId);
    },

    readIndicator(handleId: string, from?: number, to?: number): readonly IndicatorRow[] {
      const chart = require();
      const indicator = chart.listIndicators().find((i) => i.handleId === handleId);
      if (indicator === undefined) return [];
      const bars = chart.series.get().bars;
      const result = computeIndicator(indicator.id, bars, indicator.params);
      const start = Math.max(0, from ?? 0);
      const end = Math.min(bars.length - 1, to ?? bars.length - 1);
      const rows: IndicatorRow[] = [];
      for (let i = start; i <= end; i++) {
        const values: Record<string, number> = {};
        for (const plot of result.plots) values[plot.key] = result.values[plot.key][i];
        rows.push({ barIndex: i, time: bars[i].t, values });
      }
      return rows;
    },

    drawShape(kind: DrawingKind, anchors: readonly Anchor[], magnet: MagnetMode = 'off') {
      const chart = require();
      const resolved = anchors.map((anchor) => {
        if (magnet === 'off') return anchor;
        // Snap through the same path the pointer uses, so an agent-placed anchor lands
        // exactly where a user's would.
        const pixel = chart.projectAnchor(anchor);
        return chart.pickAnchor(pixel.x, pixel.y, magnet).anchor;
      });
      const drawing = chart.drawings.add(kind, resolved);
      return {
        id: drawing.id,
        kind: drawing.kind,
        anchors: drawing.anchors,
        anchorPixels: drawing.anchors.map((a) => chart.projectAnchor(a)),
      };
    },

    updateDrawing(id: string, anchors: readonly Anchor[]): DrawingHandle | null {
      const chart = require();
      const updated = chart.drawings.update(id, { anchors: [...anchors] });
      if (updated === null) return null;
      return {
        id: updated.id,
        kind: updated.kind,
        anchors: updated.anchors,
        anchorPixels: updated.anchors.map((a) => chart.projectAnchor(a)),
      };
    },

    removeDrawing(id: string): boolean {
      return require().drawings.remove(id);
    },

    listDrawings: drawingHandles,

    clearDrawings(): number {
      return require().drawings.clear();
    },

    readOhlcv(from?: number, to?: number): readonly OhlcvRow[] {
      const chart = require();
      const bars = chart.series.get().bars;
      const dump = chart.geometry();
      const start = Math.max(0, from ?? dump?.visible.from ?? 0);
      const end = Math.min(bars.length - 1, to ?? dump?.visible.to ?? bars.length - 1);
      const rows: OhlcvRow[] = [];
      for (let i = start; i <= end; i++) {
        const bar = bars[i];
        rows.push({
          barIndex: i,
          time: bar.t,
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        });
      }
      return rows;
    },

    projectAnchor(anchor: Anchor) {
      return require().projectAnchor(anchor);
    },

    unprojectPixel(x: number, y: number): Anchor {
      return require().pickAnchor(x, y, 'off').anchor;
    },
  };

  window.__tdv = api;
  void candleGeometry;
}
