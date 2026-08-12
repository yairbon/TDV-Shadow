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
import {
  clearWorkspace,
  loadWorkspace,
  saveWorkspace,
  type PaneState,
  type Workspace,
} from './app/workspace.js';
import { createHistory, type History, type HistoryState } from './app/history.js';
import { createContextMenu, type MenuEntry } from './ui/contextMenu.js';
import { createIndicatorDialog } from './ui/indicatorDialog.js';
import { createDrawingDialog } from './ui/drawingDialog.js';
import { createChartDialog, type ChartSettingsForm } from './ui/chartDialog.js';
import { DARK_THEME, LIGHT_THEME } from './renderer/theme.js';
import { resample } from './data/agg/resample.js';
import { MIN_BAR_SPACING } from './renderer/scale/timeScale.js';
import type { Bar, PriceScaleMode, Timeframe } from './data/types.js';
import type { ChartType } from './charts/types.js';
import { computeIndicator, INDICATOR_IDS } from './indicators/registry.js';
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
const panesHostEl = el('#panes');
if (chartHost === null || panesHostEl === null) {
  throw new Error('#panes / #chart containers are missing from index.html');
}
// Re-bind with explicit non-null types: TS does not carry the narrowing into the hoisted
// declarations below, and mandate #6 rules out a `!`.
const panesHost: HTMLElement = panesHostEl;

/**
 * Multi-chart layouts (10.4).
 *
 * Each pane is a full `Chart` with its own symbol, timeframe, view and alerts. The state
 * that used to be module-level singletons — symbol, bars, chart — still is: it belongs to
 * whichever pane is ACTIVE, and switching panes swaps it in and out of these variables.
 * That keeps every toolbar handler, dialog and shortcut written against one chart working
 * unchanged, instead of threading a pane through several hundred lines.
 *
 * Pointer handlers are bound to the shared `#panes` element rather than to a pane, and
 * resolve the pane from the event. One capture-phase listener, registered before all the
 * others, makes the pane under the pointer active first — so by the time the selection,
 * measure or menu handlers run, "the active chart" is the one being pointed at.
 */
interface Pane {
  readonly index: number;
  readonly host: HTMLElement;
  symbol: string;
  loaded: Loaded;
  tf: Timeframe;
  bars: Bar[];
  chart: Chart | null;
  scaleMode: PriceScaleMode;
  inverted: boolean;
  alertsJson: string;
  /**
   * Undo is per pane, because the state it restores is.
   *
   * A single shared stack would happily apply pane A's drawings to pane B: `capture()`
   * records the ACTIVE chart's annotations, so a Ctrl+Z after switching panes replayed
   * one chart's history onto another's.
   */
  history: History;
}

export type LayoutId = '1' | '2h' | '2v' | '4';
const PANE_COUNT: Readonly<Record<LayoutId, number>> = { '1': 1, '2h': 2, '2v': 2, '4': 4 };

let panes: Pane[] = [];
let activeIndex = 0;

/**
 * Replay transport state, declared HERE rather than beside the replay code.
 *
 * `setActivePane` stops the transport, and boot calls `setActivePane` while restoring a
 * saved layout — long before the replay section runs. Leaving these `let`s down there put
 * them in the temporal dead zone at that moment, and the whole restore died on a
 * ReferenceError that surfaced only as "the second pane came back on the wrong symbol".
 */
const REPLAY_STEP_MS = 700;
let replayTimer: number | null = null;
let replaySpeed = 1;
const activePane = (): Pane => panes[activeIndex];

/** The pane an event landed in; the active one for window-level events during a drag. */
function hostOf(event: { readonly target: EventTarget | null }): HTMLElement {
  const node = event.target;
  const found = node instanceof Element ? node.closest('[data-pane]') : null;
  return found instanceof HTMLElement ? found : activePane().host;
}

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

/**
 * A saved workspace is restored ONLY when the URL asks for nothing specific. The visual
 * regression fixtures pin their state in the query string, and a stray localStorage entry
 * silently changing what they render would make them meaningless.
 */
const pinned = params.has('sym') || params.has('spacing') || params.has('scale') || params.has('gl');
const saved = pinned ? null : loadWorkspace();
/** Pane 0's saved state; the rest are applied when the layout is restored. */
const savedPane = saved === null || saved.panes.length === 0 ? null : saved.panes[0];

let symbol = params.get('sym') ?? savedPane?.symbol ?? 'DEMO';
let loaded = loadSymbol(symbol);
let tf: Timeframe = savedPane?.timeframe ?? loaded.timeframe;
let bars: Bar[] = loaded.bars;
if (savedPane !== null && loaded.base !== null && savedPane.timeframe !== '1m') {
  const resampled = [...resample(loaded.base, '1m', savedPane.timeframe)];
  if (resampled.length > 0) bars = resampled;
}

let rendererMode: RendererMode = num('gl', 0) === 1 ? 'webgl' : (saved?.renderer ?? 'canvas2d');
let scaleMode: PriceScaleMode =
  params.get('scale') === 'log' ? 'log' : (savedPane?.priceScaleMode ?? 'linear');
let themeName: 'dark' | 'light' = 'dark';
let inverted = params.get('invert') === '1' || (savedPane?.priceScaleInverted ?? false);

/** Presentation settings. Colours are stored as chosen, not as a whole theme, so the
 *  dark/light toggle keeps working and only the candle pair is overridden. */
const defaultChartSettings = (base: 'dark' | 'light'): ChartSettingsForm => {
  const theme = base === 'light' ? LIGHT_THEME : DARK_THEME;
  return {
    showGrid: true,
    timeZone: 'UTC',
    pricePrecision: 2,
    rightMargin: 2,
    upColor: theme.upBody,
    downColor: theme.downBody,
  };
};
let chartSettings: ChartSettingsForm = saved?.chartSettings ?? defaultChartSettings('dark');

/**
 * Alerts live in the chart, and the chart is rebuilt on a symbol change, a theme swap and
 * a renderer swap. This is the copy that survives those rebuilds; it is refreshed from
 * the store on every change and reloaded into each new chart.
 */
let alertsJson: string = savedPane?.alerts ?? '';
let chart: Chart | null = null;
/** The ACTIVE pane's undo stack; swapped in and out by adoptActive/stashActive. */
let history: History = createHistory();
const currentChart = (): Chart | null => chart;
let restoring = saved !== null;

