import { describe, expect, it } from 'vitest';

import { indexAtTime, remapIndex, timeAtIndex } from '../../../src/charts/remap.js';

const MINUTE = 60_000;
/** 100 one-minute bars from an arbitrary epoch. */
const minutes = Array.from({ length: 100 }, (_, i) => 1_000_000 + i * MINUTE);
/** A coarser space over the same window: one entry every 10 minutes. */
const tenMinutes = Array.from({ length: 10 }, (_, i) => 1_000_000 + i * 10 * MINUTE);

describe('timeAtIndex', () => {
  it('is exact at whole indices', () => {
    expect(timeAtIndex(minutes, 0)).toBe(minutes[0]);
    expect(timeAtIndex(minutes, 42)).toBe(minutes[42]);
    expect(timeAtIndex(minutes, 99)).toBe(minutes[99]);
  });

  it('interpolates between bars', () => {
    expect(timeAtIndex(minutes, 10.5)).toBe(minutes[10] + MINUTE / 2);
    expect(timeAtIndex(minutes, 10.25)).toBe(minutes[10] + MINUTE / 4);
  });

  it('extrapolates outside the series with the edge step', () => {
    // An anchor to the left of bar 0 must keep its distance, not collapse onto it.
    expect(timeAtIndex(minutes, -3)).toBe(minutes[0] - 3 * MINUTE);
    expect(timeAtIndex(minutes, 102)).toBe(minutes[99] + 3 * MINUTE);
  });

  it('is total for degenerate input', () => {
    expect(Number.isNaN(timeAtIndex([], 5))).toBe(true);
    expect(timeAtIndex([7], 5)).toBe(7);
  });
});

describe('indexAtTime', () => {
  it('inverts timeAtIndex across the domain', () => {
    for (const index of [0, 1, 7.25, 42, 42.5, 98, 99]) {
      expect(indexAtTime(minutes, timeAtIndex(minutes, index))).toBeCloseTo(index, 9);
    }
  });

  it('inverts it outside the domain too', () => {
    expect(indexAtTime(minutes, timeAtIndex(minutes, -4))).toBeCloseTo(-4, 9);
    expect(indexAtTime(minutes, timeAtIndex(minutes, 110))).toBeCloseTo(110, 9);
  });

  it('takes the FIRST index when several bars share a timestamp', () => {
    // Several Renko bricks can complete inside one source bar, so duplicate timestamps
    // are normal. Any other choice would make the mapping unstable between frames.
    const withDuplicates = [0, MINUTE, MINUTE, MINUTE, 2 * MINUTE];
    expect(indexAtTime(withDuplicates, MINUTE)).toBe(1);
  });

  it('is total for degenerate input', () => {
    expect(Number.isNaN(indexAtTime([], 5))).toBe(true);
    expect(indexAtTime([7], 5)).toBe(0);
  });
});

describe('remapIndex', () => {
  it('moves an index to the entry covering the same moment', () => {
    // Minute 30 is entry 3 of the ten-minute space.
    expect(remapIndex(minutes, tenMinutes, 30)).toBeCloseTo(3, 9);
    expect(remapIndex(minutes, tenMinutes, 55)).toBeCloseTo(5.5, 9);
  });

  it('round-trips between the two spaces', () => {
    for (const index of [0, 12, 30, 47.5, 90]) {
      const coarse = remapIndex(minutes, tenMinutes, index);
      expect(remapIndex(tenMinutes, minutes, coarse)).toBeCloseTo(index, 6);
    }
  });

  it('is the identity when both spaces are the same', () => {
    for (const index of [0, 3.75, 60, 99]) {
      expect(remapIndex(minutes, minutes, index)).toBeCloseTo(index, 9);
    }
  });

  it('leaves the index alone rather than destroying it when a space is unusable', () => {
    // A remap that cannot improve an anchor must not damage it.
    expect(remapIndex([], tenMinutes, 42)).toBe(42);
    expect(remapIndex(minutes, [], 42)).toBe(42);
    expect(remapIndex(minutes, tenMinutes, Number.NaN)).toBeNaN();
  });

  it('preserves ORDER, so a drawing never turns inside out', () => {
    const a = remapIndex(minutes, tenMinutes, 20);
    const b = remapIndex(minutes, tenMinutes, 60);
    expect(a).toBeLessThan(b);
  });
});
