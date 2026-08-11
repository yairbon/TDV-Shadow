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

const KEY = 'tdv-shadow.workspace';
const VERSION = 1;

export interface Workspace {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly chartType: ChartType;
  readonly priceScaleMode: PriceScaleMode;
  /** §2.1 price-axis inversion. */
  readonly priceScaleInverted: boolean;
  readonly renderer: 'canvas2d' | 'webgl';
  readonly indicators: readonly { readonly id: IndicatorId; readonly params: IndicatorParams }[];
  /** Serialised drawing store, or null when there are none. */
  readonly drawings: string | null;
  readonly barSpacing: number;
  readonly scrollPosition: number;
}

const isChartType = (value: unknown): value is ChartType =>
  typeof value === 'string' && (CHART_TYPES as readonly string[]).includes(value);
const isTimeframe = (value: unknown): value is Timeframe =>
  typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value);
const isIndicatorId = (value: unknown): value is IndicatorId =>
  typeof value === 'string' && (INDICATOR_IDS as readonly string[]).includes(value);
const isParams = (value: unknown): value is IndicatorParams =>
  typeof value === 'object' && value !== null;

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
  if (typeof record['symbol'] !== 'string') return null;
  if (!isTimeframe(record['timeframe'])) return null;
  if (!isChartType(record['chartType'])) return null;

  const mode = record['priceScaleMode'];
  const renderer = record['renderer'];
  const indicators = Array.isArray(record['indicators']) ? record['indicators'] : [];

  return {
    symbol: record['symbol'],
    timeframe: record['timeframe'],
    chartType: record['chartType'],
    priceScaleMode:
      mode === 'log' || mode === 'percent' || mode === 'linear' ? mode : 'linear',
    // Defaulted rather than rejected: a payload written before this field existed is
    // still perfectly usable, and discarding a whole workspace over one boolean is worse
    // than starting it the right way up.
    priceScaleInverted: record['priceScaleInverted'] === true,
    renderer: renderer === 'webgl' ? 'webgl' : 'canvas2d',
    indicators: indicators.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const item = entry as Record<string, unknown>;
      if (!isIndicatorId(item['id'])) return [];
      const params = item['params'];
      return [
        {
          id: item['id'],
          params: isParams(params) ? params : {},
        },
      ];
    }),
    drawings: typeof record['drawings'] === 'string' ? record['drawings'] : null,
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
