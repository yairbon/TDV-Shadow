/**
 * Browser entry point. Reads its fixture from the query string so Phase 3 can pin a
 * bit-deterministic chart: `?seed=7&bars=400&spacing=8&live=0&gl=1&scale=log`.
 *
 * The toolbar is DOM — chrome outside the plot, which root mandate #1 allows. Switching
 * renderer rebuilds the chart because a canvas holds exactly one context type for life;
 * pan, zoom and scale mode are carried across the rebuild so it looks continuous.
 */

import { createChart, type Chart, type RendererMode } from './app/bootstrap.js';
import { generateBars, lcg, nextTick } from './app/feed.js';
import type { PriceScaleMode, Timeframe } from './data/types.js';

declare global {
  interface Window {
    /** Geometry actually used for the last frame — Phase 3 asserts against this. */
    __chartGeometry?: () => unknown;
    __chart?: Chart;
  }
}

const params = new URLSearchParams(window.location.search);
const num = (key: string, fallback: number): number => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const chartHost = document.querySelector<HTMLElement>('#chart');
if (chartHost === null) throw new Error('#chart container is missing from index.html');
// Re-bind with an explicit non-null type: TS does not carry the narrowing above into
// the hoisted `build` declaration below, and mandate #6 rules out a `!`.
const container: HTMLElement = chartHost;

const tf = (params.get('tf') ?? '1m') as Timeframe;
const seed = num('seed', 7);
const bars = generateBars({ seed, count: num('bars', 400), tf });
const symbol = params.get('sym') ?? 'BTCUSD';

let rendererMode: RendererMode = num('gl', 0) === 1 ? 'webgl' : 'canvas2d';
let scaleMode: PriceScaleMode = params.get('scale') === 'log' ? 'log' : 'linear';
let chart: Chart | null = null;

function build(scrollPosition?: number, barSpacing?: number): void {
  chart?.dispose();
  container.replaceChildren();
  chart = createChart({
    container,
    symbol,
    tf,
    bars,
    barSpacing: barSpacing ?? num('spacing', 8),
    renderer: rendererMode,
    priceScaleMode: scaleMode,
    ...(scrollPosition === undefined ? {} : { scrollPosition }),
  });
  window.__chartGeometry = () => chart?.geometry() ?? null;
  window.__chart = chart;
}

build();

// --- toolbar ---------------------------------------------------------------

function pressed(seg: string, value: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`#${seg} button`)) {
    button.setAttribute('aria-pressed', String(button.dataset['value'] === value));
  }
}

document.querySelector('#renderer-seg')?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const next = target.dataset['value'] === 'webgl' ? 'webgl' : 'canvas2d';
  if (next === rendererMode) return;
  rendererMode = next;
  pressed('renderer-seg', next);
  // Carry the current view across the rebuild so the chart does not jump.
  const view = chart?.view.get();
  build(view?.scrollPosition, view?.barSpacing);
});

document.querySelector('#scale-seg')?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const next: PriceScaleMode = target.dataset['value'] === 'log' ? 'log' : 'linear';
  if (next === scaleMode) return;
  scaleMode = next;
  pressed('scale-seg', next);
  // No rebuild needed: the store notifies and the scheduler repaints.
  chart?.view.setPriceScaleMode(next);
});

pressed('renderer-seg', rendererMode);
pressed('scale-seg', scaleMode);

// --- live ticks ------------------------------------------------------------
// Off by default: a visual regression run must not have a moving chart underneath it
// (tests/visual/README.md, determinism preconditions).

let liveTimer: number | null = null;
const rnd = lcg(seed + 1);

function tick(): void {
  const current = chart?.series.get().bars;
  // Length guard, not an `undefined` check: `noUncheckedIndexedAccess` is off (see
  // tsconfig.json), so the index type is `Bar` and a null test would be dead per types
  // while still being live at runtime.
  if (current === undefined || current.length === 0) return;
  const next = nextTick(current[current.length - 1], rnd);
  if (next !== null) chart?.pushTick(next);
}

function setLive(on: boolean): void {
  const button = document.querySelector<HTMLButtonElement>('#live-toggle');
  if (liveTimer !== null) {
    window.clearInterval(liveTimer);
    liveTimer = null;
  }
  if (on) liveTimer = window.setInterval(tick, 250);
  if (button !== null) {
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'On' : 'Off';
  }
}

document.querySelector('#live-toggle')?.addEventListener('click', () => {
  setLive(liveTimer === null);
});

setLive(num('live', 0) === 1);
