/**
 * Bollinger Bands, MACD, RSI, Stochastic and ATR.
 *
 * RSI uses WILDER's smoothing (1/period), not a plain EMA (2/(period+1)). They are
 * different filters and the difference is visible on a chart — a "close enough" EMA
 * gives an RSI that disagrees with every other platform.
 */

import type { Bar } from '../data/types.js';
import {
  emaInto,
  extractSource,
  leadingNaNCount,
  nanArray,
  normalizeFactor,
  normalizePeriod,
  smaInto,
  stdDevInto,
  wilderInto,
} from './shared.js';
import { TOKEN_BAND, TOKEN_HISTOGRAM, TOKEN_LINE, TOKEN_LINE_ALT } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const BOLLINGER_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'middle', label: 'Basis', style: 'line', colorToken: TOKEN_LINE }),
  Object.freeze<PlotSpec>({
    key: 'upper',
    label: 'Upper',
    style: 'band',
    colorToken: TOKEN_BAND,
    pairedWith: 'lower',
  }),
  Object.freeze<PlotSpec>({
    key: 'lower',
    label: 'Lower',
    style: 'band',
    colorToken: TOKEN_BAND,
    pairedWith: 'upper',
  }),
]);

export const bollingerIndicator: IndicatorDefinition = {
  id: 'bollinger',
  label: 'Bollinger Bands',
  placement: 'overlay',
  defaults: Object.freeze({ period: 20, stdDev: 2, source: 'close' }),
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 20);
    const factor = normalizeFactor(params.stdDev, 2);
    const src = extractSource(bars, params.source);

    const middle = nanArray(bars.length);
    const upper = nanArray(bars.length);
    const lower = nanArray(bars.length);
    const deviation = nanArray(bars.length);

    smaInto(src, period, middle);
    stdDevInto(src, middle, period, deviation);
    for (let i = 0; i < bars.length; i++) {
      const sd = deviation[i];
      if (Number.isNaN(sd)) continue;
      upper[i] = middle[i] + sd * factor;
      lower[i] = middle[i] - sd * factor;
    }

    return {
      id: 'bollinger',
      placement: 'overlay',
      plots: BOLLINGER_PLOTS,
      values: { middle, upper, lower },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(middle),
    };
  },
};

const MACD_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'macd', label: 'MACD', style: 'line', colorToken: TOKEN_LINE }),
  Object.freeze<PlotSpec>({
    key: 'signal',
    label: 'Signal',
    style: 'line',
    colorToken: TOKEN_LINE_ALT,
  }),
  Object.freeze<PlotSpec>({
    key: 'histogram',
    label: 'Histogram',
    style: 'histogram',
    colorToken: TOKEN_HISTOGRAM,
  }),
]);

export const macdIndicator: IndicatorDefinition = {
  id: 'macd',
  label: 'MACD',
  placement: 'pane',
  defaults: Object.freeze({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, source: 'close' }),
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const fastPeriod = normalizePeriod(params.fastPeriod, 12);
    const slowPeriod = normalizePeriod(params.slowPeriod, 26);
    const signalPeriod = normalizePeriod(params.signalPeriod, 9);
    const src = extractSource(bars, params.source);

    const fast = nanArray(bars.length);
    const slow = nanArray(bars.length);
    const macd = nanArray(bars.length);
    const signal = nanArray(bars.length);
    const histogram = nanArray(bars.length);

    emaInto(src, fastPeriod, fast);
    emaInto(src, slowPeriod, slow);
    for (let i = 0; i < bars.length; i++) {
      if (Number.isNaN(fast[i]) || Number.isNaN(slow[i])) continue;
      macd[i] = fast[i] - slow[i];
    }

    // The signal EMA must be seeded from the first REAL macd value, not from index 0 —
    // feeding leading NaNs into the seed poisons every later value.
    const macdStart = leadingNaNCount(macd);
    if (macdStart < bars.length) emaInto(macd, signalPeriod, signal, macdStart);

    for (let i = 0; i < bars.length; i++) {
      if (Number.isNaN(macd[i]) || Number.isNaN(signal[i])) continue;
      histogram[i] = macd[i] - signal[i];
    }

    return {
      id: 'macd',
      placement: 'pane',
      plots: MACD_PLOTS,
      values: { macd, signal, histogram },
      scaleBounds: null,
      guides: [0],
      warmup: leadingNaNCount(macd),
    };
  },
};

