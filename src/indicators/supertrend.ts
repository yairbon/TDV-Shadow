/**
 * Supertrend — an ATR trailing stop that flips from one side of price to the other.
 *
 *   mid   = (high + low) / 2
 *   bands = mid ± multiplier × ATR(period)
 *
 * The bands then RATCHET: the upper band may only move down (and the lower band only up)
 * while the trend holds, and it is released only when the previous close broke through it.
 * That ratchet is the whole indicator — without it the "stop" would wander back and forth
 * with volatility and never hold a level.
 *
 *   upper[i] = basicUpper[i] < upper[i−1] || close[i−1] > upper[i−1] ? basicUpper[i] : upper[i−1]
 *   lower[i] = basicLower[i] > lower[i−1] || close[i−1] < lower[i−1] ? basicLower[i] : lower[i−1]
 *
 * In an uptrend the line is the lower band; a close BELOW it flips the trend down and the
 * line jumps to the upper band, and vice versa. This is the TradingView `ta.supertrend`
 * formulation, including its initialisation: the first formed bar starts in a downtrend,
 * with the line above price, until a close clears the upper band. The other common
 * variant seeds the direction from the first bar's close against its mid, which changes
 * only the first few bars and then converges to the same line.
 *
 * One plot: a single line whose SIDE carries the signal. The renderer draws it as one
 * polyline, so the flip appears as the vertical jump it really is.
 */

import type { Bar } from '../data/types.js';
import { atrInto, leadingNaNCount, nanArray, normalizeFactor, normalizePeriod } from './shared.js';
import { TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const SUPERTREND_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({
    key: 'supertrend',
    label: 'Supertrend',
    style: 'line',
    colorToken: TOKEN_LINE,
  }),
]);

export const supertrendIndicator: IndicatorDefinition = {
  id: 'supertrend',
  label: 'Supertrend',
  placement: 'overlay',
  defaults: Object.freeze({ period: 10, multiplier: 3 }),

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 10);
    const multiplier = normalizeFactor(params.multiplier, 3);
    const supertrend = nanArray(bars.length);

    const atr = nanArray(bars.length);
    atrInto(bars, period, atr);

    let upper = Number.NaN;
    let lower = Number.NaN;
    // +1 while the stop trails below price, −1 while it sits above.
    let trend = -1;
    let started = false;

    for (let i = 0; i < bars.length; i++) {
      if (Number.isNaN(atr[i])) continue;

      const mid = (bars[i].h + bars[i].l) / 2;
      const basicUpper = mid + multiplier * atr[i];
      const basicLower = mid - multiplier * atr[i];

      if (!started) {
        upper = basicUpper;
        lower = basicLower;
        trend = -1;
        started = true;
        supertrend[i] = upper;
        continue;
      }

      const previousClose = bars[i - 1].c;
      upper = basicUpper < upper || previousClose > upper ? basicUpper : upper;
      lower = basicLower > lower || previousClose < lower ? basicLower : lower;

      // The flip test is against the band the line is currently sitting on.
      trend = trend === -1 ? (bars[i].c > upper ? 1 : -1) : bars[i].c < lower ? -1 : 1;
      supertrend[i] = trend === 1 ? lower : upper;
    }

    return {
      id: 'supertrend',
      placement: 'overlay',
      plots: SUPERTREND_PLOTS,
      values: { supertrend },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(supertrend),
    };
  },
};
