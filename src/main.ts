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
import { createMarketData } from './providers/registry.js';
import type { ProviderId, SymbolHit } from './providers/types.js';
import { applyQuote } from './providers/quoteBar.js';
import { detectConnector, type ConnectorDetection } from './providers/artifactRuntime.js';
import { createBundledProvider } from './providers/bundled.js';
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
import { createToolbarOverflow } from './ui/toolbarOverflow.js';
import { createObjectTree, type ObjectRow } from './ui/objectTree.js';
import { createToolRail, type ToolGroup } from './ui/toolRail.js';
import { createWatchlistPanel } from './ui/watchlistPanel.js';
import {
  addSymbol as watchAdd,
  applyQuote as watchQuote,
  fromStorage as watchFromStorage,
  removeSymbol as watchRemove,
  rowsOf as watchRows,
  toStorage as watchToStorage,
  type WatchlistState,
} from './app/watchlist.js';
import { deleteLayout, listLayouts, loadLayout, saveLayout } from './app/workspace.js';
import { createTextPrompt } from './ui/prompt.js';
import { searchSymbols, type MatchRange } from './app/symbolSearch.js';
import { createChartDialog, type ChartSettingsForm } from './ui/chartDialog.js';
import { DARK_THEME, LIGHT_THEME } from './renderer/theme.js';
import { resample } from './data/agg/resample.js';
import { MIN_BAR_SPACING } from './renderer/scale/timeScale.js';
import {
  TIMEFRAME_MS,
  TIMEFRAMES as DATA_TIMEFRAMES,
  type Bar,
  type PriceScaleMode,
  type Timeframe,
} from './data/types.js';
import { CHART_TYPES, type ChartType } from './charts/types.js';
import { computeIndicator, INDICATOR_IDS } from './indicators/registry.js';
import type { IndicatorId, IndicatorParams } from './indicators/types.js';
import type { PlotStyles } from './renderer/layers/annotationsLayer.js';
import { minimumAnchors, TOOL_DEFINITIONS } from './drawings/tools.js';
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
/** An indicator as it is remembered across a chart rebuild. */
interface IndicatorSpec {
  readonly id: IndicatorId;
  readonly params: IndicatorParams;
  readonly styles: PlotStyles;
}

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
   * Serialised drawings, keyed by the SYMBOL they were drawn on.
   *
   * Drawings belong to the instrument, so switching symbol files the outgoing set away
   * and loads the incoming one. `alertsJson` beside this has always behaved that way —
   * `AlertStore` keys by symbol — which is why alerts survived a symbol change while the
   * drawings sitting next to them were destroyed.
   */
  drawingsBySymbol: Map<string, string>;
  /** Dragged pane heights, or null for the default split. Per pane, like the view. */
  paneFractions: readonly number[] | null;
  /**
   * Indicators, which belong to the CHART and therefore do NOT follow the symbol.
   *
   * Kept as plain specs rather than live handles because every rebuild — symbol, theme,
   * renderer — throws the chart away, and an SMA has to come back on the other side of
   * that. Recomputed against the new bars, which is exactly what "per chart" means.
   */
  indicatorSpecs: readonly IndicatorSpec[];
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

/**
 * The live data chain.
 *
 * `?apikey=` is Twelve Data's, which serves 1m/5m/1h/1d; `?avkey=` is Alpha Vantage's,
 * which serves daily. Both are optional — the chain ends in the bundled CSVs, so the app
 * charts something with no key and no network at all.
 *
 * Keys come from the URL and are never persisted. A credential in localStorage outlives
 * the intent to use it.
 */
const market = createMarketData({
  // The dev server proxies `/yahoo`, so that is exactly where this route exists. `?yahoo=1`
  // is the escape hatch for anyone serving a build behind their own proxy. Neither is true
  // of the published artifact, which is the case that must not light up six buttons it
  // cannot serve.
  yahoo:
    import.meta.env.DEV ||
    // Set when the build is deployed alongside the proxy function in `api/yahoo`. Baked in
    // at build time because a deployment either has that function or it does not, and the
    // page cannot find out by asking.
    import.meta.env['VITE_YAHOO_PROXY'] === '1' ||
    params.get('yahoo') === '1',
  ...(params.get('apikey') === null ? {} : { twelveDataKey: params.get('apikey') ?? '' }),
  ...(params.get('avkey') === null ? {} : { alphaVantageKey: params.get('avkey') ?? '' }),
});

/**
 * Upgrades the chain when this build is running as a published artifact.
 *
 * There, HTTPS to a vendor is blocked outright and the only route to data is the viewer's
 * own connector — so the REST providers must not merely be deprioritised, they must leave
 * the chain. Left in, they would claim every timeframe natively, enable all six buttons,
 * and fail on each press, which is exactly the lying-button problem the capability layer
 * was built to remove.
 */
async function adoptConnectorProvider(): Promise<void> {
  const found = await detectConnector();
  connectorDetail = found.detail;
  connectorState = found.state;
  if (found.provider === null) return;
  market.replaceChain([found.provider, createBundledProvider()]);
  syncTimeframes();
  renderLegend(null);
  setStatus(`live data via ${found.provider.capabilities().label} · daily`, 5000);
}

/**
 * What the runtime detection concluded, and the last thing a provider refused to do.
 *
 * Both are held for the data panel. The status line already carries a failure the moment it
 * happens, but it is transient by design — and "what went wrong" is asked minutes later,
 * once the reader has noticed the chart is not doing what they expected.
 */
let connectorDetail = 'still looking for a claude.ai runtime…';
let connectorState: ConnectorDetection['state'] = 'absent';
let lastProviderIssue = '';

/** Records a provider refusal for the data panel. `what` names the request. */
function noteProviderIssue(what: string, reason: string): void {
  lastProviderIssue = `${what}: ${reason}`;
}

/**
 * Everything about where the data is coming from, in one readable panel.
 *
 * Built because diagnosing a published page from outside it turned out to be impossible:
 * whether the runtime was found, whether the capability was granted, which providers are in
 * the chain and what each one will actually serve are all invisible, and every one of them
 * changes what "the symbol will not load" means. Reading four lines beats guessing.
 */
function renderDataStatus(): void {
  const body = el('#data-status-body');
  if (body === null) return;
  const rows = market
    .providers()
    .map((capability) => {
      const serves =
        capability.nativeTimeframes.length === 0
          ? 'nothing'
          : [...capability.nativeTimeframes].join(', ');
      const detail = capability.ready
        ? `${serves}${capability.canQuote ? ' · quotes' : ''}`
        : 'no credential — not used';
      return (
        `<div class="prov"><span>${escapeHtml(capability.label)}</span>` +
        `<span class="${capability.ready ? '' : 'bad'}">${escapeHtml(detail)}</span></div>`
      );
    })
    .join('');

  body.innerHTML =
    `<h3>On screen</h3><p>${escapeHtml(symbol)} · ${escapeHtml(tf)} · ${escapeHtml(
      dataSource(),
    )}</p>` +
    // Only `refused` is coloured as a fault. Having no runtime is the ordinary case
    // everywhere but a published page, and flagging it red teaches the reader to skip the
    // one line that matters when something has genuinely gone wrong.
    `<h3>claude.ai connector</h3><p class="${
      connectorState === 'refused' ? 'bad' : ''
    }">${escapeHtml(connectorDetail)}</p>` +
    `<h3>Providers, in order</h3>${rows}` +
    `<h3>Last refusal</h3><p class="${lastProviderIssue === '' ? '' : 'bad'}">${escapeHtml(
      lastProviderIssue === '' ? 'none this session' : lastProviderIssue,
    )}</p>`;
}

function openDataStatus(): void {
  const dialog = document.querySelector('#data-status');
  if (!(dialog instanceof HTMLDialogElement)) return;
  renderDataStatus();
  dialog.showModal();
}


/** Where a pane's bars came from. See `Loaded.origin`. */
type DataOrigin = 'generated' | 'bundled' | 'provider';

/**
 * Which of those a chain answer counts as.
 *
 * The bundled provider is the last link in the chain, so a request that no live provider
 * could serve still comes back `ok` — with bars out of a file. Treating that as `provider`
 * would offer the Live toggle for data that cannot move.
 */
const originOf = (providerId: ProviderId): DataOrigin =>
  providerId === 'bundled' ? 'bundled' : 'provider';

interface Loaded {
  readonly bars: Bar[];
  readonly timeframe: Timeframe;
  /**
   * Where these bars came from, which decides what "live" can honestly mean.
   *
   * `generated` may be walked forward with simulated ticks; `provider` may be polled for
   * a real quote; `bundled` is a file on disk and has neither. Carried as one field
   * rather than a pair of booleans because the three are mutually exclusive and a pair
   * can express a state that does not exist.
   */
  readonly origin: DataOrigin;
  /** Base 1m series, kept so timeframe buttons can resample without refetching. */
  readonly base: Bar[] | null;
}

