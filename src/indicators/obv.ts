/**
 * On-Balance Volume — a running total that adds the bar's volume on an up close and
 * subtracts it on a down close, leaving the total alone when the close is unchanged.
 *
 * The running total has no natural origin: OBV is only meaningful up to an additive
 * constant, so the first bar (which has no previous close to compare against) starts the
 * accumulator at 0. That 0 is a real value, not a warm-up placeholder — the line is
 * defined from bar 0 onwards and `warmup` is 0. This is the one indicator here where a
 * leading zero is correct rather than the cliff the contract warns about.
 */

import type { Bar } from '../data/types.js';
import { nanArray } from './shared.js';
import { TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorResult, PlotSpec } from './types.js';

const OBV_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'obv', label: 'OBV', style: 'line', colorToken: TOKEN_LINE }),
]);

export const obvIndicator: IndicatorDefinition = {
  id: 'obv',
  label: 'On-Balance Volume',
  placement: 'pane',
  defaults: Object.freeze({}),

  compute(bars: readonly Bar[]): IndicatorResult {
    const obv = nanArray(bars.length);
    let total = 0;

    for (let i = 0; i < bars.length; i++) {
      if (i > 0) {
        const change = bars[i].c - bars[i - 1].c;
        // Strictly one bar's volume, in the direction of the close change; an unchanged
        // close contributes nothing at all.
        if (change > 0) total += bars[i].v;
        else if (change < 0) total -= bars[i].v;
      }
      obv[i] = total;
    }

    return {
      id: 'obv',
      placement: 'pane',
      plots: OBV_PLOTS,
      values: { obv },
      scaleBounds: null,
      guides: [0],
      warmup: 0,
    };
  },
};
