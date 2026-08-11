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
import { findSymbol, parseDailyCsv, SYMBOLS } from './app/marketData.js';
import { installControlApi } from './app/control.js';
import type { Bar, PriceScaleMode, Timeframe } from './data/types.js';
import type { ChartType } from './charts/types.js';
import { INDICATOR_IDS } from './indicators/registry.js';
import { TOOL_DEFINITIONS } from './drawings/tools.js';
import type { DrawingKind, MagnetMode } from './drawings/types.js';

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

const seed = num('seed', 7);

/**
 * Resolves a symbol to its bars. Real symbols come from the baked Alpha Vantage
 * snapshot; DEMO stays synthetic because the visual regression fixtures depend on a
 * deterministic 400-bar 1m series that never changes.
 */
function loadSymbol(name: string): { bars: Bar[]; timeframe: Timeframe; live: boolean } {
  const definition = findSymbol(name);
  if (definition === null || definition.source === 'synthetic') {
    const timeframe = (params.get('tf') ?? definition?.timeframe ?? '1m') as Timeframe;
    return { bars: generateBars({ seed, count: num('bars', 400), tf: timeframe }), timeframe, live: true };
  }
  // Real daily history is a fixed snapshot: appending fake ticks to it would be inventing
  // market data, so live ticking is off for these.
  return { bars: parseDailyCsv(definition.csv ?? ''), timeframe: definition.timeframe, live: false };
}

let symbol = params.get('sym') ?? 'DEMO';
let loaded = loadSymbol(symbol);
let tf: Timeframe = loaded.timeframe;
let bars: Bar[] = loaded.bars;

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
    pricePrecision: 2,
    barSpacing: barSpacing ?? num('spacing', 8),
    renderer: rendererMode,
    priceScaleMode: scaleMode,
    ...(scrollPosition === undefined ? {} : { scrollPosition }),
  });
  window.__chartGeometry = () => chart?.geometry() ?? null;
  window.__chart = chart;
  installControlApi(() => chart, {
    symbol,
    timeframe: tf,
    switchSymbol: (next) => {
      switchSymbol(next);
      const picker = document.querySelector<HTMLSelectElement>('#symbol-pick');
      if (picker !== null) picker.value = next;
    },
    available: SYMBOLS.map((s) => s.symbol),
  });
}

build();

/**
 * Switching symbol rebuilds the chart: a Series is created with its symbol, timeframe
 * and bars, and the store is append-only by design (mandate #4), so swapping the whole
 * series is the honest operation rather than mutating one in place.
 */
function switchSymbol(next: string): void {
  symbol = next;
  loaded = loadSymbol(next);
  bars = loaded.bars;
  tf = loaded.timeframe;
  setLive(false);
  build();
  const heading = document.querySelector('#symbol');
  if (heading !== null) heading.textContent = `${symbol} · ${tf}`;
  const liveButton = document.querySelector<HTMLButtonElement>('#live-toggle');
  // Real history is a fixed snapshot; ticking it would be inventing market data.
  if (liveButton !== null) liveButton.disabled = !loaded.live;
  status();
}

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

// --- Phase 5 controls ------------------------------------------------------

/**
 * The picker lists only INDEX-PRESERVING chart types.
 *
 * Renko, Kagi, Point & Figure, Line Break and Range are implemented and tested, and are
 * reachable through the registry and the MCP `chart_set_type` tool. They are held back
 * from this picker on purpose: they emit their own bar count, so their bricks index a
 * different space from the time axis, which is still labelled from the source series. A
 * user-facing chart with a confidently wrong time axis is worse than one type fewer, and
 * fixing it means teaching the axis to label through `sourceIndex`.
 */
const PICKABLE_TYPES: readonly ChartType[] = [
  'candles',
  'hollow-candles',
  'bars',
  'line',
  'area',
  'baseline',
  'step-line',
  'columns',
  'heikin-ashi',
];

