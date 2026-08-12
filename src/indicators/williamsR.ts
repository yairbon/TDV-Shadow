/**
 * Williams %R.
 *
 *   %R = −100 × (highestHigh − close) / (highestHigh − lowestLow)
 *
 * Bounded in [−100, 0] by construction: the close cannot leave the window's own high-low
 * range. It is the Stochastic %K mirrored about zero, so it is drawn on a fixed −100..0
 * scale with the conventional −20 / −80 guides.
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
import { TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const WILLIAMS_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'r', label: '%R', style: 'line', colorToken: TOKEN_LINE }),
]);

export const williamsRIndicator: IndicatorDefinition = {
  id: 'williams-r',
  label: 'Williams %R',
  placement: 'pane',
  defaults: Object.freeze({ period: 14 }),

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 14);
    const highest = nanArray(bars.length);
    const lowest = nanArray(bars.length);
    const r = nanArray(bars.length);

    rollingMaxInto(extractField(bars, 'h'), period, highest);
    rollingMinInto(extractField(bars, 'l'), period, lowest);

    for (let i = period - 1; i < bars.length; i++) {
      const high = highest[i];
      const low = lowest[i];
      if (Number.isNaN(high) || Number.isNaN(low)) continue;
      const span = high - low;
      // A window with no range has no position within it; −50 is the midpoint reading,
      // matching how the Stochastic here resolves the same degeneracy at 50.
      r[i] = span === 0 ? -50 : (-100 * (high - bars[i].c)) / span;
    }

    return {
      id: 'williams-r',
      placement: 'pane',
      plots: WILLIAMS_PLOTS,
      values: { r },
      scaleBounds: [-100, 0],
      guides: [-20, -80],
      warmup: leadingNaNCount(r),
    };
  },
};
