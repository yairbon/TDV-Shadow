/**
 * Frame lifecycle: `invalidate(mask)` -> a single `requestAnimationFrame` -> one
 * `frame()` call (SKILL rule 3, mandate #3).
 *
 * Events, WebSocket messages and store writes call `invalidate` and nothing else.
 * They never draw. Invalidations that arrive *during* a draw pass are accumulated
 * and scheduled after the pass returns, so a draw never nests a rAF request inside
 * itself.
 */

/** Layer bits. `invalidate` takes any OR of these. */
export const DirtyFlags = Object.freeze({
  None: 0,
  Grid: 1,
  Series: 2,
  Overlay: 4,
  Crosshair: 8,
  All: 15,
});

export type DirtyMask = number;

export type FrameFn = (mask: DirtyMask, time: number) => void;

export interface SchedulerOptions {
  readonly frame: FrameFn;
  /** Injectable for tests; defaults to the host `requestAnimationFrame`. */
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface Scheduler {
  /** Accumulates dirty bits and ensures exactly one frame is queued. */
  invalidate(mask: DirtyMask): void;
  readonly pendingMask: DirtyMask;
  readonly isScheduled: boolean;
  /** Drops the queued frame, keeping the accumulated mask. */
  cancel(): void;
  dispose(): void;
}

interface FrameApi {
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

function hostFrameApi(): FrameApi {
  const g: {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (handle: number) => void;
  } = globalThis;
  const request = g.requestAnimationFrame?.bind(globalThis);
  const cancel = g.cancelAnimationFrame?.bind(globalThis);
  const api: { requestFrame?: (cb: FrameRequestCallback) => number; cancelFrame?: (h: number) => void } =
    {};
  if (request !== undefined) api.requestFrame = request;
  if (cancel !== undefined) api.cancelFrame = cancel;
  return api;
}

class RafScheduler implements Scheduler {
  readonly #frame: FrameFn;
  readonly #request: (callback: FrameRequestCallback) => number;
  readonly #cancel: (handle: number) => void;
  #pending: DirtyMask = DirtyFlags.None;
  #handle = 0;
  #inFrame = false;
  #disposed = false;

  constructor(options: SchedulerOptions) {
    const host = hostFrameApi();
    const request = options.requestFrame ?? host.requestFrame;
    if (request === undefined) {
      throw new Error('scheduler: no requestAnimationFrame available — inject `requestFrame`');
    }
    const cancel = options.cancelFrame ?? host.cancelFrame;
    this.#frame = options.frame;
    this.#request = request;
    this.#cancel = cancel ?? ((): void => undefined);
  }

  get pendingMask(): DirtyMask {
    return this.#pending;
  }

  get isScheduled(): boolean {
    return this.#handle !== 0;
  }

  invalidate(mask: DirtyMask): void {
    if (this.#disposed || mask === DirtyFlags.None) return;
    this.#pending |= mask;
    // Inside a draw pass the queue is flushed by #tick's finally block instead —
    // requesting a frame from within the pass would be the reentrancy SKILL rule 3 bans.
    if (!this.#inFrame) this.#schedule();
  }

  cancel(): void {
    if (this.#handle !== 0) {
      this.#cancel(this.#handle);
      this.#handle = 0;
    }
  }

  dispose(): void {
    this.cancel();
    this.#pending = DirtyFlags.None;
    this.#disposed = true;
  }

  #schedule(): void {
    if (this.#handle !== 0 || this.#disposed) return;
    this.#handle = this.#request(this.#tick);
  }

  readonly #tick = (time: number): void => {
    this.#handle = 0;
    const mask = this.#pending;
    this.#pending = DirtyFlags.None;
    this.#inFrame = true;
    try {
      if (mask !== DirtyFlags.None) this.#frame(mask, time);
    } finally {
      this.#inFrame = false;
      if (this.#pending !== DirtyFlags.None) this.#schedule();
    }
  };
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  return new RafScheduler(options);
}
