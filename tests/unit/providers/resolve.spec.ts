/**
 * Timeframe resolution.
 *
 * The property that matters: a button is enabled exactly when pressing it produces data.
 * The old rule — synthetic series get every intraday button, real ones get only daily —
 * was wrong in both directions at once, and the second failure mode here is subtler: a
 * daily bar rolled up from intraday looks completely plausible and is silently wrong.
 */

import { describe, expect, it } from 'vitest';
import { resolveAcross, resolveAll, resolveTimeframe } from '../../../src/providers/resolve.js';
import type { ProviderCapabilities } from '../../../src/providers/types.js';
import type { Timeframe } from '../../../src/data/types.js';

const caps = (
  nativeTimeframes: readonly Timeframe[],
  overrides: Partial<ProviderCapabilities> = {},
): ProviderCapabilities => ({
  id: 'twelve-data',
  label: 'Test Provider',
  nativeTimeframes,
  canSearch: true,
  canQuote: true,
  ready: true,
  ...overrides,
});

const ALL_SIX: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

describe('a provider that serves everything natively', () => {
  it('resolves every timeframe natively', () => {
    for (const timeframe of ALL_SIX) {
      const resolution = resolveTimeframe(caps(ALL_SIX), timeframe);
      expect(resolution.origin, timeframe).toBe('native');
      expect(resolution.fetchAs).toBe(timeframe);
      expect(resolution.reason).toBe('');
    }
  });
});

describe('a provider with only 1-minute bars', () => {
  const minute = caps(['1m']);

  it('rolls the finer series up into every sub-daily timeframe', () => {
    for (const timeframe of ['5m', '15m', '1h', '4h'] as Timeframe[]) {
      const resolution = resolveTimeframe(minute, timeframe);
      expect(resolution.origin, timeframe).toBe('resampled');
      expect(resolution.fetchAs).toBe('1m');
    }
  });

  it('refuses to build a DAILY bar out of intraday', () => {
    // `resample` buckets on UTC boundaries, and UTC midnight is 20:00 in New York — so a
    // rolled-up "day" would run mid-evening to mid-evening and split every US session in
    // two. It would look like a perfectly ordinary chart.
    const resolution = resolveTimeframe(minute, '1d');
    expect(resolution.origin).toBe('unavailable');
    expect(resolution.reason).not.toBe('');
  });
});

describe('a provider with only daily bars', () => {
  // Alpha Vantage on a free key, which is the case that motivated all of this.
  const daily = caps(['1d'], { label: 'Alpha Vantage' });

  it('serves daily', () => {
    expect(resolveTimeframe(daily, '1d').origin).toBe('native');
  });

  it('cannot fabricate intraday, and says why', () => {
    for (const timeframe of ['1m', '5m', '15m', '1h', '4h'] as Timeframe[]) {
      const resolution = resolveTimeframe(daily, timeframe);
      expect(resolution.origin, timeframe).toBe('unavailable');
      expect(resolution.reason).toContain('Alpha Vantage');
      expect(resolution.reason).toContain('intraday');
    }
  });
});

describe('choosing a source to resample from', () => {
  it('takes the finest available, for the most faithful roll-up', () => {
    // Both 1m and 5m can make an hour; 1m carries twelve times the detail.
    const resolution = resolveTimeframe(caps(['1m', '5m']), '1h');
    expect(resolution.origin).toBe('resampled');
    expect(resolution.fetchAs).toBe('1m');
  });

  it('only resamples from a timeframe that divides the target exactly', () => {
    // 4h does not divide into 1h, and 15m does not divide into 4h... but 15m does divide
    // into 1h. Nothing here is allowed to produce a ragged bucket.
    expect(resolveTimeframe(caps(['4h']), '1h').origin).toBe('unavailable');
    expect(resolveTimeframe(caps(['15m']), '1h')).toMatchObject({
      origin: 'resampled',
      fetchAs: '15m',
    });
  });

  it('prefers native over resampled even when both are possible', () => {
    const resolution = resolveTimeframe(caps(['1m', '1h']), '1h');
    expect(resolution.origin).toBe('native');
    expect(resolution.fetchAs).toBe('1h');
  });
});

describe('a provider that cannot serve anything', () => {
  it('reports every timeframe unavailable with a reason', () => {
    const resolutions = resolveAll(caps([]));
    expect(resolutions).toHaveLength(6);
    for (const resolution of resolutions) {
      expect(resolution.origin).toBe('unavailable');
      expect(resolution.reason).not.toBe('');
    }
  });
});

describe('resolving across several providers', () => {
  const intraday = caps(ALL_SIX, { id: 'twelve-data', label: 'Twelve Data' });
  const dailyOnly = caps(['1d'], { id: 'alpha-vantage', label: 'Alpha Vantage' });

  it('picks whichever provider serves the timeframe natively', () => {
    const hour = resolveAcross([dailyOnly, intraday], '1h');
    expect(hour?.provider.id).toBe('twelve-data');
    expect(hour?.resolution.origin).toBe('native');
  });

  it('prefers a native resolution anywhere over a resampled one', () => {
    // Mixing conventions across providers on one axis is how two instruments end up
    // looking like one, so a native source wins wherever it lives.
    const minuteOnly = caps(['1m'], { id: 'twelve-data', label: 'Minutes' });
    const hourNative = caps(['1h'], { id: 'alpha-vantage', label: 'Hours' });
    const chosen = resolveAcross([minuteOnly, hourNative], '1h');
    expect(chosen?.provider.id).toBe('alpha-vantage');
    expect(chosen?.resolution.origin).toBe('native');
  });

  it('falls back to a resampled resolution when nothing is native', () => {
    const chosen = resolveAcross([caps(['1m'])], '15m');
    expect(chosen?.resolution.origin).toBe('resampled');
    expect(chosen?.resolution.fetchAs).toBe('1m');
  });

  it('ignores a provider that is not ready', () => {
    // A provider with no key must not make a button look available.
    const unready = caps(ALL_SIX, { ready: false });
    expect(resolveAcross([unready], '1m')).toBeNull();
  });

  it('returns null when no provider can serve the timeframe', () => {
    expect(resolveAcross([dailyOnly], '1m')).toBeNull();
  });

  it('returns null for an empty provider list', () => {
    expect(resolveAcross([], '1d')).toBeNull();
  });
});
