# TDV-Shadow — Architecture Blueprint (Phase 1, plan only)

No source code exists yet by design. This document is the contract Phase 2 implements.
Coordinate math lives in `docs/RENDER_ALGORITHMS.md`; rendering rules in
`skills/chart-render/SKILL.md`.

## 1. Module hierarchy

```
src/
├─ app/
│  ├─ bootstrap.ts          mount, wire store→scheduler, teardown
│  └─ config.ts             instrument list, endpoints, feature flags
├─ data/                    ← no DOM, no canvas, no rendering imports
│  ├─ types.ts              Bar, Series, Timeframe, branded scalars
│  ├─ codec.ts              wire → frozen Bar; validation, NaN rejection
│  ├─ ws/
│  │  ├─ client.ts          connect, backoff+jitter, heartbeat, resubscribe
│  │  ├─ protocol.ts        subscribe/unsubscribe/seq/gap message shapes
│  │  └─ gapDetector.ts     seq-gap → backfill request
│  ├─ rest/
│  │  └─ history.ts         paged historical fetch (cursor = oldest ts)
│  ├─ store/
│  │  ├─ seriesStore.ts     append-only bars; replaceLast(); snapshot()
│  │  ├─ viewStore.ts       scrollPosition k, barSpacing s, scale mode
│  │  └─ snapshot.ts        O(1) frozen view handed to the renderer
│  └─ agg/
│     └─ resample.ts        1m → 5m/15m/1h/1d rollup (client-side)
├─ renderer/                ← pure paint; input = snapshot + scales + layout
│  ├─ surface.ts            canvas creation, DPR transform, resize observer
│  ├─ scheduler.ts          invalidate(mask) → single rAF → frame()
│  ├─ layout.ts             plot rect, price gutter, time gutter, volume pane
│  ├─ scale/
│  │  ├─ priceScale.ts      §2/§3 linear+log, Y and Y⁻¹
│  │  ├─ timeScale.ts       §5 X, X⁻¹, visible range, zoom/pan
│  │  └─ ticks.ts           §8 nice-number ticks, time tick selection
│  ├─ layers/
│  │  ├─ gridLayer.ts
│  │  ├─ seriesLayer.ts     candles (§6) + volume (§9), batched by color
│  │  ├─ overlayLayer.ts    indicators, drawings
│  │  └─ crosshairLayer.ts  §10
│  └─ theme.ts              colors, typography, densities
├─ interaction/
│  ├─ pointer.ts            drag-pan, wheel-zoom, pinch → viewStore
│  └─ keyboard.ts
└─ ui/                      ← the only place DOM is allowed
   ├─ Toolbar.tsx  Legend.tsx  SymbolSearch.tsx
```

Dependency rule: `ui → app → {data, renderer}`, `renderer → data/types only`,
`data ↛ renderer`. Enforced by an ESLint `no-restricted-imports` boundary rule.

## 2. Runtime data flow

```
PostgreSQL/Timescale ──REST /history──┐
                                      ├─→ codec ─→ seriesStore ─┐
gateway ──WebSocket /stream──────────┘                          │
                                                                ▼
pointer/keyboard ─→ viewStore ─────────────→ scheduler.invalidate(mask)
                                                                │
                                                          rAF frame()
                                                                │
                              snapshot() → scales → layers → canvas
```

Back-pressure: WS messages are coalesced per symbol into a pending-tick map; at most one
`replaceLast` per bar per frame reaches the store. Bursts never queue frames.

## 3. Data schema

### 3.1 Bar (in-memory, frozen)

```ts
type TimeMs = number & { readonly __brand: 'TimeMs' };   // UTC ms, bar OPEN
interface Bar {
  readonly t: TimeMs;
  readonly o: number; readonly h: number;
  readonly l: number; readonly c: number;
  readonly v: number;
}
interface Series {
  readonly symbol: string;
  readonly tf: Timeframe;            // '1m'|'5m'|'15m'|'1h'|'4h'|'1d'
  readonly bars: readonly Bar[];     // ascending t, no duplicates, no gaps in index space
  readonly state: 'loading' | 'live' | 'stale';
  readonly lastSeq: number;
}
```

Invariants: `bars[i].t < bars[i+1].t`; `l <= min(o,c)` and `h >= max(o,c)`; `v >= 0`.
Violations are dropped at the codec boundary and counted, never thrown into the render path.

### 3.2 Wire format (WebSocket)

```jsonc
// client → server
{ "op": "sub",   "ch": "bars", "sym": "BTCUSD", "tf": "1m" }
{ "op": "unsub", "ch": "bars", "sym": "BTCUSD", "tf": "1m" }
// server → client
{ "ch":"bars", "sym":"BTCUSD", "tf":"1m", "seq": 91021,
  "b": [1754870400000, 61230.5, 61290.0, 61190.25, 61255.75, 12.83],  // [t,o,h,l,c,v]
  "final": false }                                                     // true = bar closed
{ "op":"pong", "ts": 1754870401234 }
```

