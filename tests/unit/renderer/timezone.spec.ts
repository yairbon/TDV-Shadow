import { describe, expect, it } from 'vitest';

import { offsetMinutes, shiftToZone, TIME_ZONES } from '../../../src/renderer/scale/timezone.js';

/** 2026-01-15 12:00 UTC — northern winter, so New York is on standard time. */
const WINTER = Date.UTC(2026, 0, 15, 12, 0);
/** 2026-07-15 12:00 UTC — northern summer, so New York is on daylight time. */
const SUMMER = Date.UTC(2026, 6, 15, 12, 0);

describe('timezone offsets — 10.2', () => {
  it('is zero for UTC', () => {
    expect(offsetMinutes('UTC', WINTER)).toBe(0);
    expect(offsetMinutes('UTC', SUMMER)).toBe(0);
  });

  it('is negative west of Greenwich and positive east of it', () => {
    expect(offsetMinutes('America/New_York', WINTER)).toBe(-300);
    expect(offsetMinutes('Asia/Tokyo', WINTER)).toBe(540);
  });

  it('follows daylight saving rather than assuming a fixed offset', () => {
    // The reason the offset is asked of Intl per instant instead of stored per zone.
    expect(offsetMinutes('America/New_York', WINTER)).toBe(-300);
    expect(offsetMinutes('America/New_York', SUMMER)).toBe(-240);
    // Tokyo has no DST, so it must NOT move.
    expect(offsetMinutes('Asia/Tokyo', SUMMER)).toBe(540);
  });

  it('handles half-hour and three-quarter-hour zones', () => {
    expect(offsetMinutes('Asia/Kolkata', WINTER)).toBe(330);
    expect(offsetMinutes('Asia/Kathmandu', WINTER)).toBe(345);
  });

  it('falls back to UTC for an unknown zone instead of throwing into a frame', () => {
    expect(offsetMinutes('Not/AZone', WINTER)).toBe(0);
    expect(offsetMinutes('', WINTER)).toBe(0);
  });

  it('shiftToZone moves the timestamp by exactly the offset', () => {
    expect(shiftToZone(WINTER, 'UTC')).toBe(WINTER);
    expect(shiftToZone(WINTER, 'America/New_York')).toBe(WINTER - 5 * 3_600_000);
    expect(shiftToZone(SUMMER, 'America/New_York')).toBe(SUMMER - 4 * 3_600_000);
    expect(shiftToZone(WINTER, 'Asia/Tokyo')).toBe(WINTER + 9 * 3_600_000);
  });

  it('a shifted timestamp read as UTC gives the wall clock in that zone', () => {
    // This is the whole contract: the existing UTC formatters, fed a shifted timestamp,
    // print local time — so there is one formatting path, not two.
    const shifted = new Date(shiftToZone(WINTER, 'America/New_York'));
    expect(shifted.getUTCHours()).toBe(7);
    expect(new Date(shiftToZone(WINTER, 'Asia/Tokyo')).getUTCHours()).toBe(21);
  });

  it('caches per day without leaking one day into the next across a DST switch', () => {
    // US DST began 2026-03-08 07:00 UTC. The day before is -05:00, the day after -04:00.
    const before = Date.UTC(2026, 2, 7, 12, 0);
    const after = Date.UTC(2026, 2, 9, 12, 0);
    expect(offsetMinutes('America/New_York', before)).toBe(-300);
    expect(offsetMinutes('America/New_York', after)).toBe(-240);
    // Re-reading must give the same answers, not the last one cached.
    expect(offsetMinutes('America/New_York', before)).toBe(-300);
  });

  it('every offered zone resolves to a real offset', () => {
    for (const zone of TIME_ZONES) {
      const offset = offsetMinutes(zone, WINTER);
      expect(Number.isFinite(offset)).toBe(true);
      expect(Math.abs(offset)).toBeLessThanOrEqual(14 * 60);
      // Math.abs avoids -0, which toBe distinguishes from 0.
      expect(Math.abs(offset % 15)).toBe(0);
    }
  });
});
