import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  layoutFromTheme,
  makeRect,
  rectBottom,
  rectContains,
  rectRight,
  dividerAt,
  DIVIDER_TOLERANCE,
  resizePane,
  PANE_MAX_FRACTION,
  PANE_MIN_HEIGHT,
  type Layout,
  type LayoutOptions,
  type Rect,
} from '../../../src/renderer/layout.js';
import { DARK_THEME } from '../../../src/renderer/theme.js';

const base: LayoutOptions = {
  width: 800,
  height: 600,
  priceGutterWidth: 64,
  timeGutterHeight: 24,
  volumePaneFraction: 0.2,
  paneGap: 6,
  minPlotHeight: 80,
};

describe('layout', () => {
  it('reserves the gutters and gives the rest to the panes', () => {
    const layout = computeLayout(base);
    expect(rectRight(layout.content)).toBe(800 - 64);
    expect(rectBottom(layout.content)).toBe(600 - 24);
    expect(layout.priceGutter.left).toBe(rectRight(layout.content));
    expect(layout.priceGutter.width).toBe(64);
    expect(layout.timeGutter.top).toBe(rectBottom(layout.content));
    expect(layout.timeGutter.height).toBe(24);
  });

  it('stacks plot and volume without overlap and without a gap leak', () => {
    const layout = computeLayout(base);
    const volume = layout.volume;
    expect(volume).not.toBeNull();
    if (volume === null) return;
    expect(volume.height).toBe(Math.round(576 * 0.2));
    expect(volume.top).toBe(rectBottom(layout.plot) + 6);
    expect(rectBottom(volume)).toBe(rectBottom(layout.content));
    expect(layout.plot.width).toBe(volume.width);
  });

  it('drops the volume pane rather than squeezing the plot', () => {
    const layout = computeLayout({ ...base, height: 130 });
    expect(layout.volume).toBeNull();
    expect(layout.plot.height).toBe(130 - 24);
  });

  it('drops the volume pane when the fraction is zero', () => {
    expect(computeLayout({ ...base, volumePaneFraction: 0 }).volume).toBeNull();
    expect(layoutFromTheme(800, 600, DARK_THEME, false).volume).toBeNull();
    expect(layoutFromTheme(800, 600, DARK_THEME, true).volume).not.toBeNull();
  });

  it('keeps every boundary on a whole CSS pixel', () => {
    for (const [w, h] of [
      [801.4, 600.6],
      [1_279.5, 719.5],
      [640.2, 480.7],
    ]) {
      const layout = computeLayout({ ...base, width: w, height: h });
      for (const r of [layout.viewport, layout.content, layout.plot, layout.priceGutter, layout.timeGutter]) {
        expect(Number.isInteger(r.left)).toBe(true);
        expect(Number.isInteger(r.top)).toBe(true);
        expect(Number.isInteger(r.width)).toBe(true);
        expect(Number.isInteger(r.height)).toBe(true);
      }
    }
  });

  it('degrades to empty rects instead of negative ones on a tiny viewport', () => {
    const layout = computeLayout({ ...base, width: 20, height: 10 });
    for (const r of [layout.content, layout.plot, layout.priceGutter, layout.timeGutter]) {
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
    }
  });

  it('tests point containment on the closed rect', () => {
    const r = makeRect(10, 20, 100, 50);
    expect(rectContains(r, 10, 20)).toBe(true);
    expect(rectContains(r, 110, 70)).toBe(true);
    expect(rectContains(r, 9.9, 40)).toBe(false);
    expect(rectContains(r, 50, 70.1)).toBe(false);
  });
});

/** The panes below the plot, top to bottom — the order `paneFractions` indexes. */
function stackOf(layout: Layout): Rect[] {
  return layout.volume === null ? [...layout.panes] : [layout.volume, ...layout.panes];
}

function heightsOf(layout: Layout): number[] {
  return stackOf(layout).map((r) => r.height);
}

/**
 * Rects tile the content box exactly: same x extent, no overlap, no gap leak past the
 * bottom, whole pixels throughout.
 */