function loadSymbol(name: string): Loaded {
  const definition = findSymbol(name);
  if (definition === null || definition.source === 'synthetic') {
    const base = generateBars({ seed, count: num('bars', 400), tf: '1m' });
    return { bars: base, timeframe: '1m', origin: 'generated', base };
  }
  return {
    bars: parseDailyCsv(definition.csv ?? ''),
    timeframe: definition.timeframe,
    origin: 'bundled',
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

// ---------------------------------------------------------------- watchlist

/**
 * The watchlist: a column of symbols with live prices, and one click to chart any of them.
 *
 * The most recognisable thing TradingView has that this did not. It is deliberately thin —
 * every rule about membership, ordering and which price belongs to which row lives in
 * `app/watchlist.ts`, and the panel only draws. What is left here is the wiring: persistence,
 * polling, and turning a picked row into a chart load.
 */
const WATCHLIST_KEY = 'tdv-shadow.watchlist';

/**
 * How often the listed symbols are repriced.
 *
 * Slower than the chart's own quote poll, and for a reason: this fans out over every row, so
 * a 5-symbol list at the chart's 25-second cadence would spend twelve requests a minute on
 * prices nobody is looking at closely. A metered key would be gone before lunch.
 */
const WATCHLIST_POLL_MS = 60_000;

let watchlist: WatchlistState = watchFromStorage(readWatchlist());
let watchTimer: number | null = null;
let watchPending = false;

function readWatchlist(): unknown {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    // A corrupt or unreadable entry is not a reason to fail the boot; the defaults stand.
    return null;
  }
}

function saveWatchlist(): void {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchToStorage(watchlist)));
  } catch {
    // Private mode and quota failures are swallowed, as everywhere else this app stores.
  }
}

const watchlistHost = el('#watchlist');
const watchlistInput = inp('#watchlist-input');
const watchlistRows = el('#watchlist-rows');

const watchPanel =
  watchlistHost !== null && watchlistInput !== null && watchlistRows !== null
    ? createWatchlistPanel(watchlistHost, watchlistInput, watchlistRows, {
        onPick: (symbol) => {
          void loadTicker(symbol);
        },
        onAdd: (symbol) => {
          watchlist = watchAdd(watchlist, symbol);
          saveWatchlist();
          drawWatchlist();
          void pollWatchlist();
        },
        onRemove: (symbol) => {
          watchlist = watchRemove(watchlist, symbol);
          saveWatchlist();
          drawWatchlist();
        },
        onClose: () => {
          setWatchlistOpen(false);
        },
      })
    : null;

function drawWatchlist(): void {
  watchPanel?.render(watchRows(watchlist, symbol));
}

function setWatchlistOpen(open: boolean): void {
  watchPanel?.setOpen(open);
  btn('#watchlist-toggle')?.setAttribute('aria-pressed', String(open));
  if (watchTimer !== null) {
    window.clearInterval(watchTimer);
    watchTimer = null;
  }
  if (!open) return;
  drawWatchlist();
  // Repricing a panel nobody is looking at is the one cost worth avoiding outright, so the
  // timer lives and dies with the panel rather than running for the session.
  watchTimer = window.setInterval(() => void pollWatchlist(), WATCHLIST_POLL_MS);
  void pollWatchlist();
}

/**
 * Reprices every listed symbol, one at a time.
 *
 * Sequential rather than parallel: a free key's per-minute allowance is small, and five
 * simultaneous requests is exactly the burst that trips it. The panel is redrawn after each
 * answer so prices fill in as they arrive instead of all at once at the end.
 */
async function pollWatchlist(): Promise<void> {
  if (watchPending || watchPanel === null || !watchPanel.isOpen()) return;
  watchPending = true;
  try {
    for (const listed of [...watchlist.symbols]) {
      // The list can be edited while this loop runs; a symbol removed mid-flight must not
      // be re-fetched, and `watchQuote` refuses to record it in any case.
      if (!watchlist.symbols.includes(listed)) continue;
      const result = await market.quote(listed);
      if (!result.ok) continue;
      watchlist = watchQuote(watchlist, result.value);
      drawWatchlist();
    }
  } finally {
    watchPending = false;
  }
}

el('#watchlist-toggle')?.addEventListener('click', () => {
  setWatchlistOpen(watchPanel === null ? false : !watchPanel.isOpen());
});
el('#watchlist-close')?.addEventListener('click', () => {
  setWatchlistOpen(false);
});
el('#watchlist-add')?.addEventListener('click', () => {
  const value = watchlistInput?.value ?? '';
  if (value.trim() === '') return;
  if (watchlistInput !== null) watchlistInput.value = '';
  watchlist = watchAdd(watchlist, value);
  saveWatchlist();
  drawWatchlist();
  void pollWatchlist();
});

drawWatchlist();

if (savedPane !== null && loaded.base !== null && savedPane.timeframe !== '1m') {
  const resampled = [...resample(loaded.base, '1m', savedPane.timeframe)];
  if (resampled.length > 0) bars = resampled;
}

let rendererMode: RendererMode = num('gl', 0) === 1 ? 'webgl' : (saved?.renderer ?? 'canvas2d');
let scaleMode: PriceScaleMode =
  params.get('scale') === 'log' ? 'log' : (savedPane?.priceScaleMode ?? 'linear');
/**
 * The chrome's theme and the canvas theme must be the same theme.
 *
 * The CSS keys off `data-theme` on the root element and the canvas keys off this
 * variable, but only the toggle ever set the attribute — so the app assumed nothing else
 * would. Anything that stamps the document before boot (an embedding host, a
 * user-stylesheet extension) got light chrome wrapped around a dark plot. Adopt an
 * existing stamp, then always write one back, so the two halves cannot disagree.
 *
 * Deliberately NOT `prefers-color-scheme`: the default look is dark by design, and
 * following the OS would be a product decision rather than a consistency fix.
 */
let themeName: 'dark' | 'light' =
  document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';
document.documentElement.dataset['theme'] = themeName;
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
/**
 * The ACTIVE pane's per-symbol drawings; swapped by stashActive/adoptActive.
 *
 * Deliberately EMPTY at init even when a workspace was loaded. `restorePane` applies the
 * saved annotations to the chart, and `adoptSavedAnnotations` then reads them back off
 * it — seeding here as well made `build()` and `restorePane` each add every saved
 * indicator, so a reload doubled them.
 */
let drawingsBySymbol = new Map<string, string>();
/** The ACTIVE pane's indicators, as specs that survive a rebuild. */
let indicatorSpecs: readonly IndicatorSpec[] = [];
/**
 * The symbol the live `chart` was BUILT with.
 *
 * `switchSymbol` updates `symbol` before rebuilding, so by the time `build()` files the
 * outgoing chart's drawings away, `symbol` already names the incoming instrument. Filing
 * them under that would move every drawing onto whichever symbol you switched to.
 */
let chartSymbol = symbol;
/** The ACTIVE pane's dragged pane heights; swapped by stashActive/adoptActive. */
let paneFractions: readonly number[] | null = savedPane?.paneFractions ?? null;
/**
 * Tickers loaded this session, most recent first.
 *
 * Search uses it to break ties, so the symbols you actually work with float up. Capped
 * because it is a tiebreaker and not a history: a long tail contributes nothing to
 * ranking and would only slow every keystroke.
 *
 * Declared HERE rather than beside the search dialog it serves: boot calls
 * `switchSymbol`, which records a symbol, so a `let` further down the file is in its
 * temporal dead zone at that moment. That aborts module evaluation and silently unbinds
 * every listener registered below it — the same shape as the boot crash that motivated
 * `tests/visual/harness.ts`.
 */
let recentSymbols: string[] = [];
const RECENT_LIMIT = 8;

function rememberSymbol(name: string): void {
  const upper = name.trim().toUpperCase();
  if (upper === '') return;
  recentSymbols = [upper, ...recentSymbols.filter((s) => s !== upper)].slice(0, RECENT_LIMIT);
}
let chart: Chart | null = null;
/** The ACTIVE pane's undo stack; swapped in and out by adoptActive/stashActive. */
let history: History = createHistory();
const currentChart = (): Chart | null => chart;
let restoring = saved !== null;

/**
 * Files the live chart's annotations away before it is thrown out.
 *
 * `build()` disposes and recreates, and it runs on a symbol change, a theme toggle and a
 * renderer toggle alike — so without this every one of those silently deleted the
 * drawings and indicators on screen. Capturing here rather than in `switchSymbol` is
 * deliberate: it puts the save on the same path as the destruction, so a rebuild added
 * later cannot forget to do it.
 */
function captureAnnotations(): void {
  const live = chart;
  if (live === null) return;
  if (live.drawings.list().length > 0) drawingsBySymbol.set(chartSymbol, live.drawings.toJSON());
  // Deleting the last drawing on a symbol has to clear the entry, or the set comes back
  // from the dead on the next visit.
  else drawingsBySymbol.delete(chartSymbol);
  indicatorSpecs = live.listIndicators().map((i) => ({
    id: i.id,
    params: i.params,
    styles: i.styles,
  }));
}

