/**
 * The deployed proxy's forwarding rule.
 *
 * A proxy on a public URL makes outbound requests on behalf of anyone who calls it, so the
 * property under test is not "does the app's request work" — that is the easy half — but
 * "does everything else get refused". Each case below is a request a stranger could make to
 * the deployment.
 */

import { describe, expect, it } from 'vitest';
import {
  stripPrefix,
  upstreamUrlFor,
  YAHOO_UPSTREAM,
} from '../../../src/providers/yahooProxy.js';

describe('what the proxy forwards', () => {
  it('forwards a chart request', () => {
    const url = upstreamUrlFor('/v8/finance/chart/PLTR', '?interval=5m&range=5d');
    expect(url).toBe(`${YAHOO_UPSTREAM}/v8/finance/chart/PLTR?interval=5m&range=5d`);
  });

  it('forwards a search request', () => {
    expect(upstreamUrlFor('/v1/finance/search', '?q=palantir')).toBe(
      `${YAHOO_UPSTREAM}/v1/finance/search?q=palantir`,
    );
  });

  it('forwards a symbol with a dot in it', () => {
    // ASML.AS and BRK.B are ordinary tickers, not path tricks.
    expect(upstreamUrlFor('/v8/finance/chart/ASML.AS', '')).not.toBeNull();
  });

  it('keeps the query string exactly as given', () => {
    // The interval and range are the whole request; dropping or reordering them silently
    // changes which bars come back.
    const url = upstreamUrlFor('/v8/finance/chart/AAPL', '?interval=1m&range=7d');
    expect(url).toContain('interval=1m');
    expect(url).toContain('range=7d');
  });
});

describe('what the proxy refuses', () => {
  for (const [label, path] of [
    ['an unrelated Yahoo endpoint', '/v7/finance/quote'],
    ['the API root', '/'],
    ['an empty path', ''],
    ['a nested path under chart', '/v8/finance/chart/AAPL/extra'],
    ['a path that only looks like chart', '/evil/v8/finance/chart/AAPL'],
    ['a near-miss on search', '/v1/finance/searchx'],
  ] as const) {
    it(`refuses ${label}`, () => {
      expect(upstreamUrlFor(path, '')).toBeNull();
    });
  }

  it('refuses a traversal that would climb out of the allowed path', () => {
    // The single reason this is not just a prefix check. A pattern permitting slashes in
    // the symbol segment would let this through, and the deployment would fetch whatever
    // sat at the other end.
    expect(upstreamUrlFor('/v8/finance/chart/x/../../../etc/passwd', '')).toBeNull();
    expect(upstreamUrlFor('/v8/finance/chart/..', '')).toBeNull();
  });

  it('cannot be pointed at another host', () => {
    // The upstream origin is a constant here, so a caller has nothing to redirect: whatever
    // survives the allowlist is concatenated onto Yahoo and nothing else.
    const url = upstreamUrlFor('/v8/finance/chart/AAPL', '?interval=1d');
    expect(url?.startsWith(YAHOO_UPSTREAM)).toBe(true);
  });
});

describe('normalising the host prefix', () => {
  it('strips the proxy prefix when the host leaves it on', () => {
    expect(stripPrefix('/yahoo/v8/finance/chart/AAPL')).toBe('/v8/finance/chart/AAPL');
  });

  it('leaves a path that never had the prefix alone', () => {
    // Netlify rewrites before the handler sees it; Vercel does not. The same allowlist has
    // to hold either way.
    expect(stripPrefix('/v8/finance/chart/AAPL')).toBe('/v8/finance/chart/AAPL');
  });

  it('does not strip a prefix that merely starts the same way', () => {
    // `startsWith` alone chopped this to `dle/v8`. The prefix has to end at a segment
    // boundary, or the path is left exactly as it came in.
    expect(stripPrefix('/yahoodle/v8')).toBe('/yahoodle/v8');
  });

  it('handles the prefix on its own', () => {
    expect(stripPrefix('/yahoo')).toBe('');
  });
});
