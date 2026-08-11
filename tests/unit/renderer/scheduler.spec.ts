import { describe, expect, it, vi } from 'vitest';
import { createScheduler, DirtyFlags, type DirtyMask } from '../../../src/renderer/scheduler.js';

/** Deterministic stand-in for the browser frame clock. */
class FakeRaf {
  requested = 0;
  cancelled: number[] = [];
  #queue = new Map<number, FrameRequestCallback>();
  #next = 1;

  readonly request = (callback: FrameRequestCallback): number => {
    const handle = this.#next++;
    this.#queue.set(handle, callback);
    this.requested++;
    return handle;
  };

  readonly cancel = (handle: number): void => {
    this.cancelled.push(handle);
    this.#queue.delete(handle);
  };

  get pending(): number {
    return this.#queue.size;
  }

  /** Runs exactly one queued frame, like the browser does. */
  flush(time = 0): void {
    const entry = this.#queue.entries().next();
    if (entry.done === true) return;
    const [handle, callback] = entry.value;
    this.#queue.delete(handle);
    callback(time);
  }
}

describe('scheduler — one rAF per frame (SKILL rule 3)', () => {
  it('coalesces many invalidations into a single frame', () => {
    const raf = new FakeRaf();
    const frame = vi.fn<(mask: DirtyMask, time: number) => void>();
    const scheduler = createScheduler({ frame, requestFrame: raf.request, cancelFrame: raf.cancel });

    scheduler.invalidate(DirtyFlags.Series);
    scheduler.invalidate(DirtyFlags.Series);
    scheduler.invalidate(DirtyFlags.Grid);
    scheduler.invalidate(DirtyFlags.Crosshair);

    expect(raf.requested).toBe(1);
    expect(scheduler.pendingMask).toBe(DirtyFlags.Series | DirtyFlags.Grid | DirtyFlags.Crosshair);

    raf.flush(16);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(frame).toHaveBeenCalledWith(
      DirtyFlags.Series | DirtyFlags.Grid | DirtyFlags.Crosshair,
      16,
    );
    expect(scheduler.pendingMask).toBe(DirtyFlags.None);
    expect(raf.pending).toBe(0);
  });

  it('does not draw from the event that invalidated', () => {
    const raf = new FakeRaf();
    const frame = vi.fn<(mask: DirtyMask, time: number) => void>();
    const scheduler = createScheduler({ frame, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.invalidate(DirtyFlags.All);
    expect(frame).not.toHaveBeenCalled();
  });

  it('ignores an empty mask', () => {
    const raf = new FakeRaf();
    const scheduler = createScheduler({
      frame: (): void => undefined,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.invalidate(DirtyFlags.None);
    expect(raf.requested).toBe(0);
    expect(scheduler.isScheduled).toBe(false);
  });

  it('never requests a frame from inside a draw pass, and never drops the work', () => {
    const raf = new FakeRaf();
    const masks: DirtyMask[] = [];
    let requestsDuringFrame = -1;
    const scheduler = createScheduler({
      frame: (mask: DirtyMask): void => {
        masks.push(mask);
        if (masks.length === 1) {
          // A live tick arriving mid-draw: it must land in the NEXT frame.
          scheduler.invalidate(DirtyFlags.Series);
          requestsDuringFrame = raf.requested;
        }
      },
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });

    scheduler.invalidate(DirtyFlags.Grid);
    raf.flush(1);

    expect(requestsDuringFrame).toBe(1); // no reentrant request while drawing
    expect(raf.requested).toBe(2); // queued once the pass returned
    expect(scheduler.pendingMask).toBe(DirtyFlags.Series);

    raf.flush(2);
    expect(masks).toEqual([DirtyFlags.Grid, DirtyFlags.Series]);
    expect(raf.pending).toBe(0);
  });

  it('keeps exactly one frame in flight across repeated cycles', () => {
    const raf = new FakeRaf();
    const scheduler = createScheduler({
      frame: (): void => undefined,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    for (let i = 0; i < 10; i++) {
      scheduler.invalidate(DirtyFlags.Crosshair);
      scheduler.invalidate(DirtyFlags.Crosshair);
      expect(raf.pending).toBe(1);
      raf.flush(i);
      expect(raf.pending).toBe(0);
    }
    expect(raf.requested).toBe(10);
  });

  it('still clears the queue when a layer throws', () => {
    const raf = new FakeRaf();
    const scheduler = createScheduler({
      frame: (): void => {
        throw new Error('layer exploded');
      },
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.invalidate(DirtyFlags.Series);
    expect(() => {
      raf.flush(1);
    }).toThrow('layer exploded');
    expect(scheduler.isScheduled).toBe(false);
    expect(scheduler.pendingMask).toBe(DirtyFlags.None);
    scheduler.invalidate(DirtyFlags.Series);
    expect(raf.pending).toBe(1);
  });

  it('cancels and disposes cleanly', () => {
    const raf = new FakeRaf();
    const frame = vi.fn<(mask: DirtyMask, time: number) => void>();
    const scheduler = createScheduler({ frame, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.invalidate(DirtyFlags.All);
    scheduler.cancel();
    expect(raf.cancelled).toHaveLength(1);
    expect(raf.pending).toBe(0);

    scheduler.dispose();
    scheduler.invalidate(DirtyFlags.All);
    expect(raf.requested).toBe(1);
    expect(frame).not.toHaveBeenCalled();
  });

  it('reports a missing host requestAnimationFrame instead of silently not drawing', () => {
    expect(() => createScheduler({ frame: (): void => undefined })).toThrow(
      /requestAnimationFrame/,
    );
  });
});
