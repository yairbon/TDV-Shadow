/** Simple moving average — the arithmetic mean of the last `period` source values. */

import type { Bar } from '../data/types.js';
import { extractSource, nanArray, normalizePeriod, smaInto } from './shared.js';
import { TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

export const SMA_DEFAULTS: IndicatorParams = Object.freeze({ period: 20, source: 'close' });

const PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'sma', label: 'SMA', style: 'line', colorToken: TOKEN_LINE }),
]);

export const smaIndicator: IndicatorDefinition = {
  id: 'sma',
  label: 'Simple Moving Average',
  placement: 'overlay',
  defaults: SMA_DEFAULTS,

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 20);
    const sma = nanArray(bars.length);
    smaInto(extractSource(bars, params.source), period, sma);

    return {
      id: 'sma',
      placement: 'overlay',
      plots: PLOTS,
      values: { sma },
      scaleBounds: null,
      guides: [],
      // period - 1 bars are consumed before the window is full.
      warmup: period - 1,
    };
  },
};
