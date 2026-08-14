/**
 * Wall clock → UTC, including the two days a year that are not a bijection.
 *
 * Every expectation is cross-checked against `Intl` in the round-trip test rather than
 * written from memory: the failure mode here is a whole year of intraday bars sitting an
 * hour off, which looks exactly like a correct chart. A test that encodes my belief about
 * when American DST starts would be as wrong as the code.
 */

import { describe, expect, it } from 'vitest';
import { isNonexistentLocalTime, zonedTimeToUtc } from '../../../src/providers/zonedTime.js';

const NY = 'America/New_York';
const LONDON = 'Europe/London';
const TOKYO = 'Asia/Tokyo';

/** The wall clock `t` reads as in `zone`, straight from Intl — the independent oracle. */
function wallClockIn(t: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(t));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // en-CA gives ISO-ish date parts; hour can come back as "24" at midnight.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

describe('parsing a wall clock', () => {
  it('reads a date with no time as local midnight', () => {
    // A daily bar's open on an exchange calendar is midnight local, not midnight UTC.
    const t = zonedTimeToUtc('2026-08-13', NY);
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(wallClockIn(t, NY)).toBe('2026-08-13 00:00:00');
  });

  it('accepts both separators and an optional seconds field', () => {
    const a = zonedTimeToUtc('2026-08-13 15:30:00', NY);
    const b = zonedTimeToUtc('2026-08-13T15:30:00', NY);
    const c = zonedTimeToUtc('2026-08-13 15:30', NY);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('rejects what is not a wall clock at all', () => {
    for (const bad of ['', 'yesterday', '2026-08', '13/08/2026', '2026-08-13 25:00:00', 'NaN']) {
      expect(zonedTimeToUtc(bad, NY), bad).toBeNull();
    }
  });

  it('rejects out-of-range fields rather than rolling them over', () => {
    // Date.UTC turns month 13 into January of the next year and reports success. A
    // provider that changed format would then be silently a year out.
    expect(zonedTimeToUtc('2026-13-01 00:00:00', NY)).toBeNull();
    expect(zonedTimeToUtc('2026-00-01 00:00:00', NY)).toBeNull();
    expect(zonedTimeToUtc('2026-08-32 00:00:00', NY)).toBeNull();
    expect(zonedTimeToUtc('2026-08-13 12:60:00', NY)).toBeNull();
  });
});

describe('offsets', () => {
  it('treats UTC as the identity', () => {
    expect(zonedTimeToUtc('2026-08-13 15:30:00', 'UTC')).toBe(Date.UTC(2026, 7, 13, 15, 30, 0));
  });

  it('applies standard time in winter and summer time in summer', () => {
    // New York is UTC-5 in January and UTC-4 in July. Both pinned against Intl above.
    expect(zonedTimeToUtc('2026-01-15 12:00:00', NY)).toBe(Date.UTC(2026, 0, 15, 17, 0, 0));
    expect(zonedTimeToUtc('2026-07-15 12:00:00', NY)).toBe(Date.UTC(2026, 6, 15, 16, 0, 0));
  });

  it('handles a zone whose transitions are on different dates', () => {
    // London switches on the last Sunday in March, not the second — so mid-March is a
    // date where New York is already on summer time and London is not.
    const t = zonedTimeToUtc('2026-03-15 12:00:00', LONDON);
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(wallClockIn(t, LONDON)).toBe('2026-03-15 12:00:00');
    expect(t).toBe(Date.UTC(2026, 2, 15, 12, 0, 0));
  });

  it('handles a zone with no DST at all', () => {
    expect(zonedTimeToUtc('2026-07-15 12:00:00', TOKYO)).toBe(Date.UTC(2026, 6, 15, 3, 0, 0));
    expect(zonedTimeToUtc('2026-01-15 12:00:00', TOKYO)).toBe(Date.UTC(2026, 0, 15, 3, 0, 0));
  });

  it('falls back to UTC for a zone Intl does not know, rather than throwing', () => {
    // A provider inventing a zone name must not take the frame down with it.
    expect(zonedTimeToUtc('2026-08-13 15:30:00', 'Mars/Olympus_Mons')).toBe(
      Date.UTC(2026, 7, 13, 15, 30, 0),
    );
  });
});

describe('the spring-forward gap', () => {
  // 2026-03-08 in New York: 01:59 is followed by 03:00. 02:00–02:59 do not exist.
  it('still resolves a time inside the gap, one step later', () => {
    const t = zonedTimeToUtc('2026-03-08 02:30:00', NY);
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(wallClockIn(t, NY)).toBe('2026-03-08 03:30:00');
  });

  it('reports the gap, so a provider drifting can be noticed', () => {
    expect(isNonexistentLocalTime('2026-03-08 02:30:00', NY)).toBe(true);
    expect(isNonexistentLocalTime('2026-03-08 01:30:00', NY)).toBe(false);
    expect(isNonexistentLocalTime('2026-03-08 03:30:00', NY)).toBe(false);
    expect(isNonexistentLocalTime('2026-08-13 15:30:00', NY)).toBe(false);
  });

  it('is exact either side of the boundary', () => {
    expect(zonedTimeToUtc('2026-03-08 01:59:00', NY)).toBe(Date.UTC(2026, 2, 8, 6, 59, 0));
    expect(zonedTimeToUtc('2026-03-08 03:00:00', NY)).toBe(Date.UTC(2026, 2, 8, 7, 0, 0));
  });
});

describe('the fall-back repeat', () => {
  // 2026-11-01 in New York: 01:00–01:59 happen twice, first on EDT then on EST.
  it('takes the FIRST occurrence, so a morning stays ascending', () => {
    const t = zonedTimeToUtc('2026-11-01 01:30:00', NY);
    // EDT is UTC-4, so the first 01:30 is 05:30Z; the second would be 06:30Z.
    expect(t).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
  });

  it('keeps a sequence of bars through the repeat strictly ascending', () => {
    // The property that matters more than which occurrence is chosen: a series that goes
    // backwards is rejected by the store, so an hour of bars would simply vanish.
    const wall = [
      '2026-11-01 00:30:00',
      '2026-11-01 01:00:00',
      '2026-11-01 01:30:00',
      '2026-11-01 02:00:00',
      '2026-11-01 02:30:00',
      '2026-11-01 03:00:00',
    ];
    const times = wall.map((w) => zonedTimeToUtc(w, NY));
    for (const t of times) expect(t).not.toBeNull();
    for (let i = 1; i < times.length; i++) {
      expect(Number(times[i]), wall[i]).toBeGreaterThan(Number(times[i - 1]));
    }
  });

  it('is exact either side of the boundary', () => {
    expect(zonedTimeToUtc('2026-11-01 00:59:00', NY)).toBe(Date.UTC(2026, 10, 1, 4, 59, 0));
    expect(zonedTimeToUtc('2026-11-01 03:00:00', NY)).toBe(Date.UTC(2026, 10, 1, 8, 0, 0));
  });
});

describe('round trip against Intl, across a whole year', () => {
  it('every unambiguous hour of 2026 converts back to itself', () => {
    // The real assurance. Walks an entire year at hourly steps in a DST zone, converts
    // each UTC instant to its wall clock with Intl, parses it back, and requires the
    // original instant — so any systematic hour shift shows up immediately, in whichever
    // half of the year it affects.
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const hour = 3_600_000;
    let checked = 0;
    let ambiguous = 0;

    for (let t = start; t < start + 365 * 24 * hour; t += hour) {
      const wall = wallClockIn(t, NY);
      const back = zonedTimeToUtc(wall, NY);
      if (back === t) {
        checked++;
        continue;
      }
      // The only permitted disagreement is the fall-back repeat, where two instants share
      // one wall clock and the earlier one is chosen by contract.
      expect(wallClockIn(Number(back), NY), wall).toBe(wall);
      expect(Number(back)).toBeLessThan(t);
      ambiguous++;
    }

    expect(checked).toBeGreaterThan(8700);
    // Exactly one repeated hour in the year.
    expect(ambiguous).toBe(1);
  });

  it('does the same for a southern-hemisphere zone, where the seasons invert', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const hour = 3_600_000;
    let mismatches = 0;
    for (let t = start; t < start + 365 * 24 * hour; t += hour) {
      const wall = wallClockIn(t, 'Australia/Sydney');
      const back = zonedTimeToUtc(wall, 'Australia/Sydney');
      if (back !== t) mismatches++;
    }
    // One ambiguous hour when Sydney falls back; everything else exact.
    expect(mismatches).toBe(1);
  });
});