function build(scrollPosition?: number, barSpacing?: number): void {
  const pane = activePane();
  captureAnnotations();
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
    ...(paneFractions === null ? {} : { paneFractions }),
    ...(scrollPosition === undefined ? {} : { scrollPosition }),
  });
  window.__chartGeometry = () => chart?.geometry() ?? null;
  window.__chart = chart;
  chartSymbol = symbol;
  // The two halves of the ownership split, in one place. Drawings come back only for the
  // symbol now on screen; indicators come back unconditionally and recompute against
  // whatever bars this chart was built with.
  const saved = drawingsBySymbol.get(symbol);
  if (saved !== undefined) chart.drawings.loadJSON(saved);
  for (const spec of indicatorSpecs) chart.addIndicator(spec.id, spec.params, spec.styles);
  applyCompare(chart);
  // The tree must follow edits made on the canvas — a drag, a delete, a selection — not
  // only its own buttons, or it starts describing a chart that has moved on.
  chart.drawings.subscribe(() => {
    refreshObjectTree();
  });
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
    // A getter, not a snapshot: `installControl` runs once per chart build and the armed
    // tool changes constantly after it.
    activeTool: () => activeTool,
    toolKinds: Object.keys(TOOL_DEFINITIONS),
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
  // Capture before the swap: the outgoing pane's live drawings are still on its chart.
  captureAnnotations();
  pane.drawingsBySymbol = drawingsBySymbol;
  pane.paneFractions = chart?.paneFractions() ?? paneFractions;
  pane.indicatorSpecs = indicatorSpecs;
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
  drawingsBySymbol = pane.drawingsBySymbol;
  paneFractions = pane.paneFractions;
  indicatorSpecs = pane.indicatorSpecs;
  chartSymbol = pane.symbol;
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
  clearPlacement();
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
  // Only this pane's CURRENT symbol paints; the other symbols' sets ride along in the
  // pane record and reappear when the user switches to them.
  if (state.symbol in state.drawingsBySymbol) {
    target.drawings.loadJSON(state.drawingsBySymbol[state.symbol]);
  }
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
    drawingsBySymbol: new Map(),
    paneFractions: null,
    indicatorSpecs: [],
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
 * Crosshair sync (10.4): the pointer's MOMENT is broadcast, not its pixels or its index.
 *
 * Not pixels, because panes show different symbols at different zooms and a shared pixel
 * points at unrelated bars. Not the bar index either, which is what this used to send:
 * index `i` is the same moment in two panes only when both hold the same series at the
 * same timeframe. Put a 1H pane beside a 1m one, or Renko beside candles, and the index
 * lands somewhere arbitrary — or past the end of a shorter series, where no line appears
 * at all, which is what the four-pane layout actually did. Each pane converts the time to
 * its own index, and shows nothing when the moment is outside its history.
 */
panesHost.addEventListener('pointermove', (event) => {
  if (!syncCrosshair || panes.length < 2) return;
  const source = activePane();
  if (source.chart === null) return;
  const rect = source.host.getBoundingClientRect();
  const anchor = source.chart.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, 'off');
  const time = source.chart.timeAtIndex(anchor.anchor.barIndex);
  for (const pane of panes) {
    if (pane.index === source.index || pane.chart === null) continue;
    pane.chart.setExternalTime(time);
  }
});

