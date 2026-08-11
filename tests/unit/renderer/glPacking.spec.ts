import { describe, expect, it } from 'vitest';

import { makeBar, type Bar } from '../../../src/data/types.js';
import { packInstances, parseColor, scaleModeFlag } from '../../../src/renderer/webgl/glSeriesLayer.js';

function bars(): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < 3; i++) {
    const bar = makeBar({
      t: 1_754_870_400_000 + i * 60_000,
      o: 100 + i,
      h: 110 + i,
      l: 95 + i,
      c: 105 + i,
      v: 10 + i,
    });
    if (bar === null) throw new Error('fixture bar invalid');
    out.push(bar);
  }
  return out;
}

describe('packInstances', () => {
  it('interleaves index, o, h, l, c, v in the order the shader declares', () => {
    const data = packInstances(bars());
    expect(data.length).toBe(3 * 6);
    expect([...data.slice(0, 6)]).toEqual([0, 100, 110, 95, 105, 10]);
    expect([...data.slice(6, 12)]).toEqual([1, 101, 111, 96, 106, 11]);
  });

  it('uses the array position as the bar index, matching X(i) in §5', () => {
    const data = packInstances(bars());
    expect(data[0]).toBe(0);
    expect(data[6]).toBe(1);
    expect(data[12]).toBe(2);
  });

  it('produces an empty buffer for an empty series rather than throwing', () => {
    expect(packInstances([]).length).toBe(0);
  });
});

describe('parseColor', () => {
  it('parses #rrggbb into normalized components', () => {
    expect(parseColor('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#000000')).toEqual([0, 0, 0, 1]);
  });

  it('expands #rgb shorthand', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1]);
  });

  it('reads the alpha byte of #rrggbbaa', () => {
    const [, , , a] = parseColor('#00000080');
    expect(a).toBeCloseTo(128 / 255, 5);
  });

  it('defaults alpha to opaque', () => {
    expect(parseColor('#123456')[3]).toBe(1);
  });
});

describe('scaleModeFlag', () => {
  it('maps linear to the §2 branch', () => {
    expect(scaleModeFlag('linear')).toBe(0);
  });

  it('maps log to the §3 branch', () => {
    expect(scaleModeFlag('log')).toBe(1);
  });

  it('renders percent with the log geometry — it re-bases labels only (§3)', () => {
    expect(scaleModeFlag('percent')).toBe(scaleModeFlag('log'));
  });
});