function build(scrollPosition?: number, barSpacing?: number): void {
  const pane = activePane();
  chart?.dispose();
  pane.host.replaceChildren();
  chart = createChart({
    container: pane.host,
    symbol,
    tf,
    bars,
    pricePrecision: 2,
    barSpacing: barSpacing ?? num('spacing', 8),
    renderer: rendererMode,
    theme: themeName === 'light' ? LIGHT_THEME : DARK_THEME,
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
    const fitted = Math.min(120, Math.max(MIN_BAR_SPACING, (width * 0.92) / bars.length));
    chart.view.update({ barSpacing: fitted, scrollPosition: bars.length - 1 + 2 });
  }

  // Axis inversion lives on the chart instance, so it has to be re-applied whenever the
  // chart is rebuilt (theme swap, renderer swap) or it silently resets.
  if (inverted) chart.setPriceInverted(true);
  applyChartSettings(chartSettings);
  // The pane's OWN symbol is captured here. Reading the module-level `symbol` inside the
  // listener would name whichever pane happened to be active when the alert fired, which
  // in a four-pane layout is usually a different instrument entirely.
  const paneSymbol = symbol;
  chart.onAlert((alert) => {
    toast(`${paneSymbol} reached ${alert.price.toFixed(chartSettings.pricePrecision)}`);
    status();
  });
  if (alertsJson !== '') chart.alerts.loadJSON(alertsJson);
  renderReplayBar();
  chart.alerts.subscribe(() => {
    alertsJson = currentChart()?.alerts.toJSON() ?? alertsJson;
    status();
  });

  installControl();
  renderLegend(null);
}

/**
 * (Re)points `window.__tdv` at the active pane.
 *
 * The context carries the symbol and timeframe by value, so it has to be reinstalled
 * whenever those change — including on a pane switch, where nothing is rebuilt. Without
 * that, `getState()` kept reporting the symbol of whichever pane was built last while the
 * chart it returned was a different one.
 */
function installControl(): void {
  installControlApi(() => chart, {
    symbol,
    timeframe: tf,
    switchSymbol: (next) => {
      switchSymbol(next);
    },
    available: SYMBOLS.map((s) => s.symbol),
  });
}

// ---------------------------------------------------------------- pane management

let layout: LayoutId = saved?.layout ?? '1';
let syncCrosshair = true;

// No DOM label inside a pane: mandate #1's structural guard is that a plot host contains
// canvases and nothing else, and each pane already names itself — `drawWatermark` paints
// the symbol and timeframe on the grid layer of every chart.

/** Copies the active pane's live state back into its record before switching away. */
function stashActive(): void {
  const pane = activePane();
  pane.symbol = symbol;
  pane.loaded = loaded;
  pane.tf = tf;
  pane.bars = bars;
  pane.chart = chart;
  pane.scaleMode = scaleMode;
  pane.inverted = inverted;
  pane.alertsJson = alertsJson;
  pane.history = history;
}

function adoptActive(): void {
  const pane = activePane();
  symbol = pane.symbol;
  loaded = pane.loaded;
  tf = pane.tf;
  bars = pane.bars;
  chart = pane.chart;
  scaleMode = pane.scaleMode;
  inverted = pane.inverted;
  alertsJson = pane.alertsJson;
  history = pane.history;
  window.__chartGeometry = () => chart?.geometry() ?? null;
  if (chart === null) delete window.__chart;
  else window.__chart = chart;
  if (chart !== null) installControl();
}

function markActive(): void {
  for (const pane of panes) pane.host.classList.toggle('active', pane.index === activeIndex);
  positionLegend();
}

/**
 * Moves the OHLC legend over the active pane.
 *
 * The legend reads the active chart but was pinned to the top-left of the whole plot
 * area, so in a multi-pane layout it described one chart while sitting on top of another
 * — and, because its indicator rows are clickable, it also swallowed the clicks meant to
 * activate the pane underneath it.
 */
function positionLegend(): void {
  const legendEl = el('#legend');
  const wrap = el('#chart-wrap');
  if (legendEl === null || wrap === null || panes.length === 0) return;

  // With one pane the stylesheet already has it right, including the tighter phone
  // offsets in the media query — and an inline style would silently win over those.
  if (panes.length === 1) {
    legendEl.style.removeProperty('left');
    legendEl.style.removeProperty('top');
    return;
  }

  const pane = activePane().host.getBoundingClientRect();
  const box = wrap.getBoundingClientRect();
  legendEl.style.left = `${String(Math.round(pane.left - box.left + 12))}px`;
  legendEl.style.top = `${String(Math.round(pane.top - box.top + 8))}px`;
}

window.addEventListener('resize', positionLegend);

function setActivePane(index: number): void {
  if (index === activeIndex || index < 0 || index >= panes.length) return;
  // A half-placed drawing belongs to the pane it was started in. Carrying `pending`
  // across would build a shape from one anchor in one chart's data space and the next in
  // another's — a line between two unrelated instruments.
  pending = [];
  // Same reasoning for the replay transport: it drives ONE chart, so it must not silently
  // retarget to whichever pane you clicked next.
  stopReplayTimer();
  stashActive();
  activeIndex = index;
  adoptActive();
  markActive();
  // The chrome describes the ACTIVE chart, so all of it has to follow the switch.
  syncSymbolChrome();
  syncTimeframes();
  syncToggles();
  renderLegend(null);
  renderReplayBar();
  status();
}

/**
 * Applies one saved pane onto a live chart.
 *
 * Shared by boot (pane 0) and by the layout restore (the rest), so a non-active pane gets
 * exactly what the active one does. Before this, only pane 0's state was saved at all and
 * the other panes came back as empty charts on the right symbol.
 */
function restorePane(target: Chart, state: PaneState): void {
  for (const entry of state.indicators) target.addIndicator(entry.id, entry.params, entry.styles);
  if (state.drawings !== null) target.drawings.loadJSON(state.drawings);
  if (state.alerts !== null) target.alerts.loadJSON(state.alerts);
  if (state.priceScaleMode !== 'linear') target.view.setPriceScaleMode(state.priceScaleMode);
  if (state.priceScaleInverted) target.setPriceInverted(true);
  if (state.chartType !== 'candles') target.setChartType(state.chartType);
  // The view goes LAST: setChartType can change the index space, and a scroll position
  // restored before that would be a position in the wrong one.
  if (Number.isFinite(state.scrollPosition) && state.barSpacing > 0) {
    target.view.update({ barSpacing: state.barSpacing, scrollPosition: state.scrollPosition });
  }
}

/**
 * Rebuilds every pane in place, preserving each one's view.
 *
 * The theme and the renderer are GLOBAL — both require tearing a chart down — so
 * rebuilding only the active pane left the others on the old theme or the old renderer,
 * which looked like the toggle half-working.
 */
function rebuildAllPanes(): void {
  const returnTo = activeIndex;
  for (const pane of panes) {
    if (pane.index !== activeIndex) setActivePane(pane.index);
    const view = chart?.view.get();
    build(view?.scrollPosition, view?.barSpacing);
    // A rebuilt chart is a new object; the pane record has to learn about it before the
    // next switch stashes a stale one.
    stashActive();
  }
  setActivePane(returnTo);
  markActive();
}

function newPane(index: number): Pane {
  const host =
    index === 0 && chartHost !== null
      ? chartHost
      : (() => {
          const node = document.createElement('div');
          node.className = 'pane';
          node.dataset['pane'] = String(index);
          panesHost.append(node);
          return node;
        })();
  const initial = loadSymbol(symbol);
  return {
    index,
    host,
    symbol,
    loaded: initial,
    tf: initial.timeframe,
    bars: initial.bars,
    chart: null,
    scaleMode: 'linear',
    inverted: false,
    alertsJson: '',
    history: createHistory(),
  };
}

/**
 * Applies a layout, creating or disposing panes to match.
 *
 * Panes are added and removed from the END, and existing ones keep their charts, so
 * going 1 -> 4 -> 1 does not reload the chart you were looking at.
 */
function setLayout(next: LayoutId): void {
  const wanted = PANE_COUNT[next];
  layout = next;
  panesHost.dataset['layout'] = next;
  const picker = sel('#layout-pick');
  if (picker !== null) picker.value = next;

  while (panes.length > wanted) {
    const pane = panes[panes.length - 1];
    if (pane.index === activeIndex) {
      // Never leave the active index pointing at a pane that is about to vanish.
      setActivePane(0);
    }
    pane.chart?.dispose();
    pane.host.remove();
    panes = panes.slice(0, -1);
  }
  while (panes.length < wanted) {
    const pane = newPane(panes.length);
    panes = [...panes, pane];
    const previous = activeIndex;
    stashActive();
    activeIndex = pane.index;
    adoptActive();
    build();
    stashActive();
    activeIndex = previous;
    adoptActive();
  }
  markActive();
  status();
}

sel('#layout-pick')?.addEventListener('change', (event) => {
  const target = event.currentTarget;
  if (target instanceof HTMLSelectElement) setLayout(target.value as LayoutId);
});

btn('#sync-crosshair')?.addEventListener('click', () => {
  syncCrosshair = !syncCrosshair;
  btn('#sync-crosshair')?.setAttribute('aria-pressed', String(syncCrosshair));
});

// Registered FIRST, in the capture phase, so every handler below it sees the pane under
// the pointer as the active one.
panesHost.addEventListener(
  'pointerdown',
  (event) => {
    const host = hostOf(event);
    const index = Number(host.dataset['pane'] ?? '0');
    setActivePane(index);
  },
  true,
);

/**
 * Crosshair sync (10.4): the pointer's BAR and PRICE are broadcast, not its pixels.
 *
 * Panes can show different symbols at different zooms, so a shared pixel would point at
 * unrelated bars. Sharing the bar index lines the crosshairs up on the same moment in
 * time, which is the reason to sync them at all.
 */
panesHost.addEventListener('pointermove', (event) => {
  if (!syncCrosshair || panes.length < 2) return;
  const source = activePane();
  if (source.chart === null) return;
  const rect = source.host.getBoundingClientRect();
  const anchor = source.chart.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, 'off');
  for (const pane of panes) {
    if (pane.index === source.index || pane.chart === null) continue;
    pane.chart.setExternalPointer(anchor.anchor.barIndex);
  }
});

