/** EMA, WMA and VWAP — the remaining overlay averages. */

import type { Bar } from '../data/types.js';
import {
  emaInto,
  extractSource,
  leadingNaNCount,
  nanArray,
  normalizePeriod,
  wmaInto,
} from './shared.js';
import { TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

function singlePlot(key: string, label: string): readonly PlotSpec[] {
  return Object.freeze([
    Object.freeze<PlotSpec>({ key, label, style: 'line', colorToken: TOKEN_LINE }),
  ]);
}

const EMA_PLOTS = singlePlot('ema', 'EMA');
const WMA_PLOTS = singlePlot('wma', 'WMA');
const VWAP_PLOTS = singlePlot('vwap', 'VWAP');

export const emaIndicator: IndicatorDefinition = {
  id: 'ema',
  label: 'Exponential Moving Average',
  placement: 'overlay',
  defaults: Object.freeze({ period: 20, source: 'close' }),
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 20);
    const ema = nanArray(bars.length);
    emaInto(extractSource(bars, params.source), period, ema);
    return {
      id: 'ema',
      placement: 'overlay',
      plots: EMA_PLOTS,
      values: { ema },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(ema),
    };
  },
};

export const wmaIndicator: IndicatorDefinition = {
  id: 'wma',
  label: 'Weighted Moving Average',
  placement: 'overlay',
  defaults: Object.freeze({ period: 20, source: 'close' }),
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 20);
    const wma = nanArray(bars.length);
    wmaInto(extractSource(bars, params.source), period, wma);
    return {
      id: 'wma',
      placement: 'overlay',
      plots: WMA_PLOTS,
      values: { wma },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(wma),
    };
  },
};

/**
 * VWAP — cumulative typical-price × volume over volume.
 *
 * Deliberately cumulative from the first bar of the loaded series rather than
 * session-anchored: this app has no session calendar, and inventing one would make VWAP
 * silently wrong at every session boundary. Documented here so the limitation is visible
 * rather than discovered.
 */
export const vwapIndicator: IndicatorDefinition = {
  id: 'vwap',
  label: 'VWAP (series-anchored)',
  placement: 'overlay',
  defaults: Object.freeze({ source: 'hlc3' }),
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const src = extractSource(bars, params.source ?? 'hlc3');
    const vwap = nanArray(bars.length);
    let cumulativePv = 0;
    let cumulativeVolume = 0;
    for (let i = 0; i < bars.length; i++) {
      cumulativePv += src[i] * bars[i].v;
      cumulativeVolume += bars[i].v;
      // Zero cumulative volume leaves NaN rather than dividing to Infinity.
      if (cumulativeVolume > 0) vwap[i] = cumulativePv / cumulativeVolume;
    }
    return {
      id: 'vwap',
      placement: 'overlay',
      plots: VWAP_PLOTS,
      values: { vwap },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(vwap),
    };
  },
};
