import { describe, expect, it } from 'vitest';

import { SYMBOLS, parseDailyCsv, type SymbolDefinition } from '../../../src/app/marketData.js';

/**
 * Every bundled CSV must actually parse. `parseDailyCsv` is deliberately forgiving — it
 * `continue`s past any row it cannot read — so a typo'd column or a bad OHLC relationship
 * silently vanishes instead of throwing. That is the exact failure this suite guards:
 * a chart that renders "successfully" with fewer bars than the file claims, or with none
 * at all. Hence the row-count assertion, not just a non-empty check.
 */

const DAY_MS = 86_400_000;

const bundled: readonly SymbolDefinition[] = SYMBOLS.filter((s) => s.source === 'alpha-vantage');

/** Rows the CSV claims to contain, counted the same way `parseDailyCsv` splits them. */
function csvRowCount(csv: string): number {
  return csv
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
}

describe('bundled market data', () => {
  it('ships a meaningful number of real symbols', () => {
    // Guards against an import being dropped in a merge and nobody noticing.
    expect(bundled.length).toBeGreaterThanOrEqual(20);
  });

  it('has no duplicate symbols', () => {
    const seen = SYMBOLS.map((s) => s.symbol);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('gives every alpha-vantage entry a non-empty csv', () => {
    for (const def of bundled) {
      expect(def.csv, `${def.symbol} has no csv`).toBeTypeOf('string');
      expect((def.csv ?? '').trim().length, `${def.symbol} csv is empty`).toBeGreaterThan(0);
    }
  });

  it('gives every entry a searchable label naming its ticker', () => {
    for (const def of SYMBOLS) {
      expect(def.label, `${def.symbol} label`).toContain(def.symbol);
      expect(def.label.length, `${def.symbol} label is bare`).toBeGreaterThan(
        def.symbol.length + 2,
      );
    }
  });

  describe.each(bundled.map((def) => [def.symbol, def] as const))('%s', (symbol, def) => {
    const csv = def.csv ?? '';
    const bars = parseDailyCsv(csv);

    it('parses to a non-empty bar array', () => {
      expect(bars.length, `${symbol} parsed to zero bars`).toBeGreaterThan(0);
    });

    it('parses every row it contains', () => {
      // A dropped row means a malformed line the parser skipped in silence.
      expect(bars.length, `${symbol} lost rows during parse`).toBe(csvRowCount(csv));
    });

    it('is strictly ascending in time', () => {
      for (let i = 1; i < bars.length; i += 1) {
        const prev = bars[i - 1].t;
        const curr = bars[i].t;
        expect(curr, `${symbol} row ${String(i)} is not after row ${String(i - 1)}`).toBeGreaterThan(
          prev,
        );
      }
    });

    it('stamps every bar at an integer UTC midnight (mandate #5)', () => {
      for (const b of bars) {
        expect(Number.isInteger(b.t), `${symbol} t=${String(b.t)} is not an integer`).toBe(true);
        expect(b.t % DAY_MS, `${symbol} t=${String(b.t)} is not UTC midnight`).toBe(0);
        expect(b.t).toBeGreaterThan(0);
      }
    });

    it('satisfies l <= o,c <= h with finite prices and non-negative volume', () => {
      for (const b of bars) {
        const at = `${symbol} @ ${String(b.t)}`;
        expect(Number.isFinite(b.o), `${at} open`).toBe(true);
        expect(Number.isFinite(b.h), `${at} high`).toBe(true);
        expect(Number.isFinite(b.l), `${at} low`).toBe(true);
        expect(Number.isFinite(b.c), `${at} close`).toBe(true);
        expect(Number.isFinite(b.v), `${at} volume`).toBe(true);
        expect(b.v, `${at} volume is negative`).toBeGreaterThanOrEqual(0);
        expect(b.l, `${at} low above open`).toBeLessThanOrEqual(b.o);
        expect(b.l, `${at} low above close`).toBeLessThanOrEqual(b.c);
        expect(b.h, `${at} high below open`).toBeGreaterThanOrEqual(b.o);
        expect(b.h, `${at} high below close`).toBeGreaterThanOrEqual(b.c);
      }
    });

    it('freezes every bar (mandate #4)', () => {
      for (const b of bars) {
        expect(Object.isFrozen(b), `${symbol} bar is mutable`).toBe(true);
      }
    });
  });
});
