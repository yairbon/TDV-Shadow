/**
 * WebGL2 series layer — RENDER_ALGORITHMS §11, behind a flag.
 *
 * Draws candle wicks, bodies and volume columns as three instanced passes over one
 * unit quad. The instance buffer holds raw (index, o, h, l, c, v) tuples and is
 * re-uploaded only when the series revision changes; pan and zoom rewrite uniforms.
 *
 * Scope, stated plainly: this path handles the LINEAR price scale only. Log and
 * percent modes fall back to Canvas2D (`supportsSnapshot`). Grid, axes, crosshair and
 * overlays are Canvas2D in both modes — only the series layer moves to the GPU.
 */

import type { Bar, PriceScaleMode } from '../../data/types.js';
import type { Rect } from '../layout.js';
import type { Theme } from '../theme.js';
import { candleGeometry } from '../scale/timeScale.js';
import {
  FRAGMENT_SHADER,
  PASS_BODY,
  PASS_VOLUME,
  PASS_WICK,
  VERTEX_SHADER,
} from './shaders.js';

/** Floats per instance: index, o, h, l, c, v. */
const STRIDE = 6;
const BYTES_PER_FLOAT = 4;

export interface GlFrame {
  readonly bars: readonly Bar[];
  readonly from: number;
  readonly to: number;
  readonly plot: Rect;
  readonly volume: Rect | null;
  readonly priceMin: number;
  readonly priceMax: number;
  readonly volumeMax: number;
  readonly barSpacing: number;
  readonly scrollPosition: number;
  readonly theme: Theme;
  /** Bumped whenever bar contents change; drives instance re-upload. */
  readonly revision: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

export interface GlSeriesLayer {
  draw(frame: GlFrame): void;
  dispose(): void;
}

/** Linear is the only mode with a GPU transform; see the file header. */
export function supportsMode(mode: PriceScaleMode): boolean {
  return mode === 'linear';
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  // Unlike createProgram/createBuffer/createVertexArray, createShader is nullable in
  // lib.dom — the null check here is load-bearing, not defensive noise.
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('WebGL: createShader returned null');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown error';
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${log}`);
  }
  return program;
}

/** `#rrggbb` / `#rgb` -> normalized rgba. Alpha defaults to 1. */
export function parseColor(css: string): [number, number, number, number] {
  const hex = css.trim().replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : hex;
  const r = Number.parseInt(full.slice(0, 2), 16) / 255;
  const g = Number.parseInt(full.slice(2, 4), 16) / 255;
  const b = Number.parseInt(full.slice(4, 6), 16) / 255;
  const a = full.length >= 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
  return [
    Number.isFinite(r) ? r : 0,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 0,
    Number.isFinite(a) ? a : 1,
  ];
}

/** Packs bars into the interleaved instance array the shader expects. */
export function packInstances(bars: readonly Bar[]): Float32Array {
  const data = new Float32Array(bars.length * STRIDE);
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const o = i * STRIDE;
    data[o] = i;
    data[o + 1] = bar.o;
    data[o + 2] = bar.h;
    data[o + 3] = bar.l;
    data[o + 4] = bar.c;
    data[o + 5] = bar.v;
  }
  return data;
}

const QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);