Array-tuple payload, not objects — ~40% fewer bytes on the hot path.
`seq` is monotonic per `(sym, tf)`; a skip triggers `rest/history` backfill from the last
known good `t` and marks the series `stale` until reconciled.

### 3.3 PostgreSQL (TimescaleDB hypertable)

```sql
CREATE TABLE candles (
  symbol      text        NOT NULL,
  tf          text        NOT NULL,
  ts          timestamptz NOT NULL,       -- bar open, UTC
  open        numeric(20,8) NOT NULL,
  high        numeric(20,8) NOT NULL,
  low         numeric(20,8) NOT NULL,
  close       numeric(20,8) NOT NULL,
  volume      numeric(28,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, tf, ts),
  CHECK (high >= greatest(open, close) AND low <= least(open, close))
);
SELECT create_hypertable('candles', 'ts', chunk_time_interval => interval '7 days');
CREATE INDEX ON candles (symbol, tf, ts DESC);

-- higher timeframes as continuous aggregates over the 1m base
CREATE MATERIALIZED VIEW candles_1h WITH (timescaledb.continuous) AS
SELECT symbol, time_bucket('1 hour', ts) AS ts,
       first(open, ts) AS open, max(high) AS high,
       min(low) AS low, last(close, ts) AS close, sum(volume) AS volume
FROM candles WHERE tf = '1m' GROUP BY symbol, 2;
```

History endpoint: `GET /history?sym&tf&to=<ms>&limit=<=5000` → descending page, cursor is
the oldest returned `ts`. `numeric` on the wire is serialised as a JSON number only after
range validation; precision beyond float64 is a known, documented limitation for display.

## 4. Scale math summary

Full derivations in `docs/RENDER_ALGORITHMS.md`. The two load-bearing maps:

```
Y(p) = P.t + (pMax - p) * P.h / (pMax - pMin)          // price → pixel, inverted
X(i) = P.l + P.w - (k - i) * s                         // bar index → pixel, bar center
```

with inverses `Y⁻¹(y) = pMax - (y - P.t) * (pMax - pMin) / P.h` and
`X⁻¹(x) = k - (P.l + P.w - x) / s`. Log scale substitutes `ln p` for `p`.
Candle width: `bw = max(1, min(floor(0.8s), floor(s) - 1))`, forced odd — this is what
guarantees candles never touch.

## 5. Phasing

| Phase | Deliverable | Owner |
| --- | --- | --- |
| 1 | plugin manifest, hooks, CLAUDE.md tiers, skill, this blueprint | done |
| 2A | `src/data/**` — WS client, store, history, resample | Subagent A (worktree) |
| 2B | `src/renderer/**` — surface, scheduler, scales, layers | Subagent B (worktree) |
| 3 | Playwright visual regression + geometry assertions | after 2A/2B merge |
| 4 | WebGL series layer behind a flag; Canvas2D stays the reference | later |

2A and 2B share only `src/data/types.ts`, which is written first and frozen before either
starts — that is the entire merge surface between the two worktrees.

## 6. Context-engineering layer (how the hooks actually work)

Recorded here because it is easy to get wrong and expensive to rediscover.

| Hook | Event | What it does | Why this event |
| --- | --- | --- | --- |
| `sessionstart-inject-math.sh` | `SessionStart` (`startup\|clear\|compact`) | Emits the MATH-CRITICAL block as `hookSpecificOutput.additionalContext` | **This is the one that preserves the math.** SessionStart supports `additionalContext` and its `compact` matcher fires right after a compaction. |
| `precompact-preserve-math.sh` | `PreCompact` | Verifies the math doc + markers exist, stages `.claude/.math-snapshot.md`, exits 2 to abort compaction if the math would be lost | **PreCompact cannot inject context** — it supports only `decision: "block"` / exit 2. A PreCompact hook that returns `additionalContext` is silently ignored. |
| `guard-dom-in-renderer.sh` | `PreToolUse` (Edit/Write/MultiEdit) | Exit 2 blocks writes containing DOM-construction APIs under `src/renderer` | PreToolUse exit 2 blocks the call; stderr goes back to Claude. |
| `check-silent.sh` | `PostToolUse` (Edit/Write/MultiEdit) | ESLint (`--format json`, rendered terse) + `tsc --noEmit`; silent on success, ≤40 lines on failure | PostToolUse exit 2 cannot block (the write already happened) but does surface stderr. |

Two traps worth remembering: ESLint 9 removed the `unix` and `compact` formatters from
core, so the hook uses `--format json` and renders the lines itself; and the enforcement
is doubled at rest — the same DOM ban exists as an ESLint `no-restricted-syntax` rule, so
it still holds for anyone editing without Claude Code.

## 7. Non-goals (v1)

Order entry, broker connectivity, replay mode, multi-pane layouts, saved templates,
server-side indicator computation.
