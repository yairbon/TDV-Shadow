/**
 * Alpha Vantage over the viewer's connector.
 *
 * Two things are worth holding here. The first is that this provider and the REST one
 * genuinely share their parsing — a bug fixed in one is fixed in both, and a test that
 * passes here while the REST adapter has been rewritten would be proving nothing. The
 * second is the failure vocabulary: a connector fails in ways HTTP cannot, and every one
 * of those has a different fix for the reader.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ALPHA_VANTAGE_SERVER,
  ALPHA_VANTAGE_TOOLS,
  classifyMcpError,
  createAlphaVantageMcpProvider,
  csvFromPayload,
  type McpCaller,
} from '../../../src/providers/alphaVantageMcp.js';

/** Exactly the shape the connector returned when it was driven for real. */
const DAILY_CSV =
  'timestamp,open,high,low,close,volume\r\n' +
  '2026-08-13,304.2100,306.0000,302.0500,305.2600,40349289\r\n' +
  '2026-08-12,305.1000,305.6600,300.5700,302.2500,41657768\r\n';

const QUOTE_CSV =
  'symbol,open,high,low,price,volume,latestDay,previousClose,change,changePercent\r\n' +
  'AAPL,304.2100,306.0000,302.0500,305.2600,40349289,2026-08-13,302.2500,3.0100,0.9959%\r\n';

const SEARCH_CSV =
  'symbol,name,type,region,marketOpen,marketClose,timezone,currency,matchScore\r\n' +
  'TSLA,Tesla Inc,Equity,United States,09:30,16:00,UTC-04,USD,0.8889\r\n' +
  'TL0.DEX,Tesla Inc,Equity,XETRA,08:00,20:00,UTC+02,EUR,0.7143\r\n';

/** A caller that answers with `{result: csv}`, the envelope observed on the wire. */
function caller(csvFor: (tool: string) => string): {
  mcp: McpCaller;
  calls: { server: string; tool: string; input: unknown }[];
} {
  const calls: { server: string; tool: string; input: unknown }[] = [];
  return {
    calls,
    mcp: {
      callTool(server, tool, input) {
        calls.push({ server, tool, input });
        return Promise.resolve({ payload: { result: csvFor(tool) } });
      },
    },
  };
}

/**
 * Rejects with a value verbatim.
 *
 * The runtime rejects with a plain `{code, message}` object rather than an `Error`, which
 * is the whole reason the adapter reads the rejection defensively. Wrapping these fixtures
 * in an `Error` to satisfy the lint rule would test a shape that never actually occurs.
 */
const rejectWith = (value: unknown): Promise<never> =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
  Promise.reject(value);

/** A caller that always rejects with the runtime's error shape. */
const failing = (code: string, message = 'boom'): McpCaller => ({
  callTool: () => rejectWith({ code, message }),
});

describe('capabilities', () => {
  it('is ready without a key, because the credential is the viewer’s', () => {
    const capabilities = createAlphaVantageMcpProvider(caller(() => '').mcp).capabilities();
    expect(capabilities.ready).toBe(true);
    expect(capabilities.id).toBe('alpha-vantage-mcp');
  });

  it('offers daily and nothing else', () => {
    // The entitlement wall is the vendor's, not the transport's — routing the same free
    // account through a connector does not buy intraday.
    const capabilities = createAlphaVantageMcpProvider(caller(() => '').mcp).capabilities();
    expect([...capabilities.nativeTimeframes]).toEqual(['1d']);
  });

  it('is labelled distinctly from the REST provider', () => {
    // Both are Alpha Vantage and both may be in a chain. The status line names one of
    // them, and "Alpha Vantage" twice would make that line useless.
    const capabilities = createAlphaVantageMcpProvider(caller(() => '').mcp).capabilities();
    expect(capabilities.label).not.toBe('Alpha Vantage');
  });
});

