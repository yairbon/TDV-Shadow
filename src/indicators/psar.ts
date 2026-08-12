/**
 * Parabolic SAR (stop and reverse), Wilder's original.
 *
 *   SAR[i] = SAR[i−1] + AF × (EP − SAR[i−1])
 *
 * EP is the extreme point of the current trend (the highest high of an uptrend, the lowest
 * low of a downtrend) and AF accelerates by `step` each time the EP makes a new extreme,
 * capped at `maxStep`.
 *
 * Two details that are the whole indicator and are usually where implementations go wrong:
 *
 * 1. **The clamp.** In an uptrend the SAR may never be placed above the low of either of
 *    the two previous bars (mirrored in a downtrend). Without it the stop can start the
 *    bar already triggered.
 * 2. **The reversal.** When price penetrates the SAR, the trend flips, the new SAR is the
 *    OLD extreme point, the new EP is the current bar's extreme, and AF resets to `step`.
 *
 * The result is a stop that is always on the opposite side of price from the trend, which
 * is why it is drawn as dots rather than a continuous line.
 *
 * Bar 0 has no previous bar to establish a direction from, so it stays NaN; the series is
 * seeded at bar 1 from the first two bars' extremes.
 */

import type { Bar } from '../data/types.js';
import { leadingNaNCount, nanArray, normalizeFactor } from './shared.js';
import { TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const PSAR_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'psar', label: 'PSAR', style: 'dots', colorToken: TOKEN_LINE }),
]);

export const psarIndicator: IndicatorDefinition = {
  id: 'psar',
  label: 'Parabolic SAR',
  placement: 'overlay',
  defaults: Object.freeze({ step: 0.02, maxStep: 0.2 }),

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const step = normalizeFactor(params.step, 0.02);
    const maxStep = Math.max(normalizeFactor(params.maxStep, 0.2), step);
    const psar = nanArray(bars.length);

    if (bars.length >= 2) {
      // Seed from the first two bars: their close decides the direction, their extremes
      // give the starting stop and extreme point.
      let rising = bars[1].c >= bars[0].c;
      let extreme = rising
        ? Math.max(bars[0].h, bars[1].h)
        : Math.min(bars[0].l, bars[1].l);
      let sar = rising ? Math.min(bars[0].l, bars[1].l) : Math.max(bars[0].h, bars[1].h);
      let acceleration = step;
      psar[1] = sar;

      for (let i = 2; i < bars.length; i++) {
        let next = sar + acceleration * (extreme - sar);

        // Clamp against the previous two bars, then test for penetration.
        if (rising) {
          next = Math.min(next, bars[i - 1].l, bars[i - 2].l);
          if (bars[i].l < next) {
            rising = false;
            next = extreme;
            extreme = bars[i].l;
            acceleration = step;
          } else if (bars[i].h > extreme) {
            extreme = bars[i].h;
            acceleration = Math.min(acceleration + step, maxStep);
          }
        } else {
          next = Math.max(next, bars[i - 1].h, bars[i - 2].h);
          if (bars[i].h > next) {
            rising = true;
            next = extreme;
            extreme = bars[i].h;
            acceleration = step;
          } else if (bars[i].l < extreme) {
            extreme = bars[i].l;
            acceleration = Math.min(acceleration + step, maxStep);
          }
        }

        sar = next;
        psar[i] = sar;
      }
    }

    return {
      id: 'psar',
      placement: 'overlay',
      plots: PSAR_PLOTS,
      values: { psar },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(psar),
    };
  },
};