export function createGlSeriesLayer(canvas: HTMLCanvasElement): GlSeriesLayer {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false, // Candles are axis-aligned rects; AA would only blur snapped edges.
    premultipliedAlpha: true,
    // Lets tests read the buffer back after the frame; the cost is one extra copy.
    preserveDrawingBuffer: true,
  });
  if (gl === null) throw new Error('WebGL2 is unavailable on this canvas');

  const program = link(gl);
  const vao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();

  gl.bindVertexArray(vao);

  const cornerLoc = gl.getAttribLocation(program, 'aCorner');
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(cornerLoc);
  gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);

  const instanceAttrs = ['aIndex', 'aOpen', 'aHigh', 'aLow', 'aClose', 'aVolume'] as const;
  const instanceLocs = instanceAttrs.map((name) => gl.getAttribLocation(program, name));

  const uniform = (name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(program, name);
  const u = {
    plot: uniform('uPlot'),
    volumeRect: uniform('uVolumeRect'),
    viewport: uniform('uViewport'),
    barSpacing: uniform('uBarSpacing'),
    scroll: uniform('uScroll'),
    priceMin: uniform('uPriceMin'),
    priceMax: uniform('uPriceMax'),
    volumeMax: uniform('uVolumeMax'),
    bodyWidth: uniform('uBodyWidth'),
    pass: uniform('uPass'),
    colorUp: uniform('uColorUp'),
    colorDown: uniform('uColorDown'),
  };

  let uploadedRevision = Number.NaN;
  let uploadedCount = -1;

  const bindInstanceAttribs = (offsetBars: number): void => {
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const base = offsetBars * STRIDE * BYTES_PER_FLOAT;
    for (let i = 0; i < instanceLocs.length; i++) {
      const loc = instanceLocs[i];
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(
        loc,
        1,
        gl.FLOAT,
        false,
        STRIDE * BYTES_PER_FLOAT,
        base + i * BYTES_PER_FLOAT,
      );
      gl.vertexAttribDivisor(loc, 1);
    }
  };

  const draw = (frame: GlFrame): void => {
    const backingWidth = Math.round(frame.cssWidth * frame.dpr);
    const backingHeight = Math.round(frame.cssHeight * frame.dpr);
    gl.viewport(0, 0, backingWidth, backingHeight);

    // SKILL rule 2: clear the whole layer every frame.
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const count = frame.to - frame.from + 1;
    if (count <= 0 || frame.bars.length === 0) return;

    gl.useProgram(program);
    gl.bindVertexArray(vao);

    if (frame.revision !== uploadedRevision || frame.bars.length !== uploadedCount) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, packInstances(frame.bars), gl.DYNAMIC_DRAW);
      uploadedRevision = frame.revision;
      uploadedCount = frame.bars.length;
    }
    // WebGL2 has no baseInstance, so the visible slice is expressed as a buffer offset.
    bindInstanceAttribs(frame.from);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const geometry = candleGeometry(frame.barSpacing);
    // The theme colours wicks, bodies and volume separately, so the pair is set per
    // pass rather than once per frame — matching what the Canvas2D layer draws.
    const setColors = (upCss: string, downCss: string): void => {
      const up = parseColor(upCss);
      const down = parseColor(downCss);
      gl.uniform4f(u.colorUp, up[0], up[1], up[2], up[3]);
      gl.uniform4f(u.colorDown, down[0], down[1], down[2], down[3]);
    };

    gl.uniform4f(u.plot, frame.plot.left, frame.plot.top, frame.plot.width, frame.plot.height);
    const vol = frame.volume;
    // Component order must match the shader's reads: .x left, .y top, .z width, .w height.
    gl.uniform4f(
      u.volumeRect,
      vol?.left ?? 0,
      vol?.top ?? 0,
      vol?.width ?? 0,
      vol?.height ?? 0,
    );
    gl.uniform2f(u.viewport, frame.cssWidth, frame.cssHeight);
    gl.uniform1f(u.barSpacing, frame.barSpacing);
    gl.uniform1f(u.scroll, frame.scrollPosition);
    gl.uniform1f(u.priceMin, frame.priceMin);
    gl.uniform1f(u.priceMax, frame.priceMax);
    gl.uniform1f(u.volumeMax, frame.volumeMax);
    gl.uniform1f(u.bodyWidth, geometry.width);

    // SKILL rule 8: scissor is the GPU equivalent of ctx.clip() to the plot rect.
    const scissor = (rect: Rect): void => {
      gl.enable(gl.SCISSOR_TEST);
      const x = Math.round(rect.left * frame.dpr);
      const w = Math.round(rect.width * frame.dpr);
      const h = Math.round(rect.height * frame.dpr);
      // GL's origin is bottom-left; CSS y is top-down.
      const y = Math.round(backingHeight - (rect.top + rect.height) * frame.dpr);
      gl.scissor(x, y, w, h);
    };

    scissor(frame.plot);
    // Wicks first, then bodies over them — the Canvas2D layer's order.
    setColors(frame.theme.upWick, frame.theme.downWick);
    gl.uniform1i(u.pass, PASS_WICK);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    if (geometry.mode === 'body') {
      setColors(frame.theme.upBody, frame.theme.downBody);
      gl.uniform1i(u.pass, PASS_BODY);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    }

    if (vol !== null && frame.volumeMax > 0) {
      scissor(vol);
      setColors(frame.theme.upVolume, frame.theme.downVolume);
      gl.uniform1i(u.pass, PASS_VOLUME);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    }

    gl.disable(gl.SCISSOR_TEST);
  };

  return {
    draw,
    dispose(): void {
      gl.deleteBuffer(quadBuffer);
      gl.deleteBuffer(instanceBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
