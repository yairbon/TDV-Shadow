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

  // Touch needs its own gesture state: phones have no wheel, so pinch IS the zoom.
  // Active pointers are tracked by id because a two-finger gesture delivers two
  // independent streams, and pinch distance is only meaningful across both.
  const active = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let pinchCentre = 0;

  const localPoint = (e: MouseEvent): { x: number; y: number } => {
    const rect = o.target.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const distanceBetween = (): number => {
    const points = [...active.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  };

  const centreOf = (): number => {
    const points = [...active.values()];
    if (points.length < 2) return 0;
    return (points[0].x + points[1].x) / 2;
  };

  const onPointerDown = (e: PointerEvent): void => {
    const p = localPoint(e);
    active.set(e.pointerId, p);

    if (active.size === 2) {
      // Second finger down: stop panning and start pinching, or the chart lurches as
      // the two gestures fight over scrollPosition.
      dragging = false;
      pinchDistance = distanceBetween();
      pinchCentre = centreOf();
      return;
    }

    dragging = true;
    lastX = p.x;
    // Capture is best-effort: the browser throws if the pointer is already gone (a
    // fast tap, a synthetic event), and losing capture is not worth losing the drag.
    try {
      o.target.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const p = localPoint(e);
    if (active.has(e.pointerId)) active.set(e.pointerId, p);
    pointer = { x: p.x, y: p.y };

    if (active.size >= 2) {
      const distance = distanceBetween();
      if (pinchDistance > 0 && distance > 0) {
        const view = o.view.get();
        const scale = makeTimeScale(view.scrollPosition, view.barSpacing, o.plot());
        // Zoom about the midpoint between the fingers, so the chart grows out of the
        // gesture rather than out of the plot's right edge.
        const next = zoomAbout(scale, asPixel(pinchCentre), distance / pinchDistance);
        if (o.view.update(next)) o.onViewChange();
      }
      pinchDistance = distance;
      pinchCentre = centreOf();
      o.onPointerChange();
      return;
    }

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
    active.delete(e.pointerId);
    if (active.size < 2) pinchDistance = 0;
    // Lifting one finger of a pinch must not resume a pan mid-gesture: the remaining
    // finger has moved far from `lastX`, which would jump the chart.
    dragging = false;
    try {
      if (o.target.hasPointerCapture(e.pointerId)) o.target.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
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
