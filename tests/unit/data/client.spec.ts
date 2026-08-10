import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  createWsClient,
  DEFAULT_BACKOFF,
  WS_CLOSED,
} from '../../../src/data/ws/client.js';
import type { BarEvent, DropKind } from '../../../src/data/ws/client.js';
import { createSocketHarness, createTestScheduler, T0 } from './_helpers.js';

const barFrame = (seq: number, t: number, close = 105): string =>
  JSON.stringify({
    ch: 'bars',
    sym: 'BTCUSD',
    tf: '1m',
    seq,
    b: [t, 100, 110, 90, close, 1],
    final: false,
  });

interface Harness {
  readonly client: ReturnType<typeof createWsClient>;
  readonly sockets: ReturnType<typeof createSocketHarness>;
  readonly clock: ReturnType<typeof createTestScheduler>;
  readonly bars: BarEvent[];
  readonly drops: DropKind[];
}

function harness(overrides: { readonly random?: () => number } = {}): Harness {
  const sockets = createSocketHarness();
  const clock = createTestScheduler();
  const bars: BarEvent[] = [];
  const drops: DropKind[] = [];

  const client = createWsClient({
    url: 'wss://gateway.test/stream',
    createSocket: sockets.factory,
    now: clock.now,
    delay: clock.delay,
    random: overrides.random ?? ((): number => 0.5),
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 3_000,
    onBar: (event) => bars.push(event),
    onDrop: (kind) => drops.push(kind),
  });

  return { client, sockets, clock, bars, drops };
}

