/**
 * Which timeframes a symbol can actually be shown at, and how.
 *
 * The app used to decide this with `loaded.base !== null ? tf !== '1d' : tf === '1d'` —
 * a synthetic series got every intraday button and a real one got only daily, regardless
 * of what any provider could serve. This replaces that with resolution against a
 * provider's declared capabilities, so a button is enabled exactly when pressing it can
 * produce data, and a disabled one carries the reason.
 *
 * ## Why daily is never resampled from intraday
 *
 * `resample` buckets on `Math.floor(t / step) * step` — UTC boundaries. For a sub-daily
 * target that is right: an hour is an hour in any zone with a whole-hour offset. For a
 * DAILY target it is wrong, because UTC midnight is 20:00 in New York, so each "day"
 * would run from mid-evening to mid-evening and split every US session across two bars.
 * The result looks entirely plausible and is wrong in a way no glance would catch, so
 * daily is only ever served natively.
 */

import { canResample } from '../data/agg/resample.js';
import { TIMEFRAME_MS, TIMEFRAMES, type Timeframe } from '../data/types.js';
import type { ProviderCapabilities } from './types.js';

/** Where a series for a given timeframe comes from. */
export type SeriesOrigin = 'native' | 'resampled' | 'unavailable';

export interface Resolution {
  readonly timeframe: Timeframe;
  readonly origin: SeriesOrigin;
  /**
   * The timeframe to actually request. Equals `timeframe` for a native resolution, and
   * names the finer series to roll up for a resampled one.
   */
  readonly fetchAs: Timeframe;
  /**
   * Why this timeframe is unavailable, in words fit for a disabled button's tooltip.
   * Empty when it is available.
   */
  readonly reason: string;
}

/** A day is the boundary past which UTC bucketing stops agreeing with a trading session. */
const DAY_MS = TIMEFRAME_MS['1d'];

/**
 * How a timeframe can be served, given what a provider offers natively.
 *
 * Native always wins. Resampling is the fallback, permitted only when the target is
 * sub-daily — see the header for why — and only from a finer timeframe that divides it
 * exactly. The finest available source is chosen, since a 1m series rolls into anything
 * and carries the most detail.
 */
export function resolveTimeframe(
  capabilities: ProviderCapabilities,
  timeframe: Timeframe,
): Resolution {
  const native = capabilities.nativeTimeframes;

  if (native.includes(timeframe)) {
    return { timeframe, origin: 'native', fetchAs: timeframe, reason: '' };
  }

  if (TIMEFRAME_MS[timeframe] < DAY_MS) {
    // Finest first: more source bars means a more faithful roll-up.
    const sources = [...native]
      .filter((candidate) => canResample(candidate, timeframe))
      .sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
    const source = sources.at(0);
    if (source !== undefined) {
      return { timeframe, origin: 'resampled', fetchAs: source, reason: '' };
    }
  }

  const reason =
    native.length === 0
      ? `${capabilities.label} has no data available`
      : TIMEFRAME_MS[timeframe] >= DAY_MS
        ? `${capabilities.label} does not serve ${timeframe} directly`
        : `${capabilities.label} does not serve ${timeframe} — intraday needs a key with intraday access`;
  return { timeframe, origin: 'unavailable', fetchAs: timeframe, reason };
}

/** Every timeframe the app offers, resolved against one provider. */
export function resolveAll(capabilities: ProviderCapabilities): readonly Resolution[] {
  return TIMEFRAMES.map((timeframe) => resolveTimeframe(capabilities, timeframe));
}

/**
 * The best resolution across several providers.
 *
 * Ordered by preference: the first provider that can serve a timeframe natively wins, and
 * a native resolution anywhere beats a resampled one everywhere. A chart assembled from
 * whichever provider happened to answer first would show two different instruments'
 * conventions on the same axis.
 */
export function resolveAcross(
  providers: readonly ProviderCapabilities[],
  timeframe: Timeframe,
): { readonly provider: ProviderCapabilities; readonly resolution: Resolution } | null {
  const usable = providers.filter((candidate) => candidate.ready);
  const resolved = usable.map((provider) => ({
    provider,
    resolution: resolveTimeframe(provider, timeframe),
  }));
  return (
    resolved.find((entry) => entry.resolution.origin === 'native') ??
    resolved.find((entry) => entry.resolution.origin === 'resampled') ??
    null
  );
}
