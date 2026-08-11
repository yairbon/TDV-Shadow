/**
 * Browser entry point. Reads its fixture from the query string so Phase 3 can pin a
 * bit-deterministic chart: `?seed=7&bars=400&spacing=8&live=0`.
 */

import { createChart } from './app/bootstrap.js';
import { generateBars, lcg, nextTick } from './app/feed.js';
import type { Timeframe } from './data/types.js';
import type { Chart } from './app/bootstrap.js';

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

const container = document.querySelector<HTMLElement>('#chart');
if (container === null) throw new Error('#chart container is missing from index.html');

const tf = (params.get('tf') ?? '1m') as Timeframe;
const bars = generateBars({ seed: num('seed', 7), count: num('bars', 400), tf });

const chart = createChart({
  container,
  symbol: params.get('sym') ?? 'BTCUSD',
  tf,
  bars,
  barSpacing: num('spacing', 8),
});

window.__chartGeometry = () => chart.geometry();
window.__chart = chart;

// Live ticks are opt-in and OFF by default: a visual regression run must not have a
// moving chart underneath it (tests/visual/README.md, determinism preconditions).
if (num('live', 0) === 1) {
  const rnd = lcg(num('seed', 7) + 1);
  window.setInterval(() => {
    const current = chart.series.get().bars;
    // Length guard, not an `undefined` check: `noUncheckedIndexedAccess` is off (see
    // tsconfig.json), so the index type is `Bar` and a null test would be dead per types
    // while still being live at runtime.
    if (current.length === 0) return;
    const tick = nextTick(current[current.length - 1], rnd);
    if (tick !== null) chart.pushTick(tick);
  }, 250);
}
