/**
 * Folding a live quote into the bar it belongs to.
 *
 * A quote is one number and a timestamp. The bar it lands in already has an open, a high,
 * a low and a volume, and only two of those may move: the close becomes the quoted price,
 * and the extremes widen if the price went outside them. The open is history and the
 * volume is unknowable from a quote — a trade count does not come with the last price, and
 * inventing one would put a fabricated figure on the volume pane.
 *
 * ## Why there is no "open a new bar" outcome
 *
 * When the quote is newer than the whole of the last bar, the honest move is to ask the
 * provider for bars, not to synthesize one. A fabricated bar would carry `v = 0` and an
 * open equal to its close, which is a real-looking bar that never traded that way; and
 * for a daily series the next bar's open time is a calendar question — weekends, holidays,
 * half days — that a timestamp cannot answer. So this reports `refetch` and stops.
 *
 * The caller therefore gets sub-bar responsiveness from quotes and correctness from the
 * series endpoint, each doing the part it can do truthfully.
 */

import { makeBar, TIMEFRAME_MS, type Bar, type Timeframe } from '../data/types.js';
import type { Quote } from './types.js';

export type QuoteApplication =
  /** The quote moved the current bar. `bar` is a new frozen object; swap the reference. */
  | { readonly kind: 'update'; readonly bar: Bar }
  /** The quote agrees with what is already drawn. Repainting would be pure churn. */
  | { readonly kind: 'unchanged' }
  /** The quote belongs to a later bar than the last one held. Ask for bars. */
  | { readonly kind: 'refetch' }
  /** The quote is older than the bar on screen, or unusable. Nothing is applied. */
  | { readonly kind: 'stale'; readonly reason: string };

/**
 * Decides what `quote` does to `last`, the newest bar of a `timeframe` series.
 *
 * Bar membership is tested as a half-open window forward from the bar's own open rather
 * than by flooring the quote's time into a UTC bucket. Daily equity bars are stamped at
 * the session's midnight — 04:00 or 05:00 UTC for a US venue — so a UTC-floored bucket
 * disagrees with every one of them and would report `refetch` forever.
 */
export function applyQuote(last: Bar, quote: Quote, timeframe: Timeframe): QuoteApplication {
  const price = quote.price;
  if (!Number.isFinite(price) || price <= 0) {
    return { kind: 'stale', reason: 'the quote carried no usable price' };
  }
  const time = quote.time;
  if (!Number.isFinite(time)) {
    return { kind: 'stale', reason: 'the quote carried no usable time' };
  }
  if (time < last.t) {
    return { kind: 'stale', reason: 'the quote predates the last bar' };
  }
  if (time >= last.t + TIMEFRAME_MS[timeframe]) return { kind: 'refetch' };

  const high = Math.max(last.h, price);
  const low = Math.min(last.l, price);
  if (price === last.c && high === last.h && low === last.l) return { kind: 'unchanged' };

  const bar = makeBar({ t: last.t, o: last.o, h: high, l: low, c: price, v: last.v });
  // `makeBar` validates and can refuse. It cannot refuse this one — the open and volume
  // come from a bar it already accepted, and high/low bracket the close by construction —
  // but a returned null is still a value, and treating it as one costs a line.
  if (bar === null) return { kind: 'stale', reason: 'the quoted price did not form a valid bar' };
  return { kind: 'update', bar };
}
