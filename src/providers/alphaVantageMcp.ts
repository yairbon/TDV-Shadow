/**
 * Alpha Vantage through the viewer's own connector.
 *
 * This is the only provider that works inside the published artifact. That page runs under
 * a CSP with no outbound network at all, so `fetch` to any vendor is dead on arrival and
 * every REST provider in the chain would light up its timeframe buttons and then fail on
 * each press. The connector bridge is a different route entirely: the page asks the
 * claude.ai runtime to make the call, it runs with the *viewer's* credentials, and this
 * code never sees a token.
 *
 * Everything below the transport is shared with the REST adapter — the CSV that comes back
 * through the connector is byte-for-byte what the REST endpoint serves, so `parseDailyRows`,
 * `parseQuoteRow`, `parseSearchRows` and `classifyAlphaVantageError` are reused rather than
 * written twice. What is genuinely different is failure: a connector call can fail for
 * reasons an HTTP call cannot (the viewer never added the connector, their token lapsed,
 * org policy blocks the tool), and each of those has a different fix. Collapsing them into
 * one "could not load" is the thing this file exists to avoid.
 *
 * **Daily only, and that is not a bug here either.** The free Alpha Vantage tier gates
 * intraday, so the artifact offers `1d` and reports the rest unavailable with a reason.
 */

import { createAlphaVantageCore, type AlphaVantageRequest } from './alphaVantage.js';
import { fail, ok, type MarketDataProvider, type ProviderResult } from './types.js';

/** The connector's display name — the address `callTool` takes. Not an id. */
export const ALPHA_VANTAGE_SERVER = 'Alpha Vantage MCP Server';

/** The tools this provider calls. The published manifest must list exactly these. */
export const ALPHA_VANTAGE_TOOLS: readonly string[] = Object.freeze([
  'TIME_SERIES_DAILY',
  'GLOBAL_QUOTE',
  'SYMBOL_SEARCH',
]);

/** The slice of the `mcp` capability used here. Injected, so tests need no runtime. */
export interface McpCaller {
  callTool(
    server: string,
    tool: string,
    input?: unknown,
    options?: unknown,
  ): Promise<{ readonly payload?: unknown; readonly content?: unknown }>;
}

/**
 * Maps a connector-level failure onto the provider vocabulary.
 *
 * The grouping is by what the reader would have to DO, which is the only thing the app
 * can act on: a missing or lapsed connector reads as `no-key` (there is a credential-shaped
 * hole), a blocked or unlisted tool reads as `entitlement` (it exists but is not for you),
 * and everything transient reads as `network` so the retry paths already in the app apply.
 */
export function classifyMcpError(code: string, message: string): ProviderResult<never> {
  switch (code) {
    case 'needs_reauth':
      return fail('no-key', 'reconnect Alpha Vantage in claude.ai Settings → Connectors');
    case 'server_not_connected':
    case 'server_not_found':
      return fail('no-key', 'add the Alpha Vantage connector in claude.ai Settings → Connectors');
    case 'selection_required':
      return fail('no-key', 'choose which Alpha Vantage connector to use, then reload');
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return fail('no-key', 'this view cannot reach connectors');
    case 'not_in_manifest':
      return fail('entitlement', 'this page is not allowed to call that Alpha Vantage tool');
    case 'blocked_by_policy':
      return fail('entitlement', 'your organisation blocks that Alpha Vantage tool');
    case 'approval_required':
      return fail('entitlement', 'that Alpha Vantage tool needs per-call approval');
    case 'rate_limited':
      return fail('rate-limit', 'too many connector calls — wait a moment');
    default:
      // `server_unavailable`, `upstream_error`, `tool_error`, `cancelled`, `bad_request`
      // and any code newer than this build. All transient or caller-side, and all worth
      // reporting with whatever the runtime said rather than a house phrase.
      return fail('network', message === '' ? `Alpha Vantage connector error (${code})` : message);
  }
}

/**
 * Pulls the CSV out of a connector result.
 *
 * The tools answer `{"result": "<csv>"}` — observed, not assumed. `payload` is the runtime's
 * own convenience for exactly this, so it is read first; the text content block is the
 * fallback for a runtime that does not populate it.
 */
export function csvFromPayload(result: {
  readonly payload?: unknown;
  readonly content?: unknown;
}): string | null {
  const { payload } = result;
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object' && payload !== null) {
    const inner = (payload as { result?: unknown }).result;
    if (typeof inner === 'string') return inner;
  }
  const blocks = result.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks as { type?: unknown; text?: unknown }[]) {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
    }
  }
  return null;
}

/** An error rejected by `callTool`, read defensively — it crosses a runtime boundary. */
function readMcpError(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const shape = error as { code?: unknown; message?: unknown };
    return {
      code: typeof shape.code === 'string' ? shape.code : 'upstream_error',
      message: typeof shape.message === 'string' ? shape.message : '',
    };
  }
  return { code: 'upstream_error', message: '' };
}

export function createAlphaVantageMcpProvider(
  mcp: McpCaller,
  server: string = ALPHA_VANTAGE_SERVER,
): MarketDataProvider {
  const request: AlphaVantageRequest = async (params) => {
    // The REST `function=` value IS the tool name — the connector exposes one tool per
    // endpoint under the same names, so nothing has to be translated.
    const { function: tool, ...input } = params;
    // Checked rather than trusted: the manifest published with the page lists these three,
    // and a call outside it is refused by the runtime with a code that reads like a policy
    // problem. Saying so here names the actual cause.
    if (!ALPHA_VANTAGE_TOOLS.includes(tool)) {
      return fail('entitlement', `${tool} is not exposed by the connector`);
    }
    try {
      const result = await mcp.callTool(server, tool, input);
      const csv = csvFromPayload(result);
      if (csv === null) return fail('format', 'the connector returned no readable body');
      return ok(csv);
    } catch (error) {
      const { code, message } = readMcpError(error);
      return classifyMcpError(code, message);
    }
  };

  return createAlphaVantageCore(request, 'alpha-vantage-mcp', 'Alpha Vantage (connector)', true);
}
