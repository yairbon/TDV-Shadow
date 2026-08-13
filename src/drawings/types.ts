/**
 * FROZEN CONTRACT — drawing tools (Phase 5, workstream E).
 *
 * THE ANCHOR RULE, which every tool obeys and every test checks:
 * a drawing is stored in DATA space — `{ barIndex, price }` — never in pixels. Pixels
 * are derived each frame through the same §5/§2 transforms the candles use. Store a
 * pixel and the drawing detaches from the chart the moment anyone pans, zooms, resizes,
 * or switches to log scale. Every anchor round-trips: `X(anchor.barIndex)` and
 * `Y(anchor.price)` must land on the same candle at any zoom level.
 *
 * Magnet snapping resolves against the OHLC of the bar under the cursor, so an anchor
 * placed with magnet on is exactly a wick tip or body edge — not "close to" one.
 */

import type { Bar } from '../data/types.js';

export const DRAWING_KINDS = [
  'trendline',
  'ray',
  'extended-line',
  'horizontal-line',
  'vertical-line',
  'rectangle',
  'ellipse',
  'fib-retracement',
  'fib-extension',
  'fib-fan',
  'fib-time-zones',
  'gann-fan',
  'gann-box',
  'elliott-impulse',
  'elliott-correction',
  'pitchfork',
  'long-position',
  'short-position',
  'text-note',
  'arrow',
  'horizontal-ray',
  'parallel-channel',
  'price-range',
  'date-range',
  'date-price-range',
  'trend-angle',
  'polyline',
  'callout',
] as const;

export type DrawingKind = (typeof DRAWING_KINDS)[number];

/** A point in DATA space. Never pixels. `barIndex` may be fractional between bars. */
export interface Anchor {
  readonly barIndex: number;
  readonly price: number;
}

export type MagnetMode = 'off' | 'weak' | 'strong';

/** Which part of a bar an anchor snapped to; null when magnet was off. */
export type MagnetTarget = 'open' | 'high' | 'low' | 'close' | null;

export interface DrawingStyle {
  readonly colorToken: string;
  /**
   * Explicit CSS colour chosen by the user. Wins over `colorToken` when present.
   *
   * Additive to the contract rather than a redefinition: a drawing without it resolves
   * through `colorToken` exactly as before, so every saved drawing and every test that
   * predates the style editor is unaffected. It exists because a token set can only offer
   * the theme's colours, and picking any colour is the whole point of a style editor.
   */
  readonly color?: string;
  readonly lineWidth: number;
  readonly dash: readonly number[];
  readonly opacity: number;
  readonly showLabels: boolean;
}

export interface Drawing {
  readonly id: string;
  readonly kind: DrawingKind;
  /** Tool-specific arity: 1 for horizontal lines, 2 for trendlines, 3 for pitchforks. */
  readonly anchors: readonly Anchor[];
  readonly style: DrawingStyle;
  readonly locked: boolean;
  readonly visible: boolean;
  /** Fib levels / Gann ratios / Elliott degree, per tool. */
  readonly params: Readonly<Record<string, number | string | boolean>>;
  /** Recorded per anchor when placed with magnet on — for tests and round-tripping. */
  readonly magnetTargets: readonly MagnetTarget[];
}

/** Classic Fibonacci retracement levels. Extensions add 1.272 / 1.618 / 2.618. */
export const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const FIB_EXTENSION_LEVELS = [1, 1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236] as const;
/** Gann's canonical angle set, expressed as price-units per bar multipliers. */
export const GANN_RATIOS = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8] as const;
/** Elliott impulse is 5 waves; correction is 3. */
export const ELLIOTT_IMPULSE_LABELS = ['1', '2', '3', '4', '5'] as const;
export const ELLIOTT_CORRECTION_LABELS = ['A', 'B', 'C'] as const;

export interface ToolDefinition {
  readonly kind: DrawingKind;
  readonly label: string;
  /** Anchors placement collects before finishing on its own. */
  readonly anchorCount: number;
  /**
   * Fewest anchors that still make a complete drawing, when the tool can be finished
   * early. Defaults to `anchorCount`, which is every tool but the polyline: a path is a
   * path at three points as much as at eight, and forcing eight clicks to draw a
   * four-legged one is the sort of thing that makes a tool go unused.
   */
  readonly minAnchorCount?: number;
  readonly defaults: Drawing['params'];
}

/**
 * Snaps a price to the nearest OHLC value of `bar`.
 *
 * `strong` always snaps to the closest of the four. `weak` snaps only inside
 * `thresholdPrice`, so a deliberate placement away from the bar is respected. Returning
 * the target alongside the price lets tests assert a wick tip was hit exactly, rather
 * than checking it is merely nearby.
 */
export function snapToBar(
  price: number,
  bar: Bar,
  mode: MagnetMode,
  thresholdPrice: number,
): { readonly price: number; readonly target: MagnetTarget } {
  if (mode === 'off') return { price, target: null };

  const candidates: readonly { readonly value: number; readonly target: MagnetTarget }[] = [
    { value: bar.o, target: 'open' },
    { value: bar.h, target: 'high' },
    { value: bar.l, target: 'low' },
    { value: bar.c, target: 'close' },
  ];

  let best = candidates[0];
  let bestDistance = Math.abs(price - best.value);
  for (let i = 1; i < candidates.length; i++) {
    const distance = Math.abs(price - candidates[i].value);
    if (distance < bestDistance) {
      best = candidates[i];
      bestDistance = distance;
    }
  }

  if (mode === 'weak' && bestDistance > thresholdPrice) return { price, target: null };
  return { price: best.value, target: best.target };
}
