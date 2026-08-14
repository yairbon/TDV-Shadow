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
