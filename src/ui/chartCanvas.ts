/**
 * The ONLY place canvas elements are constructed. Root mandate #1 allows DOM here:
 * these are the `<canvas>` elements themselves, not chart primitives. Everything
 * drawn *inside* them is Canvas 2D, produced by src/renderer.
 *
 * Four stacked layers, back to front: grid, series, overlay, crosshair. Stacking
 * lets a pointer move repaint only the crosshair.
 */

const LAYER_NAMES = ['grid', 'series', 'overlay', 'crosshair'] as const;

export type LayerName = (typeof LAYER_NAMES)[number];

export interface ChartCanvases {
  readonly container: HTMLElement;
  readonly canvases: Readonly<Record<LayerName, HTMLCanvasElement>>;
  /** The element that receives pointer events — the topmost layer. */
  readonly hitTarget: HTMLElement;
  dispose(): void;
}

export function createChartCanvases(container: HTMLElement): ChartCanvases {
  container.style.position = 'relative';
  container.style.overflow = 'hidden';

  const entries = LAYER_NAMES.map((name, i) => {
    const canvas = document.createElement('canvas');
    canvas.dataset['layer'] = name;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    // Pin the CSS box to the container. Without this the element falls back to its
    // intrinsic size — the `width`/`height` ATTRIBUTES, which are in DEVICE pixels —
    // so a ResizeObserver would read back cssSize * dpr and the layer would double on
    // every frame (1280 -> 2560 -> 5120 …). The attribute is the backing store; the
    // style is the display box, and they must be set independently.
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = String(i + 1);
    // Only the top layer takes pointer events; the rest are inert.
    canvas.style.pointerEvents = name === 'crosshair' ? 'auto' : 'none';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    return [name, canvas] as const;
  });

  const canvases = Object.fromEntries(entries) as Record<LayerName, HTMLCanvasElement>;

  return {
    container,
    canvases,
    hitTarget: canvases.crosshair,
    dispose(): void {
      for (const [, canvas] of entries) canvas.remove();
    },
  };
}
