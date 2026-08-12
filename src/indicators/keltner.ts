/**
 * Keltner Channels — an EMA basis with bands set an ATR multiple away.
 *
 *   middle = EMA(source, period)
 *   upper  = middle + multiplier × ATR(atrPeriod)
 *   lower  = middle − multiplier × ATR(atrPeriod)
 *
 * Defaults are EMA(20) ± ATR(10) × 2. Two variants a reader might expect instead:
 * Chester Keltner's original used an SMA of the typical price with the high-low range
 * rather than the ATR, and Linda Raschke's revision (the one everyone means today) is the
 * EMA+ATR form implemented here. The bands are a VOLATILITY envelope, not a standard
 * deviation envelope — that is Bollinger, and the two differ exactly when volatility and
 * dispersion disagree.
 */

import type { Bar } from '../data/types.js';
import {
  atrInto,
  emaInto,
  extractSource,
  leadingNaNCount,
  nanArray,
  normalizeFactor,
  normalizePeriod,
} from './shared.js';
import { TOKEN_BAND, TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const KELTNER_PLOTS: readonly PlotSpec[] = Object.freeze([
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

export const keltnerIndicator: IndicatorDefinition = {
  id: 'keltner',
  label: 'Keltner Channels',
  placement: 'overlay',
  defaults: Object.freeze({ period: 20, atrPeriod: 10, multiplier: 2, source: 'close' }),

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 20);
    const atrPeriod = normalizePeriod(params.atrPeriod, 10);
    const multiplier = normalizeFactor(params.multiplier, 2);

    const middle = nanArray(bars.length);
    const upper = nanArray(bars.length);
    const lower = nanArray(bars.length);
    const atr = nanArray(bars.length);

    emaInto(extractSource(bars, params.source), period, middle);
    atrInto(bars, atrPeriod, atr);

    for (let i = 0; i < bars.length; i++) {
      // Both inputs must be formed: an ATR that is still warming up would otherwise
      // collapse the bands onto the basis and read as zero volatility.
      if (Number.isNaN(middle[i]) || Number.isNaN(atr[i])) continue;
      upper[i] = middle[i] + multiplier * atr[i];
      lower[i] = middle[i] - multiplier * atr[i];
    }

    return {
      id: 'keltner',
      placement: 'overlay',
      plots: KELTNER_PLOTS,
      values: { middle, upper, lower },
      scaleBounds: null,
      guides: [],
      // The basis is the earliest-formed plot, so it defines the indicator's warm-up.
      warmup: leadingNaNCount(middle),
    };
  },
};
