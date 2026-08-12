/**
 * Donchian Channels — the highest high and lowest low of the trailing window, with the
 * midline halfway between them.
 *
 * The window INCLUDES the current bar, matching the standard channel indicator: the upper
 * band is then the running high the market has actually reached, and price can touch the
 * band but never pierce it. The breakout variant that excludes the current bar (shifting
 * the window back one) is a different, signal-oriented indicator and is not what this
 * draws.
 */

import type { Bar } from '../data/types.js';
import {
  extractField,
  leadingNaNCount,
  nanArray,
  normalizePeriod,
  rollingMaxInto,
  rollingMinInto,
} from './shared.js';
import { TOKEN_BAND, TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const DONCHIAN_PLOTS: readonly PlotSpec[] = Object.freeze([
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

export const donchianIndicator: IndicatorDefinition = {
  id: 'donchian',
  label: 'Donchian Channels',
  placement: 'overlay',
  defaults: Object.freeze({ period: 20 }),

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 20);
    const upper = nanArray(bars.length);
    const lower = nanArray(bars.length);
    const middle = nanArray(bars.length);

    rollingMaxInto(extractField(bars, 'h'), period, upper);
    rollingMinInto(extractField(bars, 'l'), period, lower);
    for (let i = 0; i < bars.length; i++) {
      if (Number.isNaN(upper[i]) || Number.isNaN(lower[i])) continue;
      middle[i] = (upper[i] + lower[i]) / 2;
    }

    return {
      id: 'donchian',
      placement: 'overlay',
      plots: DONCHIAN_PLOTS,
      values: { middle, upper, lower },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(middle),
    };
  },
};
