/**
 * Volume histogram and Volume Profile.
 *
 * Volume Profile is the odd one out: its values are per PRICE BUCKET, not per bar, so it
 * renders horizontally. Each bar's volume is spread across the buckets its high-low range
 * spans rather than dumped into the close's bucket — dumping it at the close is the
 * common shortcut and it produces a profile with spikes that never traded there.
 */

import type { Bar } from '../data/types.js';
import { leadingNaNCount, nanArray, normalizeFactor, normalizePeriod } from './shared.js';
import { TOKEN_PROFILE, TOKEN_VOLUME } from './tokens.js';
import type {
  IndicatorDefinition,
  IndicatorParams,
  IndicatorResult,
  PlotSpec,
  VolumeProfileResult,
} from './types.js';

const VOLUME_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({
    key: 'volume',
    label: 'Volume',
    style: 'histogram',
    colorToken: TOKEN_VOLUME,
  }),
]);

export const volumeIndicator: IndicatorDefinition = {
  id: 'volume',
  label: 'Volume',
  placement: 'pane',
  defaults: Object.freeze({}),
  compute(bars: readonly Bar[]): IndicatorResult {
    const volume = nanArray(bars.length);
    for (let i = 0; i < bars.length; i++) volume[i] = bars[i].v;
    return {
      id: 'volume',
      placement: 'pane',
      plots: VOLUME_PLOTS,
      values: { volume },
      scaleBounds: null,
      guides: [],
      warmup: leadingNaNCount(volume),
    };
  },
};

const PROFILE_PLOTS: readonly PlotSpec[] = Object.freeze([
  Object.freeze<PlotSpec>({
    key: 'profile',
    label: 'Volume Profile',
    style: 'horizontal-profile',
    colorToken: TOKEN_PROFILE,
  }),
]);

export function computeVolumeProfile(
  bars: readonly Bar[],
  params: IndicatorParams = {},
): VolumeProfileResult {
  const bucketCount = normalizePeriod(params.buckets, 24);
  const valueAreaPercent = normalizeFactor(params.valueAreaPercent, 70);
  const perBar = nanArray(bars.length);

  const empty: VolumeProfileResult = {
    id: 'volume-profile',
    placement: 'overlay',
    plots: PROFILE_PLOTS,
    values: { profile: perBar },
    scaleBounds: null,
    guides: [],
    warmup: 0,
    buckets: [],
    pointOfControl: Number.NaN,
    valueAreaHigh: Number.NaN,
    valueAreaLow: Number.NaN,
  };
  if (bars.length === 0) return empty;

  let low = Infinity;
  let high = -Infinity;
  for (const bar of bars) {
    low = Math.min(low, bar.l);
    high = Math.max(high, bar.h);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return empty;

  // A perfectly flat range would give a zero-width bucket; widen it so every bar still
  // lands somewhere and the divide below is safe.
  if (high === low) {
    const pad = Math.max(Math.abs(high) * 1e-4, 1e-8);
    low -= pad;
    high += pad;
  }

  const width = (high - low) / bucketCount;
  const totals = new Float64Array(bucketCount);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    perBar[i] = bar.v;
    const first = Math.min(bucketCount - 1, Math.max(0, Math.floor((bar.l - low) / width)));
    const last = Math.min(bucketCount - 1, Math.max(0, Math.floor((bar.h - low) / width)));
    const spanned = last - first + 1;
    // Spread evenly across the buckets the bar's range touches. Volume is conserved:
    // the totals always sum back to the traded volume.
    const share = bar.v / spanned;
    for (let b = first; b <= last; b++) totals[b] += share;
  }

  const buckets = Array.from({ length: bucketCount }, (_, b) =>
    Object.freeze({ price: low + width * (b + 0.5), volume: totals[b] }),
  );

  let pocIndex = 0;
  let totalVolume = 0;
  for (let b = 0; b < bucketCount; b++) {
    totalVolume += totals[b];
    if (totals[b] > totals[pocIndex]) pocIndex = b;
  }

  // Grow outward from the point of control, always taking the richer neighbour, until
  // the target share of volume is enclosed.
  const target = totalVolume * (valueAreaPercent / 100);
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let captured = totals[pocIndex];
  while (captured < target && (lowIndex > 0 || highIndex < bucketCount - 1)) {
    const below = lowIndex > 0 ? totals[lowIndex - 1] : -1;
    const above = highIndex < bucketCount - 1 ? totals[highIndex + 1] : -1;
    if (above >= below) {
      highIndex += 1;
      captured += totals[highIndex];
    } else {
      lowIndex -= 1;
      captured += totals[lowIndex];
    }
  }

  return {
    id: 'volume-profile',
    placement: 'overlay',
    plots: PROFILE_PLOTS,
    values: { profile: perBar },
    scaleBounds: null,
    guides: [],
    warmup: 0,
    buckets: Object.freeze(buckets),
    pointOfControl: low + width * (pocIndex + 0.5),
    valueAreaHigh: low + width * (highIndex + 1),
    valueAreaLow: low + width * lowIndex,
  };
}

export const volumeProfileIndicator: IndicatorDefinition = {
  id: 'volume-profile',
  label: 'Volume Profile',
  placement: 'overlay',
  defaults: Object.freeze({ buckets: 24, valueAreaPercent: 70 }),
  compute: (bars, params) => computeVolumeProfile(bars, params),
};
