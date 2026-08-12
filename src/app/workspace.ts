/**
 * Workspace persistence — symbol, timeframe, chart type, indicators, drawings and view,
 * saved to localStorage so a reload lands you back where you were.
 *
 * Rules that keep a bad save from bricking the app:
 *   Loading is TOTAL. A corrupt, truncated or older payload returns null and the caller
 *   falls back to defaults; it never throws into boot.
 *   Every field is validated on the way in. Restoring a chart type or indicator id that
 *   no longer exists would throw deep inside the registry, far from the real cause.
 *   The version is checked, not assumed — a schema change discards old state rather than
 *   half-applying it.
 */

import { CHART_TYPES, type ChartType } from '../charts/types.js';
import { INDICATOR_IDS } from '../indicators/registry.js';
import type { IndicatorId, IndicatorParams } from '../indicators/types.js';
import { TIMEFRAMES, type PriceScaleMode, type Timeframe } from '../data/types.js';
import type { PlotStyles, PlotStyleOverride } from '../renderer/layers/annotationsLayer.js';

const KEY = 'tdv-shadow.workspace';
/**
 * Bumped to 2 when the schema became per-pane (10.4), and to 3 when drawings became
 * per-SYMBOL rather than per-pane.
 *
 * A version-1 payload described one chart and is still discarded — the loader's contract
 * is that a payload it cannot fully understand is not applied at all. Version 2 IS fully
 * understood, though: its single `drawings` blob is exactly the set that was on screen
 * for that pane's saved symbol, so it migrates cleanly by filing it under that symbol.
 * Discarding it instead would delete the user's drawings on upgrade, which is the very
 * failure this schema change exists to stop.
 */
const VERSION = 3;
const OLDEST_MIGRATABLE = 2;

/** Everything one pane remembers. Panes are independent charts, so this is per pane. */
export interface PaneState {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly chartType: ChartType;
  readonly priceScaleMode: PriceScaleMode;
  /** §2.1 price-axis inversion. */
  readonly priceScaleInverted: boolean;
  readonly indicators: readonly {
    readonly id: IndicatorId;
    readonly params: IndicatorParams;
    readonly styles: PlotStyles;
  }[];
  /**
   * Serialised drawing stores, keyed by the SYMBOL they were drawn on.
   *
   * TradingView's model, and the one this app now follows: a drawing belongs to the
   * instrument, not to the chart that happens to be showing it. Switch AAPL → MSFT and
   * the AAPL drawings are put away, not deleted; switch back and they return. Before
   * this the pane held one blob, so a symbol change destroyed it outright.
   *
   * Indicators are deliberately NOT keyed this way — see `indicators` above. They belong
   * to the chart and follow it across a symbol change, which is also TradingView's model.
   */
  readonly drawingsBySymbol: Readonly<Record<string, string>>;
  /** Serialised alert store (9.2), or null when there are none. */
  readonly alerts: string | null;
  readonly barSpacing: number;
  readonly scrollPosition: number;
  /**
   * Pane heights the user dragged to, or null for the default split.
   *
   * Added without a version bump: it is optional in both directions, so a v3 payload
   * without it loads as null (the default), and a v3 reader that predates it ignores the
   * field. Bumping would have discarded every existing workspace to add one nullable
   * number list, which is a worse trade than the one the v2 migration was worth.
   */
  readonly paneFractions: readonly number[] | null;
}

export interface Workspace {
  /**
   * One entry per pane, in pane order.
   *
   * Before this the workspace held a single chart's state plus a list of pane SYMBOLS, so
   * a reload restored what the other panes were showing but silently dropped every
   * indicator, drawing and alert on them.
   */
  readonly panes: readonly PaneState[];
  /** Multi-chart layout (10.4). */
  readonly layout: '1' | '2h' | '2v' | '4';
  /** Renderer choice is global: it is a capability of the build, not of a chart. */
  readonly renderer: 'canvas2d' | 'webgl';
  /** Presentation settings (8.3). Null when the payload predates them. */
  readonly chartSettings: ChartSettings | null;
}

/** Mirrors `ChartSettingsForm` in ui/chartDialog, kept structural to avoid a UI import. */
export interface ChartSettings {
  readonly showGrid: boolean;
  readonly timeZone: string;
  readonly pricePrecision: number;
  readonly rightMargin: number;
  readonly upColor: string;
  readonly downColor: string;
}

const readLayout = (value: unknown): Workspace['layout'] =>
  value === '2h' || value === '2v' || value === '4' ? value : '1';

const isColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value);

/**
 * Total, like everything else in this file: one bad field discards the settings block
 * rather than the whole workspace, and rather than handing a junk string to a canvas
 * `fillStyle`.
 */
