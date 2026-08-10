/**
 * WebSocket wire protocol. Shapes are fixed by ARCHITECTURE.md §3.2:
 *
 * ```jsonc
 * // client -> server
 * { "op": "sub",   "ch": "bars", "sym": "BTCUSD", "tf": "1m" }
 * { "op": "unsub", "ch": "bars", "sym": "BTCUSD", "tf": "1m" }
 * // server -> client
 * { "ch":"bars", "sym":"BTCUSD", "tf":"1m", "seq": 91021,
 *   "b": [1754870400000, 61230.5, 61290.0, 61190.25, 61255.75, 12.83], "final": false }
 * { "op":"pong", "ts": 1754870401234 }
 * ```
 *
 * `{ "op":"ping", "ts": <epoch ms> }` is the client half of the pong exchange —
 * the heartbeat the server answers with `pong` (src/data/CLAUDE.md).
 *
 * Parsing is total: every malformed frame returns a reason instead of throwing.
 */

import type { BarTuple, Timeframe } from '../types.js';
import { TIMEFRAMES } from '../types.js';

export const BARS_CHANNEL = 'bars';
export type BarsChannel = typeof BARS_CHANNEL;

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

export interface SubscribeMessage {
  readonly op: 'sub';
  readonly ch: BarsChannel;
  readonly sym: string;
  readonly tf: Timeframe;
}

export interface UnsubscribeMessage {
  readonly op: 'unsub';
  readonly ch: BarsChannel;
  readonly sym: string;
  readonly tf: Timeframe;
}

export interface PingMessage {
  readonly op: 'ping';
  /** Integer UTC epoch ms, supplied by the caller's injected clock. */
  readonly ts: number;
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

export interface BarMessage {
  readonly ch: BarsChannel;
  readonly sym: string;
  readonly tf: Timeframe;
  /** Monotonic per (sym, tf). A skip is a gap — see gapDetector.ts. */
  readonly seq: number;
  /** `[t,o,h,l,c,v]`; still untrusted numerically, the codec owns invariants. */
  readonly b: BarTuple;
  /** `true` once the bar is closed; `false` for an in-progress live bar. */
  readonly final: boolean;
}

export interface PongMessage {
  readonly op: 'pong';
  readonly ts: number;
}

export type ServerMessage = BarMessage | PongMessage;

export const isBarMessage = (message: ServerMessage): message is BarMessage =>
  !('op' in message);

export const isPongMessage = (message: ServerMessage): message is PongMessage => 'op' in message;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface Subscription {
  readonly sym: string;
  readonly tf: Timeframe;
}

/** Stable identity for a (symbol, timeframe) pair. `|` cannot occur in a symbol. */
export const subscriptionKey = (sym: string, tf: Timeframe): string => `${sym}|${tf}`;

export const subscribeMessage = (sym: string, tf: Timeframe): SubscribeMessage =>
  Object.freeze<SubscribeMessage>({ op: 'sub', ch: BARS_CHANNEL, sym, tf });

export const unsubscribeMessage = (sym: string, tf: Timeframe): UnsubscribeMessage =>
  Object.freeze<UnsubscribeMessage>({ op: 'unsub', ch: BARS_CHANNEL, sym, tf });

export const pingMessage = (ts: number): PingMessage =>
  Object.freeze<PingMessage>({ op: 'ping', ts });

export const encodeClientMessage = (message: ClientMessage): string => JSON.stringify(message);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export const PARSE_FAILURES = [
  'not-json',
  'not-object',
  'unknown-op',
  'bad-channel',
  'bad-symbol',
  'bad-timeframe',
  'bad-seq',
  'bad-payload',
  'bad-final',
  'bad-ts',
] as const;
export type ParseFailure = (typeof PARSE_FAILURES)[number];

export type ParsedServerMessage =
  | { readonly ok: true; readonly message: ServerMessage }
  | { readonly ok: false; readonly reason: ParseFailure };

const ok = (message: ServerMessage): ParsedServerMessage => Object.freeze({ ok: true, message });
const fail = (reason: ParseFailure): ParsedServerMessage => Object.freeze({ ok: false, reason });

const isTimeframe = (value: unknown): value is Timeframe =>
  typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Shape-check only: `[t,o,h,l,c,v]`, six numbers. Ranges are the codec's job. */
const isBarTuple = (value: unknown): value is BarTuple =>
  Array.isArray(value) &&
  value.length === 6 &&
  (value as readonly unknown[]).every((n) => typeof n === 'number');

/**
 * Accepts a raw frame (`string` from `MessageEvent.data`, or an already-parsed
 * value) and returns either a typed message or the reason it was rejected.
 */
export function parseServerMessage(raw: unknown): ParsedServerMessage {
  let value: unknown = raw;

  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return fail('not-json');
    }
  }

  if (!isRecord(value)) return fail('not-object');

  if ('op' in value) {
    if (value['op'] !== 'pong') return fail('unknown-op');
    const ts = value['ts'];
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return fail('bad-ts');
    return ok(Object.freeze<PongMessage>({ op: 'pong', ts }));
  }

  if (value['ch'] !== BARS_CHANNEL) return fail('bad-channel');

  const sym = value['sym'];
  if (typeof sym !== 'string' || sym.length === 0) return fail('bad-symbol');

  const tf = value['tf'];
  if (!isTimeframe(tf)) return fail('bad-timeframe');

  const seq = value['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return fail('bad-seq');

  const b = value['b'];
  if (!isBarTuple(b)) return fail('bad-payload');

  const final = value['final'];
  if (typeof final !== 'boolean') return fail('bad-final');

  return ok(Object.freeze<BarMessage>({ ch: BARS_CHANNEL, sym, tf, seq, b, final }));
}
