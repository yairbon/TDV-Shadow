import { describe, expect, it } from 'vitest';
import {
  encodeClientMessage,
  isBarMessage,
  isPongMessage,
  parseServerMessage,
  pingMessage,
  subscribeMessage,
  subscriptionKey,
  unsubscribeMessage,
} from '../../../src/data/ws/protocol.js';
import { T0 } from './_helpers.js';

const barFrame = {
  ch: 'bars',
  sym: 'BTCUSD',
  tf: '1m',
  seq: 91021,
  b: [T0, 61230.5, 61290.0, 61190.25, 61255.75, 12.83],
  final: false,
};

describe('client -> server frames match ARCHITECTURE.md §3.2 byte for byte', () => {
  it('encodes sub and unsub', () => {
    expect(encodeClientMessage(subscribeMessage('BTCUSD', '1m'))).toBe(
      '{"op":"sub","ch":"bars","sym":"BTCUSD","tf":"1m"}',
    );
    expect(encodeClientMessage(unsubscribeMessage('BTCUSD', '1m'))).toBe(
      '{"op":"unsub","ch":"bars","sym":"BTCUSD","tf":"1m"}',
    );
  });

  it('encodes the heartbeat ping with an injected timestamp', () => {
    expect(encodeClientMessage(pingMessage(1_754_870_401_234))).toBe(
      '{"op":"ping","ts":1754870401234}',
    );
  });

  it('keys subscriptions by (symbol, timeframe)', () => {
    expect(subscriptionKey('BTCUSD', '1m')).toBe('BTCUSD|1m');
    expect(subscriptionKey('BTCUSD', '5m')).not.toBe(subscriptionKey('BTCUSD', '1m'));
  });
});

describe('parseServerMessage', () => {
  it('parses a bar frame from its JSON string', () => {
    const parsed = parseServerMessage(JSON.stringify(barFrame));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(isBarMessage(parsed.message)).toBe(true);
    if (!isBarMessage(parsed.message)) return;
    expect(parsed.message.sym).toBe('BTCUSD');
    expect(parsed.message.seq).toBe(91021);
    expect(parsed.message.b[0]).toBe(T0);
    expect(parsed.message.final).toBe(false);
  });

  it('parses a pong', () => {
    const parsed = parseServerMessage({ op: 'pong', ts: 1_754_870_401_234 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(isPongMessage(parsed.message)).toBe(true);
  });

  it('reports a reason instead of throwing for every malformed frame', () => {
    const cases: readonly [unknown, string][] = [
      ['{not json', 'not-json'],
      [42, 'not-object'],
      [{ op: 'hello' }, 'unknown-op'],
      [{ op: 'pong' }, 'bad-ts'],
      [{ ...barFrame, ch: 'trades' }, 'bad-channel'],
      [{ ...barFrame, sym: '' }, 'bad-symbol'],
      [{ ...barFrame, tf: '3m' }, 'bad-timeframe'],
      [{ ...barFrame, seq: -1 }, 'bad-seq'],
      [{ ...barFrame, seq: 1.5 }, 'bad-seq'],
      [{ ...barFrame, b: [T0, 1, 2, 3, 4] }, 'bad-payload'],
      [{ ...barFrame, b: [T0, '1', 2, 3, 4, 5] }, 'bad-payload'],
      [{ ...barFrame, final: 'yes' }, 'bad-final'],
    ];

    for (const [raw, reason] of cases) {
      const parsed = parseServerMessage(raw);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe(reason);
    }
  });

  it('accepts an already-parsed object as well as a string', () => {
    expect(parseServerMessage(barFrame).ok).toBe(true);
  });
});