function readChartSettings(value: unknown): ChartSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const precision = record['pricePrecision'];
  const margin = record['rightMargin'];
  if (typeof record['showGrid'] !== 'boolean') return null;
  if (typeof precision !== 'number' || precision < 0 || precision > 8) return null;
  if (typeof margin !== 'number' || margin < 0 || margin > 80) return null;
  if (!isColor(record['upColor']) || !isColor(record['downColor'])) return null;
  return {
    showGrid: record['showGrid'],
    // Defaulted, not rejected: a payload written before timezones existed is still
    // perfectly usable, and an unknown zone falls back to UTC in the formatter anyway.
    timeZone: typeof record['timeZone'] === 'string' ? record['timeZone'] : 'UTC',
    pricePrecision: Math.round(precision),
    rightMargin: Math.round(margin),
    upColor: record['upColor'],
    downColor: record['downColor'],
  };
}

const isChartType = (value: unknown): value is ChartType =>
  typeof value === 'string' && (CHART_TYPES as readonly string[]).includes(value);
const isTimeframe = (value: unknown): value is Timeframe =>
  typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value);
const isIndicatorId = (value: unknown): value is IndicatorId =>
  typeof value === 'string' && (INDICATOR_IDS as readonly string[]).includes(value);
const isParams = (value: unknown): value is IndicatorParams =>
  typeof value === 'object' && value !== null;

/**
 * Per-plot style overrides, field by field. A saved colour is applied to a canvas
 * `strokeStyle`, so an unvalidated string from localStorage would be handed straight to
 * the renderer; anything that is not a plain colour-ish string is dropped instead.
 */
function readStyles(value: unknown): PlotStyles {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, PlotStyleOverride> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const override: {
      color?: string;
      lineWidth?: number;
      dash?: number[];
    } = {};
    const color = entry['color'];
    if (typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color)) override.color = color;
    const lineWidth = entry['lineWidth'];
    if (typeof lineWidth === 'number' && lineWidth > 0 && lineWidth <= 8) {
      override.lineWidth = lineWidth;
    }
    const dash = entry['dash'];
    if (Array.isArray(dash) && dash.every((n) => typeof n === 'number' && n >= 0)) {
      override.dash = dash as number[];
    }
    if (Object.keys(override).length > 0) out[key] = override;
  }
  return out;
}

export function saveWorkspace(workspace: Workspace): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, ...workspace }));
  } catch {
    // Private browsing and full quotas both throw here. Losing the layout is acceptable;
    // breaking the chart over it is not.
  }
}

export function loadWorkspace(): Workspace | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  return parseWorkspace(raw);
}

/**
 * Validates a serialised workspace, wherever it came from.
 *
 * Shared by the autosave and by named layouts on purpose: two copies of this would drift
 * the first time the schema moved, and then a payload would load as one and be rejected
 * as the other.
 */
function parseWorkspace(raw: string): Workspace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'number' || version < OLDEST_MIGRATABLE || version > VERSION) return null;
  const rawPanes = record['panes'];
  if (!Array.isArray(rawPanes)) return null;

  const panes = rawPanes.flatMap((entry) => {
    const pane = readPane(entry);
    return pane === null ? [] : [pane];
  });
  // A workspace with no usable pane is not a workspace; falling back to defaults beats
  // booting into an empty grid.
  if (panes.length === 0) return null;

  const renderer = record['renderer'];
  return {
    panes: panes.slice(0, 4),
    layout: readLayout(record['layout']),
    renderer: renderer === 'webgl' ? 'webgl' : 'canvas2d',
    chartSettings: readChartSettings(record['chartSettings']),
  };
}

/**
 * The per-symbol drawing map, migrating a version-2 pane on the way.
 *
 * v2 stored one `drawings` string per pane. That blob was whatever was on screen, and a
 * pane also records the symbol it was showing — so the blob belongs to that symbol and
 * nothing is guessed by filing it there. A v2 pane whose symbol is missing has nowhere to
 * file its drawings and drops them, which is the only lossy path and is unreachable in
 * practice because `readPane` already rejects a pane without a string symbol.
 */
function readDrawingsBySymbol(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};

  const modern = record['drawingsBySymbol'];
  if (typeof modern === 'object' && modern !== null) {
    for (const [symbol, json] of Object.entries(modern as Record<string, unknown>)) {
      if (typeof json === 'string' && symbol !== '') out[symbol] = json;
    }
  }

  // v2 migration. Never overwrites a v3 entry: if both shapes are somehow present the
  // newer one is the truth.
  const legacy = record['drawings'];
  const symbol = record['symbol'];
  if (typeof legacy === 'string' && typeof symbol === 'string' && !(symbol in out)) {
    out[symbol] = legacy;
  }
  return out;
}

/**
 * Pane height fractions, or null.
 *
 * Every entry must be a finite number in (0, 1): these are divided into a pixel budget,
 * and a NaN or a negative would propagate into a `Rect` and out into `fillRect`.
 */
