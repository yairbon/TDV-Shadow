/**
 * Ichimoku Kinko Hyo — five plots, two of them displaced in time.
 *
 *   Tenkan-sen  = (HH 9  + LL 9 ) / 2
 *   Kijun-sen   = (HH 26 + LL 26) / 2
 *   Senkou A    = (Tenkan + Kijun) / 2, drawn 26 bars FORWARD
 *   Senkou B    = (HH 52 + LL 52) / 2, drawn 26 bars FORWARD
 *   Chikou      = close, drawn 26 bars BACKWARD
 *
 * The displacement is what makes Ichimoku Ichimoku, so it is baked into the values rather
 * than left to the renderer: `senkouA[i]` is the span computed 26 bars ago, and
 * `chikou[i]` is the close 26 bars ahead. Two consequences a reader should know:
 *
 * 1. The cloud's projection PAST the last bar cannot be expressed in a bar-aligned array
 *    and is dropped. Drawing the cloud into empty space to the right of the last candle
 *    needs future bar slots, which the columnar contract does not have.
 * 2. Chikou is therefore the earliest-formed plot (it has a value at bar 0) and the LAST
 *    26 entries are NaN rather than the first. It is listed first in `plots` because the
 *    contract reads an indicator's warm-up from `plots[0]`, and Chikou's 0 is the honest
 *    answer for "bars consumed before the first real value".
 *
 * The displacement is tied to the Kijun period, as in the classic definition. Platforms
 * that expose a separate "displacement" input default it to the same 26.
 *
 * All four high/low windows use the one-pass rolling extreme kernel: at Senkou B's 52 bars
 * the naive nested loop is O(n·52) for a single plot and is visible in the frame budget.
 */

import type { Bar } from '../data/types.js';
import {
  extractField,
  nanArray,
  normalizePeriod,
  rollingMaxInto,
  rollingMinInto,
} from './shared.js';
import { TOKEN_BAND, TOKEN_LINE, TOKEN_LINE_ALT, TOKEN_LINE_THIRD, TOKEN_LINE_POSITIVE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const ICHIMOKU_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({
    key: 'chikou',
    label: 'Chikou',
    style: 'line',
    colorToken: TOKEN_LINE_THIRD,
  }),
  Object.freeze<PlotSpec>({ key: 'tenkan', label: 'Tenkan', style: 'line', colorToken: TOKEN_LINE }),
  Object.freeze<PlotSpec>({
    key: 'kijun',
    label: 'Kijun',
    style: 'line',
    colorToken: TOKEN_LINE_ALT,
  }),
  Object.freeze<PlotSpec>({
    key: 'senkouA',
    label: 'Senkou A',
    style: 'band',
    colorToken: TOKEN_LINE_POSITIVE,
    pairedWith: 'senkouB',
  }),
  Object.freeze<PlotSpec>({
    key: 'senkouB',
    label: 'Senkou B',
    style: 'band',
    colorToken: TOKEN_BAND,
    pairedWith: 'senkouA',
  }),
]);

/** Midpoint of the rolling high-low channel — the shape all three lines share. */
function channelMidpoint(
  highs: Float64Array,
  lows: Float64Array,
  period: number,
  out: Float64Array,
): void {
  const high = nanArray(highs.length);
  const low = nanArray(lows.length);
  rollingMaxInto(highs, period, high);
  rollingMinInto(lows, period, low);
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(high[i]) || Number.isNaN(low[i])) continue;
    out[i] = (high[i] + low[i]) / 2;
  }
}

export const ichimokuIndicator: IndicatorDefinition = {
  id: 'ichimoku',
  label: 'Ichimoku Cloud',
  placement: 'overlay',
  defaults: Object.freeze({ tenkanPeriod: 9, kijunPeriod: 26, senkouBPeriod: 52 }),

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const tenkanPeriod = normalizePeriod(params.tenkanPeriod, 9);
    const kijunPeriod = normalizePeriod(params.kijunPeriod, 26);
    const senkouBPeriod = normalizePeriod(params.senkouBPeriod, 52);
    const displacement = kijunPeriod;
    const n = bars.length;

    const highs = extractField(bars, 'h');
    const lows = extractField(bars, 'l');

    const tenkan = nanArray(n);
    const kijun = nanArray(n);
    const senkouA = nanArray(n);
    const senkouB = nanArray(n);
    const chikou = nanArray(n);

    channelMidpoint(highs, lows, tenkanPeriod, tenkan);
    channelMidpoint(highs, lows, kijunPeriod, kijun);

    const senkouBRaw = nanArray(n);
    channelMidpoint(highs, lows, senkouBPeriod, senkouBRaw);

    for (let i = 0; i < n; i++) {
      const source = i - displacement;
      if (source >= 0) {
        if (!Number.isNaN(tenkan[source]) && !Number.isNaN(kijun[source])) {
          senkouA[i] = (tenkan[source] + kijun[source]) / 2;
        }
        senkouB[i] = senkouBRaw[source];
      }
      // Chikou is the close pulled BACK, so the tail of the series has nothing to show.
      const ahead = i + displacement;
      if (ahead < n) chikou[i] = bars[ahead].c;
    }

    return {
      id: 'ichimoku',
      placement: 'overlay',
      plots: ICHIMOKU_PLOTS,
      values: { chikou, tenkan, kijun, senkouA, senkouB },
      scaleBounds: null,
      guides: [],
      // Chikou carries a value from bar 0, so nothing is consumed before the first plotted
      // point. The individual lines form later, each at its own period.
      warmup: 0,
    };
  },
};
