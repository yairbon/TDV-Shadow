/**
 * Wiring test for the single draw entrypoint: the dirty mask decides which layers
 * repaint, and a pointer move must not repaint candles.
 */

import { describe, expect, it } from 'vitest';
import { buildFrameInput, type FrameInput } from '../../../src/renderer/frame.js';
import { createChartRenderer, type LayerContexts } from '../../../src/renderer/index.js';
import { createScheduler, DirtyFlags, type DirtyMask } from '../../../src/renderer/scheduler.js';
import { FakeContext } from './fakeCanvas.js';
import { makeBars, makeSnapshot, TEST_THEME, testLayout } from './fixtures.js';

interface Harness {
  readonly contexts: LayerContexts;
  readonly grid: FakeContext;
  readonly series: FakeContext;
  readonly overlay: FakeContext;
  readonly crosshair: FakeContext;
}

function harness(): Harness {
  const grid = new FakeContext();
  const series = new FakeContext();
  const overlay = new FakeContext();
  const crosshair = new FakeContext();
  return {
    grid,
    series,
    overlay,
    crosshair,
    contexts: {
      grid: grid.asContext(),
      series: series.asContext(),
      overlay: overlay.asContext(),
      crosshair: crosshair.asContext(),
    },
  };
}

function frame(): FrameInput {
  return buildFrameInput({
    snapshot: makeSnapshot({ bars: makeBars(300), barSpacing: 9 }),
    layout: testLayout(),
    theme: TEST_THEME,
    pricePrecision: 2,
    overlays: [],
    pointer: { x: 300, y: 200 },
    priceRange: null,
  });
}

describe('chart renderer', () => {
  it('repaints only the layers named in the mask', () => {
    const h = harness();
    createChartRenderer().render(DirtyFlags.Crosshair, h.contexts, frame());
    expect(h.crosshair.calls.length).toBeGreaterThan(0);
    expect(h.grid.calls).toHaveLength(0);
    expect(h.series.calls).toHaveLength(0);
    expect(h.overlay.calls).toHaveLength(0);
  });

  it('repaints everything for DirtyFlags.All', () => {
    const h = harness();
    createChartRenderer().render(DirtyFlags.All, h.contexts, frame());
    for (const ctx of [h.grid, h.series, h.overlay, h.crosshair]) {
      expect(ctx.calls[0].op).toBe('clearRect');
    }
  });

  it('drives one frame per rAF through the scheduler', () => {
    const h = harness();
    const renderer = createChartRenderer();
    const input = frame();
    const queued: FrameRequestCallback[] = [];
    const scheduler = createScheduler({
      frame: (mask: DirtyMask): void => {
        renderer.render(mask, h.contexts, input);
      },
      requestFrame: (callback: FrameRequestCallback): number => {
        queued.push(callback);
        return queued.length;
      },
      cancelFrame: (): void => undefined,
    });

    scheduler.invalidate(DirtyFlags.Series);
    scheduler.invalidate(DirtyFlags.Grid);
    expect(h.series.calls).toHaveLength(0); // events never draw
    expect(queued).toHaveLength(1);

    queued[0](0);

    expect(h.series.calls.length).toBeGreaterThan(0);
    expect(h.grid.calls.length).toBeGreaterThan(0);
    expect(h.crosshair.calls).toHaveLength(0);
  });
});
