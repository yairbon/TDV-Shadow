/**
 * Browser entry point and chrome.
 *
 * Layout follows the shape traders already know: a left tool rail, a top bar of symbol /
 * timeframe / type / indicators, and an OHLC legend over the top-left of the plot. All of
 * it is DOM — root mandate #1 permits chrome outside the plot and legend text; the
 * candles, axes, gridlines and crosshair remain canvas-only.
 *
 * Query string still pins the visual-regression fixture:
 * `?seed=7&bars=400&spacing=8&live=0&gl=1&scale=log&sym=DEMO`.
 */

import { createChart, type Chart, type RendererMode } from './app/bootstrap.js';
import { generateBars, lcg, nextTick } from './app/feed.js';
import { findSymbol, parseDailyCsv, SYMBOLS } from './app/marketData.js';
import { fetchDailySeries } from './app/liveData.js';
import { installControlApi } from './app/control.js';
import { resample } from './data/agg/resample.js';
import type { Bar, PriceScaleMode, Timeframe } from './data/types.js';
import type { ChartType } from './charts/types.js';
import { INDICATOR_IDS } from './indicators/registry.js';
import { TOOL_DEFINITIONS } from './drawings/tools.js';
import type { DrawingKind, MagnetMode } from './drawings/types.js';

declare global {
  interface Window {
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
// Typed lookups via `instanceof` rather than `querySelector<T>`: the generic overload is
// deprecated in lib.dom, and narrowing is honest about an element that is not there.
const el = (selector: string): HTMLElement | null => {
  const found = document.querySelector(selector);
  return found instanceof HTMLElement ? found : null;
};
const sel = (selector: string): HTMLSelectElement | null => {
  const found = document.querySelector(selector);
  return found instanceof HTMLSelectElement ? found : null;
};
const btn = (selector: string): HTMLButtonElement | null => {
  const found = document.querySelector(selector);
  return found instanceof HTMLButtonElement ? found : null;
};
const inp = (selector: string): HTMLInputElement | null => {
  const found = document.querySelector(selector);
  return found instanceof HTMLInputElement ? found : null;
};

const chartHost = el('#chart');
if (chartHost === null) throw new Error('#chart container is missing from index.html');
// Re-bind with an explicit non-null type: TS does not carry the narrowing into the
// hoisted declarations below, and mandate #6 rules out a `!`.
const container: HTMLElement = chartHost;

const seed = num('seed', 7);

interface Loaded {
  readonly bars: Bar[];
  readonly timeframe: Timeframe;
  /** Whether simulated ticks may be appended — never for real history. */
  readonly live: boolean;
  /** Base 1m series, kept so timeframe buttons can resample without refetching. */
  readonly base: Bar[] | null;
}

function loadSymbol(name: string): Loaded {
  const definition = findSymbol(name);
  if (definition === null || definition.source === 'synthetic') {
    const base = generateBars({ seed, count: num('bars', 400), tf: '1m' });
    return { bars: base, timeframe: '1m', live: true, base };
  }
  return {
    bars: parseDailyCsv(definition.csv ?? ''),
    timeframe: definition.timeframe,
    live: false,
    base: null,
  };
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
  // Fit the series to the pane on load. A fixed default spacing leaves 100 daily bars
  // hugging the right edge of a wide screen with dead space beside them, which is the
  // first thing that reads as unfinished.
  // An explicit ?spacing= must win: the visual-regression fixtures pin it, and silently
  // refitting made three differently-zoomed fixtures render identically.
  if (barSpacing === undefined && params.get('spacing') === null && bars.length > 1) {
    const width = chart.layout().plot.width;
    const fitted = Math.min(120, Math.max(1.5, (width * 0.92) / bars.length));
    chart.view.update({ barSpacing: fitted, scrollPosition: bars.length - 1 + 2 });
  }

  installControlApi(() => chart, {
    symbol,
    timeframe: tf,
    switchSymbol: (next) => {
      switchSymbol(next);
    },
    available: SYMBOLS.map((s) => s.symbol),
  });
  renderLegend(null);
}

// ---------------------------------------------------------------- legend

const legend = el('#legend');
const fmt = (value: number): string =>
  value >= 1000 ? value.toFixed(2) : value.toPrecision(Math.min(6, Math.max(4, 4)));

/** Renders the OHLC readout for `index`, or for the last bar when null. */
function renderLegend(index: number | null): void {
  if (legend === null || chart === null) return;
  const series = chart.series.get().bars;
  if (series.length === 0) {
    legend.innerHTML = '';
    return;
  }
  const i = index === null ? series.length - 1 : Math.min(series.length - 1, Math.max(0, index));
  const bar = series[i];
  const previous = series[Math.max(0, i - 1)];
  const change = bar.c - previous.c;
  const percent = previous.c === 0 ? 0 : (change / previous.c) * 100;
  const direction = bar.c >= bar.o ? 'up' : 'down';

  const cell = (label: string, value: number): string =>
    `${label}<b class="${direction}">${fmt(value)}</b>`;

  // One row per indicator with its value AT THE CURSOR and a remove control — the
  // readout a trader actually uses, rather than a list of names.
  const rows = chart
    .indicatorValuesAt(i)
    .map((entry) => {
      const readout = entry.values
        .filter((v) => !Number.isNaN(v.value))
        .map((v) => fmt(v.value))
        .join(' ');
      return (
        `<div class="row ind" data-handle="${entry.handleId}">` +
        `<span>${entry.label}</span><span>${readout}</span>` +
        `<button type="button" title="Remove ${entry.label}" aria-label="Remove ${entry.label}">×</button>` +
        `</div>`
      );
    })
    .join('');

  legend.innerHTML =
    `<div class="title">${symbol} <span class="muted">· ${tf} · ${
      chart.chartType().replace(/-/g, ' ')
    }</span></div>` +
    `<div class="ohlc">${cell('O', bar.o)} ${cell('H', bar.h)} ${cell('L', bar.l)} ${cell('C', bar.c)} ` +
    `<b class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${change.toFixed(2)} (${
      percent >= 0 ? '+' : ''
    }${percent.toFixed(2)}%)</b></div>` +
    rows;

  status();
  const changeBadge = el('#symbol-change');
  if (changeBadge !== null && index === null) {
    changeBadge.textContent = `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
    changeBadge.className = percent >= 0 ? 'up' : 'down';
  }
}

legend?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const handle = target.closest('[data-handle]');
  if (!(handle instanceof HTMLElement)) return;
  const id = handle.dataset['handle'];
  if (id !== undefined) chart?.removeIndicator(id);
  renderLegend(null);
});

// The legend follows the crosshair. This only reads state and writes text, so it stays
// clear of the draw loop (mandate #3).
container.addEventListener('pointermove', (event) => {
  if (chart === null) return;
  const rect = container.getBoundingClientRect();
  const anchor = chart.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, 'off');
  renderLegend(Math.round(anchor.anchor.barIndex));
});
container.addEventListener('pointerleave', () => {
  renderLegend(null);
});

// ---------------------------------------------------------------- symbol

function switchSymbol(next: string): void {
  symbol = next;
  loaded = loadSymbol(next);
  bars = loaded.bars;
  tf = loaded.timeframe;
  setLive(false);
  build();
  const name = el('#symbol-name');
  if (name !== null) name.textContent = symbol;
  const picker = sel('#symbol-pick');
  if (picker !== null) picker.value = symbol;
  const liveButton = btn('#live-toggle');
  if (liveButton !== null) liveButton.disabled = !loaded.live;
  syncTimeframes();
  renderLegend(null);
  status();
}

const symbolSelect = sel('#symbol-pick');
if (symbolSelect !== null) {
  for (const definition of SYMBOLS) {
    const option = document.createElement('option');
    option.value = definition.symbol;
    option.textContent = definition.label;
    symbolSelect.append(option);
  }
  symbolSelect.addEventListener('change', () => {
    switchSymbol(symbolSelect.value);
  });
}

const symbolInput = inp('#symbol-input');

async function loadTicker(ticker: string): Promise<void> {
  const name = ticker.trim().toUpperCase();
  if (name === '') return;
  if (findSymbol(name) !== null) {
    switchSymbol(name);
    return;
  }
  setStatus(`loading ${name}…`);
  const result = await fetchDailySeries(name, params.get('apikey') ?? '');
  if (!result.ok) {
    // Keep the current chart: blanking it, or relabelling the old bars, is worse than
    // saying plainly that the load failed.
    setStatus(`${name}: ${result.reason}`);
    return;
  }
  symbol = name;
  bars = [...result.bars];
  tf = '1d';
  loaded = { bars, timeframe: tf, live: false, base: null };
  setLive(false);
  build();
  const heading = el('#symbol-name');
  if (heading !== null) heading.textContent = symbol;
  syncTimeframes();
  renderLegend(null);
  status();
}

el('#symbol-load')?.addEventListener('click', () => {
  void loadTicker(symbolInput?.value ?? '');
});
symbolInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void loadTicker(symbolInput.value);
});

// ---------------------------------------------------------------- timeframes

/**
 * Intraday timeframes are produced by resampling the synthetic 1m base series. Daily
 * history cannot be resampled UP to an intraday bar — the information is not there — so
 * those buttons are disabled rather than silently showing the wrong thing.
 */
const TIMEFRAMES: readonly { readonly tf: Timeframe; readonly label: string }[] = [
  { tf: '1m', label: '1m' },
  { tf: '5m', label: '5m' },
  { tf: '15m', label: '15m' },
  { tf: '1h', label: '1H' },
  { tf: '1d', label: '1D' },
];

const timeframeHost = el('#timeframes');
if (timeframeHost !== null) {
  for (const entry of TIMEFRAMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb tf';
    button.dataset['tf'] = entry.tf;
    button.textContent = entry.label;
    button.addEventListener('click', () => {
      setTimeframe(entry.tf);
    });
    timeframeHost.append(button);
  }
}

function syncTimeframes(): void {
  for (const node of document.querySelectorAll('#timeframes button')) {
    if (!(node instanceof HTMLButtonElement)) continue;
    const button = node;
    const value = (button.dataset['tf'] ?? '1m') as Timeframe;
    const supported = loaded.base !== null ? value !== '1d' : value === '1d';
    button.disabled = !supported;
    button.style.opacity = supported ? '1' : '0.35';
    button.setAttribute('aria-pressed', String(value === tf));
    button.title = supported ? `${value} bars` : 'not available for this symbol';
  }
}

function setTimeframe(next: Timeframe): void {
  const base = loaded.base;
  if (base === null || next === tf) return;
  const resampled = next === '1m' ? base : [...resample(base, '1m', next)];
  if (resampled.length === 0) return;
  bars = resampled;
  tf = next;
  loaded = { bars, timeframe: next, live: loaded.live, base };
  build();
  syncTimeframes();
  renderLegend(null);
  status();
}

// ---------------------------------------------------------------- toggles

const logButton = btn('#scale-log');
logButton?.addEventListener('click', () => {
  scaleMode = scaleMode === 'log' ? 'linear' : 'log';
  logButton.setAttribute('aria-pressed', String(scaleMode === 'log'));
  chart?.view.setPriceScaleMode(scaleMode);
});

const glButton = btn('#renderer-webgl');
glButton?.addEventListener('click', () => {
  rendererMode = rendererMode === 'webgl' ? 'canvas2d' : 'webgl';
  glButton.setAttribute('aria-pressed', String(rendererMode === 'webgl'));
  const view = chart?.view.get();
  build(view?.scrollPosition, view?.barSpacing);
});

let liveTimer: number | null = null;
const rnd = lcg(seed + 1);

function tick(): void {
  const current = chart?.series.get().bars;
  // Length guard, not an `undefined` check: `noUncheckedIndexedAccess` is off, so the
  // index type is `Bar` and a null test would be dead per types yet live at runtime.
  if (current === undefined || current.length === 0) return;
  const next = nextTick(current[current.length - 1], rnd);
  if (next !== null) chart?.pushTick(next);
  renderLegend(null);
}

function setLive(on: boolean): void {
  const button = btn('#live-toggle');
  if (liveTimer !== null) {
    window.clearInterval(liveTimer);
    liveTimer = null;
  }
  if (on) liveTimer = window.setInterval(tick, 250);
  button?.setAttribute('aria-pressed', String(on));
}

el('#live-toggle')?.addEventListener('click', () => {
  setLive(liveTimer === null);
});

// ---------------------------------------------------------------- chart type

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

const typeSelect = sel('#chart-type');
if (typeSelect !== null) {
  for (const type of PICKABLE_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    typeSelect.append(option);
  }
  typeSelect.addEventListener('change', () => {
    chart?.setChartType(typeSelect.value as ChartType);
    renderLegend(null);
  });
}

// ---------------------------------------------------------------- indicators

const indicatorSelect = sel('#indicator-pick');
if (indicatorSelect !== null) {
  for (const id of INDICATOR_IDS) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id.replace(/-/g, ' ').toUpperCase();
    indicatorSelect.append(option);
  }
}

el('#indicator-add')?.addEventListener('click', () => {
  const id = indicatorSelect?.value;
  if (id === undefined) return;
  chart?.addIndicator(id as (typeof INDICATOR_IDS)[number]);
  renderLegend(null);
  status();
});

el('#indicator-clear')?.addEventListener('click', () => {
  for (const entry of chart?.listIndicators() ?? []) chart?.removeIndicator(entry.handleId);
  renderLegend(null);
  status();
});

// ---------------------------------------------------------------- tool rail

const ICONS: Readonly<Record<string, string>> = {
  cursor: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
  trendline: '<path d="M4 19L20 5"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="5" r="2"/>',
  ray: '<path d="M4 19L20 5"/><circle cx="4" cy="19" r="2"/>',
  'horizontal-line': '<path d="M3 12h18"/><circle cx="8" cy="12" r="2"/>',
  'vertical-line': '<path d="M12 3v18"/><circle cx="12" cy="8" r="2"/>',
  rectangle: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
  'fib-retracement':
    '<path d="M4 5h16M4 10h16M4 15h16M4 20h16"/><path d="M4 5l16 15" stroke-dasharray="2 2"/>',
  'fib-extension': '<path d="M4 7h16M4 12h16M4 17h16"/><path d="M6 20l6-14 6 8"/>',
  'gann-fan': '<path d="M4 20L20 4M4 20L20 12M4 20L20 18M4 20L12 4"/>',
  pitchfork: '<path d="M4 18l8-10 8 10"/><path d="M12 8v12"/>',
  'elliott-impulse': '<path d="M3 19l4-6 3 4 4-9 4 6 3-2"/>',
  'long-position': '<rect x="4" y="5" width="16" height="6"/><rect x="4" y="13" width="16" height="6"/>',
  'text-note': '<path d="M6 6h12M12 6v12"/>',
  magnet: '<path d="M7 4v8a5 5 0 0010 0V4"/><path d="M7 8h4M13 8h4"/>',
  erase: '<path d="M6 6l12 12M18 6L6 18"/>',
};

const RAIL_TOOLS: readonly string[] = [
  'cursor',
  'trendline',
  'ray',
  'horizontal-line',
  'vertical-line',
  'rectangle',
  'ellipse',
  'fib-retracement',
  'fib-extension',
  'gann-fan',
  'pitchfork',
  'elliott-impulse',
  'long-position',
  'text-note',
];

let activeTool = '';
let magnet: MagnetMode = 'off';
let pending: { barIndex: number; price: number }[] = [];

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS['cursor']}</svg>`;
}

const rail = el('#tool-rail');
if (rail !== null) {
  for (const name of RAIL_TOOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset['tool'] = name === 'cursor' ? '' : name;
    button.title = name === 'cursor' ? 'Cursor' : TOOL_DEFINITIONS[name as DrawingKind].label;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(name === 'cursor'));
    button.innerHTML = icon(name);
    button.addEventListener('click', () => {
      activeTool = button.dataset['tool'] ?? '';
      pending = [];
      for (const other of rail.querySelectorAll('button[data-tool]')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      status();
    });
    rail.append(button);
  }

  const separator = document.createElement('div');
  separator.className = 'sep';
  rail.append(separator);

  const magnetButton = document.createElement('button');
  magnetButton.type = 'button';
  magnetButton.title = 'Magnet — snap anchors to OHLC';
  magnetButton.setAttribute('aria-label', magnetButton.title);
  magnetButton.setAttribute('aria-pressed', 'false');
  magnetButton.innerHTML = icon('magnet');
  magnetButton.addEventListener('click', () => {
    magnet = magnet === 'off' ? 'strong' : 'off';
    magnetButton.setAttribute('aria-pressed', String(magnet !== 'off'));
    status();
  });
  rail.append(magnetButton);

  const eraseButton = document.createElement('button');
  eraseButton.type = 'button';
  eraseButton.title = 'Remove all drawings';
  eraseButton.setAttribute('aria-label', eraseButton.title);
  eraseButton.innerHTML = icon('erase');
  eraseButton.addEventListener('click', () => {
    chart?.drawings.clear();
    pending = [];
    status();
  });
  rail.append(eraseButton);
}

// ---------------------------------------------------------------- placement

function setStatus(text: string): void {
  const element = el('#status');
  if (element !== null) element.textContent = text;
}

function status(): void {
  const indicators = chart?.listIndicators().length ?? 0;
  const shapes = chart?.drawings.list().length ?? 0;
  const placing =
    activeTool === ''
      ? ''
      : ` · ${activeTool} ${String(pending.length)}/${String(
          TOOL_DEFINITIONS[activeTool as DrawingKind].anchorCount,
        )}`;
  setStatus(
    `${String(indicators)} indicator${indicators === 1 ? '' : 's'} · ${String(shapes)} drawing${
      shapes === 1 ? '' : 's'
    }${magnet === 'off' ? '' : ' · magnet'}${placing}`,
  );
}

let downAt: { x: number; y: number } | null = null;
container.addEventListener('pointerdown', (event) => {
  downAt = { x: event.clientX, y: event.clientY };
});

container.addEventListener('click', (event) => {
  if (activeTool === '' || chart === null) return;
  const start = downAt;
  // A click that followed a drag was a pan, not a placement.
  if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;

  const rect = container.getBoundingClientRect();
  const snapped = chart.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, magnet);
  pending = [...pending, snapped.anchor];

  if (pending.length >= TOOL_DEFINITIONS[activeTool as DrawingKind].anchorCount) {
    chart.drawings.add(activeTool as DrawingKind, pending);
    pending = [];
  }
  status();
});

// ---------------------------------------------------------------- boot

build();
switchSymbol(symbol);
if (typeSelect !== null) typeSelect.value = 'candles';
logButton?.setAttribute('aria-pressed', String(scaleMode === 'log'));
glButton?.setAttribute('aria-pressed', String(rendererMode === 'webgl'));
setLive(num('live', 0) === 1);
status();

// ---------------------------------------------------------------- symbol search

const searchDialog = document.querySelector('#search');
const searchInput = inp('#search-input');
const searchResults = document.querySelector('#search-results');
let searchIndex = 0;

interface Candidate {
  readonly symbol: string;
  readonly label: string;
  readonly source: string;
}

function candidates(query: string): Candidate[] {
  const q = query.trim().toUpperCase();
  const local = SYMBOLS.filter(
    (s) => q === '' || s.symbol.includes(q) || s.label.toUpperCase().includes(q),
  ).map((s) => ({ symbol: s.symbol, label: s.label, source: s.source === 'synthetic' ? 'demo' : 'bundled' }));

  // An unmatched query is still offered, because the ticker box can fetch it when the
  // page has network. Offering it and failing loudly beats pretending it does not exist.
  if (q !== '' && !local.some((c) => c.symbol === q)) {
    local.push({ symbol: q, label: 'Fetch from Alpha Vantage', source: 'live' });
  }
  return local;
}

function renderSearch(): void {
  if (searchResults === null || searchInput === null) return;
  const list = candidates(searchInput.value);
  searchIndex = Math.min(searchIndex, Math.max(0, list.length - 1));
  searchResults.innerHTML = list
    .map(
      (c, i) =>
        `<li role="option" aria-selected="${String(i === searchIndex)}" data-symbol="${c.symbol}">` +
        `<span class="tk">${c.symbol}</span><span class="nm">${c.label}</span>` +
        `<span class="src">${c.source}</span></li>`,
    )
    .join('');
  const note = el('#search-note');
  if (note !== null) {
    note.textContent =
      params.get('apikey') === null ? 'live fetch needs ?apikey=' : 'live fetch enabled';
  }
}

function openSearch(): void {
  if (!(searchDialog instanceof HTMLDialogElement)) return;
  searchIndex = 0;
  if (searchInput !== null) searchInput.value = '';
  renderSearch();
  searchDialog.showModal();
  searchInput?.focus();
}

function chooseSearch(): void {
  if (searchResults === null) return;
  const selected = searchResults.querySelector('[aria-selected="true"]');
  const name = selected instanceof HTMLElement ? selected.dataset['symbol'] : undefined;
  if (name === undefined) return;
  if (searchDialog instanceof HTMLDialogElement) searchDialog.close();
  void loadTicker(name);
}

el('#symbol-button')?.addEventListener('click', openSearch);
searchInput?.addEventListener('input', () => {
  searchIndex = 0;
  renderSearch();
});
searchInput?.addEventListener('keydown', (event) => {
  const list = searchResults?.querySelectorAll('li') ?? [];
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    searchIndex = Math.min(list.length - 1, searchIndex + 1);
    renderSearch();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    searchIndex = Math.max(0, searchIndex - 1);
    renderSearch();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    chooseSearch();
  }
});
searchResults?.addEventListener('click', (event) => {
  const item = event.target instanceof HTMLElement ? event.target.closest('li') : null;
  if (!(item instanceof HTMLElement)) return;
  const list = [...searchResults.querySelectorAll("li")];
  searchIndex = list.indexOf(item);
  chooseSearch();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openSearch();
  }
});

