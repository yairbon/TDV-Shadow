# TDV-Shadow

A TradingView-shaped charting app. Every candle, axis, gridline and crosshair is drawn with
Canvas 2D or WebGL — no DOM node ever represents a chart element.

## Live data

```bash
npm install
npm run dev     # then open http://localhost:5173
```

That is all it takes to get **1m / 5m / 15m / 1h / 1d on every symbol, in real time**. The
dev server proxies Yahoo Finance, which needs no key and no signup — Yahoo sends no CORS
header, so the proxy is what makes it callable from the page at all. Type any ticker into
the symbol box, or press the search button and look one up.

Optional keys, neither required:

| Query parameter | Provider | What it adds |
|---|---|---|
| `?apikey=…` | Twelve Data | intraday without the proxy, 800 requests/day |
| `?avkey=…` | Alpha Vantage | daily only — its free tier gates intraday |
| `?yahoo=1` | Yahoo Finance | forces it on for a **built** app served behind your own proxy |

Keys come from the URL and are never persisted: a credential in `localStorage` outlives the
intent to use it.

A production build has no proxy, so Yahoo is off there and the app falls back to whatever
key it was given, then to the CSVs baked into the build. Click the data source in the legend
— `Yahoo Finance`, `bundled data`, `demo data` — to see the whole chain, whether the
claude.ai connector was reached, and the last thing a provider refused to do.

Yahoo's endpoint is unofficial and can change without notice. That is why it sits *first* in
the chain rather than alone: when it breaks, the request falls through to the keyed
providers and then to the bundled files, instead of the chart going blank.

## Using it on a phone or tablet

**Over your own Wi-Fi**, with nothing to deploy:

```bash
npm run dev -- --host
```

Vite prints a **Network** address like `http://192.168.1.42:5173`. Open that on the tablet
and you get the full app, intraday included — the proxy runs on the computer, the tablet is
just the screen. Needs both devices on the same network and the computer awake.

**From anywhere**, deploy it. A static build is not enough on its own: the whole point of
the Yahoo route is that a *server* makes the outbound call, so the deployment needs the
proxy function in `api/yahoo/` alongside the page.

```bash
npx vercel deploy --prod
```

`vercel.json` builds with `VITE_YAHOO_PROXY=1`, which is what turns the Yahoo provider on
for a deployed build. Leave that out and the app correctly reports intraday unavailable
rather than lighting up buttons it cannot serve.

The deployed proxy forwards **only** the two endpoints this app calls. A public URL that
relays any path is an open relay for other people's traffic; the allowlist lives in
`src/providers/yahooProxy.ts` and is tested in `tests/unit/providers/yahooProxy.spec.ts`.
Netlify and Cloudflare need their own thin wrapper around the same helper.

Touch is supported throughout: drag to pan, pinch to zoom. Below about 1100px the toolbar
collapses its controls into the **⋯** button, the ticker box included.

## Development

```bash
npm test           # unit suite (vitest)
npm run test:visual # end-to-end and visual regression (playwright)
npm run lint
npm run typecheck
```

## Where things are

| Path | What lives there |
|---|---|
| `src/renderer/` | Canvas/WebGL layers, scales, coordinate math |
| `src/data/` | Immutable bar store, resampling, snapshots — no `Date`, no I/O |
| `src/providers/` | The ingest boundary: the only place allowed to touch the network |
| `src/indicators/` | The indicator registry and kernels |
| `src/drawings/` | Drawing tools and their geometry |
| `docs/RENDER_ALGORITHMS.md` | Normative coordinate math — implement it, do not re-derive it |
| `docs/ARCHITECTURE.md` | Module hierarchy and data schema |
| `docs/ROADMAP.md` | What was built, what it cost, and what is deliberately still open |

`CLAUDE.md` at the root carries the non-negotiable rules; several directories add their own.