function readPaneFractions(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: number[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0 || entry >= 1) {
      return null;
    }
    out.push(entry);
  }
  return out;
}

/** One pane, validated field by field. Returns null when it cannot be trusted. */
function readPane(value: unknown): PaneState | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['symbol'] !== 'string') return null;
  if (!isTimeframe(record['timeframe'])) return null;
  if (!isChartType(record['chartType'])) return null;

  const mode = record['priceScaleMode'];
  const indicators = Array.isArray(record['indicators']) ? record['indicators'] : [];

  return {
    symbol: record['symbol'],
    timeframe: record['timeframe'],
    chartType: record['chartType'],
    priceScaleMode: mode === 'log' || mode === 'percent' || mode === 'linear' ? mode : 'linear',
    // Defaulted rather than rejected: discarding a whole pane over one boolean is worse
    // than starting it the right way up.
    priceScaleInverted: record['priceScaleInverted'] === true,
    indicators: indicators.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const item = entry as Record<string, unknown>;
      if (!isIndicatorId(item['id'])) return [];
      const params = item['params'];
      return [
        {
          id: item['id'],
          params: isParams(params) ? params : {},
          styles: readStyles(item['styles']),
        },
      ];
    }),
    drawingsBySymbol: readDrawingsBySymbol(record),
    // Validated by the alert store's own loadJSON, which drops bad entries field by
    // field; storing it as a string keeps one owner for that schema.
    alerts: typeof record['alerts'] === 'string' ? record['alerts'] : null,
    paneFractions: readPaneFractions(record['paneFractions']),
    barSpacing: typeof record['barSpacing'] === 'number' ? record['barSpacing'] : 8,
    scrollPosition:
      typeof record['scrollPosition'] === 'number' ? record['scrollPosition'] : Number.NaN,
  };
}

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

// ---------------------------------------------------------------- named layouts

/**
 * Named layouts, on top of the single autosaved workspace.
 *
 * TradingView's model: the autosave is where you are RIGHT NOW, and a named layout is a
 * snapshot you chose to keep. They are deliberately separate keys — saving a layout must
 * not disturb the autosave, and the autosave must keep tracking the live chart after you
 * have saved one, or "save" would silently become "switch to".
 *
 * Stored as one index plus one entry per layout rather than a single blob, so opening a
 * layout parses only that layout, and a corrupt entry cannot take the others with it.
 */
const LAYOUT_INDEX_KEY = 'tdv-shadow.layouts';
const LAYOUT_PREFIX = 'tdv-shadow.layout.';

export interface SavedLayout {
  readonly id: string;
  readonly name: string;
  /** UTC epoch ms, so the list can be ordered most-recent-first. */
  readonly savedAt: number;
}

function readIndex(): SavedLayout[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LAYOUT_INDEX_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return (parsed as unknown[]).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const { id, name, savedAt } = record;
    if (typeof id !== 'string' || id === '') return [];
    if (typeof name !== 'string' || name === '') return [];
    return [{ id, name, savedAt: typeof savedAt === 'number' ? savedAt : 0 }];
  });
}

function writeIndex(entries: readonly SavedLayout[]): void {
  try {
    localStorage.setItem(LAYOUT_INDEX_KEY, JSON.stringify(entries));
  } catch {
    /* private mode or a full quota; the layout list is not worth breaking the app over */
  }
}

/** Saved layouts, most recently saved first. */
export function listLayouts(): readonly SavedLayout[] {
  return [...readIndex()].sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Saves `workspace` under `name`, replacing any layout with the same name.
 *
 * Replacing by name rather than appending: "save" on a name you already used means
 * update, and a list with three identical names is a worse outcome than an overwrite the
 * user can see coming.
 */
export function saveLayout(name: string, workspace: Workspace): SavedLayout | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;

  const index = readIndex();
  const existing = index.find((entry) => entry.name === trimmed);
  const id = existing?.id ?? `l${String(Date.now())}${String(Math.floor(Math.random() * 1e6))}`;
  const entry: SavedLayout = { id, name: trimmed, savedAt: Date.now() };

  try {
    localStorage.setItem(LAYOUT_PREFIX + id, JSON.stringify({ version: VERSION, ...workspace }));
  } catch {
    return null;
  }
  writeIndex([...index.filter((e) => e.id !== id), entry]);
  return entry;
}

/** Loads a saved layout, or null when it is missing or unreadable. */
export function loadLayout(id: string): Workspace | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LAYOUT_PREFIX + id);
  } catch {
    return null;
  }
  if (raw === null) return null;
  return parseWorkspace(raw);
}

export function deleteLayout(id: string): void {
  try {
    localStorage.removeItem(LAYOUT_PREFIX + id);
  } catch {
    /* nothing to do */
  }
  writeIndex(readIndex().filter((entry) => entry.id !== id));
}