const typeSelect = document.querySelector<HTMLSelectElement>('#chart-type');
if (typeSelect !== null) {
  for (const type of PICKABLE_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type.replace(/-/g, ' ');
    typeSelect.append(option);
  }
  typeSelect.addEventListener('change', () => {
    chart?.setChartType(typeSelect.value as ChartType);
    status();
  });
}

const indicatorSelect = document.querySelector<HTMLSelectElement>('#indicator-pick');
if (indicatorSelect !== null) {
  for (const id of INDICATOR_IDS) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id.replace(/-/g, ' ');
    indicatorSelect.append(option);
  }
}

document.querySelector('#indicator-add')?.addEventListener('click', () => {
  const id = indicatorSelect?.value;
  if (id === undefined) return;
  chart?.addIndicator(id as (typeof INDICATOR_IDS)[number]);
  status();
});

document.querySelector('#indicator-clear')?.addEventListener('click', () => {
  for (const indicator of chart?.listIndicators() ?? []) chart?.removeIndicator(indicator.handleId);
  status();
});

const toolSelect = document.querySelector<HTMLSelectElement>('#tool-pick');
if (toolSelect !== null) {
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'none';
  toolSelect.append(none);
  for (const definition of Object.values(TOOL_DEFINITIONS)) {
    const option = document.createElement('option');
    option.value = definition.kind;
    option.textContent = definition.label;
    toolSelect.append(option);
  }
  toolSelect.addEventListener('change', () => {
    pending = [];
    status();
  });
}

let magnet: MagnetMode = 'off';
const magnetButton = document.querySelector<HTMLButtonElement>('#magnet-toggle');
magnetButton?.addEventListener('click', () => {
  magnet = magnet === 'off' ? 'strong' : 'off';
  magnetButton.setAttribute('aria-pressed', String(magnet !== 'off'));
  status();
});

document.querySelector('#draw-clear')?.addEventListener('click', () => {
  chart?.drawings.clear();
  pending = [];
  status();
});

/** Anchors collected so far for the drawing being placed. */
let pending: { barIndex: number; price: number }[] = [];

function status(): void {
  const element = document.querySelector('#status');
  if (element === null) return;
  const kind = toolSelect?.value ?? '';
  const indicators = chart?.listIndicators().length ?? 0;
  const shapes = chart?.drawings.list().length ?? 0;
  const placing =
    kind === ''
      ? ''
      : ` · placing ${kind} ${String(pending.length)}/${String(TOOL_DEFINITIONS[kind as DrawingKind].anchorCount)}`;
  element.textContent = `${String(indicators)} ind · ${String(shapes)} draw${placing}`;
}

// Placement runs on click, and a click that followed a drag is a pan, not a placement.
let downAt: { x: number; y: number } | null = null;
container.addEventListener('pointerdown', (event) => {
  downAt = { x: event.clientX, y: event.clientY };
});

container.addEventListener('click', (event) => {
  const kind = toolSelect?.value ?? '';
  if (kind === '' || chart === null) return;
  const start = downAt;
  if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;

  const rect = container.getBoundingClientRect();
  const snapped = chart.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, magnet);
  pending = [...pending, snapped.anchor];

  const needed = TOOL_DEFINITIONS[kind as DrawingKind].anchorCount;
  if (pending.length >= needed) {
    chart.drawings.add(kind as DrawingKind, pending);
    pending = [];
  }
  status();
});

status();

const symbolSelect = document.querySelector<HTMLSelectElement>('#symbol-pick');
if (symbolSelect !== null) {
  for (const definition of SYMBOLS) {
    const option = document.createElement('option');
    option.value = definition.symbol;
    option.textContent = definition.label;
    symbolSelect.append(option);
  }
  symbolSelect.value = symbol;
  symbolSelect.addEventListener('change', () => {
    switchSymbol(symbolSelect.value);
  });
}

switchSymbol(symbol);
