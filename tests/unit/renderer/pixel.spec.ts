import { describe, expect, it } from 'vitest';
import { fillSpan, snapFill, snapLine, snapStroke } from '../../../src/renderer/pixel.js';

describe('pixel snapping — RENDER_ALGORITHMS §7', () => {
  it('puts 1px strokes on a half pixel', () => {
    expect(snapLine(10)).toBe(10.5);
    expect(snapLine(10.4)).toBe(10.5);
    expect(snapLine(10.6)).toBe(11.5);
    for (let v = -50; v <= 50; v += 0.13) {
      expect(Math.abs(snapLine(v) % 1)).toBeCloseTo(0.5, 12);
    }
  });

  it('puts fills on whole pixels', () => {
    expect(snapFill(10.4)).toBe(10);
    expect(snapFill(10.5)).toBe(11);
    for (let v = -50; v <= 50; v += 0.13) {
      expect(Number.isInteger(snapFill(v))).toBe(true);
    }
  });

  it('offsets odd stroke widths only', () => {
    expect(snapStroke(10.2, 1)).toBe(10.5);
    expect(snapStroke(10.2, 2)).toBe(10);
    expect(snapStroke(10.2, 3)).toBe(10.5);
  });

  it('floors a span at 1px so a doji is never invisible', () => {
    expect(fillSpan(100, 100)).toBe(1);
    expect(fillSpan(100.4, 100.6)).toBe(1);
    expect(fillSpan(100, 90)).toBe(1);
  });

  it('measures the span between snapped edges, not the snapped difference', () => {
    // round(b - a) drifts: a = 10.6, b = 20.4 -> round(9.8) = 10, but the painted
    // rows run 11..20, which is 9 rows. fillSpan must agree with the paint.
    const a = 10.6;
    const b = 20.4;
    expect(fillSpan(a, b)).toBe(9);
    expect(fillSpan(a, b)).toBe(snapFill(b) - snapFill(a));
    expect(Math.round(b - a)).toBe(10); // the wrong answer, for the record
  });

  it('keeps every fill edge integral across a sweep', () => {
    for (let a = 0; a < 20; a += 0.17) {
      const b = a + 3.6;
      const top = snapFill(a);
      const height = fillSpan(a, b);
      expect(Number.isInteger(top)).toBe(true);
      expect(Number.isInteger(height)).toBe(true);
      expect(height).toBeGreaterThanOrEqual(1);
      expect(top + height).toBe(snapFill(b));
    }
  });
});