// ---------------------------------------------------------------- axis drags

/**
 * Dragging the price gutter scales the price axis; dragging the time gutter zooms.
 * Double-clicking either resets it — the gesture traders expect, and without it a chart
 * that has been squashed has no way back.
 */
let axisDrag: { axis: 'price' | 'time'; y: number; x: number; zoom: number; spacing: number } | null =
  null;

function axisAt(x: number, y: number): 'price' | 'time' | null {
  if (chart === null) return null;
  const layout = chart.layout();
  if (x >= layout.priceGutter.left) return 'price';
  if (y >= layout.timeGutter.top) return 'time';
  return null;
}

container.addEventListener(
  'pointerdown',
  (event) => {
    if (chart === null) return;
    const rect = container.getBoundingClientRect();
    const axis = axisAt(event.clientX - rect.left, event.clientY - rect.top);
    if (axis === null) return;
    axisDrag = {
      axis,
      x: event.clientX,
      y: event.clientY,
      zoom: chart.priceZoom(),
      spacing: chart.view.get().barSpacing,
    };
    event.stopPropagation();
  },
  true,
);

window.addEventListener('pointermove', (event) => {
  const drag = axisDrag;
  if (drag === null || chart === null) return;
  if (drag.axis === 'price') {
    chart.setPriceZoom(drag.zoom * Math.exp((event.clientY - drag.y) / 260));
  } else {
    chart.view.setBarSpacing(drag.spacing * Math.exp((drag.x - event.clientX) / 260));
  }
});

window.addEventListener('pointerup', () => {
  axisDrag = null;
});

container.addEventListener('dblclick', (event) => {
  if (chart === null) return;
  const rect = container.getBoundingClientRect();
  const axis = axisAt(event.clientX - rect.left, event.clientY - rect.top);
  if (axis === 'price') chart.resetPriceZoom();
  else chart.fitAll();
});

// ---------------------------------------------------------------- jump to latest

const jumpButton = btn('#jump');
jumpButton?.addEventListener('click', () => {
  chart?.scrollToRealtime();
});

window.setInterval(() => {
  if (jumpButton === null || chart === null) return;
  jumpButton.hidden = !chart.isScrolledBack();
}, 250);