panesHost.addEventListener('pointerleave', () => {
  for (const pane of panes) pane.chart?.setExternalPointer(null);
});

// ---------------------------------------------------------------- chart settings

const chartDialog = createChartDialog();

/**
 * Applies presentation settings to the live chart.
 *
 * The candle colours are folded into a derived theme rather than stored as one: the
 * dark/light toggle rebuilds from its own base theme, and persisting a whole theme object
 * would pin the user to whichever mode they were in when they picked a colour.
 */
function applyChartSettings(next: ChartSettingsForm): void {
  chartSettings = next;
  // Every pane: these are global settings, and applying them to the active chart only
  // left the other panes on different gridlines, precision and candle colours.
  for (const pane of panes) {
    const target = pane.index === activeIndex ? currentChart() : pane.chart;
    if (target !== null) applySettingsTo(target, next);
  }
  if (panes.length === 0) {
    const active = currentChart();
    if (active !== null) applySettingsTo(active, next);
  }
}

function applySettingsTo(target: Chart, next: ChartSettingsForm): void {
  const base = themeName === 'light' ? LIGHT_THEME : DARK_THEME;
  target.updateSettings({
    showGrid: next.showGrid,
    timeZone: next.timeZone,
    pricePrecision: next.pricePrecision,
    rightMargin: next.rightMargin,
    // Volume keeps the theme's own translucent pair. Tinting it with the candle colour
    // looked right for a green/red palette and wrong for anything else, and volume is a
    // separate setting in TradingView for the same reason.
    theme: {
      ...base,
      upBody: next.upColor,
      upWick: next.upColor,
      downBody: next.downColor,
      downWick: next.downColor,
    },
  });
}

function openChartSettings(): void {
  chartDialog.open({
    settings: chartSettings,
    defaults: defaultChartSettings(themeName),
    onApply: applyChartSettings,
    onCancel: applyChartSettings,
  });
}

el('#chart-settings')?.addEventListener('click', openChartSettings);

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
        `<button type="button" data-action="settings" title="${entry.label} settings" ` +
        `aria-label="${entry.label} settings">⚙</button>` +
        `<button type="button" data-action="remove" title="Remove ${entry.label}" ` +
        `aria-label="Remove ${entry.label}">×</button>` +
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
  if (id === undefined) return;

  if (target.dataset['action'] === 'settings') {
    openIndicatorSettings(id);
    return;
  }
  capture();
  chart?.removeIndicator(id);
  renderLegend(null);
});

// Double-clicking the row is the TradingView gesture; the gear is the discoverable one,
// and the only one that works on a touch screen.
legend?.addEventListener('dblclick', (event) => {
  const target = event.target;
  const handle = target instanceof HTMLElement ? target.closest('[data-handle]') : null;
  if (!(handle instanceof HTMLElement)) return;
  const id = handle.dataset['handle'];
  if (id !== undefined) openIndicatorSettings(id);
});

// The legend follows the crosshair. This only reads state and writes text, so it stays
// clear of the draw loop (mandate #3).
panesHost.addEventListener('pointermove', (event) => {
  if (chart === null) return;
  const rect = hostOf(event).getBoundingClientRect();
  const anchor = chart.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, 'off');
  renderLegend(Math.round(anchor.anchor.barIndex));
});
panesHost.addEventListener('pointerleave', () => {
  renderLegend(null);
});

// ---------------------------------------------------------------- symbol

/** Chrome that names the ACTIVE pane's symbol. Also runs when the active pane changes. */
function syncSymbolChrome(): void {
  const name = el('#symbol-name');
  if (name !== null) name.textContent = symbol;
  const picker = sel('#symbol-pick');
  if (picker !== null) picker.value = symbol;
  const liveButton = btn('#live-toggle');
  if (liveButton !== null) liveButton.disabled = !loaded.live;
}

/** Toolbar toggles that reflect per-pane state. */
function syncToggles(): void {
  logButton?.setAttribute('aria-pressed', String(scaleMode === 'log'));
  glButton?.setAttribute('aria-pressed', String(rendererMode === 'webgl'));
  const picker = sel('#chart-type');
  if (picker !== null && chart !== null) picker.value = chart.chartType();
}

