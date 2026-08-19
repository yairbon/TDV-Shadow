/**
 * Workspace schema, and the version-2 → version-3 migration.
 *
 * The migration is the risky part and the reason these tests exist. v3 made drawings
 * per-symbol; a loader that simply rejected v2 (which is what the version check did
 * before, by design) would have deleted every existing user's drawings on upgrade —
 * exactly the data loss the schema change was made to stop.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearWorkspace, loadWorkspace, saveWorkspace, type Workspace } from '../../../src/app/workspace.js';

const KEY = 'tdv-shadow.workspace';

/**
 * An in-memory `localStorage`, rather than pulling in jsdom for one file.
 *
 * The workspace module is the only thing in `src/app` that touches web storage, and it
 * does so behind try/catch precisely because the API can be absent or throwing (private
 * browsing, full quota). A four-method stub exercises the same code path.
 */
class MemoryStorage {
  readonly #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
  clear(): void {
    this.#map.clear();
  }
}

(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();

/** A v2 pane: one `drawings` blob, no `drawingsBySymbol`. */
function legacyPayload(symbol: string, drawings: string | null): string {
  return JSON.stringify({
    version: 2,
    layout: '1',
    renderer: 'canvas2d',
    chartSettings: null,
    panes: [
      {
        symbol,
        timeframe: '1d',
        chartType: 'candles',
        priceScaleMode: 'linear',
        priceScaleInverted: false,
        indicators: [{ id: 'sma', params: { period: 20 }, styles: {} }],
        drawings,
        alerts: null,
        barSpacing: 8,
        scrollPosition: 100,
      },
    ],
  });
}

const modern = (): Workspace => ({
  layout: '1',
  renderer: 'canvas2d',
  chartSettings: null,
  panes: [
    {
      symbol: 'AAPL',
      timeframe: '1d',
      chartType: 'candles',
      priceScaleMode: 'linear',
      priceScaleInverted: false,
      indicators: [],
      drawingsBySymbol: { AAPL: '{"version":1,"drawings":[]}', MSFT: '{"version":1,"drawings":[]}' },
      alerts: null,
      paneFractions: null,
      barSpacing: 8,
      scrollPosition: 100,
    },
  ],
});

beforeEach(() => {
  clearWorkspace();
});

describe('workspace v2 → v3 migration', () => {
  it('files a v2 pane’s drawings under the symbol that pane was showing', () => {
    localStorage.setItem(KEY, legacyPayload('TSLA', '{"version":1,"drawings":[{"id":"d1"}]}'));
    const loaded = loadWorkspace();
    expect(loaded).not.toBeNull();
    const pane = loaded?.panes[0];
    expect(pane?.symbol).toBe('TSLA');
    // The whole point: the blob is not dropped, and it is not filed under a guess.
    expect(pane?.drawingsBySymbol['TSLA']).toBe('{"version":1,"drawings":[{"id":"d1"}]}');
    expect(Object.keys(pane?.drawingsBySymbol ?? {})).toEqual(['TSLA']);
  });

  it('keeps a v2 pane’s indicators, which are per-chart and not per-symbol', () => {
    localStorage.setItem(KEY, legacyPayload('TSLA', null));
    expect(loadWorkspace()?.panes[0].indicators).toEqual([
      { id: 'sma', params: { period: 20 }, styles: {} },
    ]);
  });

  it('yields an empty map for a v2 pane that had no drawings', () => {
    localStorage.setItem(KEY, legacyPayload('TSLA', null));
    expect(loadWorkspace()?.panes[0].drawingsBySymbol).toEqual({});
  });

  it('still rejects version 1, which described a single chart', () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, panes: [], layout: '1' }));
    expect(loadWorkspace()).toBeNull();
  });

  it('rejects a version from the future rather than half-reading it', () => {
    localStorage.setItem(KEY, legacyPayload('TSLA', null).replace('"version":2', '"version":99'));
    expect(loadWorkspace()).toBeNull();
  });
});

describe('workspace v3 round trip', () => {
  it('preserves every symbol’s drawings, not only the one on screen', () => {
    saveWorkspace(modern());
    const pane = loadWorkspace()?.panes[0];
    // MSFT is not the pane's symbol. Losing it here is the autosave-shaped version of
    // the original bug, one layer down.
    expect(Object.keys(pane?.drawingsBySymbol ?? {}).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('drops a non-string entry instead of handing it to the drawing store', () => {
    const workspace = modern();
    const payload = JSON.parse(JSON.stringify({ version: 3, ...workspace })) as {
      panes: { drawingsBySymbol: Record<string, unknown> }[];
    };
    payload.panes[0].drawingsBySymbol['NVDA'] = { not: 'a string' };
    localStorage.setItem(KEY, JSON.stringify(payload));
    expect(Object.keys(loadWorkspace()?.panes[0].drawingsBySymbol ?? {}).sort()).toEqual([
      'AAPL',
      'MSFT',
    ]);
  });

  it('lets a v3 entry win when a stale v2 blob is present too', () => {
    const payload = {
      version: 3,
      layout: '1',
      renderer: 'canvas2d',
      chartSettings: null,
      panes: [
        {
          symbol: 'TSLA',
          timeframe: '1d',
          chartType: 'candles',
          priceScaleMode: 'linear',
          priceScaleInverted: false,
          indicators: [],
          drawings: 'STALE',
          drawingsBySymbol: { TSLA: 'CURRENT' },
          alerts: null,
          barSpacing: 8,
          scrollPosition: 1,
        },
      ],
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
    expect(loadWorkspace()?.panes[0].drawingsBySymbol['TSLA']).toBe('CURRENT');
  });
});

describe('a workspace written before the previous-close setting existed', () => {
  it('keeps every other preference rather than rejecting the payload', () => {
    // One missing boolean must not throw away the colours, the zone and the precision.
    const stored = {
      version: 3,
      panes: [
        {
          symbol: 'AAPL',
          timeframe: '1d',
          chartType: 'candles',
          priceScaleMode: 'linear',
          priceScaleInverted: false,
          indicators: [],
          drawingsBySymbol: {},
          alerts: null,
          barSpacing: 8,
          scrollPosition: 100,
        },
      ],
      layout: '1',
      renderer: 'canvas2d',
      chartSettings: {
        showGrid: false,
        timeZone: 'America/New_York',
        pricePrecision: 4,
        rightMargin: 10,
        upColor: '#26a69a',
        downColor: '#ef5350',
      },
    };
    localStorage.setItem('tdv-shadow.workspace', JSON.stringify(stored));
    const restored = loadWorkspace();
    expect(restored?.chartSettings?.pricePrecision).toBe(4);
    expect(restored?.chartSettings?.timeZone).toBe('America/New_York');
    // …and the new setting takes its default rather than becoming undefined.
    expect(restored?.chartSettings?.showPreviousClose).toBe(true);
  });
});