panesHost.addEventListener('pointerleave', () => {
  for (const pane of panes) pane.chart?.setExternalTime(null);
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
    } · <span class="src-open" role="button" tabindex="0" title="Where this data comes from">${
      dataSource()
    }</span></span></div>` +
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
// The legend's source label is the handle, because that label is what prompts the question
// in the first place — the reader is already looking at "bundled data" and wondering why.
legend?.addEventListener('click', (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.classList.contains('src-open')) openDataStatus();
});

// It carries `role="button"`, so it has to answer the keys a button answers.
legend?.addEventListener('keydown', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains('src-open')) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  openDataStatus();
});

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
  // The active row follows the chart, so picking a symbol anywhere — the search dialog,
  // the ticker box, another pane — highlights it in the list too.
  drawWatchlist();
  const liveButton = btn('#live-toggle');
  if (liveButton !== null) {
    const live = liveAvailability();
    liveButton.disabled = !live.available;
    liveButton.title = live.reason;
  }
}

/**
 * Whether the Live toggle can do anything for what is on screen, and what to say if not.
 *
 * The rule used to be "generated series only", which was right when a simulated random
 * walk was the only thing "live" could mean. It is wrong now: real bars can be polled for
 * a real quote. It is still wrong to offer it for bundled CSVs — those are a file, and no
 * amount of polling makes a file move.
 */
function liveAvailability(): { available: boolean; reason: string } {
  if (loaded.origin === 'generated') {
    return { available: true, reason: 'Stream simulated ticks — this series is generated' };
  }
  if (loaded.origin === 'bundled') {
    return {
      available: false,
      reason: 'bundled history has no live price — load this symbol from a provider',
    };
  }
  const quoter = market.providers().find((capability) => capability.ready && capability.canQuote);
  if (quoter === undefined) {
    return { available: false, reason: 'no configured provider serves a live quote' };
  }
  return { available: true, reason: `Poll ${quoter.label} for the latest price` };
}

/** Toolbar toggles that reflect per-pane state. */
function syncToggles(): void {
  logButton?.setAttribute('aria-pressed', String(scaleMode === 'log'));
  glButton?.setAttribute('aria-pressed', String(rendererMode === 'webgl'));
  const picker = sel('#chart-type');
  if (picker !== null && chart !== null) picker.value = chart.chartType();
}

function switchSymbol(next: string): void {
  rememberSymbol(next);
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

/**
 * Compare overlay: a second instrument's relative performance on the same plot.
 *
 * Per CHART, not per symbol — it is a property of the view you have set up, the same way
 * an indicator is. Switching the primary keeps the comparison and re-aligns it against
 * the new bars, which is what `build()` does by re-applying it after the rebuild.
 */
let compareSymbol: string | null = null;

function applyCompare(target: Chart): void {
  syncCompareScaleButton();
  if (compareSymbol === null || compareSymbol === symbol) {
    target.setCompare(null);
    return;
  }
  const loadedCompare = loadSymbol(compareSymbol);
  target.setCompareScale(compareScaleMode);
  target.setCompare({ symbol: compareSymbol, bars: loadedCompare.bars });
}

/**
 * How the comparison is read. Per chart, like the comparison itself.
 *
 * Percent by default: it is what makes two instruments comparable at all. Own-scale adds
 * a second axis on the left showing the compared instrument's actual prices.
 */
let compareScaleMode: 'percent' | 'own' = 'percent';

const compareScaleButton = btn('#compare-scale');

/**
 * The toggle only exists while there is something to toggle.
 *
 * A control for a series that is not on the chart is a control that does nothing, and it
 * was costing a permanent slot in a bar that already overflows a 1920px window — the
 * overflow panel then hides a real control to make room for a dead one.
 */
function syncCompareScaleButton(): void {
  if (compareScaleButton === null) return;
  const active = compareSymbol !== null && compareSymbol !== symbol;
  compareScaleButton.hidden = !active;
  compareScaleButton.textContent = compareScaleMode === 'percent' ? '±%' : '⇤';
  compareScaleButton.setAttribute('aria-pressed', String(compareScaleMode === 'own'));
}

compareScaleButton?.addEventListener('click', () => {
  compareScaleMode = compareScaleMode === 'percent' ? 'own' : 'percent';
  syncCompareScaleButton();
  currentChart()?.setCompareScale(compareScaleMode);
});

const comparePick = sel('#compare-pick');
if (comparePick !== null) {
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Compare…';
  comparePick.append(none);
  for (const definition of SYMBOLS) {
    const option = document.createElement('option');
    option.value = definition.symbol;
    option.textContent = definition.symbol;
    comparePick.append(option);
  }
  comparePick.addEventListener('change', () => {
    compareSymbol = comparePick.value === '' ? null : comparePick.value;
    const target = currentChart();
    if (target !== null) applyCompare(target);
    status();
  });
}

const symbolInput = inp('#symbol-input');

async function loadTicker(ticker: string): Promise<void> {
  const name = ticker.trim().toUpperCase();
  if (name === '') return;
  // A generated series has no provider to ask; everything else goes through the chain,
  // INCLUDING the tickers that ship as CSVs. Short-circuiting those to the baked-in file
  // meant AAPL and TSLA loaded months-old bars that look exactly like fresh ones — and the
  // chain already ends in the bundled provider, so the file is still what answers when
  // nothing live can.
  if (findSymbol(name)?.source === 'synthetic') {
    switchSymbol(name);
    return;
  }
  setPending(`loading ${name}…`);
  // Daily first: it is the timeframe every provider in the chain can serve, so a symbol
  // loads even on a key with no intraday entitlement.
  const result = await market.series(name, '1d');
  if (!result.ok) {
    // Keep the current chart: blanking it, or relabelling the old bars, is worse than
    // saying plainly that the load failed.
    noteProviderIssue(`loading ${name}`, result.reason);
    setStatus(`${name}: ${result.reason}`);
    return;
  }
  rememberSymbol(name);
  symbol = name;
  bars = [...result.value.bars];
  tf = '1d';
  // The chain's last link is the CSV, so a load that fell through to it must NOT be
  // dressed up as live: the Live toggle reads this, and offering to poll a file is the
  // lie this field exists to prevent.
  loaded = { bars, timeframe: tf, origin: originOf(result.value.providerId), base: null };
  setLive(false);
  build();
  installControl();
  // `syncSymbolChrome`, not just the heading: the Live toggle's enabled state is decided
  // by where these bars came from, and setting the name by hand skipped it — so a symbol
  // that fell through to the CSV kept whatever state the previous symbol had left behind.
  syncSymbolChrome();
  syncTimeframes();
  renderLegend(null);
  setStatus(
    `${name} · ${String(result.value.bars.length)} daily bars · ${result.value.provider}`,
    4000,
  );
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
/**
 * How each timeframe is written on its button. Presentation only.
 *
 * The LIST of buttons is not here — it is `DATA_TIMEFRAMES`, walked below. A second list
 * naming the timeframes is exactly the defect this repo has already paid for three times:
 * `4h` was in the data layer, resolvable by the provider chain, and served natively by
 * Yahoo, yet had no button, so a timeframe the app fully supported was unreachable. A map
 * with a missing key degrades to the timeframe's own name; a missing array entry vanishes.
 */
const TIMEFRAME_LABELS: Readonly<Partial<Record<Timeframe, string>>> = Object.freeze({
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
});

const timeframeHost = el('#timeframes');
if (timeframeHost !== null) {
  for (const value of DATA_TIMEFRAMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb tf';
    button.dataset['tf'] = value;
    button.textContent = TIMEFRAME_LABELS[value] ?? value;
    button.addEventListener('click', () => {
      setTimeframe(value);
    });
    timeframeHost.append(button);
  }
}

/**
 * Which timeframes this symbol can actually be shown at, and why not when it cannot.
 *
 * A synthetic series carries its own 1-minute base and is resampled locally with no
 * network, so it answers for itself. Everything else asks the provider chain, which knows
 * what its keys entitle it to — that is what stops the app offering four intraday buttons
 * against a daily-only key and failing on every press.
 */
function timeframeAvailability(): Map<Timeframe, { available: boolean; reason: string }> {
  const out = new Map<Timeframe, { available: boolean; reason: string }>();
  if (loaded.base !== null) {
    // Locally resampled from a 1m base. Daily is excluded for the same reason the
    // provider layer excludes it: UTC day buckets do not line up with a trading session.
    for (const value of DATA_TIMEFRAMES) {
      out.set(value, {
        available: value !== '1d',
        reason: value === '1d' ? 'a day cannot be rolled up from generated minutes' : '',
      });
    }
    return out;
  }
  for (const entry of market.timeframes()) {
    out.set(entry.timeframe, {
      available: entry.origin !== 'unavailable',
      reason: entry.reason,
    });
  }
  return out;
}

function syncTimeframes(): void {
  const availability = timeframeAvailability();
  for (const node of document.querySelectorAll('#timeframes button')) {
    if (!(node instanceof HTMLButtonElement)) continue;
    const button = node;
    const value = (button.dataset['tf'] ?? '1m') as Timeframe;
    const entry = availability.get(value);
    const supported = entry?.available ?? false;
    button.disabled = !supported;
    button.style.opacity = supported ? '1' : '0.35';
    button.setAttribute('aria-pressed', String(value === tf));
    // The reason, not "not available" — a disabled control that does not say why is a
    // dead end, and the reason here is usually "your key does not cover intraday".
    button.title = supported ? `${value} bars` : (entry?.reason ?? 'not available for this symbol');
  }
}

function setTimeframe(next: Timeframe): void {
  if (next === tf) return;
  const base = loaded.base;
  if (base !== null) {
    // Synthetic: roll up locally. Instant, and no request against anyone's budget.
    const resampled = next === '1m' ? base : [...resample(base, '1m', next)];
    if (resampled.length === 0) return;
    bars = resampled;
    tf = next;
    loaded = { bars, timeframe: next, origin: loaded.origin, base };
    build();
    syncTimeframes();
    renderLegend(null);
    status();
    return;
  }
  void fetchTimeframe(symbol, next);
}

/**
 * Loads a real series for `wanted` and swaps it in.
 *
 * The chart is left alone until the bars arrive: blanking it while a request is in flight,
 * or worse relabelling the bars already on screen, is worse than a moment of the previous
 * timeframe with the status line saying what is happening.
 */
async function fetchTimeframe(forSymbol: string, wanted: Timeframe): Promise<void> {
  // Held until the outcome rather than for a fixed span: the request can outlast any hold
  // worth setting, and a fixed one lets the counters return before the answer does.
  setPending(`loading ${forSymbol} ${wanted}…`);
  const result = await market.series(forSymbol, wanted);
  // The user may have moved on while this was in flight. Applying it now would put one
  // symbol's bars under another's name — but the hold must still be released, or the line
  // would sit on a message about a symbol that is no longer on screen, forever.
  if (forSymbol !== symbol) {
    awaitingOutcome = false;
    return;
  }
  if (!result.ok) {
    noteProviderIssue(`${forSymbol} ${wanted}`, result.reason);
    setStatus(`${forSymbol} ${wanted}: ${result.reason}`);
    return;
  }
  bars = [...result.value.bars];
  tf = wanted;
  loaded = { bars, timeframe: wanted, origin: originOf(result.value.providerId), base: null };
  setLive(false);
  build();
  installControl();
  syncSymbolChrome();
  syncTimeframes();
  renderLegend(null);
  setStatus(
    `${forSymbol} ${wanted} · ${String(result.value.bars.length)} bars · ${result.value.provider}` +
      (result.value.origin === 'resampled'
        ? ` (rolled up from ${result.value.sourceTimeframe})`
        : ''),
    4000,
  );
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
    if ((isActive ? loaded.origin : pane.loaded.origin) !== 'generated') continue;
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

/**
 * Live state, as it is shown on the toggle.
 *
 * The distinction is the point: a chart that is not moving because the exchange is shut
 * and a chart that is not moving because the provider stopped answering look identical,
 * and only one of them is worth doing something about.
 */
type LiveState = 'off' | 'sim' | 'live' | 'closed' | 'stale';

const LIVE_LABEL: Readonly<Record<LiveState, string>> = Object.freeze({
  off: 'Live',
  sim: 'Sim',
  live: 'Live',
  closed: 'Closed',
  stale: 'Stale',
});

function setLiveState(state: LiveState, detail: string): void {
  const button = btn('#live-toggle');
  const label = el('#live-label');
  if (label !== null) label.textContent = LIVE_LABEL[state];
  button?.setAttribute('data-live-state', state);
  button?.setAttribute('title', detail);
}

/**
 * How often the quote is asked for.
 *
 * Just past the cache's own 20-second quote window, so a poll is a real request rather
 * than the same cached number handed back — and slow enough that a free key's per-minute
 * budget survives a chart left open all day.
 */
const QUOTE_POLL_MS = 25_000;
/**
 * After a roll-forward that changed nothing, wait this long before asking again.
 *
 * A roll can legitimately answer with the bars it already had: the provider cache holds a
 * series for a fraction of its own bar period, so the first ask after a bar closes may be
 * served from the page fetched during that bar. The new bar then arrives up to one cache
 * window late rather than immediately. Retrying every poll would spend the budget on the
 * same cached answer, so this backs off to roughly the length of that window.
 */
const ROLL_RETRY_MS = 30_000;

let quoteTimer: number | null = null;
/** True while a poll is out, so a slow provider cannot stack requests behind itself. */
let quotePending = false;
let nextRollAt = 0;

function setLive(on: boolean): void {
  const button = btn('#live-toggle');
  if (liveTimer !== null) {
    window.clearInterval(liveTimer);
    liveTimer = null;
  }
  if (quoteTimer !== null) {
    window.clearInterval(quoteTimer);
    quoteTimer = null;
  }
  button?.setAttribute('aria-pressed', String(on));
  if (!on) {
    setLiveState('off', 'Stream live prices');
    return;
  }
  // Simulated ticks and real quotes are the same toggle but not the same mechanism, and
  // which one runs is decided by the data on screen rather than by a separate control:
  // a generated series has no quote to fetch, and real bars must never be nudged by a
  // random walk.
  if (loaded.origin === 'generated') {
    liveTimer = window.setInterval(tick, 250);
    setLiveState('sim', 'Simulated ticks — this series is generated');
    return;
  }
  setLiveState('live', 'Polling the provider for the latest price');
  nextRollAt = 0;
  quoteTimer = window.setInterval(() => void pollQuote(), QUOTE_POLL_MS);
  // Immediately, too: waiting a full interval for the first price makes the toggle feel
  // broken for as long as it takes to wonder whether it worked.
  void pollQuote();
}

/**
 * Asks for the latest price and folds it into the bar it belongs to.
 *
 * The symbol and timeframe are captured before the request and re-checked after it: a
 * quote that arrives once the user has moved on describes an instrument that is no longer
 * drawn, and applying it would move one symbol's candle by another symbol's price.
 */
async function pollQuote(): Promise<void> {
  if (quotePending) return;
  const forSymbol = symbol;
  const forTimeframe = tf;
  const target = currentChart();
  if (target === null) return;
  quotePending = true;
  try {
    const result = await market.quote(forSymbol);
    if (forSymbol !== symbol || forTimeframe !== tf || quoteTimer === null) return;
    if (!result.ok) {
      noteProviderIssue(`quote for ${forSymbol}`, result.reason);
      setLiveState('stale', `${forSymbol}: ${result.reason}`);
      // No key and no entitlement do not improve by asking again every 25 seconds; a
      // rate limit or a dropped connection might, so those keep polling.
      if (result.kind === 'no-key' || result.kind === 'entitlement') setLive(false);
      return;
    }
    const quote = result.value;
    const current = target.series.get().bars;
    if (current.length === 0) return;
    const outcome = applyQuote(current[current.length - 1], quote, forTimeframe);
    if (outcome.kind === 'stale') {
      setLiveState('stale', `${forSymbol}: ${outcome.reason}`);
      return;
    }
    if (outcome.kind === 'refetch') {
      await rollForward(forSymbol, forTimeframe);
      return;
    }
    if (outcome.kind === 'update') {
      target.pushTick(outcome.bar);
      bars = [...target.series.get().bars];
      renderLegend(null);
    }
    // `marketOpen` is null when the provider does not say, which is not the same as
    // closed — reporting it as closed would explain a moving chart with a shut exchange.
    setLiveState(
      quote.marketOpen === false ? 'closed' : 'live',
      `${forSymbol} ${String(quote.price)}${quote.marketOpen === false ? ' · market closed' : ''}`,
    );
  } finally {
    quotePending = false;
  }
}

/**
 * Pulls the newest bars in when the quote has moved past the last one held.
 *
 * The bars are pushed in rather than rebuilding the chart, because a rebuild resets the
 * view — every bar boundary would snap a chart the user had panned back to the right-hand
 * edge. Bars at or after the current last are pushed, so the final partial bar is also
 * corrected with the volume the quote could not supply.
 */
async function rollForward(forSymbol: string, forTimeframe: Timeframe): Promise<void> {
  const now = Date.now();
  if (now < nextRollAt) return;
  const result = await market.series(forSymbol, forTimeframe, ROLL_FORWARD_BARS);
  if (forSymbol !== symbol || forTimeframe !== tf || quoteTimer === null) return;
  const target = currentChart();
  if (target === null) return;
  if (!result.ok) {
    noteProviderIssue(`bars for ${forSymbol}`, result.reason);
    setLiveState('stale', `${forSymbol}: ${result.reason}`);
    nextRollAt = Date.now() + ROLL_RETRY_MS;
    return;
  }
  const before = target.series.get().bars;
  const lastT = before.length === 0 ? 0 : before[before.length - 1].t;
  let applied = 0;
  for (const bar of result.value.bars) {
    if (bar.t < lastT) continue;
    target.pushTick(bar);
    applied += 1;
  }
  const after = target.series.get().bars;
  bars = [...after];
  renderLegend(null);
  // A cached page answers with the same bars it did a moment ago, which is not a failure
  // but is also not progress — backing off keeps a closed market from re-asking forever.
  if (applied === 0 || after.length === before.length) nextRollAt = Date.now() + ROLL_RETRY_MS;
}

/** Enough to close the current bar and open the next, with room for a gap. */
const ROLL_FORWARD_BARS = 5;

el('#live-toggle')?.addEventListener('click', () => {
  setLive(liveTimer === null && quoteTimer === null);
});

// ---------------------------------------------------------------- chart type

/**
 * The chart-type picker is built from `CHART_TYPES` itself.
 *
 * It used to be a second array naming all fourteen — identical in content and order, and
 * therefore a list that could only ever drift. That is the same defect this project has
 * already paid for in the pane allocator, the MCP server, `resolveToken` and the timeframe
 * buttons: a type added to the registry and forgotten here would compute, remap and render
 * correctly while being unreachable from the UI.
 */

const typeSelect = sel('#chart-type');
if (typeSelect !== null) {
  for (const type of CHART_TYPES) {
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
/**
 * Plots this indicator may read INSTEAD of price — every plot of every indicator that sits
 * earlier in the stack than it does.
 *
 * Earlier only, which is the same rule the chart enforces when resolving one: it makes a
 * cycle impossible by construction rather than something to detect, and it means the
 * picker never offers a choice the chart would silently refuse.
 */
function indicatorSourcesFor(handleId: string): { value: string; label: string }[] {
  const active = currentChart();
  if (active === null) return [];
  const stack = active.listIndicators();
  const selfAt = stack.findIndex((i) => i.handleId === handleId);
  if (selfAt < 0) return [];
  const options: { value: string; label: string }[] = [];
  for (const candidate of stack.slice(0, selfAt)) {
    const plots = computeIndicator(candidate.id, [], candidate.params).plots;
    for (const plot of plots) {
      options.push({
        value: `${candidate.handleId}:${plot.key}`,
        // The plot name only when the indicator draws more than one, so a lone RSI reads
        // as "RSI" rather than "RSI · rsi".
        label: plots.length === 1 ? candidate.id.toUpperCase() : `${candidate.id.toUpperCase()} · ${plot.label}`,
      });
    }
  }
  return options;
}

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
    sources: indicatorSourcesFor(handleId),
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
  'extended-line': '<path d="M2 20L22 4"/><circle cx="8" cy="15.6" r="2"/><circle cx="16" cy="9.6" r="2"/>',
  'horizontal-ray': '<path d="M4 12h17"/><circle cx="4" cy="12" r="2"/>',
  'parallel-channel': '<path d="M3 17L15 5"/><path d="M9 21L21 9"/><circle cx="3" cy="17" r="1.6"/><circle cx="15" cy="5" r="1.6"/>',
  'price-range': '<path d="M12 4v16"/><path d="M8 7l4-3 4 3"/><path d="M8 17l4 3 4-3"/>',
  'date-range': '<path d="M4 12h16"/><path d="M7 8l-3 4 3 4"/><path d="M17 8l3 4-3 4"/>',
  'date-price-range': '<rect x="4" y="6" width="16" height="12" rx="1"/><path d="M4 12h16M12 6v12"/>',
  'trend-angle': '<path d="M4 20h14"/><path d="M4 20L18 8"/><path d="M10 20a6 6 0 00.9-3.2"/>',
  polyline: '<path d="M3 17l5-6 4 4 4-8 5 5"/><circle cx="3" cy="17" r="1.6"/><circle cx="21" cy="12" r="1.6"/>',
  callout: '<path d="M4 5h16v10H11l-4 4v-4H4z"/>',
  'fib-fan': '<path d="M4 20L20 4M4 20L20 11M4 20L20 17"/><path d="M4 20h16"/>',
  'fib-time-zones': '<path d="M5 4v16M8 4v16M13 4v16M20 4v16"/>',
  'gann-box': '<rect x="4" y="4" width="16" height="16"/><path d="M4 20L20 4M4 4l16 16"/>',
  'elliott-correction': '<path d="M4 17l5-8 5 6 6-9"/>',
  'short-position':
    '<rect x="4" y="5" width="16" height="6"/><rect x="4" y="13" width="16" height="6"/><path d="M9 8h6"/>',
  arrow: '<path d="M4 18L19 6"/><path d="M13 5h6v6"/>',
  magnet: '<path d="M7 4v8a5 5 0 0010 0V4"/><path d="M7 8h4M13 8h4"/>',
  measure:
    '<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/>',
  erase: '<path d="M6 6l12 12M18 6L6 18"/>',
};

/**
 * The rail, as families rather than a flat list.
 *
 * Every kind in `TOOL_DEFINITIONS` appears in exactly one group, so nothing this app can
 * draw is unreachable — fifteen of thirty kinds had no rail entry before. Within a group
 * the first entry is what the slot shows until the user picks another, so the ordering is
 * "most reached for first", not alphabetical.
 */
const RAIL_GROUPS: readonly ToolGroup[] = [
  { id: 'cursor', label: 'Cursor', tools: ['cursor'] },
  {
    id: 'lines',
    label: 'Lines',
    tools: ['trendline', 'ray', 'extended-line', 'horizontal-line', 'horizontal-ray',
      'vertical-line', 'trend-angle', 'parallel-channel', 'polyline'],
  },
  { id: 'shapes', label: 'Shapes', tools: ['rectangle', 'ellipse', 'arrow'] },
  {
    id: 'fib',
    label: 'Fibonacci',
    tools: ['fib-retracement', 'fib-extension', 'fib-fan', 'fib-time-zones'],
  },
  { id: 'gann', label: 'Gann', tools: ['gann-fan', 'gann-box'] },
  { id: 'patterns', label: 'Patterns', tools: ['elliott-impulse', 'elliott-correction', 'pitchfork'] },
  {
    id: 'measure',
    label: 'Measure',
    tools: ['measure', 'price-range', 'date-range', 'date-price-range'],
  },
  { id: 'positions', label: 'Positions', tools: ['long-position', 'short-position'] },
  { id: 'notes', label: 'Annotations', tools: ['text-note', 'callout'] },
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

/** The rail component, or null when the host element is missing (tests render fragments). */
const toolRail =
  rail === null
    ? null
    : createToolRail(rail, {
        groups: RAIL_GROUPS,
        icon,
        label: (tool) => {
          const named = TOOL_LABELS[tool];
          if (named !== undefined) return named;
          return isDrawingTool(tool) ? TOOL_DEFINITIONS[tool].label : tool;
        },
        onSelect: (tool) => {
          // 'cursor' is the rail's name for "nothing armed"; the rest of main.ts spells
          // that as the empty string, and has since before the rail was grouped.
          activeTool = tool === 'cursor' ? '' : tool;
          pending = [];
          clearPlacement();
          status();
        },
      });

if (rail !== null && toolRail !== null) {
  toolRail.addSeparator();

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
  toolRail.addExtra(magnetButton);

  const eraseButton = document.createElement('button');
  eraseButton.type = 'button';
  eraseButton.title = 'Remove all drawings';
  eraseButton.setAttribute('aria-label', eraseButton.title);
  eraseButton.innerHTML = icon('erase');
  eraseButton.addEventListener('click', () => {
    capture();
    chart?.drawings.clear();
    pending = [];
    clearPlacement();
    status();
  });
  toolRail.addExtra(eraseButton);

  const objectsButton = document.createElement('button');
  objectsButton.type = 'button';
  objectsButton.id = 'objects-open';
  objectsButton.title = 'Objects on the chart';
  objectsButton.setAttribute('aria-label', objectsButton.title);
  objectsButton.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
  objectsButton.addEventListener('click', () => {
    if (objectTree.isOpen()) objectTree.close();
    else objectTree.open(objectRows());
  });
  toolRail.addExtra(objectsButton);
}

/**
 * The chart's drawings as rows, newest first.
 *
 * Newest first because the thing you just drew and cannot find is the thing you came here
 * to hide, and the store keeps paint order (oldest first) for the renderer's benefit.
 */
function objectRows(): ObjectRow[] {
  const target = currentChart();
  if (target === null) return [];
  const selected = target.drawings.selected();
  return [...target.drawings.list()].reverse().map((drawing) => ({
    id: drawing.id,
    label: TOOL_DEFINITIONS[drawing.kind].label,
    detail: describeDrawing(drawing.anchors),
    visible: drawing.visible,
    locked: drawing.locked,
    selected: drawing.id === selected,
  }));
}

/** A short, stable description: where it is, in the units the user reads off the axes. */
function describeDrawing(anchors: readonly { barIndex: number; price: number }[]): string {
  if (anchors.length === 0) return '';
  const decimals = chartSettings.pricePrecision;
  if (anchors.length === 1) return anchors[0].price.toFixed(decimals);
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const bars = Math.abs(Math.round(last.barIndex - first.barIndex));
  return `${first.price.toFixed(decimals)} → ${last.price.toFixed(decimals)} · ${String(bars)} bars`;
}

/** Re-renders the tree if it is showing. Cheap enough to call from every store change. */
function refreshObjectTree(): void {
  objectTree.update(objectRows());
}

const objectTree = createObjectTree({
  onSelect(id) {
    currentChart()?.drawings.select(id);
    refreshObjectTree();
  },
  onToggleVisible(id) {
    const target = currentChart();
    const drawing = target?.drawings.get(id) ?? null;
    if (target === null || drawing === null) return;
    capture();
    target.drawings.update(id, { visible: !drawing.visible });
    refreshObjectTree();
  },
  onToggleLocked(id) {
    const target = currentChart();
    const drawing = target?.drawings.get(id) ?? null;
    if (target === null || drawing === null) return;
    capture();
    target.drawings.update(id, { locked: !drawing.locked });
    refreshObjectTree();
  },
  onRemove(id) {
    capture();
    currentChart()?.drawings.remove(id);
    refreshObjectTree();
    status();
  },
  onAllVisible(visible) {
    const target = currentChart();
    if (target === null) return;
    capture();
    for (const drawing of target.drawings.list()) target.drawings.update(drawing.id, { visible });
    refreshObjectTree();
  },
  onAllLocked(locked) {
    const target = currentChart();
    if (target === null) return;
    capture();
    for (const drawing of target.drawings.list()) target.drawings.update(drawing.id, { locked });
    refreshObjectTree();
  },
});

// ---------------------------------------------------------------- placement

/**
 * A message that holds the status line for a while, instead of being wiped instantly.
 *
 * `status()` runs on a 1-second interval to keep the counters honest, and it used to
 * overwrite whatever `setStatus` had just written. So "loading GOOG…" and "no API key"
 * both appeared for under a second: loading an unlisted ticker looked like the button did
 * nothing at all, when in fact it was reporting a perfectly clear refusal.
 */
let stickyUntil = 0;

/** Writes the line. No policy — `status()` and `setStatus` both go through here. */
function writeStatus(text: string): void {
  const element = el('#status');
  if (element !== null) element.textContent = text;
}

/**
 * A transient message that holds the line against the ticking counters.
 *
 * Separate from `writeStatus` because `status()` writes too: if the routine refresh also
 * armed the hold, the first tick would pin the line forever.
 */
function setStatus(text: string, holdMs = 6000): void {
  awaitingOutcome = false;
  writeStatus(text);
  stickyUntil = performance.now() + holdMs;
}

/**
 * True while a request is in flight, so the counters cannot reclaim the line before the
 * answer arrives.
 *
 * A timed hold cannot do this job: it is a clock racing a network, and the loser is the
 * reader. Loading a symbol no provider carries took about ten seconds to resolve while the
 * "loading…" message expired after six, so the counters came back — the chart looked
 * settled and unchanged — and then a failure appeared out of nowhere four seconds later.
 *
 * A flag is only safe because every provider now has a deadline: the outcome always
 * arrives, so this is always cleared.
 */
let awaitingOutcome = false;

/** Announces work that will report its own outcome. Holds the line until it does. */
function setPending(text: string): void {
  writeStatus(text);
  awaitingOutcome = true;
}

function status(): void {
  if (awaitingOutcome || performance.now() < stickyUntil) return;
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
  writeStatus(
    `${String(indicators)} indicator${indicators === 1 ? '' : 's'} · ${String(shapes)} drawing${
      shapes === 1 ? '' : 's'
    }${armed === 0 ? '' : ` · ${String(armed)} alert${armed === 1 ? '' : 's'}`}${
      magnet === 'off' ? '' : ' · magnet'
    }${placing}`,
  );
}

/**
 * Names where the bars on screen came from. Shown in the legend, beside the timeframe.
 *
 * Permanent rather than transient, because it is the first question to ask when the chart
 * is not doing what was expected — a symbol that will not load and a greyed-out timeframe
 * have completely different explanations depending on which chain is live, and until this
 * was on screen there was no way to tell from the outside which one it was.
 *
 * In the legend rather than the status line: `#status` is `flex: 0 0 auto` precisely so it
 * never shrinks, so anything added to it widens the toolbar and evicts a control into the
 * overflow panel at a width that previously fitted. The legend floats over the plot and
 * costs the toolbar nothing.
 *
 * Derived, never stored: the provider that serves the current timeframe is a fact the
 * chain already knows, and a copy kept alongside it would be one more thing to go stale.
 */
function dataSource(): string {
  if (loaded.origin === 'generated') return 'demo data';
  if (loaded.origin === 'bundled') return 'bundled data';
  const entry = market.timeframes().find((candidate) => candidate.timeframe === tf);
  return entry?.provider ?? 'live data';
}

/**
 * Commits the anchors placed so far as a drawing.
 *
 * `barMs` rides along for the tools that report elapsed time. Geometry is handed the two
 * projectors and the plot box and nothing else — a bar index becomes an x, but nothing in
 * there says how much TIME a bar spans, so the timeframe has to come from here. Passing 0
 * (the default) makes those tools report the bar count alone rather than invent a
 * duration, which is why this is not merely cosmetic.
 */
function commitPending(kind: DrawingKind): void {
  const target = chart;
  if (target === null || pending.length < minimumAnchors(kind)) return;
  capture();
  target.drawings.add(kind, pending, { params: { barMs: TIMEFRAME_MS[tf] } });
  pending = [];
  clearPlacement();
  status();
}

/**
 * Finishes a variable-length placement early — Enter, or a double-click on the chart.
 *
 * Only the polyline has anything to finish early today; for every other tool the minimum
 * and the full arity are the same number and this is a no-op, which is what keeps the
 * gesture from surprising anyone using a two-anchor tool.
 */
function finishPending(): boolean {
  if (!isDrawingTool(activeTool)) return false;
  const definition = TOOL_DEFINITIONS[activeTool];
  const minimum = minimumAnchors(activeTool);
  if (minimum >= definition.anchorCount) return false;
  if (pending.length < minimum) return false;
  commitPending(activeTool);
  return true;
}

let downAt: { x: number; y: number } | null = null;
panesHost.addEventListener('pointerdown', (event) => {
  downAt = { x: event.clientX, y: event.clientY };
});

panesHost.addEventListener('dblclick', () => {
  finishPending();
});

panesHost.addEventListener('click', (event) => {
  if (!isDrawingTool(activeTool) || chart === null) return;
  const start = downAt;
  // A click that followed a drag was a pan, not a placement.
  if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;

  const rect = hostOf(event).getBoundingClientRect();
  const snapped = chart.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, magnet);
  // The SAME constraint the preview drew with. Applying it to the preview only would
  // show a 45° line and then commit a different one — worse than not offering it.
  const placedAnchor =
    event.shiftKey && pending.length > 0
      ? chart.constrainAnchor(pending[pending.length - 1], snapped.anchor)
      : snapped.anchor;
  pending = [...pending, placedAnchor];

  if (pending.length >= TOOL_DEFINITIONS[activeTool].anchorCount) {
    commitPending(activeTool);
  } else {
    // Repin immediately rather than waiting for the next pointer move, so the anchor
    // shows up under the cursor the instant it is clicked.
    chart.setPlacement({ kind: activeTool, placed: pending, cursor: placedAnchor });
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
  adoptSavedAnnotations(savedPane);
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
    if (target !== null) {
      restorePane(target, state);
      adoptSavedAnnotations(state);
    }
  }
  setActivePane(0);
}
status();

// Fire and forget: it resolves to nothing at all outside a published page, and the chart
// must not wait on a promise that will usually answer `null`.
void adoptConnectorProvider();

// ---------------------------------------------------------------- symbol search

const searchDialog = document.querySelector('#search');
const searchInput = inp('#search-input');
const searchResults = document.querySelector('#search-results');
let searchIndex = 0;

interface Candidate {
  readonly symbol: string;
  readonly label: string;
  readonly source: string;
  readonly symbolRanges: readonly MatchRange[];
  readonly labelRanges: readonly MatchRange[];
}

/**
 * Remote hits for the query they were fetched for.
 *
 * Held with their query rather than alone: a response that arrives after the user has
 * typed further describes a query that is no longer on screen, and merging it would show
 * results for text nobody can see. `remoteFor` is compared before anything is merged.
 */
let remoteHits: readonly SymbolHit[] = [];
let remoteFor = ' ';
let remoteNote = '';
let remoteSeq = 0;
let remoteTimer: number | null = null;

/** A symbol the ranker can score, plus where it came from. */
interface SearchEntry {
  readonly symbol: string;
  readonly label: string;
  readonly source: string;
}

function candidates(query: string): Candidate[] {
  const q = query.trim().toUpperCase();

  const entries: SearchEntry[] = SYMBOLS.map((definition) => ({
    symbol: definition.symbol,
    label: definition.label,
    source: definition.source === 'synthetic' ? 'demo' : 'bundled',
  }));

  // Remote hits join the SAME ranking pass rather than being appended in a block below
  // the local ones. Appending would put an exact remote ticker under a fuzzy bundled
  // match — typing NVDA would offer four other things before the one instrument that is
  // exactly what was typed.
  if (remoteFor === q) {
    const known = new Set(entries.map((entry) => entry.symbol));
    for (const hit of remoteHits) {
      if (known.has(hit.symbol)) continue;
      known.add(hit.symbol);
      entries.push({
        symbol: hit.symbol,
        label: hit.name === '' ? hit.symbol : hit.name,
        // The venue, not the vendor: TSLA on NASDAQ and TSLA on BMV are different
        // instruments in different currencies, and that is the distinction worth the
        // column. Which provider answered is a diagnostic, not something to pick between.
        source: hit.exchange === '' ? hit.country : hit.exchange,
      });
    }
  }

  const ranked = searchSymbols(query, entries, { recents: recentSymbols }).map((hit) => ({
    symbol: hit.item.symbol,
    label: hit.item.label,
    source: hit.item.source,
    symbolRanges: hit.symbolRanges,
    labelRanges: hit.labelRanges,
  }));

  // An unmatched query is still offered: search covers the venues the providers index,
  // and the series endpoints accept tickers the search index does not list. Offering it
  // and failing loudly beats pretending the symbol does not exist.
  if (q !== '' && !ranked.some((c) => c.symbol === q)) {
    ranked.push({
      symbol: q,
      label: `Load ${q} from the data provider`,
      source: 'fetch',
      symbolRanges: [],
      labelRanges: [],
    });
  }
  return ranked;
}

/**
 * Asks the provider chain about `query`, debounced.
 *
 * Debounced rather than fired per keystroke because a five-letter ticker is five
 * requests against a metered budget, four of which describe a prefix the user was only
 * passing through. The sequence number is what keeps a slow first response from landing
 * on top of a fast second one — comparing the query alone does not, since the same query
 * can be in flight twice after a backspace and retype.
 */
function scheduleRemoteSearch(query: string): void {
  const q = query.trim().toUpperCase();
  if (remoteTimer !== null) window.clearTimeout(remoteTimer);
  remoteTimer = null;
  if (q === '') {
    remoteHits = [];
    remoteFor = '';
    remoteNote = '';
    return;
  }
  if (remoteFor === q) return;
  remoteNote = 'searching…';
  remoteTimer = window.setTimeout(() => {
    remoteTimer = null;
    const seq = ++remoteSeq;
    void market.search(q).then((result) => {
      if (seq !== remoteSeq) return;
      remoteFor = q;
      if (result.ok) {
        remoteHits = result.value;
        remoteNote = result.value.length === 0 ? 'no venue lists that' : '';
      } else {
        // The reason, not a generic failure: "you have used your 8 credits" and "no key"
        // call for completely different actions from the reader.
        remoteHits = [];
        remoteNote = result.reason;
        noteProviderIssue(`search for ${q}`, result.reason);
      }
      // Only if the dialog is still showing this query — the user may have typed on, or
      // closed the dialog entirely, while the request was out.
      if (searchInput !== null && searchInput.value.trim().toUpperCase() === q) renderSearch();
    });
  }, SEARCH_DEBOUNCE_MS);
}

/** Long enough to skip the letters of a ticker typed at speed, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 220;

/** Escapes text destined for `innerHTML`. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escapes `text` and wraps the matched ranges in `<mark>`.
 *
 * Escaping happens per SEGMENT rather than up front, because escaping first shifts every
 * index (`&` becomes five characters) and the ranges would then point at the wrong
 * places. This also closes a real hole: the "fetch from the network" row carries the raw
 * query as its ticker, so a query containing markup used to be written straight into
 * `innerHTML`.
 */
function highlight(text: string, ranges: readonly MatchRange[]): string {
  if (ranges.length === 0) return escapeHtml(text);
  let out = '';
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out += escapeHtml(text.slice(at, start));
    out += `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + escapeHtml(text.slice(at));
}

function renderSearch(): void {
  if (searchResults === null || searchInput === null) return;
  const list = candidates(searchInput.value);
  searchIndex = Math.min(searchIndex, Math.max(0, list.length - 1));
  searchResults.innerHTML = list
    .map(
      (c, i) =>
        `<li role="option" aria-selected="${String(i === searchIndex)}" ` +
        `data-symbol="${escapeHtml(c.symbol)}">` +
        `<span class="tk">${highlight(c.symbol, c.symbolRanges)}</span>` +
        `<span class="nm">${highlight(c.label, c.labelRanges)}</span>` +
        `<span class="src">${escapeHtml(c.source)}</span></li>`,
    )
    .join('');
  const note = el('#search-note');
  if (note !== null) note.textContent = searchNote();
}

/**
 * The line under the results.
 *
 * Says what the search actually covered, since that changes with the key: without one,
 * Twelve Data's symbol index still answers (it needs no credential) but the series behind
 * a hit will not load, and promising otherwise sets the reader up to pick a symbol that
 * then fails.
 */
function searchNote(): string {
  if (remoteNote !== '') return remoteNote;
  if (remoteFor !== '' && remoteHits.length > 0) {
    return `${String(remoteHits.length)} across all venues`;
  }
  return params.get('apikey') === null ? 'intraday needs ?apikey=' : 'live data enabled';
}

function openSearch(): void {
  if (!(searchDialog instanceof HTMLDialogElement)) return;
  searchIndex = 0;
  if (searchInput !== null) searchInput.value = '';
  // The box is cleared on open, so last session's hits belong to a query that is no
  // longer there; leaving them would show a stale list against an empty field.
  remoteHits = [];
  remoteFor = '';
  remoteNote = '';
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
  scheduleRemoteSearch(searchInput.value);
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
/**
 * A pane's whole per-symbol drawing map, with the live chart folded in.
 *
 * The map on the record is only as fresh as the last rebuild, and the chart on screen has
 * moved on since — so the symbol being displayed is read from the chart itself, and the
 * symbols NOT displayed come from the record. Saving only the live chart would drop every
 * other symbol's drawings on the next autosave, which is the bug this map exists to fix,
 * reintroduced one layer down.
 */
function drawingMapOf(pane: Pane, isActive: boolean, target: Chart): Record<string, string> {
  const map = new Map(isActive ? drawingsBySymbol : pane.drawingsBySymbol);
  const shown = isActive ? chartSymbol : pane.symbol;
  if (target.drawings.list().length > 0) map.set(shown, target.drawings.toJSON());
  else map.delete(shown);
  return Object.fromEntries(map);
}

/**
 * Takes the annotations a saved pane just restored into the module state.
 *
 * Two halves. The symbols NOT on screen come straight from the payload — nothing on the
 * chart knows about them. The symbol that IS on screen is read back off the chart by
 * `captureAnnotations`, so the live indicator handles and the saved specs cannot drift
 * apart. Runs after `restorePane`, never before: it is reading the result of it.
 */
function adoptSavedAnnotations(state: PaneState): void {
  drawingsBySymbol = new Map(Object.entries(state.drawingsBySymbol));
  captureAnnotations();
  stashActive();
}

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
    drawingsBySymbol: drawingMapOf(pane, isActive, target),
    alerts: target.alerts.list().length > 0 ? target.alerts.toJSON() : null,
    paneFractions: target.paneFractions(),
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

/**
 * Set while a saved layout is being applied, to stop the autosave overwriting it.
 *
 * Opening a layout writes it to the autosave key and reloads, so the tested boot-time
 * restore does the work. But `beforeunload` also autosaves — so the reload was saving the
 * chart the user was leaving over the layout they had just asked for, and then faithfully
 * restoring that. The layout appeared to do nothing at all.
 */
let suspendAutosave = false;

function persist(): void {
  if (suspendAutosave) return;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    // Checked again here, not only on the way in: a save scheduled BEFORE the flag was
    // set would otherwise still fire and land on top of the layout being applied. Putting
    // the guard where the write happens makes the ordering irrelevant, which is better
    // than clearing the timer at the call site and hoping every future caller remembers.
    if (suspendAutosave) return;
    const workspace = snapshotWorkspace();
    if (workspace !== null) saveWorkspace(workspace);
  }, 400);
}

window.setInterval(persist, 2000);
window.addEventListener('beforeunload', () => {
  if (suspendAutosave) return;
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
/**
 * Dragging the divider between stacked panes.
 *
 * Kept separate from the drawing drag: that one runs in the capture phase over the plot,
 * while this starts in the GAP between panes where no drawing can be, so the two can
 * never contend for the same pointerdown.
 */
let paneDrag: { readonly host: HTMLElement; readonly index: number } | null = null;

panesHost.addEventListener(
  'pointerdown',
  (event) => {
    if (activeTool !== '' || event.button !== 0) return;
    const active = currentChart();
    if (active === null) return;
    const host = hostOf(event);
    const divider = active.dividerAt(event.clientY - host.getBoundingClientRect().top);
    if (divider === null) return;
    paneDrag = { host, index: divider.index };
    host.setPointerCapture(event.pointerId);
    // Pan must not also see this: the pointer is over the chart, and the pan handler has
    // no idea the gap between panes means something.
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);

window.addEventListener('pointermove', (event) => {
  const active = paneDrag;
  if (active === null) return;
  currentChart()?.dragDivider(active.index, event.clientY - active.host.getBoundingClientRect().top);
});

window.addEventListener('pointerup', (event) => {
  if (paneDrag === null) return;
  paneDrag.host.releasePointerCapture(event.pointerId);
  paneDrag = null;
  // The chart owns the live value; mirror it so the next rebuild restores what was
  // dragged rather than snapping back to the default split.
  paneFractions = currentChart()?.paneFractions() ?? paneFractions;
  persist();
});

panesHost.addEventListener('pointermove', (event) => {
  const active = currentChart();
  if (active === null || drag !== null || paneDrag !== null) return;
  if (activeTool !== '') {
    hostOf(event).style.cursor = 'crosshair';
    if (isDrawingTool(activeTool)) pushPlacement(event);
    return;
  }
  const host = hostOf(event);
  if (active.dividerAt(event.clientY - host.getBoundingClientRect().top) !== null) {
    host.style.cursor = 'ns-resize';
    return;
  }
  const point = localPoint(event);
  host.style.cursor = active.hitTestAt(point.x, point.y) === null ? 'default' : 'move';
});

/**
 * Hands the in-progress drawing to the chart so the renderer can paint it.
 *
 * Called on every pointer move with a tool armed, which is the cadence the rubber band
 * needs — the crosshair layer already repaints at exactly that rate.
 */
function pushPlacement(event: PointerEvent): void {
  const active = currentChart();
  if (active === null || !isDrawingTool(activeTool)) return;
  const rect = hostOf(event).getBoundingClientRect();
  const snapped = active.pickAnchor(event.clientX - rect.left, event.clientY - rect.top, magnet);
  // Shift constrains to 45°, but only once there is something to measure the angle FROM.
  const cursor =
    event.shiftKey && pending.length > 0
      ? active.constrainAnchor(pending[pending.length - 1], snapped.anchor)
      : snapped.anchor;
  active.setPlacement({ kind: activeTool, placed: pending, cursor });
}

/** Takes the preview off every pane. Disarming, finishing and Escape all land here. */
function clearPlacement(): void {
  for (const pane of panes) pane.chart?.setPlacement(null);
  currentChart()?.setPlacement(null);
}

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
  // Tier 3 tools. Letters picked to be mnemonic and unused: `a` for angle, `c` for
  // channel, `p` for polyline, `n` for the callout note, `d` for the date range.
  a: 'trend-angle',
  c: 'parallel-channel',
  p: 'polyline',
  n: 'callout',
  d: 'date-range',
};

function selectTool(kind: string): void {
  activeTool = kind;
  pending = [];
  clearPlacement();
  // The rail reflects what is armed; it does not decide it. A keyboard shortcut for a
  // tool tucked inside a flyout also makes it that group's shown member, so the next
  // click on the slot repeats it.
  toolRail?.select(kind === '' ? 'cursor' : kind);
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
  // Enter finishes a variable-length placement. Checked before Escape's cancel so the two
  // gestures stay distinct: Enter keeps what you drew, Escape throws it away.
  if (event.key === 'Enter' && finishPending()) {
    event.preventDefault();
    return;
  }
  if (event.key === 'Escape') {
    if (active?.measure() != null) {
      active.setMeasure(null);
      return;
    }
    if (pending.length > 0) {
      pending = [];
      clearPlacement();
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

// ---------------------------------------------------------------- saved layouts

/**
 * Named layouts, on top of the autosave.
 *
 * The autosave is where you are right now; a named layout is a snapshot you chose to
 * keep. Saving one deliberately does NOT stop the autosave tracking the live chart —
 * otherwise "save" would quietly become "switch to", and the next edit would go to the
 * saved copy instead of to the session you are actually in.
 */
const layoutSelect = sel('#saved-layouts');

function renderLayoutList(): void {
  if (layoutSelect === null) return;
  const saved = listLayouts();
  layoutSelect.innerHTML = '';
  const head = document.createElement('option');
  head.value = '';
  head.textContent = saved.length === 0 ? 'Layouts…' : `Layouts (${String(saved.length)})`;
  layoutSelect.append(head);

  for (const entry of saved) {
    const option = document.createElement('option');
    option.value = `open:${entry.id}`;
    option.textContent = entry.name;
    layoutSelect.append(option);
  }

  const separator = document.createElement('option');
  separator.disabled = true;
  separator.textContent = '──────────';
  layoutSelect.append(separator);

  const save = document.createElement('option');
  save.value = 'save';
  save.textContent = 'Save current as…';
  layoutSelect.append(save);

  if (saved.length > 0) {
    const remove = document.createElement('option');
    remove.value = 'manage';
    remove.textContent = 'Delete a layout…';
    layoutSelect.append(remove);
  }
  layoutSelect.value = '';
}

/**
 * Applies a whole workspace: layout, panes and all.
 *
 * Reloads rather than rebuilding in place. Boot already knows how to restore a workspace
 * — symbols, panes, per-symbol drawings, indicators, alerts, pane heights and the view —
 * and re-implementing that here would be a second restore path that drifts from the one
 * that runs every time the app starts. The workspace is written to the autosave key and
 * the page is reloaded, so the tested path does the work.
 */
function applyLayout(id: string): void {
  const workspace = loadLayout(id);
  if (workspace === null) {
    setStatus('that layout could not be read');
    return;
  }
  // Before writing, not after: `persist` checks this flag both on entry and inside its
  // debounced callback, so setting it here is enough to stop an in-flight save landing on
  // top of the layout between this write and the reload.
  suspendAutosave = true;
  saveWorkspace(workspace);
  window.location.reload();
}

const textPrompt = createTextPrompt();

async function saveCurrentLayout(): Promise<void> {
  const workspace = snapshotWorkspace();
  if (workspace === null) return;
  const name = await textPrompt.ask({
    title: 'Save layout',
    label: 'Name',
    confirmLabel: 'Save',
  });
  if (name === null || name === '') return;
  const entry = saveLayout(name, workspace);
  renderLayoutList();
  setStatus(entry === null ? 'could not save that layout' : `saved “${entry.name}”`);
}

async function deleteNamedLayout(): Promise<void> {
  const saved = listLayouts();
  const name = await textPrompt.ask({
    title: 'Delete layout',
    label: `Name — one of: ${saved.map((l) => l.name).join(', ')}`,
    confirmLabel: 'Delete',
  });
  if (name === null || name === '') return;
  const match = saved.find((l) => l.name === name);
  if (match === undefined) {
    setStatus(`no layout named “${name}”`);
    return;
  }
  deleteLayout(match.id);
  renderLayoutList();
  setStatus(`deleted “${match.name}”`);
}

layoutSelect?.addEventListener('change', () => {
  const value = layoutSelect.value;
  layoutSelect.value = '';
  if (value === '') return;
  if (value === 'save') void saveCurrentLayout();
  else if (value === 'manage') void deleteNamedLayout();
  else if (value.startsWith('open:')) applyLayout(value.slice('open:'.length));
});

renderLayoutList();

// ---------------------------------------------------------------- toolbar overflow

/**
 * Keeps the top bar's controls reachable at any window width.
 *
 * Installed last, so every control the bar will ever hold is already in the DOM when the
 * first measurement runs — the overflow moves real nodes, and a control added afterwards
 * would never be considered for eviction.
 */
const overflowBar = el('#topbar');
const overflowButton = el('#toolbar-more');
const overflowPanel = el('#toolbar-overflow');
if (overflowBar !== null && overflowButton !== null && overflowPanel !== null) {
  createToolbarOverflow(overflowBar, overflowButton, overflowPanel);
}
