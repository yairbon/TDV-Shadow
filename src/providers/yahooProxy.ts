/**
 * The rule a Yahoo proxy has to follow, wherever it runs.
 *
 * The dev server's proxy (see `vite.config.ts`) forwards anything under `/yahoo`, which is
 * fine on a machine only its owner can reach. A DEPLOYED proxy is a different object: it is
 * a public URL that makes outbound requests on behalf of whoever calls it, and forwarding
 * an arbitrary path turns it into an open relay for someone else's traffic.
 *
 * So a deployed proxy forwards exactly the two endpoints this app calls and refuses
 * everything else. The list is short because the app is small, and keeping it short is the
 * point — every entry is a path a stranger can make the deployment fetch.
 *
 * Pure and host-agnostic on purpose: the Vercel, Netlify and Cloudflare handlers differ
 * only in how they receive a request and return a response, and none of them should be
 * re-deciding this.
 */

export const YAHOO_UPSTREAM = 'https://query2.finance.yahoo.com';

/**
 * Paths the proxy will forward.
 *
 * Anchored, and with no `.*` in the symbol segment — a pattern that matched slashes would
 * let `/v8/finance/chart/x/../../anything` through.
 */
const ALLOWED: readonly RegExp[] = Object.freeze([
  /^\/v8\/finance\/chart\/[^/]+$/,
  /^\/v1\/finance\/search$/,
]);

/**
 * The upstream URL for a request, or `null` when the path is not one this app uses.
 *
 * `pathname` is the path with the proxy's own prefix already removed, and `search` is the
 * query string including its leading `?` (or empty).
 */
export function upstreamUrlFor(pathname: string, search: string): string | null {
  // A path containing a traversal segment cannot be normalised into something safe by
  // pattern matching alone, so it is refused before matching rather than after.
  if (pathname.includes('..')) return null;
  if (!ALLOWED.some((allowed) => allowed.test(pathname))) return null;
  return `${YAHOO_UPSTREAM}${pathname}${search}`;
}

/**
 * Strips a leading proxy prefix from a path.
 *
 * Hosts disagree about what reaches the handler: Vercel passes the full `/yahoo/...`,
 * Netlify rewrites to a function path. Normalising here keeps that difference out of the
 * allowlist.
 */
export function stripPrefix(pathname: string, prefix = '/yahoo'): string {
  if (!pathname.startsWith(prefix)) return pathname;
  // The prefix must end at a segment boundary. A bare `startsWith` also matches
  // `/yahoodle/v8` and chops it to `dle/v8` — a path that then fails the allowlist for the
  // wrong reason, and one that would be mangled rather than refused if the allowlist ever
  // grew a looser entry.
  const rest = pathname.slice(prefix.length);
  return rest === '' || rest.startsWith('/') ? rest : pathname;
}

/** Yahoo answers a bare programmatic client with a challenge page rather than JSON. */
export const UPSTREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'Mozilla/5.0',
  Accept: 'application/json',
});
