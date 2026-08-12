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
 * Bumped to 2 when the schema became per-pane (10.4). A version-1 payload described one
 * chart and is discarded rather than half-migrated — the loader's contract is that a
 * payload it cannot fully understand is not applied at all.
 */
const VERSION = 2;

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
  /** Serialised drawing store, or null when there are none. */
  readonly drawings: string | null;
  /** Serialised alert store (9.2), or null when there are none. */
  readonly alerts: string | null;
  readonly barSpacing: number;
  readonly scrollPosition: number;
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record['version'] !== VERSION) return null;
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
    drawings: typeof record['drawings'] === 'string' ? record['drawings'] : null,
    // Validated by the alert store's own loadJSON, which drops bad entries field by
    // field; storing it as a string keeps one owner for that schema.
    alerts: typeof record['alerts'] === 'string' ? record['alerts'] : null,
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
