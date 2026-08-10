/**
 * WebSocket client: connect, heartbeat, exponential backoff with jitter,
 * idempotent resubscribe, clean teardown.
 *
 * Everything the client needs from the outside world is injected — the socket
 * factory, the clock, the timer and the RNG. That keeps `src/data` free of DOM
 * and of `Date` (src/data/CLAUDE.md), and makes every timing rule testable
 * without a real socket or a real second passing.
 *
 * The client never draws and never calls the store directly: it hands decoded
 * bars to `onBar`, and back-pressure (one `replaceLast` per bar per frame) is
 * applied by `store/tickBuffer.ts` before anything reaches the renderer
 * (ARCHITECTURE.md §2, root mandate #3).
 */

import type { Bar, Timeframe } from '../types.js';
import type { Codec } from '../codec.js';
import { createCodec } from '../codec.js';
import type { BarMessage, ClientMessage, ParseFailure, Subscription } from './protocol.js';
import {
  encodeClientMessage,
  isPongMessage,
  parseServerMessage,
  pingMessage,
  subscribeMessage,
  subscriptionKey,
  unsubscribeMessage,
} from './protocol.js';

// ---------------------------------------------------------------------------
// Injected transport
// ---------------------------------------------------------------------------

/** `WebSocket.readyState` values (the spec's constants, restated locally). */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

/**
 * The slice of `WebSocket` this client uses. A browser `WebSocket` satisfies it
 * behaviourally; `app/` supplies a thin adapter because the DOM handler
 * signatures are `Event`-typed.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Schedules `fn` after `delayMs`; the returned function cancels it. */
export type DelayFn = (fn: () => void, delayMs: number) => () => void;

const defaultDelay: DelayFn = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(id);
  };
};

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export interface BackoffPolicy {
  /** Delay before the first retry. */
  readonly baseMs: number;
  /** Ceiling for the exponential term. */
  readonly maxMs: number;
  /** Growth per attempt. */
  readonly factor: number;
  /**
   * Fraction of the capped delay that is randomised, in [0, 1].
   * The delay lands in `[capped * (1 - jitterRatio), capped]` — "equal jitter"
   * at 0.5, "full jitter" at 1. Never zero, so a fleet does not reconnect in
   * lockstep after a gateway restart.
   */
  readonly jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitterRatio: 0.5,
});

/**
 * `attempt` is 0-based: attempt 0 is the first retry after a drop.
 * Deterministic given `random`, which is what the bounds test leans on.
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const uncapped = policy.baseMs * Math.pow(policy.factor, safeAttempt);
  const capped = Math.min(policy.maxMs, uncapped);
  const ratio = Math.min(1, Math.max(0, policy.jitterRatio));
  const floor = capped * (1 - ratio);
  return floor + (capped - floor) * random();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** One decoded live bar, with the stream metadata the pipeline needs. */
export interface BarEvent {
  readonly symbol: string;
  readonly tf: Timeframe;
  readonly seq: number;
  readonly final: boolean;
  readonly bar: Bar;
}

export type DropKind = ParseFailure | 'codec';

export interface WsClientStats {
  readonly state: ConnectionState;
  readonly connects: number;
  readonly reconnects: number;
  readonly messages: number;
  readonly bars: number;
  readonly dropped: number;
  readonly heartbeatTimeouts: number;
  readonly subscriptions: number;
}

export interface WsClientOptions {
  readonly url: string;
  readonly createSocket: WebSocketFactory;
  /**
   * Integer UTC epoch ms. Injected rather than read from `Date` — the data
   * layer owns no clock of its own (src/data/CLAUDE.md).
   */
  readonly now: () => number;
  readonly delay?: DelayFn;
  readonly random?: () => number;
  readonly codec?: Codec;
  readonly backoff?: BackoffPolicy;
  /** Ping cadence while open. */
  readonly heartbeatIntervalMs?: number;
  /** Silence longer than this (no frame of any kind) means a dead socket. */
  readonly heartbeatTimeoutMs?: number;
  readonly onBar?: (event: BarEvent) => void;
  readonly onStateChange?: (state: ConnectionState) => void;
  readonly onDrop?: (kind: DropKind) => void;
  /** Fires after every (re)connect with the subscriptions that were replayed. */
  readonly onResubscribe?: (subscriptions: readonly Subscription[]) => void;
}

