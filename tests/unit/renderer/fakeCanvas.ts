/**
 * A minimal recording CanvasRenderingContext2D.
 *
 * Layer geometry is asserted against the recorded call list — no real canvas, no
 * DOM, no screenshots. Pixel-level appearance is the job of the Playwright suite;
 * these tests prove the numbers that go into `fillRect`.
 */

export type RecordedOp =
  | 'clearRect'
  | 'fillRect'
  | 'fillText'
  | 'strokeRect'
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'rect'
  | 'clip'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'stroke'
  | 'fill'
  | 'setLineDash'
  | 'setTransform';

export interface RecordedCall {
  readonly op: RecordedOp;
  readonly args: readonly number[];
  readonly text: string;
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly lineWidth: number;
  readonly globalAlpha: number;
  /**
   * The alignment in force when the call was made. `fillText` places text relative to it,
   * so an x argument alone does not say where the glyphs land — a right-aligned label at
   * x=64 occupies the pixels a left-aligned one at x=64 leaves empty.
   */
  readonly textAlign: string;
}

interface SavedState {
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly lineWidth: number;
  readonly globalAlpha: number;
  readonly textAlign: string;
}

/** Width per character used by `measureText`; keeps label maths deterministic. */
export const FAKE_CHAR_WIDTH = 6;

export class FakeContext {
  readonly calls: RecordedCall[] = [];

  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  font = '';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  lineJoin = 'miter';
  lineCap = 'butt';

  readonly #stack: SavedState[] = [];

  #record(op: RecordedOp, args: readonly number[], text = ''): void {
    this.calls.push({
      op,
      args,
      text,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      textAlign: this.textAlign,
    });
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.#record('clearRect', [x, y, w, h]);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.#record('fillRect', [x, y, w, h]);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.#record('strokeRect', [x, y, w, h]);
  }

  fillText(text: string, x: number, y: number): void {
    this.#record('fillText', [x, y], text);
  }

  arc(x: number, y: number, radius: number, start: number, end: number): void {
    this.#record('arc', [x, y, radius, start, end]);
  }

  measureText(text: string): { width: number } {
    return { width: text.length * FAKE_CHAR_WIDTH };
  }

  save(): void {
    this.#stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      textAlign: this.textAlign,
    });
    this.#record('save', []);
  }

  restore(): void {
    const state = this.#stack.pop();
    if (state !== undefined) {
      this.fillStyle = state.fillStyle;
      this.strokeStyle = state.strokeStyle;
      this.lineWidth = state.lineWidth;
      this.globalAlpha = state.globalAlpha;
      this.textAlign = state.textAlign;
    }
    this.#record('restore', []);
  }

  beginPath(): void {
    this.#record('beginPath', []);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.#record('rect', [x, y, w, h]);
  }

  clip(): void {
    this.#record('clip', []);
  }

  moveTo(x: number, y: number): void {
    this.#record('moveTo', [x, y]);
  }

  lineTo(x: number, y: number): void {
    this.#record('lineTo', [x, y]);
  }

  stroke(): void {
    this.#record('stroke', []);
  }

  fill(): void {
    this.#record('fill', []);
  }

  setLineDash(segments: readonly number[]): void {
    this.#record('setLineDash', segments);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#record('setTransform', [a, b, c, d, e, f]);
  }

  /** Unbalanced save/restore is a bug: every layer must leave the stack as it found it. */
  get depth(): number {
    return this.#stack.length;
  }

  ops(op: RecordedOp): RecordedCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** Every `fillRect` painted with the given colour. */
  fillsOf(color: string): RecordedCall[] {
    return this.calls.filter((c) => c.op === 'fillRect' && c.fillStyle === color);
  }

  /** Order of distinct `fillStyle` values used by `fillRect` — batching evidence. */
  fillStyleRuns(): string[] {
    const runs: string[] = [];
    for (const call of this.calls) {
      if (call.op !== 'fillRect') continue;
      if (runs.length === 0 || runs[runs.length - 1] !== call.fillStyle) runs.push(call.fillStyle);
    }
    return runs;
  }

  asContext(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }
}

/** Stand-in for the canvas element `src/ui/` hands to `createSurface`. */
export class FakeCanvas {
  width = 300;
  height = 150;
  readonly context = new FakeContext();

  getContext(id: string): FakeContext | null {
    return id === '2d' ? this.context : null;
  }

  asCanvas(): HTMLCanvasElement {
    return this as unknown as HTMLCanvasElement;
  }
}
