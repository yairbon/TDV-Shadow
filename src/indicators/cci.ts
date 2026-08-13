/**
 * Commodity Channel Index.
 *
 *   CCI = (TP − SMA(TP, n)) / (0.015 × meanDeviation)
 *
 * where TP is the typical price (h + l + c) / 3 and meanDeviation is the MEAN ABSOLUTE
 * deviation from that same SMA — not the standard deviation. Substituting the standard
 * deviation is the common mistake and it rescales the whole oscillator, so the ±100 lines
 * stop meaning what every reference says they mean.
 *
 * Lambert's 0.015 constant is what puts roughly 70–80% of readings inside ±100; it is part
 * of the definition, not a tunable.
 */

import type { Bar } from '../data/types.js';
import { extractSource, leadingNaNCount, nanArray, normalizePeriod, smaInto } from './shared.js';
import { TOKEN_LINE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const LAMBERT_CONSTANT = 0.015;

const CCI_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({ key: 'cci', label: 'CCI', style: 'line', colorToken: TOKEN_LINE }),
]);

export const cciIndicator: IndicatorDefinition = {
  id: 'cci',
  label: 'Commodity Channel Index',
  placement: 'pane',
  // Typical price by default: CCI is defined on (h+l+c)/3, though the source is editable.
  defaults: Object.freeze({ period: 20, source: 'hlc3' }),

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 20);
    const typical = extractSource(bars, params.source ?? 'hlc3');

    const mean = nanArray(bars.length);
    const cci = nanArray(bars.length);
    smaInto(typical, period, mean);

    for (let i = period - 1; i < bars.length; i++) {
      const average = mean[i];
      if (Number.isNaN(average)) continue;

      let deviation = 0;
      for (let j = i - period + 1; j <= i; j++) deviation += Math.abs(typical[j] - average);
      deviation /= period;

      // A perfectly flat window has zero deviation and zero numerator: price sits exactly
      // on its own mean, which is CCI 0. Guard the divide rather than emitting NaN, which
      // would break the line in the middle of a formed series.
      cci[i] = deviation === 0 ? 0 : (typical[i] - average) / (LAMBERT_CONSTANT * deviation);
    }

    return {
      id: 'cci',
      placement: 'pane',
      plots: CCI_PLOTS,
      values: { cci },
      scaleBounds: null,
      guides: [-100, 0, 100],
      warmup: leadingNaNCount(cci),
    };
  },
};