export interface WsClient {
  connect(): void;
  /** Idempotent: subscribing twice sends one `sub` and replays one on reconnect. */
  subscribe(sym: string, tf: Timeframe): void;
  unsubscribe(sym: string, tf: Timeframe): void;
  subscriptions(): readonly Subscription[];
  state(): ConnectionState;
  stats(): WsClientStats;
  /** Deliberate shutdown: timers cleared, handlers detached, no reconnect. */
  close(): void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

export function createWsClient(options: WsClientOptions): WsClient {
  const delay = options.delay ?? defaultDelay;
  const random = options.random ?? Math.random;
  const codec = options.codec ?? createCodec();
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

  const subs = new Map<string, Subscription>();

  let socket: WebSocketLike | null = null;
  let state: ConnectionState = 'idle';
  let attempt = 0;
  let disposed = false;
  let cancelReconnect: (() => void) | null = null;
  let cancelHeartbeat: (() => void) | null = null;
  let lastMessageAt = 0;

  let connects = 0;
  let reconnects = 0;
  let messages = 0;
  let barCount = 0;
  let dropped = 0;
  let heartbeatTimeouts = 0;

  const setState = (next: ConnectionState): void => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next);
  };

  const drop = (kind: DropKind): void => {
    dropped += 1;
    options.onDrop?.(kind);
  };

  const send = (message: ClientMessage): void => {
    const active = socket;
    if (active === null || active.readyState !== WS_OPEN) return;
    active.send(encodeClientMessage(message));
  };

  const clearTimers = (): void => {
    cancelReconnect?.();
    cancelReconnect = null;
    cancelHeartbeat?.();
    cancelHeartbeat = null;
  };

  const detach = (target: WebSocketLike): void => {
    target.onopen = null;
    target.onclose = null;
    target.onerror = null;
    target.onmessage = null;
  };

  /** Drops the current socket and schedules a reconnect (unless disposed). */
  const teardown = (reconnect: boolean): void => {
    const active = socket;
    socket = null;
    cancelHeartbeat?.();
    cancelHeartbeat = null;
    if (active !== null) {
      detach(active);
      if (active.readyState === WS_OPEN || active.readyState === WS_CONNECTING) {
        active.close();
      }
    }
    if (reconnect && !disposed) scheduleReconnect();
  };

  function scheduleReconnect(): void {
    cancelReconnect?.();
    const wait = backoffDelayMs(attempt, backoff, random);
    attempt += 1;
    setState('reconnecting');
    cancelReconnect = delay(() => {
      cancelReconnect = null;
      if (disposed) return;
      reconnects += 1;
      open();
    }, wait);
  }

  function armHeartbeat(): void {
    cancelHeartbeat?.();
    cancelHeartbeat = delay(() => {
      cancelHeartbeat = null;
      if (disposed || socket === null) return;
      if (options.now() - lastMessageAt > heartbeatTimeoutMs) {
        // Silent socket. TCP can stay "open" long after the peer is gone.
        heartbeatTimeouts += 1;
        teardown(true);
        return;
      }
      send(pingMessage(options.now()));
      armHeartbeat();
    }, heartbeatIntervalMs);
  }

  /** Replays the whole subscription set — safe to call on every reconnect. */
  function resubscribeAll(): void {
    const replayed: Subscription[] = [];
    for (const sub of subs.values()) {
      send(subscribeMessage(sub.sym, sub.tf));
      replayed.push(sub);
    }
    options.onResubscribe?.(Object.freeze(replayed));
  }

  function handleBarMessage(message: BarMessage): void {
    const bar = codec.decodeTuple(message.b);
    if (bar === null) {
      drop('codec');
      return;
    }
    barCount += 1;
    options.onBar?.(
      Object.freeze<BarEvent>({
        symbol: message.sym,
        tf: message.tf,
        seq: message.seq,
        final: message.final,
        bar,
      }),
    );
  }

  function open(): void {
    if (disposed) return;
    setState(state === 'reconnecting' ? 'reconnecting' : 'connecting');

    const created = options.createSocket(options.url);
    socket = created;
    connects += 1;
    lastMessageAt = options.now();

    created.onopen = (): void => {
      if (socket !== created) return;
      attempt = 0;
      lastMessageAt = options.now();
      setState('open');
      resubscribeAll();
      armHeartbeat();
    };

    created.onmessage = (event): void => {
      if (socket !== created) return;
      messages += 1;
      lastMessageAt = options.now();

      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) {
        drop(parsed.reason);
        return;
      }
      if (isPongMessage(parsed.message)) return;
      handleBarMessage(parsed.message);
    };

    created.onerror = (): void => {
      if (socket !== created) return;
      // `error` is always followed by `close` in the spec, but not every gateway
      // is spec-perfect; tearing down here is idempotent with the close path.
      teardown(true);
    };

    created.onclose = (): void => {
      if (socket !== created) return;
      teardown(true);
    };
  }

  const connect = (): void => {
    if (disposed || socket !== null) return;
    cancelReconnect?.();
    cancelReconnect = null;
    attempt = 0;
    open();
  };

  const subscribe = (sym: string, tf: Timeframe): void => {
    const key = subscriptionKey(sym, tf);
    if (subs.has(key)) return;
    subs.set(key, Object.freeze<Subscription>({ sym, tf }));
    send(subscribeMessage(sym, tf));
  };

  const unsubscribe = (sym: string, tf: Timeframe): void => {
    const key = subscriptionKey(sym, tf);
    if (!subs.delete(key)) return;
    send(unsubscribeMessage(sym, tf));
  };

  const subscriptions = (): readonly Subscription[] => Object.freeze([...subs.values()]);

  const stats = (): WsClientStats =>
    Object.freeze<WsClientStats>({
      state,
      connects,
      reconnects,
      messages,
      bars: barCount,
      dropped,
      heartbeatTimeouts,
      subscriptions: subs.size,
    });

  const close = (): void => {
    disposed = true;
    clearTimers();
    teardown(false);
    setState('closed');
  };

  return Object.freeze<WsClient>({
    connect,
    subscribe,
    unsubscribe,
    subscriptions,
    state: () => state,
    stats,
    close,
  });
}