const RSI_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'rsi', label: 'RSI', style: 'line', colorToken: TOKEN_LINE }),
]);

export const rsiIndicator: IndicatorDefinition = {
  id: 'rsi',
  label: 'Relative Strength Index',
  placement: 'pane',
  defaults: Object.freeze({ period: 14, source: 'close' }),
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 14);
    const src = extractSource(bars, params.source);
    const rsi = nanArray(bars.length);

    if (bars.length > period) {
      const gains = new Float64Array(bars.length);
      const losses = new Float64Array(bars.length);
      for (let i = 1; i < bars.length; i++) {
        const change = src[i] - src[i - 1];
        gains[i] = change > 0 ? change : 0;
        losses[i] = change < 0 ? -change : 0;
      }

      const avgGain = nanArray(bars.length);
      const avgLoss = nanArray(bars.length);
      // offset 1: index 0 has no change, so smoothing starts at the first real delta.
      wilderInto(gains, period, avgGain, 1);
      wilderInto(losses, period, avgLoss, 1);

      for (let i = 0; i < bars.length; i++) {
        const gain = avgGain[i];
        const loss = avgLoss[i];
        if (Number.isNaN(gain) || Number.isNaN(loss)) continue;
        // All-gain windows are RSI 100 by definition; guard the divide rather than
        // producing Infinity.
        rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    }

    return {
      id: 'rsi',
      placement: 'pane',
      plots: RSI_PLOTS,
      values: { rsi },
      scaleBounds: [0, 100],
      guides: [30, 70],
      warmup: leadingNaNCount(rsi),
    };
  },
};

const STOCH_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'k', label: '%K', style: 'line', colorToken: TOKEN_LINE }),
  Object.freeze<PlotSpec>({ key: 'd', label: '%D', style: 'line', colorToken: TOKEN_LINE_ALT }),
]);

export const stochasticIndicator: IndicatorDefinition = {
  id: 'stochastic',
  label: 'Stochastic Oscillator',
  placement: 'pane',
  defaults: Object.freeze({ period: 14, signalPeriod: 3 }),
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 14);
    const signalPeriod = normalizePeriod(params.signalPeriod, 3);
    const k = nanArray(bars.length);
    const d = nanArray(bars.length);

    for (let i = period - 1; i < bars.length; i++) {
      let highest = -Infinity;
      let lowest = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        highest = Math.max(highest, bars[j].h);
        lowest = Math.min(lowest, bars[j].l);
      }
      const span = highest - lowest;
      // A flat window has no range; 50 is the conventional neutral reading and avoids
      // dividing by zero.
      k[i] = span === 0 ? 50 : ((bars[i].c - lowest) / span) * 100;
    }

    const kStart = leadingNaNCount(k);
    if (kStart < bars.length) smaInto(k, signalPeriod, d, kStart);

    return {
      id: 'stochastic',
      placement: 'pane',
      plots: STOCH_PLOTS,
      values: { k, d },
      scaleBounds: [0, 100],
      guides: [20, 80],
      warmup: leadingNaNCount(k),
    };
  },
};

const ATR_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'atr', label: 'ATR', style: 'line', colorToken: TOKEN_LINE }),
]);

export const atrIndicator: IndicatorDefinition = {
  id: 'atr',
  label: 'Average True Range',
  placement: 'pane',
  defaults: Object.freeze({ period: 14 }),
  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 14);
    const atr = nanArray(bars.length);

    if (bars.length > 1) {
      const trueRange = new Float64Array(bars.length);
      for (let i = 1; i < bars.length; i++) {
        const previousClose = bars[i - 1].c;
        trueRange[i] = Math.max(
          bars[i].h - bars[i].l,
          Math.abs(bars[i].h - previousClose),
          Math.abs(bars[i].l - previousClose),
        );
      }
      wilderInto(trueRange, period, atr, 1);
    }

    return {
      id: 'atr',
      placement: 'pane',
      plots: ATR_PLOTS,
      values: { atr },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(atr),
    };
  },
};
