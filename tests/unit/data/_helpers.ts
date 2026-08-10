/** Shared fixtures for the data-layer specs. Not a spec file itself. */

import type { Bar } from '../../../src/data/types.js';
import { makeBar } from '../../../src/data/types.js';
import type { DelayFn, WebSocketLike } from '../../../src/data/ws/client.js';
import { WS_CLOSED, WS_CONNECTING, WS_OPEN } from '../../../src/data/ws/client.js';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** 2025-08-11T00:00:00Z — exactly on a 1m/5m/15m/1h/4h/1d boundary. */
export const T0 = 1_754_870_400_000;

/** Builds a valid frozen Bar or fails the test loudly (no `!` anywhere). */
export function bar(t: number, o = 100, h = 110, l = 90, c = 105, v = 1): Bar {
  const made = makeBar({ t, o, h, l, c, v });
  if (made === null) throw new Error(`invalid test bar at t=${String(t)}`);
  return made;
}

/** `[t,o,h,l,c,v]` in wire order. */
export const tuple = (b: Bar): readonly number[] => [b.t, b.o, b.h, b.l, b.c, b.v];

// ---------------------------------------------------------------------------
// Deterministic time
// ---------------------------------------------------------------------------

interface Task {
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

export interface TestScheduler {
  readonly delay: DelayFn;
  /** Property, not a method — it gets passed to the client as `now`. */
  readonly now: () => number;
  /** Runs everything due within the next `ms`, in due order, clock included. */
  readonly advance: (ms: number) => void;
  readonly pending: () => number;
}

export function createTestScheduler(start = 1_000): TestScheduler {
  let clock = start;
  let tasks: Task[] = [];

  const delay: DelayFn = (fn, delayMs) => {
    const task: Task = { at: clock + delayMs, fn, cancelled: false };
    tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  const advance = (ms: number): void => {
    const target = clock + ms;
    for (;;) {
      tasks = tasks.filter((t) => !t.cancelled);
      let next: Task | null = null;
      for (const task of tasks) {
        if (task.at <= target && (next === null || task.at < next.at)) next = task;
      }
      if (next === null) break;
      const due = next;
      tasks = tasks.filter((t) => t !== due);
      clock = Math.max(clock, due.at);
      due.fn();
    }
    clock = target;
  };

  return {
    delay,
    now: () => clock,
    advance,
    pending: () => tasks.filter((t) => !t.cancelled).length,
  };
}

// ---------------------------------------------------------------------------
// Fake socket
// ---------------------------------------------------------------------------

export interface FakeSocket extends WebSocketLike {
  readonly sent: readonly string[];
  readonly closes: number;
  triggerOpen(): void;
  triggerMessage(data: unknown): void;
  triggerClose(): void;
  triggerError(): void;
  /** Parsed view of `sent`, for asserting on ops rather than JSON strings. */
  frames(): readonly Record<string, unknown>[];
}

export function createFakeSocket(): FakeSocket {
  let readyState: number = WS_CONNECTING;
  const sent: string[] = [];
  let closes = 0;

  const socket: FakeSocket = {
    get readyState(): number {
      return readyState;
    },
    get sent(): readonly string[] {
      return sent;
    },
    get closes(): number {
      return closes;
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send(data: string): void {
      sent.push(data);
    },
    close(): void {
      readyState = WS_CLOSED;
      closes += 1;
    },
    triggerOpen(): void {
      readyState = WS_OPEN;
      socket.onopen?.();
    },
    triggerMessage(data: unknown): void {
      socket.onmessage?.({ data });
    },
    triggerClose(): void {
      readyState = WS_CLOSED;
      socket.onclose?.({ code: 1006 });
    },
    triggerError(): void {
      socket.onerror?.(new Error('socket error'));
    },
    frames(): readonly Record<string, unknown>[] {
      return sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    },
  };

  return socket;
}

export interface SocketHarness {
  readonly created: readonly FakeSocket[];
  readonly factory: (url: string) => WebSocketLike;
  last(): FakeSocket;
}

export function createSocketHarness(): SocketHarness {
  const created: FakeSocket[] = [];
  return {
    created,
    factory: (): WebSocketLike => {
      const socket = createFakeSocket();
      created.push(socket);
      return socket;
    },
    last: (): FakeSocket => {
      if (created.length === 0) throw new Error('no socket has been created yet');
      return created[created.length - 1];
    },
  };
}
