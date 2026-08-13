/**
 * TDV-Shadow MCP server (Phase 6) — stdio.
 *
 * Exposes the chart to an external agent as tools. The design decision that matters:
 * this server is a THIN PROXY. It owns no chart state. Every tool is one
 * `page.evaluate` against `window.__tdv` (src/mcp/controlApi.ts), driving the same
 * stores user input drives. An agent therefore cannot reach a state a user could not,
 * and cannot read geometry the renderer did not actually paint.
 *
 * Scope, stated honestly rather than padded: the tool surface below is the set that is
 * genuinely wired end to end. It is deliberately not a long list of names that return
 * "not implemented" — an agent cannot tell the difference between a stub and a bug, so
 * a stub is worse than an absent tool.
 *
 * Run: npm run mcp   (stdio; point an MCP client at it)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { CHART_TYPES } from '../charts/types.js';
import { INDICATOR_IDS } from '../indicators/registry.js';
import { DRAWING_KINDS } from '../drawings/types.js';
import { TIMEFRAMES } from '../data/types.js';
import type { ChartControlApi } from './controlApi.js';

const DIST = new URL('../../dist/', import.meta.url).pathname;
const PORT = Number(process.env['TDV_MCP_PORT'] ?? 4319);
const CHROMIUM_PATH =
  process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Serves dist/ so the page runs from the real build, not a synthetic fixture. */