function expectTilesContent(layout: Layout, gap: number): void {
  let previous = layout.plot;
  for (const rect of stackOf(layout)) {
    expect(rect.top).toBe(rectBottom(previous) + gap);
    expect(rect.left).toBe(layout.content.left);
    expect(rect.width).toBe(layout.content.width);
    expect(rect.height).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(rect.top)).toBe(true);
    expect(Number.isInteger(rect.height)).toBe(true);
    previous = rect;
  }
  expect(rectBottom(previous)).toBe(rectBottom(layout.content));
  expect(layout.plot.height).toBeGreaterThanOrEqual(0);
}

describe('layout — per-pane sizing', () => {
  // Captured from the implementation that predates `paneFractions`. These are the
  // numbers the screenshot baselines were taken against: they must not move.
  const legacy: readonly [Partial<LayoutOptions>, string][] = [
    [{}, '455|461,115|'],
    [{ extraPanes: 1 }, '357|363,115|484,92'],
    [{ extraPanes: 2 }, '259|265,115|386,92;484,92'],
    [{ extraPanes: 5 }, '161|167,115|288,92;386,92;484,92'],
    [{ volumePaneFraction: 0, extraPanes: 2 }, '380||386,92;484,92'],
    [{ width: 1280, height: 720, extraPanes: 3 }, '200|206,139|351,111;468,111;585,111'],
    [{ height: 260, extraPanes: 2 }, '95|101,47|154,38;198,38'],
    [{ height: 130, extraPanes: 1 }, '83||89,17'],
    [{ width: 20, height: 10, extraPanes: 2 }, '0||'],
    [{ width: 801.4, height: 600.6, extraPanes: 1 }, '358|364,115|485,92'],
  ];

  const describeLayout = (l: Layout): string =>
    [
      String(l.plot.height),
      l.volume === null ? '' : `${String(l.volume.top)},${String(l.volume.height)}`,
      l.panes.map((p) => `${String(p.top)},${String(p.height)}`).join(';'),
    ].join('|');

  it('is byte-identical to the pre-resize layout when paneFractions is absent', () => {
    for (const [patch, expected] of legacy) {
      expect(describeLayout(computeLayout({ ...base, ...patch }))).toBe(expected);
    }
  });

  it('honours a requested fraction when there is room', () => {
    const layout = computeLayout({ ...base, paneFractions: [0.35] });
    expect(heightsOf(layout)).toEqual([Math.round(576 * 0.35)]);
    expect(layout.plot.height).toBe(576 - 202 - 6);
    expectTilesContent(layout, 6);

    const two = computeLayout({ ...base, extraPanes: 2, paneFractions: [0.1, 0.3] });
    expect(heightsOf(two)).toEqual([58, 173, 92]); // third entry falls back to 0.16
    expect(two.plot.height).toBe(576 - (58 + 173 + 92) - 18);
    expectTilesContent(two, 6);
  });

  it('clamps each pane to the floor and the ceiling', () => {
    expect(heightsOf(computeLayout({ ...base, paneFractions: [0.01] }))).toEqual([
      PANE_MIN_HEIGHT,
    ]);
    expect(heightsOf(computeLayout({ ...base, paneFractions: [-4] }))).toEqual([PANE_MIN_HEIGHT]);
    const tall = computeLayout({ ...base, paneFractions: [0.95] });
    expect(heightsOf(tall)).toEqual([Math.floor(576 * PANE_MAX_FRACTION)]);
    // The ceiling, not minPlotHeight, is what bit here: the plot still has slack.
    expect(tall.plot.height).toBeGreaterThan(base.minPlotHeight);
  });

  it('scales an oversized stack down together instead of dropping a pane', () => {
    const layout = computeLayout({ ...base, extraPanes: 2, paneFractions: [0.8, 0.8, 0.8] });
    const heights = heightsOf(layout);
    expect(heights).toHaveLength(3);
    expect(layout.plot.height).toBe(base.minPlotHeight);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(PANE_MIN_HEIGHT);
    // Shrunk in proportion, so they stay within a pixel of each other.
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    expectTilesContent(layout, 6);
  });

  it('never lets the plot fall below minPlotHeight', () => {
    for (const extraPanes of [0, 1, 3, 8]) {
      for (const f of [0.5, 0.8, 2]) {
        const fractions = Array.from({ length: extraPanes + 1 }, () => f);
        const layout = computeLayout({ ...base, extraPanes, paneFractions: fractions });
        expect(layout.plot.height).toBeGreaterThanOrEqual(base.minPlotHeight);
        expectTilesContent(layout, 6);
      }
    }
  });

  it('drops from the bottom only when the floor itself no longer fits', () => {
    const layout = computeLayout({ ...base, extraPanes: 20, paneFractions: [] });
    const heights = heightsOf(layout);
    // 576 content, 80 plot floor, 6px gaps: 16 panes at 24px is the most that fits. The
    // survivors are the TOP 16 slots — the volume pane (0.2 of the box, so the tallest
    // before shrinking) is still there, and the leftover pixels go to the top.
    expect(layout.volume).not.toBeNull();
    expect(heights).toEqual([26, ...Array.from({ length: 14 }, () => 25), 24]);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(PANE_MIN_HEIGHT);
    expect(layout.plot.height).toBe(base.minPlotHeight);
    expectTilesContent(layout, 6);
  });

  it('handles zero panes, one pane, and a stack with no room at all', () => {
    const none = computeLayout({ ...base, volumePaneFraction: 0, paneFractions: [0.3, 0.3] });
    expect(stackOf(none)).toHaveLength(0);
    expect(none.plot.height).toBe(576);

    const one = computeLayout({ ...base, volumePaneFraction: 0, extraPanes: 1, paneFractions: [0.25] });
    expect(heightsOf(one)).toEqual([144]);

    // 106px of content cannot hold an 80px plot plus a 24px pane and a 6px gap.
    const squeezed = computeLayout({ ...base, height: 130, extraPanes: 1, paneFractions: [0.2, 0.2] });
    expect(stackOf(squeezed)).toHaveLength(0);
    expect(squeezed.plot.height).toBe(106);
    expectTilesContent(squeezed, 6);
  });

  it('keeps panes non-overlapping and inside the content box across a spread of inputs', () => {
    const sizes = [
      [800, 600],
      [1280, 720],
      [640, 300],
      [400, 180],
      [300, 120],
    ];
    const stacks: (readonly number[] | undefined)[] = [
      undefined,
      [],
      [0.05],
      [0.5, 0.5],
      [0.9, 0.02, 0.4],
      [Number.NaN, 0.3],
      [0.25, 0.25, 0.25, 0.25],
    ];
    for (const [width, height] of sizes) {
      for (const extraPanes of [0, 1, 3]) {
        for (const paneFractions of stacks) {
          for (const gap of [0, 6, 11]) {
            const o: LayoutOptions = {
              ...base,
              width,
              height,
              paneGap: gap,
              extraPanes,
              ...(paneFractions === undefined ? {} : { paneFractions }),
            };
            const layout = computeLayout(o);
            expectTilesContent(layout, gap);
            expect(rectBottom(layout.content)).toBeLessThanOrEqual(rectBottom(layout.viewport));
            if (stackOf(layout).length > 0 && paneFractions !== undefined) {
              expect(layout.plot.height).toBeGreaterThanOrEqual(base.minPlotHeight);
            }
          }
        }
      }
    }
  });
});

