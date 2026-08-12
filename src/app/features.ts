/**
 * Phase 5 state that sits alongside the chart: active chart type, indicators and
 * drawings, plus the memoisation that keeps them off the per-frame path.
 *
 * The memo key is the store revision plus the parameters. Recomputing a 400-bar MACD or
 * re-deriving a Renko series every frame would blow the 8ms budget on its own, and both
 * are pure functions of (bars, params) — so a revision check is a complete cache test.
 */

import type { Bar } from '../data/types.js';
import { applyChartType } from '../charts/registry.js';
import type { ChartType, ChartTypeParams, DerivedSeries } from '../charts/types.js';
import { computeIndicator } from '../indicators/registry.js';
import type { IndicatorId, IndicatorParams, IndicatorResult } from '../indicators/types.js';
import type { PlotStyles } from '../renderer/layers/annotationsLayer.js';

export interface ActiveIndicator {
  readonly handleId: string;
  readonly id: IndicatorId;
  readonly params: IndicatorParams;
  /**
   * Per-plot appearance chosen by the user, keyed by plot key. Deliberately NOT part of
   * the memo key: styles change how a result is painted, never what it computes, so a
   * colour change must not throw away a 400-bar MACD.
   */
  readonly styles: PlotStyles;
}

export interface FeatureState {
  chartType: ChartType;
  chartParams: ChartTypeParams;
  indicators: ActiveIndicator[];
}

export function createFeatureState(): FeatureState {
  return { chartType: 'candles', chartParams: {}, indicators: [] };
}

interface SeriesCacheEntry {
  readonly revision: number;
  readonly type: ChartType;
  readonly key: string;
  readonly series: DerivedSeries;
}

/**
 * Memoised chart-type transform, keyed by (revision, type, params).
 *
 * `misses` is exported deliberately: a memo whose key changes every frame is not a memo,
 * and it fails silently — the chart still looks right, it is just recomputing an O(n)
 * transform per frame. That happened (the key was the combined series+view revision), so
 * the miss count is now a testable fact rather than something to profile for.
 */
export interface SeriesMemo {
  compute(revision: number, type: ChartType, params: ChartTypeParams, bars: readonly Bar[]): DerivedSeries;
  misses(): number;
}

export function createSeriesMemo(): SeriesMemo {
  let cache: SeriesCacheEntry | null = null;
  let misses = 0;
  return {
    compute(revision, type, params, bars) {
      const key = JSON.stringify(params);
      const hit = cache;
      if (hit !== null && hit.revision === revision && hit.type === type && hit.key === key) {
        return hit.series;
      }
      misses += 1;
      const series = applyChartType(type, bars, params);
      cache = { revision, type, key, series };
      return series;
    },
    misses: () => misses,
  };
}

interface IndicatorCacheEntry {
  readonly revision: number;
  readonly key: string;
  readonly result: IndicatorResult;
}

/** Memoised indicator compute, one cache slot per handle. */
export interface IndicatorMemo {
  compute(
    handleId: string,
    revision: number,
    id: IndicatorId,
    params: IndicatorParams,
    bars: readonly Bar[],
  ): IndicatorResult;
  misses(): number;
}

export function createIndicatorMemo(): IndicatorMemo {
  const cache = new Map<string, IndicatorCacheEntry>();
  let misses = 0;
  return {
    compute(handleId, revision, id, params, bars) {
      const key = `${id}:${JSON.stringify(params)}`;
      const hit = cache.get(handleId);
      if (hit !== undefined && hit.revision === revision && hit.key === key) return hit.result;
      misses += 1;
      const result = computeIndicator(id, bars, params);
      cache.set(handleId, { revision, key, result });
      return result;
    },
    misses: () => misses,
  };
}

/** Indicators are split by where they draw; the pane ones need vertical space. */
export function splitByPlacement(
  active: readonly ActiveIndicator[],
  resolve: (indicator: ActiveIndicator) => IndicatorResult,
): {
  readonly overlays: readonly { indicator: ActiveIndicator; result: IndicatorResult }[];
  readonly panes: readonly { indicator: ActiveIndicator; result: IndicatorResult }[];
} {
  const overlays: { indicator: ActiveIndicator; result: IndicatorResult }[] = [];
  const panes: { indicator: ActiveIndicator; result: IndicatorResult }[] = [];
  for (const indicator of active) {
    const result = resolve(indicator);
    (result.placement === 'pane' ? panes : overlays).push({ indicator, result });
  }
  return { overlays, panes };
}