function switchSymbol(next: string): void {
  symbol = next;
  loaded = loadSymbol(next);
  bars = loaded.bars;
  tf = loaded.timeframe;
  setLive(false);
  build();
  installControl();
  syncSymbolChrome();
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

/** Single path for the log toggle, so the menu and the toolbar cannot disagree. */
function setScaleMode(next: PriceScaleMode): void {
  scaleMode = next;
  logButton?.setAttribute('aria-pressed', String(scaleMode === 'log'));
  chart?.view.setPriceScaleMode(scaleMode);
}

logButton?.addEventListener('click', () => {
  setScaleMode(scaleMode === 'log' ? 'linear' : 'log');
});

const glButton = btn('#renderer-webgl');
glButton?.addEventListener('click', () => {
  rendererMode = rendererMode === 'webgl' ? 'canvas2d' : 'webgl';
  glButton.setAttribute('aria-pressed', String(rendererMode === 'webgl'));
  rebuildAllPanes();
});

let liveTimer: number | null = null;
const rnd = lcg(seed + 1);

function tick(): void {
  // Every pane, not just the active one: a four-pane layout with live data froze three
  // of its charts the moment it stopped being the one you were looking at.
  for (const pane of panes) {
    const isActive = pane.index === activeIndex;
    // Real history is not live: fabricating ticks onto a daily series would invent
    // prices that never traded.
    if (!(isActive ? loaded.live : pane.loaded.live)) continue;
    const target = isActive ? chart : pane.chart;
    const current = target?.series.get().bars;
    // Length guard, not an `undefined` check: `noUncheckedIndexedAccess` is off, so the
    // index type is `Bar` and a null test would be dead per types yet live at runtime.
    if (target === null || current === undefined || current.length === 0) continue;
    const next = nextTick(current[current.length - 1], rnd);
    if (next !== null) target.pushTick(next);
  }
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

/**
 * Every chart type is pickable now (10.3).
 *
 * The resampling five — Renko, Kagi, P&F, Line Break, Range — were excluded because they
 * index their own bar space while the axis labelled from the source series. The chart now
 * renders them in that derived space with timestamps resolved back through `sourceIndex`,
 * so there is one index space again and the axis, crosshair and drawings all agree.
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
  'renko',
  'kagi',
  'point-and-figure',
  'line-break',
  'range',
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
  capture();
  chart?.addIndicator(id as (typeof INDICATOR_IDS)[number]);
  renderLegend(null);
  status();
});

el('#indicator-clear')?.addEventListener('click', () => {
  for (const entry of chart?.listIndicators() ?? []) chart?.removeIndicator(entry.handleId);
  renderLegend(null);
  status();
});

// ---------------------------------------------------------------- indicator settings

const indicatorDialog = createIndicatorDialog();

/**
 * Opens the settings sheet for one live indicator.
 *
 * `updateIndicator` rather than remove+add: the handle and the pane position have to
 * survive, or changing RSI's length would drop its pane to the bottom of the stack.
 *
 * Undo is captured ONCE, on open, not per keystroke — otherwise typing "50" over "20"
 * would leave three separate undo steps for one edit.
 */
function openIndicatorSettings(handleId: string): void {
  const active = currentChart();
  if (active === null) return;
  const indicator = active.listIndicators().find((i) => i.handleId === handleId);
  if (indicator === undefined) return;

  capture();
  indicatorDialog.open({
    id: indicator.id,
    handleId,
    params: indicator.params,
    styles: indicator.styles,
    // Plots are asked of the indicator itself, with no bars: the declaration is part of
    // the result, so this is the only honest source for "which lines does this draw".
    plots: computeIndicator(indicator.id, [], indicator.params).plots,
    onApply: (settings) => {
      currentChart()?.updateIndicator(handleId, settings);
      renderLegend(null);
      status();
    },
    onCancel: (settings) => {
      currentChart()?.updateIndicator(handleId, settings);
      renderLegend(null);
      status();
    },
  });
}

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
  measure:
    '<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/>',
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
  'measure',
];

/**
 * Rail entries that are NOT drawing tools. Without this the rail would look them up in
 * TOOL_DEFINITIONS, which has no entry for them, and the lookup returns undefined at
 * runtime while typing fine.
 */
const TOOL_LABELS: Readonly<Record<string, string | undefined>> = {
  cursor: 'Cursor',
  measure: 'Measure — shift-drag anywhere, or use this on touch',
};

/** True for a rail tool that places a drawing, as opposed to the cursor or the ruler. */
const isDrawingTool = (tool: string): tool is DrawingKind =>
  tool !== '' && tool !== 'measure' && tool in TOOL_DEFINITIONS;

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
    button.title = TOOL_LABELS[name] ?? TOOL_DEFINITIONS[name as DrawingKind].label;
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
    capture();
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
  const armed = chart?.alerts.forSymbol(symbol).filter((a) => !a.triggered).length ?? 0;
  const placing = isDrawingTool(activeTool)
    ? ` · ${activeTool} ${String(pending.length)}/${String(
        TOOL_DEFINITIONS[activeTool].anchorCount,
      )}`
    : activeTool === ''
      ? ''
      : ` · ${activeTool}`;
  setStatus(
    `${String(indicators)} indicator${indicators === 1 ? '' : 's'} · ${String(shapes)} drawing${
      shapes === 1 ? '' : 's'
    }${armed === 0 ? '' : ` · ${String(armed)} alert${armed === 1 ? '' : 's'}`}${
      magnet === 'off' ? '' : ' · magnet'
    }${placing}`,
  );
}

let downAt: { x: number; y: number } | null = null;
panesHost.addEventListener('pointerdown', (event) => {
  downAt = { x: event.clientX, y: event.clientY };
});

panesHost.addEventListener('click', (event) => {
  if (!isDrawingTool(activeTool) || chart === null) return;
  const start = downAt;
  // A click that followed a drag was a pan, not a placement.
  if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;

  const rect = hostOf(event).getBoundingClientRect();
  const snapped = chart.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, magnet);
  pending = [...pending, snapped.anchor];

  if (pending.length >= TOOL_DEFINITIONS[activeTool].anchorCount) {
    capture();
    chart.drawings.add(activeTool, pending);
    pending = [];
  }
  status();
});

// ---------------------------------------------------------------- boot

// Pane 0 reuses the `#chart` element that is already in the page, so a single-chart
// layout is byte-for-byte the DOM it was before multi-chart existed.
panes = [newPane(0)];
markActive();
panesHost.dataset['layout'] = '1';

build();
switchSymbol(symbol);

/**
 * Restoration runs AFTER boot finishes, not inside build(): boot builds the chart twice
 * (once directly, once through switchSymbol), and applying the saved state to the first
 * chart meant the second one threw it away — indicators and drawings vanished on reload
 * while the symbol appeared to restore fine.
 */