describe('fetching through the connector', () => {
  it('calls the daily tool on the named connector and parses the CSV', async () => {
    const { mcp, calls } = caller(() => DAILY_CSV);
    const result = await createAlphaVantageMcpProvider(mcp).fetchSeries('aapl', '1d', 100);
    if (!result.ok) throw new Error(result.reason);

    expect(calls).toHaveLength(1);
    expect(calls[0].server).toBe(ALPHA_VANTAGE_SERVER);
    expect(calls[0].tool).toBe('TIME_SERIES_DAILY');
    // The endpoint name is the TOOL, so it must not also be sent as an argument.
    expect(calls[0].input).toMatchObject({ symbol: 'AAPL', datatype: 'csv' });
    expect(calls[0].input).not.toHaveProperty('function');

    expect(result.value.bars).toHaveLength(2);
    // Ascending, though the wire order is newest-first.
    expect(result.value.bars[0].t).toBeLessThan(result.value.bars[1].t);
    expect(result.value.bars[1].c).toBeCloseTo(305.26, 4);
  });

  it('reuses the REST adapter’s parsing rather than its own', async () => {
    // Daily bars are stamped at the SESSION's midnight, not UTC midnight — that rule
    // lives in the shared core, and a separate parser here would quietly lose it.
    const { mcp } = caller(() => DAILY_CSV);
    const result = await createAlphaVantageMcpProvider(mcp).fetchSeries('AAPL', '1d', 100);
    if (!result.ok) throw new Error(result.reason);
    const stamp = new Date(result.value.bars[1].t).toISOString();
    expect(stamp).not.toBe('2026-08-13T00:00:00.000Z');
    expect(stamp.startsWith('2026-08-13T0')).toBe(true);
  });

  it('refuses intraday without spending a call', async () => {
    const { mcp, calls } = caller(() => DAILY_CSV);
    const result = await createAlphaVantageMcpProvider(mcp).fetchSeries('AAPL', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('entitlement');
    expect(calls).toHaveLength(0);
  });

  it('quotes', async () => {
    const { mcp, calls } = caller(() => QUOTE_CSV);
    const result = await createAlphaVantageMcpProvider(mcp).fetchQuote('AAPL');
    if (!result.ok) throw new Error(result.reason);
    expect(calls[0].tool).toBe('GLOBAL_QUOTE');
    expect(result.value.price).toBeCloseTo(305.26, 4);
    // GLOBAL_QUOTE does not say whether the venue is open, and inventing an answer would
    // have the app call a holiday "open" whenever the last session was recent.
    expect(result.value.marketOpen).toBeNull();
  });

  it('searches, keeping the same instrument on two venues apart', async () => {
    const { mcp, calls } = caller(() => SEARCH_CSV);
    const result = await createAlphaVantageMcpProvider(mcp).searchSymbols('tesla');
    if (!result.ok) throw new Error(result.reason);
    expect(calls[0].tool).toBe('SYMBOL_SEARCH');
    expect(calls[0].input).toMatchObject({ keywords: 'tesla' });
    expect(result.value).toHaveLength(2);
    expect(result.value.map((hit) => hit.symbol)).toEqual(['TSLA', 'TL0.DEX']);
  });

  it('declares exactly the tools it calls', async () => {
    // The published manifest is built from this list. A tool called but not declared is
    // refused by the runtime at view time, which no test in this repo would otherwise see.
    const { mcp, calls } = caller((tool) =>
      tool === 'GLOBAL_QUOTE' ? QUOTE_CSV : tool === 'SYMBOL_SEARCH' ? SEARCH_CSV : DAILY_CSV,
    );
    const provider = createAlphaVantageMcpProvider(mcp);
    await provider.fetchSeries('AAPL', '1d', 10);
    await provider.fetchQuote('AAPL');
    await provider.searchSymbols('tesla');
    const used = new Set(calls.map((call) => call.tool));
    expect([...used].sort()).toEqual([...ALPHA_VANTAGE_TOOLS].sort());
  });
});

describe('reading the result envelope', () => {
  it('takes the CSV out of the observed {result} payload', () => {
    expect(csvFromPayload({ payload: { result: 'a,b\r\n1,2\r\n' } })).toBe('a,b\r\n1,2\r\n');
  });

  it('accepts a bare string payload', () => {
    expect(csvFromPayload({ payload: 'a,b' })).toBe('a,b');
  });

  it('falls back to the first text content block', () => {
    // For a runtime that does not populate the convenience field.
    expect(
      csvFromPayload({ content: [{ type: 'image', data: '' }, { type: 'text', text: 'a,b' }] }),
    ).toBe('a,b');
  });

  it('reports nothing readable rather than inventing an empty series', () => {
    expect(csvFromPayload({ payload: { unexpected: 1 } })).toBeNull();
    expect(csvFromPayload({})).toBeNull();
  });

  it('turns an unreadable body into a format failure, not a crash', async () => {
    const mcp: McpCaller = { callTool: () => Promise.resolve({ payload: { nope: true } }) };
    const result = await createAlphaVantageMcpProvider(mcp).fetchSeries('AAPL', '1d', 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('format');
  });
});

describe('connector failures', () => {
  // Each of these has a different fix, and collapsing them into one banner hides the only
  // action that would make the page work.
  for (const [code, kind] of [
    ['needs_reauth', 'no-key'],
    ['server_not_connected', 'no-key'],
    ['server_not_found', 'no-key'],
    ['selection_required', 'no-key'],
    ['not_granted', 'no-key'],
    ['capability_disabled', 'no-key'],
    ['not_in_manifest', 'entitlement'],
    ['blocked_by_policy', 'entitlement'],
    ['approval_required', 'entitlement'],
    ['rate_limited', 'rate-limit'],
    ['server_unavailable', 'network'],
    ['upstream_error', 'network'],
    ['tool_error', 'network'],
  ] as const) {
    it(`maps ${code} to ${kind}`, () => {
      const result = classifyMcpError(code, 'boom');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe(kind);
      expect(result.reason).not.toBe('');
    });
  }

  it('names the action for a connector the viewer has not added', () => {
    const result = classifyMcpError('server_not_connected', 'no such server');
    if (result.ok) return;
    expect(result.reason.toLowerCase()).toContain('connector');
  });

  it('treats a code newer than this build as transient rather than fatal', () => {
    // The contract says to read an unknown code as `upstream_error`. Anything else would
    // have a future runtime permanently disable a working chart.
    const result = classifyMcpError('some_future_code', 'unheard of');
    if (result.ok) return;
    expect(result.kind).toBe('network');
    expect(result.reason).toBe('unheard of');
  });

  it('surfaces the failure through the provider interface', async () => {
    const result = await createAlphaVantageMcpProvider(failing('needs_reauth')).fetchSeries(
      'AAPL',
      '1d',
      10,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('no-key');
  });

  it('survives a rejection that is not an error object at all', async () => {
    const mcp: McpCaller = { callTool: () => rejectWith('plain string') };
    const result = await createAlphaVantageMcpProvider(mcp).fetchSeries('AAPL', '1d', 10);
    expect(result.ok).toBe(false);
  });

  it('never throws out of a provider call', async () => {
    const mcp: McpCaller = {
      callTool: () => {
        throw new Error('synchronous explosion');
      },
    };
    const provider = createAlphaVantageMcpProvider(mcp);
    // Failure is a value at this boundary; a throw would take down whatever awaited it.
    await expect(provider.fetchSeries('AAPL', '1d', 10)).resolves.toMatchObject({ ok: false });
  });
});

describe('a connector call is a real call', () => {
  it('is not made at all for an empty symbol', async () => {
    const call = vi.fn();
    const mcp: McpCaller = {
      callTool: (server, tool, input) => {
        call(server, tool, input);
        return Promise.resolve({ payload: { result: DAILY_CSV } });
      },
    };
    await createAlphaVantageMcpProvider(mcp).fetchSeries('   ', '1d', 10);
    await createAlphaVantageMcpProvider(mcp).searchSymbols('  ');
    expect(call).not.toHaveBeenCalled();
  });
});
