/**
 * Volume -> Y for the subpanel. RENDER_ALGORITHMS §9.
 *
 * A separate transform that shares the time scale; it lives in `scale/` with the
 * other transforms so no draw call ever inlines a re-derived formula (SKILL rule 10).
 */

import { asPixel, type Bar, type BarIndex, type Pixel } from '../../data/types.js';
import type { Rect } from '../layout.js';

export interface VolumeScale {
  /** `vMax` over the visible bars. Always > 0 — a zero max skips the pane. */
  readonly max: number;
  /** `V.t` */
  readonly top: Pixel;
  /** `V.h` */
  readonly height: Pixel;
  /** `Yv(v) = V.t + V.h - (v / vMax) * V.h` */
  y(v: number): Pixel;
}

/** §9: `vMax = max(volume[i])` over visible i. Returns 0 when there is nothing to draw. */
export function maxVolume(bars: readonly Bar[], from: BarIndex, to: BarIndex): number {
  let max = 0;
  for (let i: number = from; i <= to; i++) {
    const v = bars[i].v;
    if (v > max) max = v;
  }
  return max;
}

/** Returns null when `vMax <= 0` — §9 says to skip the pane rather than divide by it. */
export function makeVolumeScale(pane: Rect, vMax: number): VolumeScale | null {
  if (!(vMax > 0)) return null;
  const top: number = pane.top;
  const height: number = pane.height;
  const bottom = top + height;
  return Object.freeze({
    max: vMax,
    top: pane.top,
    height: pane.height,
    y: (v: number): Pixel => asPixel(bottom - (v / vMax) * height),
  });
}