// Read through a function so TypeScript does not narrow `chart` to `never` here: it
// cannot see that build() assigns it, and a `!` is ruled out by mandate #6.
const booted = currentChart();
if (restoring && savedPane !== null && booted !== null) {
  restoring = false;
  restorePane(booted, savedPane);
  const picker = sel('#chart-type');
  if (picker !== null) picker.value = savedPane.chartType;
  renderLegend(null);
}
if (typeSelect !== null) typeSelect.value = 'candles';
logButton?.setAttribute('aria-pressed', String(scaleMode === 'log'));
glButton?.setAttribute('aria-pressed', String(rendererMode === 'webgl'));
setLive(num('live', 0) === 1);

// The saved layout is applied AFTER pane 0 is fully restored, so the extra panes are
// created against a chart that already has its symbol, view and annotations.
if (saved !== null && saved.layout !== '1') {
  setLayout(saved.layout);
  for (const pane of panes) {
    // Index guard rather than an undefined check: `noUncheckedIndexedAccess` is off, so
    // the index type is `PaneState` and a null test reads as dead code to the linter.
    if (pane.index === 0 || pane.index >= saved.panes.length) continue;
    const state = saved.panes[pane.index];
    setActivePane(pane.index);
    if (state.symbol !== symbol) switchSymbol(state.symbol);
    const target = currentChart();
    if (target !== null) restorePane(target, state);
  }
  setActivePane(0);
}
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

panesHost.addEventListener(
  'pointerdown',
  (event) => {
    if (chart === null) return;
    const rect = hostOf(event).getBoundingClientRect();
    const axis = axisAt(event.clientX - rect.left, event.clientY - rect.top);
    if (axis === null || event.button !== 0) return;
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

panesHost.addEventListener('dblclick', (event) => {
  if (chart === null) return;
  const rect = hostOf(event).getBoundingClientRect();
  // A drawing under the cursor wins: double-clicking a trendline must open its style
  // editor, not reset the scale it happens to be drawn on.
  const hit = chart.hitTestAt(event.clientX - rect.left, event.clientY - rect.top);
  if (hit !== null) {
    openDrawingSettings(hit.id);
    return;
  }
  const axis = axisAt(event.clientX - rect.left, event.clientY - rect.top);
  if (axis === 'price') chart.resetPriceZoom();
  else chart.fitAll();
});

// ---------------------------------------------------------------- jump to latest

const jumpButton = btn('#jump');
jumpButton?.addEventListener('click', () => {
  chart?.scrollToRealtime();
});

let legendSignature = '';

window.setInterval(() => {
  if (chart === null) return;
  if (jumpButton !== null) jumpButton.hidden = !chart.isScrolledBack();
  // Keeps the counters honest after changes made through the control API, which never
  // touch the toolbar handlers.
  status();

  // The legend follows the crosshair, so it is normally redrawn by pointermove. An
  // indicator added or removed through the control API touches neither the toolbar
  // handlers nor the pointer, and its row would not appear until the user happened to
  // move the mouse. Redraw only when the SET changes, not every tick, so this never
  // fights the cursor readout.
  const signature = chart
    .listIndicators()
    .map((i) => `${i.handleId}:${i.id}`)
    .join(',');
  if (signature !== legendSignature) {
    legendSignature = signature;
    renderLegend(null);
  }
}, 250);

// ---------------------------------------------------------------- persistence

/**
 * Saved on a debounce rather than per frame: panning fires hundreds of view updates a
 * second and localStorage writes are synchronous.
 */
let saveTimer: number | null = null;

/** One description of what a saved workspace IS, so the two save paths cannot drift. */
function paneStateOf(pane: Pane): PaneState | null {
  // The active pane's live state lives in the module variables, not in its record.
  const isActive = pane.index === activeIndex;
  const target = isActive ? chart : pane.chart;
  if (target === null) return null;
  const view = target.view.get();
  return {
    symbol: isActive ? symbol : pane.symbol,
    timeframe: isActive ? tf : pane.tf,
    chartType: target.chartType(),
    priceScaleMode: view.priceScaleMode,
    priceScaleInverted: isActive ? inverted : pane.inverted,
    indicators: target.listIndicators().map((i) => ({
      id: i.id,
      params: i.params,
      styles: i.styles,
    })),
    drawings: target.drawings.list().length > 0 ? target.drawings.toJSON() : null,
    alerts: target.alerts.list().length > 0 ? target.alerts.toJSON() : null,
    barSpacing: view.barSpacing,
    scrollPosition: view.scrollPosition,
  };
}

function snapshotWorkspace(): Workspace | null {
  const states = panes.flatMap((pane) => {
    const state = paneStateOf(pane);
    return state === null ? [] : [state];
  });
  if (states.length === 0) return null;
  return { panes: states, layout, renderer: rendererMode, chartSettings };
}

function persist(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const workspace = snapshotWorkspace();
    if (workspace !== null) saveWorkspace(workspace);
  }, 400);
}

window.setInterval(persist, 2000);
window.addEventListener('beforeunload', () => {
  const workspace = snapshotWorkspace();
  if (workspace !== null) saveWorkspace(workspace);
});

el('#reset-workspace')?.addEventListener('click', () => {
  clearWorkspace();
  window.location.reload();
});

// ---------------------------------------------------------------- theme

el('#theme-toggle')?.addEventListener('click', () => {
  const previous = defaultChartSettings(themeName);
  themeName = themeName === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset['theme'] = themeName;

  // Candle colours follow the theme UNLESS the user picked their own. Comparing against
  // the outgoing theme's defaults is what tells those two cases apart; skipping it would
  // either strand dark-theme candles on a white chart or silently discard a choice.
  const fresh = defaultChartSettings(themeName);
  if (chartSettings.upColor === previous.upColor && chartSettings.downColor === previous.downColor) {
    chartSettings = { ...chartSettings, upColor: fresh.upColor, downColor: fresh.downColor };
  }

  rebuildAllPanes();
  persist();
});

// ---------------------------------------------------------------- history

function snapshotState(): HistoryState | null {
  const active = currentChart();
  if (active === null) return null;
  return {
    drawings: active.drawings.toJSON(),
    indicators: active.listIndicators().map((i) => ({
      id: i.id,
      params: i.params,
      styles: i.styles,
    })),
  };
}

/** Records the state BEFORE a mutation. Call it first, never after. */
function capture(): void {
  const state = snapshotState();
  if (state !== null) history.capture(state);
}

function applyState(state: HistoryState): void {
  const active = currentChart();
  if (active === null) return;
  active.drawings.loadJSON(state.drawings);
  for (const existing of active.listIndicators()) active.removeIndicator(existing.handleId);
  for (const entry of state.indicators) active.addIndicator(entry.id, entry.params, entry.styles);
  renderLegend(null);
  status();
}

function undo(): void {
  const current = snapshotState();
  if (current === null) return;
  const previous = history.undo(current);
  if (previous !== null) applyState(previous);
}