/** The y each divider should report: mid-gap between a pane and whatever is above it. */
function dividerLines(layout: Layout, gap: number): number[] {
  let above = layout.plot;
  const lines: number[] = [];
  for (const pane of stackOf(layout)) {
    lines.push(rectBottom(above) + gap / 2);
    above = pane;
  }
  return lines;
}

describe('layout — dividerAt', () => {
  const threePane: LayoutOptions = { ...base, extraPanes: 2 };

  it('finds every divider, mid-gap, top to bottom', () => {
    const layout = computeLayout(threePane);
    const lines = dividerLines(layout, 6);
    expect(lines).toEqual([262, 383, 481]);
    lines.forEach((line, index) => {
      expect(dividerAt(layout, line)).toEqual({ index, y: line });
    });
  });

  it('reaches exactly `tolerance` px and no further', () => {
    const layout = computeLayout(threePane);
    const line = dividerLines(layout, 6)[1];
    for (const offset of [-DIVIDER_TOLERANCE, DIVIDER_TOLERANCE]) {
      expect(dividerAt(layout, line + offset)).toEqual({ index: 1, y: line });
    }
    for (const offset of [-DIVIDER_TOLERANCE - 0.01, DIVIDER_TOLERANCE + 0.01]) {
      expect(dividerAt(layout, line + offset)).toBeNull();
    }
    expect(dividerAt(layout, line, 0)).toEqual({ index: 1, y: line });
    expect(dividerAt(layout, line + 1, 0)).toBeNull();
    // A wider grab radius reaches further, and still reports the divider it caught.
    const last = dividerLines(layout, 6)[2];
    expect(dividerAt(layout, last - 11)).toBeNull();
    expect(dividerAt(layout, last - 11, 20)).toEqual({ index: 2, y: last });
  });

  it('returns null inside a pane, in the gutters, and when nothing is stacked', () => {
    const layout = computeLayout(threePane);
    for (const y of [0, 120, 320, 430, 540, rectBottom(layout.content) + 10]) {
      expect(dividerAt(layout, y)).toBeNull();
    }
    const bare = computeLayout({ ...base, volumePaneFraction: 0 });
    expect(stackOf(bare)).toHaveLength(0);
    for (const y of [0, 100, 300, 576]) expect(dividerAt(bare, y)).toBeNull();
  });

  it('picks the nearer divider when two are within tolerance', () => {
    const layout = computeLayout({ ...base, extraPanes: 1, paneFractions: [0.01, 0.01] });
    const [first, second] = dividerLines(layout, 6);
    expect(second - first).toBe(PANE_MIN_HEIGHT + 6);
    expect(dividerAt(layout, first + 12, 20)).toEqual({ index: 0, y: first });
    expect(dividerAt(layout, first + 18, 20)).toEqual({ index: 1, y: second });
    // Dead centre between the two: the upper one wins, deterministically.
    expect(dividerAt(layout, (first + second) / 2, 20)).toEqual({ index: 0, y: first });
  });
});

