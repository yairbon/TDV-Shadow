import { afterEach, describe, expect, it } from 'vitest';
import { createSurface } from '../../../src/renderer/surface.js';
import { FakeCanvas } from './fakeCanvas.js';

interface RatioHost {
  devicePixelRatio?: number;
}

function setRatio(value: number | undefined): void {
  const host: RatioHost = globalThis;
  if (value === undefined) {
    delete host.devicePixelRatio;
  } else {
    host.devicePixelRatio = value;
  }
}

afterEach(() => {
  setRatio(undefined);
});

describe('surface — RENDER_ALGORITHMS §1', () => {
  it('sizes the backing store to round(css * dpr) and sets the transform once', () => {
    setRatio(2);
    const canvas = new FakeCanvas();
    const surface = createSurface(canvas.asCanvas(), {
      onResize: (): void => undefined,
      autoObserve: false,
    });

    expect(surface.resize(800, 600)).toBe(true);
    expect(canvas.width).toBe(1_600);
    expect(canvas.height).toBe(1_200);
    expect(surface.cssWidth).toBe(800);
    expect(surface.cssHeight).toBe(600);
    expect(surface.ratio).toBe(2);

    const transforms = canvas.context.ops('setTransform');
    expect(transforms).toHaveLength(1);
    expect(transforms[0].args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('rounds fractional device pixels rather than truncating them', () => {
    setRatio(1.5);
    const canvas = new FakeCanvas();
    const surface = createSurface(canvas.asCanvas(), {
      onResize: (): void => undefined,
      autoObserve: false,
    });
    surface.resize(801, 601);
    expect(canvas.width).toBe(Math.round(801 * 1.5));
    expect(canvas.height).toBe(Math.round(601 * 1.5));
  });

  it('falls back to a ratio of 1 on a host without devicePixelRatio', () => {
    setRatio(undefined);
    const canvas = new FakeCanvas();
    const surface = createSurface(canvas.asCanvas(), {
      onResize: (): void => undefined,
      autoObserve: false,
    });
    surface.resize(300, 150);
    expect(surface.ratio).toBe(1);
    expect(canvas.width).toBe(300);
    expect(canvas.context.ops('setTransform')[0].args).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('is idempotent: an unchanged size does not touch the backing store', () => {
    setRatio(2);
    const canvas = new FakeCanvas();
    const surface = createSurface(canvas.asCanvas(), {
      onResize: (): void => undefined,
      autoObserve: false,
    });
    surface.resize(800, 600);
    expect(surface.resize(800, 600)).toBe(false);
    expect(canvas.context.ops('setTransform')).toHaveLength(1);
  });

  it('re-applies the transform when the ratio changes under a fixed size', () => {
    setRatio(1);
    const canvas = new FakeCanvas();
    const surface = createSurface(canvas.asCanvas(), {
      onResize: (): void => undefined,
      autoObserve: false,
    });
    surface.resize(800, 600);
    setRatio(3);
    expect(surface.sync()).toBe(true);
    expect(canvas.width).toBe(2_400);
    const transforms = canvas.context.ops('setTransform');
    expect(transforms[transforms.length - 1].args).toEqual([3, 0, 0, 3, 0, 0]);
  });

  it('clears in CSS pixel space, not device pixel space', () => {
    setRatio(2);
    const canvas = new FakeCanvas();
    const surface = createSurface(canvas.asCanvas(), {
      onResize: (): void => undefined,
      autoObserve: false,
    });
    surface.resize(800, 600);
    surface.clear();
    expect(canvas.context.ops('clearRect')[0].args).toEqual([0, 0, 800, 600]);
  });

  it('throws when the element cannot give a 2d context', () => {
    const broken = { getContext: (): null => null } as unknown as HTMLCanvasElement;
    expect(() =>
      createSurface(broken, { onResize: (): void => undefined, autoObserve: false }),
    ).toThrow(/2d context/);
  });

  it('disposes without a ResizeObserver present', () => {
    const canvas = new FakeCanvas();
    const surface = createSurface(canvas.asCanvas(), { onResize: (): void => undefined });
    expect(() => {
      surface.dispose();
    }).not.toThrow();
  });
});