function redo(): void {
  const current = snapshotState();
  if (current === null) return;
  const next = history.redo(current);
  if (next !== null) applyState(next);
}

// ---------------------------------------------------------------- selection & drag

interface DragState {
  readonly id: string;
  /** -1 when the body was grabbed rather than a specific anchor. */
  readonly anchorIndex: number;
  readonly startAnchors: readonly { barIndex: number; price: number }[];
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

let drag: DragState | null = null;

function localPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = hostOf(event).getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * Selection and dragging run in the CAPTURE phase and stop propagation on a hit, so the
 * pan handler never sees the gesture. Without that the chart would pan while the shape
 * moves, and both would be wrong.
 */
panesHost.addEventListener(
  'pointerdown',
  (event) => {
    const active = currentChart();
    // Button 0 only: a right-click must open the menu, not start a drag that the
    // following pointerup then commits.
    if (active === null || activeTool !== '' || event.button !== 0) return;
    // A measuring gesture is not a selection. Both handlers sit on the same element, so
    // `stopPropagation` in the measure handler does not stop this one — a shift-drag that
    // began on a trendline grabbed the line AND measured, and left an undo step behind
    // for a drag that never happened.
    if (measureActive(event)) return;
    const point = localPoint(event);
    const hit = active.hitTestAt(point.x, point.y);
    if (hit === null) {
      if (active.drawings.selected() !== null) {
        active.drawings.select(null);
        status();
      }
      return;
    }

    const drawing = active.drawings.get(hit.id);
    if (drawing === null) return;

    // A locked drawing still selects — otherwise there is no way to reach it to unlock —
    // it just refuses to move.
    active.drawings.select(hit.id);
    if (drawing.locked) {
      status();
      return;
    }
    capture();
    drag = {
      id: hit.id,
      anchorIndex: hit.anchorIndex,
      startAnchors: drawing.anchors.map((a) => ({ barIndex: a.barIndex, price: a.price })),
      startX: point.x,
      startY: point.y,
      moved: false,
    };
    event.stopPropagation();
    event.preventDefault();
    status();
  },
  true,
);

window.addEventListener('pointermove', (event) => {
  const state = drag;
  const active = currentChart();
  if (state === null || active === null) return;
  const point = localPoint(event);
  if (Math.hypot(point.x - state.startX, point.y - state.startY) > 2) state.moved = true;

  // Dragging works in DATA space: convert both the grab point and the cursor, then apply
  // the delta to the stored anchors. Moving pixels and converting once at the end would
  // drift as soon as the scale is non-linear.
  const from = active.pickAnchor(state.startX, state.startY, 'off').anchor;
  const to = active.pickAnchor(point.x, point.y, magnet).anchor;

  if (state.anchorIndex >= 0) {
    const next = state.startAnchors.map((anchor, i) =>
      i === state.anchorIndex ? { barIndex: to.barIndex, price: to.price } : anchor,
    );
    active.drawings.update(state.id, { anchors: next });
    return;
  }

  const dIndex = to.barIndex - from.barIndex;
  const dPrice = to.price - from.price;
  active.drawings.update(state.id, {
    anchors: state.startAnchors.map((a) => ({
      barIndex: a.barIndex + dIndex,
      price: a.price + dPrice,
    })),
  });
});

window.addEventListener('pointerup', () => {
  drag = null;
});

// Cursor feedback: a shape under the pointer should look grabbable.
panesHost.addEventListener('pointermove', (event) => {
  const active = currentChart();
  if (active === null || drag !== null) return;
  if (activeTool !== '') {
    hostOf(event).style.cursor = 'crosshair';
    return;
  }
  const point = localPoint(event);
  hostOf(event).style.cursor = active.hitTestAt(point.x, point.y) === null ? 'default' : 'move';
});

// ---------------------------------------------------------------- drawing style

const drawingDialog = createDrawingDialog();

/** Opens the style editor for one drawing. Undo is captured once, on open. */
function openDrawingSettings(id: string): void {
  const active = currentChart();
  const drawing = active?.drawings.get(id) ?? null;
  if (active === null || drawing === null) return;

  capture();
  drawingDialog.open({
    id,
    label: TOOL_DEFINITIONS[drawing.kind].label,
    style: drawing.style,
    onApply: (style) => {
      currentChart()?.drawings.update(id, { style });
      status();
    },
    onCancel: (style) => {
      currentChart()?.drawings.update(id, { style });
      status();
    },
  });
}

// ---------------------------------------------------------------- context menus

/**
 * What a right-click means depends only on WHERE it landed, so the region test lives
 * here rather than inside the widget: a drawing under the cursor wins, then the two
 * gutters, then the plot itself.
 */
const menu = createContextMenu();

function drawingMenu(active: Chart, id: string): MenuEntry[] {
  const drawing = active.drawings.get(id);
  if (drawing === null) return [];
  const locked = drawing.locked;
  const mutate = (change: () => void): void => {
    capture();
    change();
    status();
  };
  return [
    {
      label: 'Settings',
      onSelect: () => {
        openDrawingSettings(id);
      },
    },
    {
      label: 'Clone',
      onSelect: () => {
        // Offset so the copy is visibly a second shape rather than sitting exactly on
        // top of the original, where it would look like nothing happened.
        mutate(() => {
          const copy = active.drawings.duplicate(id, { barIndex: 3, price: 0 });
          if (copy !== null) active.drawings.select(copy.id);
        });
      },
    },
    {
      label: locked ? 'Unlock' : 'Lock',
      checked: locked,
      onSelect: () => {
        mutate(() => active.drawings.update(id, { locked: !locked }));
      },
    },
    // No "Hide": a hidden drawing is not hit-testable, so with no object tree to select
    // it from there would be no way to bring it back. Lock is the reversible version.
    'separator',
    {
      label: 'Bring to front',
      onSelect: () => {
        mutate(() => active.drawings.reorder(id, 'front'));
      },
    },
    {
      label: 'Send to back',
      onSelect: () => {
        mutate(() => active.drawings.reorder(id, 'back'));
      },
    },
    'separator',
    {
      label: 'Remove',
      danger: true,
      onSelect: () => {
        mutate(() => active.drawings.remove(id));
      },
    },
  ];
}

function indicatorSubmenu(active: Chart): MenuEntry[] {
  return INDICATOR_IDS.map((id) => ({
    label: id.replace(/-/g, ' ').toUpperCase(),
    onSelect: () => {
      capture();
      active.addIndicator(id);
      renderLegend(null);
      status();
    },
  }));
}

function alertMenu(active: Chart, id: string): MenuEntry[] {
  const alert = active.alerts.get(id);
  return [
    {
      label: alert?.triggered === true ? 'Re-arm alert' : 'Alert armed',
      disabled: alert?.triggered !== true,
      onSelect: () => {
        active.alerts.reset(id);
        status();
      },
    },
    'separator',
    {
      label: 'Remove alert',
      danger: true,
      onSelect: () => {
        active.alerts.remove(id);
        status();
      },
    },
  ];
}

function scaleEntries(active: Chart): MenuEntry[] {
  return [
    {
      label: 'Logarithmic',
      checked: scaleMode === 'log',
      onSelect: () => {
        setScaleMode(scaleMode === 'log' ? 'linear' : 'log');
      },
    },
    {
      label: 'Invert price scale',
      checked: inverted,
      onSelect: () => {
        inverted = !inverted;
        active.setPriceInverted(inverted);
      },
    },
    {
      label: 'Auto scale',
      onSelect: () => {
        active.resetPriceZoom();
      },
    },
  ];
}

/** The bar under a plot-relative x, for "start replay here". */
function replayIndexAt(x: number): number | undefined {
  const active = currentChart();
  if (active === null) return undefined;
  const index = Math.round(active.pickAnchor(x, active.layout().plot.top + 10, 'off').anchor.barIndex);
  const count = active.series.get().bars.length;
  return index >= 0 && index < count ? index : undefined;
}

function plotMenu(active: Chart, y: number, x: number): MenuEntry[] {
  const shapes = active.drawings.list().length;
  const indicators = active.listIndicators().length;
  return [
    { label: 'Add indicator', items: indicatorSubmenu(active) },
    {
      label: 'Add alert here',
      onSelect: () => {
        addAlertAt(y);
      },
    },
    {
      label: active.replayAt() === null ? 'Start replay here' : 'Leave replay',
      onSelect: () => {
        if (active.replayAt() === null) enterReplay(replayIndexAt(x));
        else exitReplay();
      },
    },
    { label: 'Chart settings', onSelect: openChartSettings },
    'separator',
    ...scaleEntries(active),
    {
      label: 'Fit all bars',
      onSelect: () => {
        active.fitAll();
      },
    },
    {
      label: 'Go to realtime',
      onSelect: () => {
        active.scrollToRealtime();
      },
    },
    'separator',
    {
      label: `Remove ${String(indicators)} indicator${indicators === 1 ? '' : 's'}`,
      disabled: indicators === 0,
      onSelect: () => {
        capture();
        for (const entry of active.listIndicators()) active.removeIndicator(entry.handleId);
        renderLegend(null);
        status();
      },
    },
    {
      label: `Remove ${String(shapes)} drawing${shapes === 1 ? '' : 's'}`,
      danger: true,
      disabled: shapes === 0,
      onSelect: () => {
        capture();
        active.drawings.clear();
        status();
      },
    },
  ];
}

function timeAxisMenu(active: Chart): MenuEntry[] {
  return [
    {
      label: 'Fit all bars',
      onSelect: () => {
        active.fitAll();
      },
    },
    {
      label: 'Go to realtime',
      onSelect: () => {
        active.scrollToRealtime();
      },
    },
  ];
}

panesHost.addEventListener('contextmenu', (event) => {
  const active = currentChart();
  if (active === null) return;
  event.preventDefault();
  const point = localPoint(event);
  const hit = active.hitTestAt(point.x, point.y);

  if (hit !== null) {
    active.drawings.select(hit.id);
    status();
    menu.open(event.clientX, event.clientY, drawingMenu(active, hit.id));
    return;
  }

  const alert = active.alertAt(point.y);
  const axis = axisAt(point.x, point.y);
  if (alert !== null && axis !== 'time') {
    menu.open(event.clientX, event.clientY, alertMenu(active, alert.id));
    return;
  }

  const entries =
    axis === 'price'
      ? [
          ...scaleEntries(active),
          'separator' as const,
          {
            label: 'Add alert here',
            onSelect: () => {
              addAlertAt(point.y);
            },
          },
        ]
      : axis === 'time'
        ? timeAxisMenu(active)
        : plotMenu(active, point.y, point.x);
  menu.open(event.clientX, event.clientY, entries);
});

// ---------------------------------------------------------------- replay

/**
 * Replay (9.3).
 *
 * Truncation, not mutation: the chart renders a prefix of the series and the bars beyond
 * the cursor are still in the store, so stepping forward is free and leaving replay is
 * instant. This module only owns the transport — the cursor itself lives on the chart.
 */
function replayBarCount(): number {
  return currentChart()?.series.get().bars.length ?? 0;
}

function renderReplayBar(): void {
  const bar = el('#replay');
  const active = currentChart();
  const at = active?.replayAt() ?? null;
  if (bar === null) return;
  bar.hidden = at === null || active === null;
  if (at === null || active === null) return;

  const count = replayBarCount();
  const scrub = inp('#replay-scrub');
  if (scrub !== null) {
    scrub.max = String(Math.max(0, count - 1));
    scrub.value = String(at);
  }
  const label = el('#replay-at');
  if (label !== null) {
    const bars = active.series.get().bars;
    const stamp =
      at < bars.length ? new Date(bars[at].t).toISOString().slice(0, 16).replace('T', ' ') : '';
    label.textContent = `${stamp} · ${String(at + 1)}/${String(count)}`;
  }
  const play = btn('#replay-play');
  if (play !== null) {
    play.textContent = replayTimer === null ? '▶' : '❚❚';
    play.title = replayTimer === null ? 'Play' : 'Pause';
  }
}

function stopReplayTimer(): void {
  if (replayTimer !== null) window.clearInterval(replayTimer);
  replayTimer = null;
}

function stepReplay(delta: number): void {
  const active = currentChart();
  const at = active?.replayAt() ?? null;
  if (active === null || at === null) return;
  const next = at + delta;
  if (next >= replayBarCount() - 1) {
    // Reaching the end pauses rather than looping: a replay that silently restarts looks
    // exactly like one that never advanced.
    active.setReplayAt(replayBarCount() - 1);
    stopReplayTimer();
  } else {
    active.setReplayAt(Math.max(0, next));
  }
  renderReplayBar();
  status();
}

function enterReplay(index?: number): void {
  const active = currentChart();
  if (active === null) return;
  const count = replayBarCount();
  if (count < 2) return;
  active.setReplayAt(index ?? Math.floor(count * 0.6));
  renderReplayBar();
  status();
}

function exitReplay(): void {
  stopReplayTimer();
  currentChart()?.setReplayAt(null);
  renderReplayBar();
  status();
}

el('#replay-exit')?.addEventListener('click', exitReplay);
el('#replay-back')?.addEventListener('click', () => {
  stopReplayTimer();
  stepReplay(-1);
});
el('#replay-forward')?.addEventListener('click', () => {
  stopReplayTimer();
  stepReplay(1);
});
el('#replay-play')?.addEventListener('click', () => {
  if (replayTimer !== null) {
    stopReplayTimer();
  } else {
    replayTimer = window.setInterval(() => {
      stepReplay(1);
    }, REPLAY_STEP_MS / replaySpeed);
  }
  renderReplayBar();
});
sel('#replay-speed')?.addEventListener('change', (event) => {
  const target = event.currentTarget;
  replaySpeed = target instanceof HTMLSelectElement ? Number(target.value) : 1;
  // Restart the timer so a speed change takes effect immediately rather than after the
  // current interval, which at 1x is most of a second of apparent non-response.
  if (replayTimer !== null) {
    stopReplayTimer();
    replayTimer = window.setInterval(() => {
      stepReplay(1);
    }, REPLAY_STEP_MS / replaySpeed);
  }
  renderReplayBar();
});
inp('#replay-scrub')?.addEventListener('input', (event) => {
  const target = event.currentTarget;
  if (!(target instanceof HTMLInputElement)) return;
  stopReplayTimer();
  currentChart()?.setReplayAt(Number(target.value));
  renderReplayBar();
});

// ---------------------------------------------------------------- alerts

/**
 * Alert lines (9.2).
 *
 * Levels live in the chart's alert store in PRICE space, so an alert survives pan, zoom
 * and a log-scale switch exactly as a drawing does. Dragging one re-arms it, which the
 * store handles: a level you just moved has not been reached yet.
 */
let alertDrag: string | null = null;

function toast(text: string): void {
  const host = el('#toasts');
  if (host === null) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = text;
  host.append(node);
  // Removed on a timer rather than on animation end: a page that never animates (reduced
  // motion, a background tab) would otherwise accumulate toasts forever.
  window.setTimeout(() => {
    node.remove();
  }, 6000);
}

function addAlertAt(y: number): void {
  const active = currentChart();
  if (active === null) return;
  const price = active.pickAnchor(active.layout().plot.left + 10, y, 'off').anchor.price;
  if (!Number.isFinite(price)) return;
  active.alerts.add(symbol, price);
  status();
}

panesHost.addEventListener(
  'pointerdown',
  (event) => {
    const active = currentChart();
    if (active === null || event.button !== 0 || activeTool !== '' || event.shiftKey) return;
    const point = localPoint(event);
    const alert = active.alertAt(point.y);
    // Drawings win: an alert line spans the whole plot, so without this a trendline
    // crossing one would become unselectable wherever they meet.
    if (alert === null || active.hitTestAt(point.x, point.y) !== null) return;
    alertDrag = alert.id;
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);

window.addEventListener('pointermove', (event) => {
  const id = alertDrag;
  const active = currentChart();
  if (id === null || active === null) return;
  const point = localPoint(event);
  const price = active.pickAnchor(active.layout().plot.left + 10, point.y, magnet).anchor.price;
  if (Number.isFinite(price)) active.alerts.move(id, price);
});

window.addEventListener('pointerup', () => {
  alertDrag = null;
});

// ---------------------------------------------------------------- measure tool

/**
 * The ruler (9.1).
 *
 * Two ways in, one implementation: Shift+drag anywhere on the plot, or the rail's ruler
 * button for touch, where there is no Shift key. A measurement stays on screen after the
 * drag so its numbers can be read, and is cleared by Escape or by the next plain click.
 */
let measuring: { from: { barIndex: number; price: number } } | null = null;

function measureActive(event: PointerEvent): boolean {
  return event.shiftKey || activeTool === 'measure';
}

panesHost.addEventListener(
  'pointerdown',
  (event) => {
    const active = currentChart();
    if (active === null || event.button !== 0 || !measureActive(event)) return;
    const point = localPoint(event);
    if (axisAt(point.x, point.y) !== null) return;

    const from = active.pickAnchor(point.x, point.y, magnet).anchor;
    measuring = { from };
    active.setMeasure({ from, to: from });
    // Stop the pan handler and the drawing-placement click from seeing this gesture.
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);

window.addEventListener('pointermove', (event) => {
  const session = measuring;
  const active = currentChart();
  if (session === null || active === null) return;
  const point = localPoint(event);
  active.setMeasure({ from: session.from, to: active.pickAnchor(point.x, point.y, magnet).anchor });
});

/**
 * True between the pointerup that finishes a measurement and the click that follows it.
 *
 * A drag ending somewhere else still fires a `click`, so without this flag the gesture
 * that CREATES a measurement immediately clears it — which looked like the ruler simply
 * not working when driven from the rail, where there is no Shift key to test for.
 */
let justMeasured = false;

window.addEventListener('pointerup', () => {
  if (measuring !== null) justMeasured = true;
  measuring = null;
});

function clearMeasure(): void {
  const active = currentChart();
  if (active?.measure() != null) active.setMeasure(null);
}

// Any click that is not the tail of a measuring gesture clears the last measurement.
panesHost.addEventListener('click', () => {
  if (justMeasured) {
    justMeasured = false;
    return;
  }
  clearMeasure();
});

// ---------------------------------------------------------------- shortcuts

const TOOL_KEYS: Readonly<Record<string, DrawingKind>> = {
  t: 'trendline',
  h: 'horizontal-line',
  v: 'vertical-line',
  r: 'rectangle',
  f: 'fib-retracement',
};

function selectTool(kind: string): void {
  activeTool = kind;
  pending = [];
  const rail = el('#tool-rail');
  for (const button of rail?.querySelectorAll('button[data-tool]') ?? []) {
    button.setAttribute('aria-pressed', String((button as HTMLElement).dataset['tool'] === kind));
  }
  status();
}

document.addEventListener('keydown', (event) => {
  const target = event.target;
  // Never steal keys from a text field — Delete in the search box must delete text.
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

  const active = currentChart();
  const meta = event.metaKey || event.ctrlKey;

  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (event.key === 'Escape') {
    if (active?.measure() != null) {
      active.setMeasure(null);
      return;
    }
    if (pending.length > 0) {
      pending = [];
      status();
    } else {
      selectTool('');
      active?.drawings.select(null);
    }
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const id = active?.drawings.selected();
    if (id !== undefined && id !== null && active !== null) {
      event.preventDefault();
      // A lock is meant to protect the drawing from an accidental gesture; deleting it
      // with one keystroke would make the lock decorative.
      if (active.drawings.get(id)?.locked === true) return;
      capture();
      active.drawings.remove(id);
      status();
    }
    return;
  }
  if (event.key.toLowerCase() === 'm' && !meta) {
    magnet = magnet === 'off' ? 'strong' : 'off';
    const magnetButton = el('#tool-rail button[title^="Magnet"]');
    magnetButton?.setAttribute('aria-pressed', String(magnet !== 'off'));
    status();
    return;
  }
  if (event.key === 'Home') {
    active?.scrollToRealtime();
    return;
  }
  if (event.key.toLowerCase() === 'r' && !meta && !event.altKey) {
    if (active?.replayAt() === null) enterReplay();
    else exitReplay();
    return;
  }
  if (event.altKey) {
    // `in` rather than an undefined check: with noUncheckedIndexedAccess off the index
    // type is DrawingKind, so a null test is dead per types while live at runtime.
    const key = event.key.toLowerCase();
    if (key in TOOL_KEYS) {
      event.preventDefault();
      selectTool(TOOL_KEYS[key]);
    }
  }
});