/** One drag: new fractions, and the layout they produce. */
function drag(
  options: LayoutOptions,
  layout: Layout,
  index: number,
  y: number,
): { fractions: readonly number[]; layout: Layout } {
  const fractions = resizePane(layout, options, index, y);
  return { fractions, layout: computeLayout({ ...options, paneFractions: fractions }) };
}

describe('layout — resizePane', () => {
  const threePane: LayoutOptions = { ...base, extraPanes: 2 };

  it('puts the divider where it was dragged and leaves the rest of the stack alone', () => {
    const start = computeLayout(threePane);
    expect([start.plot.height, ...heightsOf(start)]).toEqual([259, 115, 92, 92]);

    // Divider 0 up 100px: the plot gives, the volume pane takes, indicators hold still.
    const up = drag(threePane, start, 0, 162);
    expect(heightsOf(up.layout)).toEqual([215, 92, 92]);
    expect(up.layout.plot.height).toBe(159);
    expect(dividerAt(up.layout, 162)).toEqual({ index: 0, y: 162 });

    // Divider 1 down 50px: only the two panes it splits move; the plot is untouched.
    const down = drag(threePane, start, 1, 433);
    expect(down.layout.plot.height).toBe(259);
    expect(heightsOf(down.layout)).toEqual([165, 42, 92]);
    expect(dividerAt(down.layout, 433)).toEqual({ index: 1, y: 433 });
    expect(dividerAt(down.layout, 481)).toEqual({ index: 2, y: 481 });
  });

  it('is reversible: drag away and back restores the original fractions', () => {
    const start = computeLayout(threePane);
    const home = [0, 1, 2].map((i) => dividerAt(start, dividerLines(start, 6)[i]));
    for (const divider of home) {
      expect(divider).not.toBeNull();
      if (divider === null) return;
      for (const delta of [-77, -13, 5, 60]) {
        const moved = drag(threePane, start, divider.index, divider.y + delta);
        expect(moved.layout.content.height).toBe(start.content.height);
        expect(moved.fractions).not.toEqual([115 / 576, 92 / 576, 92 / 576]);
        // Dragging the divider back to where it started undoes the move exactly, even
        // when the outward drag was clamped.
        const back = resizePane(moved.layout, threePane, divider.index, divider.y);
        expect([...back]).toEqual([115 / 576, 92 / 576, 92 / 576]);
        expect(JSON.stringify(computeLayout({ ...threePane, paneFractions: back }))).toBe(
          JSON.stringify(start),
        );
      }
    }
  });

  it('clamps instead of inverting when dragged past the bottom limit', () => {
    const start = computeLayout(threePane);
    for (const y of [600, 5_000]) {
      const pushed = drag(threePane, start, 0, y);
      expect(heightsOf(pushed.layout)).toEqual([PANE_MIN_HEIGHT, 92, 92]);
      expect(pushed.layout.plot.height).toBe(576 - 24 - 92 - 92 - 18);
      expectTilesContent(pushed.layout, 6);
    }
    const middle = drag(threePane, start, 1, 5_000);
    expect(heightsOf(middle.layout)).toEqual([207 - PANE_MIN_HEIGHT, PANE_MIN_HEIGHT, 92]);
    expect(middle.layout.plot.height).toBe(259);
    expectTilesContent(middle.layout, 6);
  });

  it('clamps instead of inverting when dragged past the top limit', () => {
    const start = computeLayout(threePane);
    // Divider 0 stops where the price plot hits minPlotHeight.
    const top = drag(threePane, start, 0, -5_000);
    expect(top.layout.plot.height).toBe(base.minPlotHeight);
    expect(heightsOf(top.layout)).toEqual([294, 92, 92]);
    expectTilesContent(top.layout, 6);

    // Divider 1 stops where the pane above it would breach PANE_MIN_HEIGHT.
    const middle = drag(threePane, start, 1, -5_000);
    expect(heightsOf(middle.layout)).toEqual([PANE_MIN_HEIGHT, 207 - PANE_MIN_HEIGHT, 92]);
    expect(middle.layout.plot.height).toBe(259);
  });

  it('stops the upper pane at the ceiling, not only at the plot floor', () => {
    // 1076px of content: two panes can share 984px, so the 80% ceiling bites first.
    const tall: LayoutOptions = { ...base, height: 1_100, extraPanes: 1, paneFractions: [0.5, 0.5] };
    const start = computeLayout(tall);
    expect(heightsOf(start)).toEqual([492, 492]);
    expect(start.plot.height).toBe(base.minPlotHeight);

    const pushed = drag(tall, start, 1, 5_000);
    expect(heightsOf(pushed.layout)).toEqual([Math.floor(1_076 * PANE_MAX_FRACTION), 124]);
    expect(pushed.layout.plot.height).toBe(base.minPlotHeight);
    expectTilesContent(pushed.layout, 6);
  });

  it('returns the current fractions unchanged for an index with no divider', () => {
    const start = computeLayout(threePane);
    const current = [115 / 576, 92 / 576, 92 / 576];
    for (const index of [-1, 3, 99]) {
      expect([...resizePane(start, threePane, index, 300)]).toEqual(current);
    }
    const bare = computeLayout({ ...base, volumePaneFraction: 0 });
    expect([...resizePane(bare, base, 0, 300)]).toEqual([]);
    expect(Object.isFrozen(resizePane(start, threePane, 0, 300))).toBe(true);
  });

  it('returns finite fractions for a collapsed content box', () => {
    // A window collapsed to nothing mid-drag: the divide-by-zero must not leak out.
    const empty = computeLayout({ ...base, width: 20, height: 10 });
    const collapsed: Layout = { ...empty, volume: makeRect(0, 0, 0, 10), panes: [] };
    expect(collapsed.content.height).toBe(0);
    for (const f of resizePane(collapsed, base, 0, 5)) expect(Number.isFinite(f)).toBe(true);
    expect([...resizePane(collapsed, base, 0, 5)]).toEqual([0]);
  });

  it('never produces a stack that computeLayout has to re-clamp', () => {
    const start = computeLayout(threePane);
    for (let index = 0; index < 3; index++) {
      for (let y = -40; y <= 640; y += 7) {
        const after = drag(threePane, start, index, y);
        expectTilesContent(after.layout, 6);
        expect(heightsOf(after.layout)).toHaveLength(3);
        expect(after.layout.plot.height).toBeGreaterThanOrEqual(base.minPlotHeight);
        for (const h of heightsOf(after.layout)) expect(h).toBeGreaterThanOrEqual(PANE_MIN_HEIGHT);
        // The fractions describe exactly the pixels that came back.
        expect(after.fractions.map((f) => Math.round(f * 576))).toEqual(heightsOf(after.layout));
      }
    }
  });
});