describe('backoffDelayMs — exponential with jitter', () => {
  it('grows exponentially and never exceeds maxMs', () => {
    const atCeiling = (attempt: number): number => backoffDelayMs(attempt, DEFAULT_BACKOFF, () => 1);

    expect(atCeiling(0)).toBe(500);
    expect(atCeiling(1)).toBe(1_000);
    expect(atCeiling(2)).toBe(2_000);
    expect(atCeiling(3)).toBe(4_000);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect(atCeiling(attempt)).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    }
    expect(atCeiling(30)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it('stays inside [capped * (1 - jitterRatio), capped] for every random draw', () => {
    const draws = [0, 0.0001, 0.25, 0.5, 0.75, 0.999999, 1];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const capped = Math.min(
        DEFAULT_BACKOFF.maxMs,
        DEFAULT_BACKOFF.baseMs * Math.pow(DEFAULT_BACKOFF.factor, attempt),
      );
      const floor = capped * (1 - DEFAULT_BACKOFF.jitterRatio);
      for (const draw of draws) {
        const delay = backoffDelayMs(attempt, DEFAULT_BACKOFF, () => draw);
        expect(delay).toBeGreaterThanOrEqual(floor);
        expect(delay).toBeLessThanOrEqual(capped);
      }
    }
  });

  it('actually jitters — two draws give two delays', () => {
    expect(backoffDelayMs(4, DEFAULT_BACKOFF, () => 0)).not.toBe(
      backoffDelayMs(4, DEFAULT_BACKOFF, () => 1),
    );
  });

  it('never returns a negative delay, whatever it is handed', () => {
    const policy = { baseMs: 100, maxMs: 1_000, factor: 2, jitterRatio: 5 };
    expect(backoffDelayMs(-3, policy, () => 0)).toBeGreaterThanOrEqual(0);
    expect(backoffDelayMs(Number.NaN, policy, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it('full jitter (ratio 1) can reach zero, so a fleet never reconnects in lockstep', () => {
    const policy = { baseMs: 500, maxMs: 30_000, factor: 2, jitterRatio: 1 };
    expect(backoffDelayMs(3, policy, () => 0)).toBe(0);
    expect(backoffDelayMs(3, policy, () => 1)).toBe(4_000);
  });
});

describe('WsClient — subscribe and resubscribe', () => {
  it('queues subscriptions made before the socket opens and sends them on open', () => {
    const { client, sockets } = harness();
    client.subscribe('BTCUSD', '1m');
    client.connect();

    expect(sockets.last().sent).toHaveLength(0);
    sockets.last().triggerOpen();

    expect(sockets.last().frames()).toEqual([
      { op: 'sub', ch: 'bars', sym: 'BTCUSD', tf: '1m' },
    ]);
  });

  it('is idempotent: subscribing twice sends one frame and replays one', () => {
    const { client, sockets, clock } = harness();
    client.connect();
    sockets.last().triggerOpen();

    client.subscribe('BTCUSD', '1m');
    client.subscribe('BTCUSD', '1m');
    client.subscribe('BTCUSD', '1m');

    expect(sockets.last().sent).toHaveLength(1);
    expect(client.subscriptions()).toHaveLength(1);

    sockets.last().triggerClose();
    clock.advance(60_000);
    sockets.last().triggerOpen();

    expect(sockets.created).toHaveLength(2);
    expect(sockets.last().frames()).toEqual([
      { op: 'sub', ch: 'bars', sym: 'BTCUSD', tf: '1m' },
    ]);
  });

  it('replays every distinct subscription after a reconnect', () => {
    const { client, sockets, clock } = harness();
    client.connect();
    sockets.last().triggerOpen();
    client.subscribe('BTCUSD', '1m');
    client.subscribe('ETHUSD', '5m');

    sockets.last().triggerClose();
    clock.advance(60_000);
    sockets.last().triggerOpen();

    expect(sockets.last().frames()).toEqual([
      { op: 'sub', ch: 'bars', sym: 'BTCUSD', tf: '1m' },
      { op: 'sub', ch: 'bars', sym: 'ETHUSD', tf: '5m' },
    ]);
  });

  it('unsubscribe sends unsub once and drops the symbol from the replay set', () => {
    const { client, sockets, clock } = harness();
    client.connect();
    sockets.last().triggerOpen();
    client.subscribe('BTCUSD', '1m');
    client.unsubscribe('BTCUSD', '1m');
    client.unsubscribe('BTCUSD', '1m');

    expect(sockets.last().frames()).toEqual([
      { op: 'sub', ch: 'bars', sym: 'BTCUSD', tf: '1m' },
      { op: 'unsub', ch: 'bars', sym: 'BTCUSD', tf: '1m' },
    ]);

    sockets.last().triggerClose();
    clock.advance(60_000);
    sockets.last().triggerOpen();
    expect(sockets.last().sent).toHaveLength(0);
  });
});

describe('WsClient — reconnect', () => {
  it('reconnects with a jittered backoff and resets the attempt counter on open', () => {
    const { client, sockets, clock } = harness({ random: () => 1 });
    client.connect();
    sockets.last().triggerOpen();

    sockets.last().triggerClose();
    clock.advance(499); // first retry lands at baseMs = 500 with random() = 1
    expect(sockets.created).toHaveLength(1);
    clock.advance(1);
    expect(sockets.created).toHaveLength(2);

    // Second drop without ever opening: the delay doubles.
    sockets.last().triggerClose();
    clock.advance(999);
    expect(sockets.created).toHaveLength(2);
    clock.advance(1);
    expect(sockets.created).toHaveLength(3);

    // A successful open resets the ladder back to baseMs.
    sockets.last().triggerOpen();
    sockets.last().triggerClose();
    clock.advance(500);
    expect(sockets.created).toHaveLength(4);
    expect(client.stats().reconnects).toBe(3);
  });

  it('treats an error frame like a drop', () => {
    const { sockets, clock, client } = harness();
    client.connect();
    sockets.last().triggerOpen();
    sockets.last().triggerError();

    clock.advance(60_000);
    expect(sockets.created).toHaveLength(2);
  });

  it('ignores late events from a socket it has already abandoned', () => {
    const { client, sockets, clock, bars } = harness();
    client.connect();
    sockets.last().triggerOpen();
    const stale = sockets.last();

    stale.triggerClose();
    clock.advance(60_000);
    expect(sockets.created).toHaveLength(2);

    stale.triggerMessage(barFrame(1, T0));
    expect(bars).toHaveLength(0);
    expect(client.stats().messages).toBe(0);
  });
});

describe('WsClient — heartbeat', () => {
  it('pings on the interval while frames keep arriving', () => {
    const { client, sockets, clock } = harness();
    client.connect();
    sockets.last().triggerOpen();

    clock.advance(1_000);
    clock.advance(1_000);

    const ops = sockets.last().frames().map((frame) => frame['op']);
    expect(ops).toEqual(['ping', 'ping']);
    expect(sockets.created).toHaveLength(1);
  });

  it('tears the socket down and reconnects when the peer goes silent', () => {
    const { client, sockets, clock } = harness();
    client.connect();
    sockets.last().triggerOpen();
    const dead = sockets.last();

    clock.advance(4_000); // > heartbeatTimeoutMs with no inbound frame

    expect(client.stats().heartbeatTimeouts).toBe(1);
    expect(dead.readyState).toBe(WS_CLOSED);
    expect(dead.onmessage).toBeNull();

    clock.advance(60_000);
    expect(sockets.created).toHaveLength(2);
  });

  it('an inbound frame counts as liveness', () => {
    const { client, sockets, clock } = harness();
    client.connect();
    sockets.last().triggerOpen();

    for (let i = 0; i < 6; i += 1) {
      clock.advance(1_000);
      sockets.last().triggerMessage(barFrame(i + 1, T0 + i * 60_000));
    }

    expect(client.stats().heartbeatTimeouts).toBe(0);
    expect(sockets.created).toHaveLength(1);
  });
});

describe('WsClient — inbound frames', () => {
  it('decodes bar frames into frozen bars with their stream metadata', () => {
    const { client, sockets, bars } = harness();
    client.connect();
    sockets.last().triggerOpen();
    sockets.last().triggerMessage(barFrame(7, T0));

    expect(bars).toHaveLength(1);
    const event = bars[0];
    expect(event.symbol).toBe('BTCUSD');
    expect(event.tf).toBe('1m');
    expect(event.seq).toBe(7);
    expect(event.final).toBe(false);
    expect(Object.isFrozen(event.bar)).toBe(true);
    expect(event.bar.t).toBe(T0);
    expect(client.stats().bars).toBe(1);
  });

  it('drops malformed frames with a reason and keeps the socket alive', () => {
    const { client, sockets, bars, drops } = harness();
    client.connect();
    sockets.last().triggerOpen();

    sockets.last().triggerMessage('{broken');
    sockets.last().triggerMessage(JSON.stringify({ ch: 'bars', sym: 'BTCUSD', tf: '9x' }));
    sockets.last().triggerMessage(
      JSON.stringify({
        ch: 'bars',
        sym: 'BTCUSD',
        tf: '1m',
        seq: 3,
        b: [T0, 100, 104, 90, 105, 1], // high below close: codec rejects it
        final: true,
      }),
    );

    expect(bars).toHaveLength(0);
    expect(drops).toEqual(['not-json', 'bad-timeframe', 'codec']);
    expect(client.stats().dropped).toBe(3);
    expect(client.state()).toBe('open');
  });

  it('swallows pongs without waking the pipeline', () => {
    const { client, sockets, bars, drops } = harness();
    client.connect();
    sockets.last().triggerOpen();
    sockets.last().triggerMessage(JSON.stringify({ op: 'pong', ts: 1 }));

    expect(bars).toHaveLength(0);
    expect(drops).toHaveLength(0);
    expect(client.stats().messages).toBe(1);
  });
});

describe('WsClient — teardown', () => {
  it('close() clears timers, detaches handlers and never reconnects', () => {
    const { client, sockets, clock, bars } = harness();
    client.connect();
    sockets.last().triggerOpen();
    const socket = sockets.last();

    client.close();

    expect(client.state()).toBe('closed');
    expect(socket.readyState).toBe(WS_CLOSED);
    expect(socket.closes).toBe(1);
    expect(socket.onopen).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(clock.pending()).toBe(0);

    clock.advance(600_000);
    expect(sockets.created).toHaveLength(1);

    socket.triggerMessage(barFrame(1, T0));
    expect(bars).toHaveLength(0);
  });

  it('close() during a pending reconnect cancels it', () => {
    const { client, sockets, clock } = harness();
    client.connect();
    sockets.last().triggerOpen();
    sockets.last().triggerClose();

    client.close();
    clock.advance(600_000);

    expect(sockets.created).toHaveLength(1);
    expect(client.state()).toBe('closed');
  });

  it('connect() after close() stays closed — the client is single-use', () => {
    const { client, sockets } = harness();
    client.connect();
    client.close();
    client.connect();

    expect(sockets.created).toHaveLength(1);
    expect(client.state()).toBe('closed');
  });
});
