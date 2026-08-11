/**
 * The no-overlap invariant (RENDER_ALGORITHMS §6) is the single most important
 * property in the renderer: two candles sharing an x-pixel is the classic
 * "TradingView clone looks wrong" bug. It is asserted here as a property over a
 * dense sweep of bar spacings rather than a couple of hand-picked cases.
 */

import { describe, expect, it } from 'vitest';
import { asBarIndex } from '../../../src/data/types.js';
import { makeRect } from '../../../src/renderer/layout.js';
import {
  candleBodyWidth,
  candleGeometry,
  makeTimeScale,
  MIN_BODY_SPACING,
} from '../../../src/renderer/scale/timeScale.js';

const plot = makeRect(0, 0, 900, 500);

/** 0.5 … 120 in 0.1 steps, plus the awkward exact boundaries. */
function spacingSweep(): number[] {
  const out: number[] = [];
  for (let s = 5; s <= 1_200; s++) out.push(s / 10);
  out.push(1, 1.999, 2, 2.001, 2.999, 3, 3.001, 4, 5, 119.999, 120);
  return out;
}

describe('candle body width — §6', () => {
  it('never lets two adjacent candles touch: X(i+1) - bw/2 >= X(i) + bw/2 + 1', () => {
    for (const s of spacingSweep()) {
      const geometry = candleGeometry(s);
      if (s < 2) {
        // A 1px mark is the hardware floor. §6 draws a high/low line here precisely
        // because no body can fit with a gap, so the invariant is not attainable.
        expect(geometry.mode).toBe('line');
        expect(geometry.width).toBe(1);
        continue;
      }
      const scale = makeTimeScale(500, s, plot);
      const left: number = scale.x(asBarIndex(100));
      const right: number = scale.x(asBarIndex(101));
      const bw = geometry.width;
      expect(right - bw / 2).toBeGreaterThanOrEqual(left + bw / 2 + 1);
    }
  });

  it('forces an odd width so the 1px wick centres on the body', () => {
    for (const s of spacingSweep()) {
      const bw = candleGeometry(s).width;
      expect(bw % 2).toBe(1);
      expect(bw).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(bw)).toBe(true);
      expect(candleGeometry(s).half).toBe((bw - 1) / 2);
      expect(Number.isInteger(candleGeometry(s).half)).toBe(true);
    }
  });

  it('switches to a high/low line below 3px of spacing', () => {
    for (const s of [0.5, 1, 1.5, 2, 2.5, 2.999]) {
      expect(s).toBeLessThan(MIN_BODY_SPACING);
      expect(candleGeometry(s).mode).toBe('line');
      expect(candleGeometry(s).width).toBe(1);
      expect(candleGeometry(s).half).toBe(0);
    }
    expect(candleGeometry(3).mode).toBe('body');
  });

  it('matches the worked values of §6', () => {
    expect(candleBodyWidth(3)).toBe(1); // floor(2.4)=2 -> even -> 1
    expect(candleBodyWidth(5)).toBe(3); // floor(4)=4, floor(5)-1=4 -> even -> 3
    expect(candleBodyWidth(10)).toBe(7); // floor(8)=8 -> even -> 7
    expect(candleBodyWidth(20)).toBe(15); // floor(16)=16 -> even -> 15
    expect(candleBodyWidth(120)).toBe(95); // floor(96)=96 -> even -> 95
  });

  it('never exceeds 80% of the spacing once a body is drawn', () => {
    for (const s of spacingSweep()) {
      if (s < MIN_BODY_SPACING) continue;
      expect(candleGeometry(s).width).toBeLessThanOrEqual(Math.floor(s * 0.8));
      expect(candleGeometry(s).width).toBeLessThanOrEqual(Math.floor(s) - 1);
    }
  });

  it('leaves at least one whole pixel of gap between painted body columns', () => {
    // Bodies span the integer columns [xc - half, xc + half]; the gap is what is
    // left between the right column of bar i and the left column of bar i+1.
    for (const s of spacingSweep()) {
      if (s < MIN_BODY_SPACING) continue;
      const scale = makeTimeScale(1_000, s, plot);
      const geometry = candleGeometry(s);
      for (let i = 900; i < 960; i++) {
        const a = Math.round(scale.x(asBarIndex(i)));
        const b = Math.round(scale.x(asBarIndex(i + 1)));
        const gap = b - geometry.half - (a + geometry.half) - 1;
        expect(gap).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
