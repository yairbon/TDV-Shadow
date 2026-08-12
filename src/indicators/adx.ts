/**
 * Average Directional Index with its two directional indicators (+DI, −DI).
 *
 * Wilder's original construction, all three legs of it:
 *
 *   upMove   = high − prevHigh          downMove = prevLow − low
 *   +DM      = upMove   if upMove > downMove and upMove > 0,   else 0
 *   −DM      = downMove if downMove > upMove and downMove > 0, else 0
 *   +DI      = 100 × wilder(+DM, n) / wilder(TR, n)
 *   DX       = 100 × |+DI − −DI| / (+DI + −DI)
 *   ADX      = wilder(DX, n)
 *
 * Two choices worth naming:
 *
 * 1. The DM and TR legs are smoothed as Wilder AVERAGES (`avg += (x − avg)/n`), where
 *    Wilder wrote running SUMS (`sum -= sum/n; sum += x`). The sums are exactly n times
 *    the averages, and both DI legs divide one by the other, so the ratio — and therefore
 *    every published ADX value — is identical. The average form reuses the same kernel RSI
 *    and ATR already use.
 * 2. An equal up and down move contributes to NEITHER +DM nor −DM (both tests are strict).
 *    An inside bar likewise contributes zero on both sides. That is Wilder's rule; the
 *    variant that awards the tie to +DM biases the index upwards on quiet ranges.
 *
 * Warm-up: the DI pair forms at index `period`, and ADX is smoothed from there, so ADX
 * itself does not appear until index `2 × period − 1` — 27 bars for the default 14.
 */

import type { Bar } from '../data/types.js';
import { leadingNaNCount, nanArray, normalizePeriod, trueRange, wilderInto } from './shared.js';
import { TOKEN_LINE, TOKEN_LINE_NEGATIVE, TOKEN_LINE_POSITIVE } from './tokens.js';
import type { IndicatorDefinition, IndicatorParams, IndicatorResult, PlotSpec } from './types.js';

const ADX_PLOTS: readonly PlotSpec[] = Object.freeze([
  // +DI first: it is the earliest-formed plot, and the contract reads an indicator's
  // warm-up from plots[0]. ADX trails it by another `period` bars.
  Object.freeze<PlotSpec>({
    key: 'plusDI',
    label: '+DI',
    style: 'line',
    colorToken: TOKEN_LINE_POSITIVE,
  }),
  Object.freeze<PlotSpec>({
    key: 'minusDI',
    label: '−DI',
    style: 'line',
    colorToken: TOKEN_LINE_NEGATIVE,
  }),
  Object.freeze<PlotSpec>({ key: 'adx', label: 'ADX', style: 'line', colorToken: TOKEN_LINE }),
]);

export const adxIndicator: IndicatorDefinition = {
  id: 'adx',
  label: 'Average Directional Index',
  placement: 'pane',
  defaults: Object.freeze({ period: 14 }),

  compute(bars: readonly Bar[], params: IndicatorParams): IndicatorResult {
    const period = normalizePeriod(params.period, 14);
    const n = bars.length;

    const plusDI = nanArray(n);
    const minusDI = nanArray(n);
    const adx = nanArray(n);

    if (n > 1) {
      const plusDM = new Float64Array(n);
      const minusDM = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        const upMove = bars[i].h - bars[i - 1].h;
        const downMove = bars[i - 1].l - bars[i].l;
        plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
      }

      const smoothedPlus = nanArray(n);
      const smoothedMinus = nanArray(n);
      const smoothedRange = nanArray(n);
      // offset 1: index 0 has no previous bar, so smoothing starts at the first real move.
      wilderInto(plusDM, period, smoothedPlus, 1);
      wilderInto(minusDM, period, smoothedMinus, 1);
      wilderInto(trueRange(bars), period, smoothedRange, 1);

      const dx = nanArray(n);
      for (let i = 0; i < n; i++) {
        const range = smoothedRange[i];
        if (Number.isNaN(range)) continue;
        // A window with no true range at all has no direction either: report a flat 0 on
        // both legs rather than dividing by zero.
        const plus = range === 0 ? 0 : (100 * smoothedPlus[i]) / range;
        const minus = range === 0 ? 0 : (100 * smoothedMinus[i]) / range;
        plusDI[i] = plus;
        minusDI[i] = minus;
        const total = plus + minus;
        dx[i] = total === 0 ? 0 : (100 * Math.abs(plus - minus)) / total;
      }

      const dxStart = leadingNaNCount(dx);
      if (dxStart < n) wilderInto(dx, period, adx, dxStart);
    }

    return {
      id: 'adx',
      placement: 'pane',
      plots: ADX_PLOTS,
      values: { plusDI, minusDI, adx },
      scaleBounds: [0, 100],
      guides: [20, 40],
      warmup: leadingNaNCount(plusDI),
    };
  },
};