function serveDist(): Promise<Server> {
  const server = createServer((req, res) => {
    const raw = (req.url ?? '/').split('?')[0];
    const rel = normalize(raw === '/' ? '/index.html' : raw).replace(/^(\.\.[/\\])+/, '');
    readFile(join(DIST, rel))
      .then((body) => {
        res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404).end('not found');
      });
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

interface Session {
  readonly browser: Browser;
  readonly page: Page;
  readonly http: Server;
}

let session: Session | null = null;

async function ensureSession(): Promise<Session> {
  if (session !== null) return session;
  const http = await serveDist();
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  await page.goto(`http://127.0.0.1:${String(PORT)}/?seed=7&bars=400&spacing=8&live=0`);
  await page.waitForFunction(() => window.__tdv !== undefined, null, { timeout: 20_000 });
  session = { browser, page, http };
  return session;
}

async function closeSession(): Promise<boolean> {
  const current = session;
  if (current === null) return false;
  session = null;
  await current.browser.close();
  await new Promise<void>((resolve) => current.http.close(() => { resolve(); }));
  return true;
}

/**
 * Calls one method on `window.__tdv` by name. Dispatching by name rather than shipping
 * a serialised closure keeps this CSP-safe (no `new Function` in the page) and keeps
 * the method names checked against the contract at compile time.
 */
async function call<T>(method: keyof ChartControlApi, args: readonly unknown[] = []): Promise<T> {
  const { page } = await ensureSession();
  return (await page.evaluate(
    ({ m, a }: { m: string; a: readonly unknown[] }): unknown => {
      const api = window.__tdv;
      if (api === undefined) throw new Error('window.__tdv is not present on this page');
      const table = api as unknown as Record<string, unknown>;
      const fn = table[m];
      if (typeof fn !== 'function') throw new Error(`unknown control method: ${m}`);
      return (fn as (...rest: unknown[]) => unknown).apply(api, [...a]);
    },
    { m: method, a: args },
  )) as T;
}

const json = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const server = new McpServer({ name: 'tdv-shadow', version: '1.0.0' });

/**
 * Derived from the registry rather than restated here.
 *
 * A second hand-maintained list is a list that goes stale: the nine indicators added in
 * Tier 3 were addressable from the browser the moment they were registered and invisible
 * over MCP, because this array did not know about them. Validating by membership keeps one
 * source of truth; the ids still reach the client through the description below.
 */
const indicatorId = z
  .string()
  .refine((value) => (INDICATOR_IDS as readonly string[]).includes(value), {
    message: 'unknown indicator id',
  })
  .describe(`One of: ${INDICATOR_IDS.join(', ')}`);

// --- session ---------------------------------------------------------------

server.registerTool(
  'session_open',
  {
    description:
      'Launch the headless chart session (serves dist/, opens Chromium, waits for the control API). Other tools call it implicitly; use it to pre-warm.',
    inputSchema: {},
  },
  async () => json(await call('getState')),
);

server.registerTool(
  'session_close',
  { description: 'Close the headless chart session and release the browser.', inputSchema: {} },
  async () => json({ closed: await closeSession() }),
);

// --- read ------------------------------------------------------------------

server.registerTool(
  'chart_get_state',
  {
    description:
      'Full chart state: symbol, timeframe, chart type, renderer, viewport, active indicators and drawings.',
    inputSchema: {},
  },
  async () => json(await call('getState')),
);

server.registerTool(
  'chart_check_integrity',
  {
    description:
      'Spatial self-check of the LAST RENDERED FRAME: candle overlap, marks outside the plot rect, page overflow, non-canvas nodes inside the plot, and DPR backing-store correctness. Run it after drawing or zooming to confirm nothing broke.',
    inputSchema: {},
  },
  async () => json(await call('getIntegrityReport')),
);

server.registerTool(
  'data_read_ohlcv',
  {
    description:
      'Read OHLCV rows by inclusive bar-index range. Omit both bounds to read the visible range.',
    inputSchema: { from: z.number().int().optional(), to: z.number().int().optional() },
  },
  async ({ from, to }) => json(await call('readOhlcv', [from, to])),
);

// --- chart configuration ---------------------------------------------------

server.registerTool(
  'chart_set_symbol',
  {
    description: 'Switch the instrument and optionally the timeframe.',
    inputSchema: { symbol: z.string().min(1), timeframe: z.enum(TIMEFRAMES).optional() },
  },
  async ({ symbol, timeframe }) => json(await call('setSymbol', [symbol, timeframe])),
);

server.registerTool(
  'chart_set_type',
  {
    description: `Set the chart type. One of: ${CHART_TYPES.join(', ')}.`,
    inputSchema: { type: z.enum(CHART_TYPES) },
  },
  async ({ type }) => json(await call('setChartType', [type])),
);

server.registerTool(
  'chart_set_scale',
  {
    description: 'Set the price scale mode: linear, log or percent.',
    inputSchema: { mode: z.enum(['linear', 'log', 'percent']) },
  },
  async ({ mode }) => json(await call('setPriceScaleMode', [mode])),
);

server.registerTool(
  'chart_set_renderer',
  {
    description: 'Switch the series renderer between canvas2d and webgl.',
    inputSchema: { renderer: z.enum(['canvas2d', 'webgl']) },
  },
  async ({ renderer }) => json(await call('setRenderer', [renderer])),
);

// --- viewport --------------------------------------------------------------

server.registerTool(
  'chart_zoom',
  {
    description: 'Zoom about a pixel anchor, keeping the bar under it fixed. factor > 1 zooms in.',
    inputSchema: { anchorX: z.number(), factor: z.number().positive() },
  },
  async ({ anchorX, factor }) => json(await call('zoomAbout', [anchorX, factor])),
);

server.registerTool(
  'chart_pan',
  {
    description: 'Pan by a number of bars. Positive moves toward older bars.',
    inputSchema: { bars: z.number() },
  },
  async ({ bars }) => json(await call('panBars', [bars])),
);

server.registerTool(
  'chart_fit_range',
  {
    description: 'Fit an inclusive bar-index range to the plot width.',
    inputSchema: { from: z.number().int(), to: z.number().int() },
  },
  async ({ from, to }) => json(await call('fitVisibleRange', [from, to])),
);

server.registerTool(
  'chart_set_bar_spacing',
  {
    description: 'Set bar spacing in CSS pixels per bar (clamped to the renderer limits).',
    inputSchema: { spacing: z.number().positive() },
  },
  async ({ spacing }) => json(await call('setBarSpacing', [spacing])),
);

// --- indicators ------------------------------------------------------------

server.registerTool(
  'indicator_add',
  {
    description:
      'Add an indicator. Overlays draw on the price plot; the rest get their own pane. Returns a handle id.',
    inputSchema: {
      id: indicatorId,
      period: z.number().int().positive().optional(),
      source: z.enum(['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4']).optional(),
      stdDev: z.number().positive().optional(),
      fastPeriod: z.number().int().positive().optional(),
      slowPeriod: z.number().int().positive().optional(),
      signalPeriod: z.number().int().positive().optional(),
      buckets: z.number().int().positive().optional(),
    },
  },
  async ({ id, ...params }) => json(await call('addIndicator', [id, params])),
);

server.registerTool(
  'indicator_remove',
  { description: 'Remove an indicator by handle id.', inputSchema: { handleId: z.string() } },
  async ({ handleId }) => json({ removed: await call('removeIndicator', [handleId]) }),
);

server.registerTool(
  'indicator_read',
  {
    description:
      "Read an indicator's computed table as rows. Warm-up bars come back as NaN, never zero — treat NaN as 'no value yet', not as a data error.",
    inputSchema: {
      handleId: z.string(),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
    },
  },
  async ({ handleId, from, to }) => json(await call('readIndicator', [handleId, from, to])),
);

// --- drawings --------------------------------------------------------------

server.registerTool(
  'draw_shape',
  {
    description: `Place a drawing. Anchors are DATA space {barIndex, price}, never pixels, so the shape stays attached through pan, zoom and scale changes. Magnet snaps anchors to bar OHLC. Kinds: ${DRAWING_KINDS.join(', ')}.`,
    inputSchema: {
      kind: z.enum(DRAWING_KINDS),
      anchors: z.array(z.object({ barIndex: z.number(), price: z.number() })).min(1),
      magnet: z.enum(['off', 'weak', 'strong']).optional(),
    },
  },
  async ({ kind, anchors, magnet }) => json(await call('drawShape', [kind, anchors, magnet])),
);

server.registerTool(
  'draw_update',
  {
    description: 'Move an existing drawing by replacing its anchors.',
    inputSchema: {
      id: z.string(),
      anchors: z.array(z.object({ barIndex: z.number(), price: z.number() })).min(1),
    },
  },
  async ({ id, anchors }) => json(await call('updateDrawing', [id, anchors])),
);

server.registerTool(
  'draw_list',
  {
    description:
      'List drawings with their data-space anchors AND the pixel positions those anchors resolved to in the last frame — use it to verify anchoring.',
    inputSchema: {},
  },
  async () => json(await call('listDrawings')),
);

server.registerTool(
  'draw_remove',
  { description: 'Remove a drawing by id.', inputSchema: { id: z.string() } },
  async ({ id }) => json({ removed: await call('removeDrawing', [id]) }),
);

server.registerTool(
  'draw_clear',
  { description: 'Remove every drawing. Returns how many were removed.', inputSchema: {} },
  async () => json({ removed: await call('clearDrawings') }),
);

// --- geometry --------------------------------------------------------------

server.registerTool(
  'geometry_project',
  {
    description: 'Project a data-space anchor to pixels through the live scales.',
    inputSchema: { barIndex: z.number(), price: z.number() },
  },
  async ({ barIndex, price }) => json(await call('projectAnchor', [{ barIndex, price }])),
);

server.registerTool(
  'geometry_unproject',
  {
    description: 'Invert a pixel position back to a data-space anchor.',
    inputSchema: { x: z.number(), y: z.number() },
  },
  async ({ x, y }) => json(await call('unprojectPixel', [x, y])),
);

// --- capture ---------------------------------------------------------------

server.registerTool(
  'capture_screenshot',
  {
    description:
      'Screenshot the chart as a base64 PNG. `full` captures the whole page including the toolbar.',
    inputSchema: { full: z.boolean().optional() },
  },
  async ({ full }) => {
    const { page } = await ensureSession();
    const target = full === true ? page : page.locator('#chart');
    const buffer = await target.screenshot();
    return {
      content: [
        { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/png' },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
