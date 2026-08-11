/**
 * Pointer input -> viewStore. Never draws (root mandate #3): every handler mutates
 * view state and calls `invalidate`, and the scheduler owns the single rAF.
 */

import type { ViewStore } from '../data/store/viewStore.js';
import { asPixel } from '../data/types.js';
import type { PointerState } from '../renderer/frame.js';
import { makeTimeScale, panBy, zoomAbout } from '../renderer/scale/timeScale.js';
import type { Rect } from '../renderer/layout.js';

export interface PointerBindings {
  /** Latest pointer position in CSS px, or null when outside the plot. */
  pointer(): PointerState | null;
  dispose(): void;
}

export interface PointerOptions {
  readonly target: HTMLElement;
  readonly view: ViewStore;
  /** Current plot rect — read lazily, since layout changes on resize. */
  readonly plot: () => Rect;
  readonly onViewChange: () => void;
  readonly onPointerChange: () => void;
}

const ZOOM_PER_WHEEL_LINE = 1.1;

export function bindPointer(o: PointerOptions): PointerBindings {
  let pointer: PointerState | null = null;
  let dragging = false;
  let lastX = 0;

  const localPoint = (e: MouseEvent): { x: number; y: number } => {
    const rect = o.target.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: PointerEvent): void => {
    dragging = true;
    lastX = localPoint(e).x;
    o.target.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent): void => {
    const p = localPoint(e);
    pointer = { x: p.x, y: p.y };

    if (dragging) {
      const dx = p.x - lastX;
      lastX = p.x;
      if (dx !== 0) {
        const view = o.view.get();
        const scale = makeTimeScale(view.scrollPosition, view.barSpacing, o.plot());
        const next = panBy(scale, dx);
        if (o.view.update(next)) o.onViewChange();
      }
    }
    o.onPointerChange();
  };

  const endDrag = (e: PointerEvent): void => {
    dragging = false;
    if (o.target.hasPointerCapture(e.pointerId)) o.target.releasePointerCapture(e.pointerId);
  };

  const onPointerLeave = (): void => {
    pointer = null;
    o.onPointerChange();
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const view = o.view.get();
    const scale = makeTimeScale(view.scrollPosition, view.barSpacing, o.plot());
    // Wheel up (deltaY < 0) zooms in.
    const factor = e.deltaY < 0 ? ZOOM_PER_WHEEL_LINE : 1 / ZOOM_PER_WHEEL_LINE;
    const anchor = asPixel(localPoint(e).x);
    const next = zoomAbout(scale, anchor, factor);
    if (o.view.update(next)) o.onViewChange();
  };

  o.target.addEventListener('pointerdown', onPointerDown);
  o.target.addEventListener('pointermove', onPointerMove);
  o.target.addEventListener('pointerup', endDrag);
  o.target.addEventListener('pointercancel', endDrag);
  o.target.addEventListener('pointerleave', onPointerLeave);
  o.target.addEventListener('wheel', onWheel, { passive: false });

  return {
    pointer: () => pointer,
    dispose(): void {
      o.target.removeEventListener('pointerdown', onPointerDown);
      o.target.removeEventListener('pointermove', onPointerMove);
      o.target.removeEventListener('pointerup', endDrag);
      o.target.removeEventListener('pointercancel', endDrag);
      o.target.removeEventListener('pointerleave', onPointerLeave);
      o.target.removeEventListener('wheel', onWheel);
    },
  };
}
