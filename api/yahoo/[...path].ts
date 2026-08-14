/**
 * The deployed Yahoo proxy — a Vercel Edge function.
 *
 * This is the piece that makes the app work on a phone or tablet from anywhere. Yahoo sends
 * no CORS header, so the browser cannot call it; the dev server solves that locally and
 * this solves it for a deployment. Both do the same thing: the request becomes same-origin
 * for the page, and a server makes the outbound call.
 *
 * Deploy with `vercel deploy` (or connect the repo). Build with `VITE_YAHOO_PROXY=1` so the
 * app enables the provider — a deployment without this function must NOT, or it lights up
 * six timeframe buttons that cannot fetch anything.
 *
 * Netlify and Cloudflare need only their own wrapper around the same three lines; the
 * decisions all live in `yahooProxy.ts`.
 */

import { stripPrefix, UPSTREAM_HEADERS, upstreamUrlFor } from '../../src/providers/yahooProxy.js';

export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const upstream = upstreamUrlFor(stripPrefix(incoming.pathname), incoming.search);
  if (upstream === null) {
    // Refused rather than forwarded: a public proxy that relays any path is an open relay
    // for someone else's traffic, and this app calls exactly two endpoints.
    return new Response(JSON.stringify({ error: 'path not proxied' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const response = await fetch(upstream, { headers: UPSTREAM_HEADERS });
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
      // The page is served from this same origin, so no CORS header is needed for it —
      // and adding a permissive one would hand the proxy to every other site too.
      'cache-control': 'public, max-age=20',
    },
  });
}
