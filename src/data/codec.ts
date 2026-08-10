/**
 * Wire payload -> frozen `Bar`.
 *
 * This is the single boundary where untrusted bytes become domain objects
 * (ARCHITECTURE.md §2). Every rejection is *counted and returned as `null`* —
 * a malformed tick must never throw into the render path (ARCHITECTURE.md §3.1,
 * src/data/CLAUDE.md).
 *
 * Strings are parsed here and only here: nothing downstream ever sees a string
 * price. `numeric(20,8)` from PostgreSQL may arrive JSON-encoded as a string,
 * so both forms are accepted at this boundary and normalised to `number`.
 */

import type { Bar, BarTuple } from './types.js';
import { barFromTuple } from './types.js';

/** Why a payload was rejected. Exposed for counters, dashboards and tests. */
export const DROP_REASONS = ['shape', 'arity', 'field', 'invariant'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface CodecStats {
  /** Payloads that produced a `Bar`. */
  readonly decoded: number;
  /** Payloads rejected. Always equals the sum of `byReason`. */
  readonly dropped: number;
  readonly byReason: Readonly<Record<DropReason, number>>;
}

export interface Codec {
  /** Wire tuple `[t,o,h,l,c,v]` (ARCHITECTURE.md §3.2). */
  decodeTuple(payload: unknown): Bar | null;
  /** Tuple *or* object row (`{t,o,h,l,c,v}` / `{ts,open,high,low,close,volume}`). */
  decodeRow(payload: unknown): Bar | null;
  /** An array of rows. Bad rows are dropped and counted; good rows are kept. */
  decodeRows(payload: unknown): readonly Bar[];
  /** O(1) frozen copy of the counters. */
  stats(): CodecStats;
  /** Zeroes the counters (test helper / long-session hygiene). */
  reset(): void;
}

const zeroCounts = (): Record<DropReason, number> => ({
  shape: 0,
  arity: 0,
  field: 0,
  invariant: 0,
});

const TUPLE_ARITY = 6;

/**
 * Coerces one wire field to a finite `number`.
 * Returns `null` for anything else — including `NaN`, `Infinity`, `''`,
 * booleans and `null` (which `Number()` would happily turn into `0`).
 */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Object rows may use the in-memory field names or the SQL column names (§3.3). */
const FIELD_ALIASES: Readonly<Record<'t' | 'o' | 'h' | 'l' | 'c' | 'v', readonly string[]>> =
  Object.freeze({
    t: ['t', 'ts', 'time'],
    o: ['o', 'open'],
    h: ['h', 'high'],
    l: ['l', 'low'],
    c: ['c', 'close'],
    v: ['v', 'volume'],
  });

function pickField(row: Readonly<Record<string, unknown>>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in row) return row[key];
  }
  return undefined;
}

export function createCodec(): Codec {
  let decoded = 0;
  const counts = zeroCounts();

  const drop = (reason: DropReason): null => {
    counts[reason] += 1;
    return null;
  };

  /** Shared tail: numbers are in hand, `makeBar` owns the OHLCV invariants. */
  const build = (fields: readonly number[]): Bar | null => {
    const tuple: BarTuple = [fields[0], fields[1], fields[2], fields[3], fields[4], fields[5]];
    const bar = barFromTuple(tuple);
    if (bar === null) return drop('invariant');
    decoded += 1;
    return bar;
  };

  const decodeTuple = (payload: unknown): Bar | null => {
    if (!Array.isArray(payload)) return drop('shape');
    const raw: readonly unknown[] = payload;
    if (raw.length !== TUPLE_ARITY) return drop('arity');

    const fields: number[] = [];
    for (const value of raw) {
      const n = toFiniteNumber(value);
      if (n === null) return drop('field');
      fields.push(n);
    }
    return build(fields);
  };

  const decodeRow = (payload: unknown): Bar | null => {
    if (Array.isArray(payload)) return decodeTuple(payload);
    if (!isRecord(payload)) return drop('shape');

    const fields: number[] = [];
    for (const keys of [
      FIELD_ALIASES.t,
      FIELD_ALIASES.o,
      FIELD_ALIASES.h,
      FIELD_ALIASES.l,
      FIELD_ALIASES.c,
      FIELD_ALIASES.v,
    ]) {
      const n = toFiniteNumber(pickField(payload, keys));
      if (n === null) return drop('field');
      fields.push(n);
    }
    return build(fields);
  };

  const decodeRows = (payload: unknown): readonly Bar[] => {
    if (!Array.isArray(payload)) {
      drop('shape');
      return [];
    }
    const rows: readonly unknown[] = payload;
    const bars: Bar[] = [];
    for (const row of rows) {
      const bar = decodeRow(row);
      if (bar !== null) bars.push(bar);
    }
    return bars;
  };

  const stats = (): CodecStats =>
    Object.freeze<CodecStats>({
      decoded,
      dropped: counts.shape + counts.arity + counts.field + counts.invariant,
      byReason: Object.freeze({ ...counts }),
    });

  const reset = (): void => {
    decoded = 0;
    counts.shape = 0;
    counts.arity = 0;
    counts.field = 0;
    counts.invariant = 0;
  };

  return Object.freeze<Codec>({ decodeTuple, decodeRow, decodeRows, stats, reset });
}
