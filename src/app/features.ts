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

export interface ActiveIndicator {
  readonly handleId: string;
  readonly id: IndicatorId;
  readonly params: IndicatorParams;
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

/** Memoised chart-type transform, keyed by (revision, type, params). */
export function createSeriesMemo(): (
  revision: number,
  type: ChartType,
  params: ChartTypeParams,
  bars: readonly Bar[],
) => DerivedSeries {
  let cache: SeriesCacheEntry | null = null;
  return (revision, type, params, bars) => {
    const key = JSON.stringify(params);
    const hit = cache;
    if (hit !== null && hit.revision === revision && hit.type === type && hit.key === key) {
      return hit.series;
    }
    const series = applyChartType(type, bars, params);
    cache = { revision, type, key, series };
    return series;
  };
}

interface IndicatorCacheEntry {
  readonly revision: number;
  readonly key: string;
  readonly result: IndicatorResult;
}

/** Memoised indicator compute, one cache slot per handle. */
export function createIndicatorMemo(): (
  handleId: string,
  revision: number,
  id: IndicatorId,
  params: IndicatorParams,
  bars: readonly Bar[],
) => IndicatorResult {
  const cache = new Map<string, IndicatorCacheEntry>();
  return (handleId, revision, id, params, bars) => {
    const key = `${id}:${JSON.stringify(params)}`;
    const hit = cache.get(handleId);
    if (hit !== undefined && hit.revision === revision && hit.key === key) return hit.result;
    const result = computeIndicator(id, bars, params);
    cache.set(handleId, { revision, key, result });
    return result;
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
