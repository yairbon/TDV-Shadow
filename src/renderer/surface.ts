/**
 * The one and only place device pixels exist.
 *
 * RENDER_ALGORITHMS §1, applied exactly once per canvas:
 *
 *     canvas.width  = round(cssW * dpr)
 *     canvas.height = round(cssH * dpr)
 *     ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
 *
 * After that call every coordinate in the renderer is a CSS pixel and `dpr` appears
 * nowhere else in the codebase.
 *
 * The `<canvas>` elements are built and sized by `src/ui/` and handed in here; this
 * module owns the backing store and the transform, never the element's box. The CSS
 * box is whatever the UI layout gives it, and `ResizeObserver` reports that box back
 * in CSS pixels — which is why nothing here needs to touch element styling.
 */

export interface SurfaceOptions {
  /**
   * Called after the backing store has been re-sized. Wire this to
   * `scheduler.invalidate(DirtyFlags.All)` — never draw from it (mandate #3).
   */
  readonly onResize: (cssWidth: number, cssHeight: number) => void;
  /** Observe the element's content box. Default true; pass false in tests. */
  readonly autoObserve?: boolean;
}

export interface Surface {
  readonly ctx: CanvasRenderingContext2D;
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Device pixel ratio the current backing store was built for. */
  readonly ratio: number;
  /** Applies §1. Returns true when the backing store or the ratio actually changed. */
  resize(cssWidth: number, cssHeight: number): boolean;
  /** Re-applies §1 for the current size — use after a ratio change. */
  sync(): boolean;
  /** Clears the whole layer in CSS-pixel space (SKILL rule 2). */
  clear(): void;
  dispose(): void;
}

interface GlobalWithRatio {
  readonly devicePixelRatio?: number;
}

function currentRatio(): number {
  const g: GlobalWithRatio = globalThis;
  const ratio = g.devicePixelRatio;
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

class CanvasSurface implements Surface {
  readonly ctx: CanvasRenderingContext2D;

  readonly #canvas: HTMLCanvasElement;
  readonly #onResize: (cssWidth: number, cssHeight: number) => void;
  #cssWidth = 0;
  #cssHeight = 0;
  #ratio = 0;
  #observer: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, options: SurfaceOptions) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('surface: 2d context unavailable');
    }
    this.#canvas = canvas;
    this.ctx = ctx;
    this.#onResize = options.onResize;
  }

  get cssWidth(): number {
    return this.#cssWidth;
  }

  get cssHeight(): number {
    return this.#cssHeight;
  }

  get ratio(): number {
    return this.#ratio;
  }

  resize(cssWidth: number, cssHeight: number): boolean {
    const w = Math.max(0, cssWidth);
    const h = Math.max(0, cssHeight);
    const dpr = currentRatio();

    // §1 — the only multiplication by the device pixel ratio in the project.
    const backingWidth = Math.round(w * dpr);
    const backingHeight = Math.round(h * dpr);

    const unchanged =
      this.#ratio === dpr &&
      this.#cssWidth === w &&
      this.#cssHeight === h &&
      this.#canvas.width === backingWidth &&
      this.#canvas.height === backingHeight;
    if (unchanged) return false;

    this.#cssWidth = w;
    this.#cssHeight = h;
    this.#ratio = dpr;
    // Assigning either dimension resets the context state, so the transform is
    // re-applied immediately afterwards and never anywhere else.
    this.#canvas.width = backingWidth;
    this.#canvas.height = backingHeight;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  sync(): boolean {
    return this.resize(this.#cssWidth, this.#cssHeight);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.#cssWidth, this.#cssHeight);
  }

  observe(): void {
    if (this.#observer !== null) return;
    const host: { ResizeObserver?: typeof ResizeObserver } = globalThis;
    const Observer = host.ResizeObserver;
    if (Observer === undefined) return; // non-DOM host (unit tests): nothing to observe
    const observer = new Observer((entries: readonly ResizeObserverEntry[]): void => {
      for (const entry of entries) {
        const box = entry.contentRect;
        if (this.resize(box.width, box.height)) {
          this.#onResize(box.width, box.height);
        }
      }
    });
    observer.observe(this.#canvas);
    this.#observer = observer;
  }

  dispose(): void {
    if (this.#observer !== null) {
      this.#observer.disconnect();
      this.#observer = null;
    }
  }
}

/**
 * Wraps an existing canvas element. The element itself comes from `src/ui/` —
 * mandate #1 keeps element construction out of the renderer entirely.
 */
export function createSurface(canvas: HTMLCanvasElement, options: SurfaceOptions): Surface {
  const surface = new CanvasSurface(canvas, options);
  if (options.autoObserve !== false) surface.observe();
  return surface;
}
