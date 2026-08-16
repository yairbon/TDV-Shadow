# Roadmap — status

Written after auditing the code rather than the screenshots. The original diagnosis was
that the gap to TradingView was **not** feature count but the absence of an interaction
layer. Phases 7–10 closed that. This file now records what shipped, what each item cost,
and what is deliberately still open.

## The original five findings, and where they stand

| Finding | Status |
| --- | --- |
| `hitTest.ts` never called by the app | **Fixed** (7.1). Wired into the pointer layer; drawings select, drag and delete. |
| `drawings.select()` never called | **Fixed** (7.1). It also never notified subscribers, so the highlight did not repaint. |
| No undo stack | **Fixed** (7.2). Snapshot-based, one step per edit. |
| `addIndicator` called with no params from the UI | **Fixed** (8.1). Settings sheet derived from each indicator's own declared defaults. |
| No context menu, no shortcuts beyond ⌘K | **Fixed** (7.3, 7.4). |

---

## Phase 7 — Direct manipulation ✅

**7.1 Selection, drag, delete.** Click selects (anchor handles beat the body), drag an
anchor to reshape, drag the body to translate, `Delete` removes, `Esc` cancels. The
gesture runs in the capture phase and stops propagation so pan never sees it, and dragging
works in DATA space so the anchor rule holds at any zoom and on a log scale.

**7.2 Undo/redo.** Snapshot-based rather than inverse-command based — drawing sets are
small, and one wrong inverse corrupts state untraceably. `capture()` runs BEFORE every
mutation and collapses no-ops, so a drag that ends where it started does not eat a step.

**7.3 Context menus.** Drawing (settings, clone, lock, order, remove), plot (indicators,
scales, fit, alerts, replay, clear), price gutter (log, invert, auto scale, alert), time
gutter. Surfaced three store bugs: `update()` rejected every patch on a locked drawing so
locking was one-way; `select()` did not notify; `visible: false` was ignored by the
renderer. Also added §2.1 — an invertible price axis — which exposed the same latent bug
in three renderers, all of which built wick rects assuming Y(high) is above Y(low).

**7.4 Keyboard map.** Tools, magnet, undo/redo, delete, escape, home, replay — behind a
guard that never steals a key from a text field.

## Phase 8 — Configuration surfaces ✅

**8.1 Indicator settings.** The form is DERIVED from the definition's `defaults` and its
declared plots, so a dialog cannot offer a field the indicator ignores. Live preview;
Cancel and Escape both revert; one undo step per edit.

**8.2 Drawing style editor.** Colour, width, dash, opacity, labels — every one of which
already existed on `DrawingStyle` and was read by nothing. `drawDrawings` now honours them.

**8.3 Chart settings.** Gridlines, price decimals, right margin, timezone, candle colours,
applied through `updateSettings` and a repaint rather than a rebuild.

## Phase 9 — Analysis ✅

**9.1 Measure tool.** Shift-drag or the rail ruler; Δprice, Δ%, bars and elapsed time.
Anchors in data space, painted on the crosshair layer.

**9.2 Price alerts.** Draggable levels, checked on each tick against the bar's RANGE with
a remembered side, so an alert fires once when the price reaches it rather than on every
bar thereafter.

**9.3 Replay mode.** A view truncation, not a data mutation: the snapshot is truncated
once, so autoscale, the axes, the indicators and the drawings all agree about where the
series ends.

## Phase 10 — Scale and fidelity ✅

**10.1 Large history.** 100k bars inside the 8ms budget. The bottleneck was not the bar
count: the chart-type transform, every indicator and the GL upload were keyed on a
combined series+view revision, so none of those memos ever hit while panning. §5.1 adds
level-of-detail aggregation and lowers the zoom floor so "fit all" over 100k bars actually
fits. `tests/visual/performance.spec.ts` asserts both work counters and wall time.

**10.2 Session breaks and timezone.** Weekends already consumed no width — that is what
index space means, and there is now a test saying so. Added: a display timezone for every
label, DST-correct via `Intl` per instant, and session separators at day boundaries.

**10.3 Resampling chart types.** Renko, Kagi, P&F, Line Break and Range are in the picker.
They render in their own index space with timestamps resolved through `sourceIndex`, so
there is one index space again rather than two.

**10.4 Multi-chart layouts.** 1, 2×1, 1×2 and 2×2. Each pane is a full chart; the active
pane owns the toolbar. Crosshair sync broadcasts the bar index, not the pixel.

---

## Fixed after the phase work, from an end-to-end pass

Running the built app rather than the tests turned up six defects, all now fixed and
covered:

- **Derived bars carried no volume.** A brick was built with `v = 0`, so the volume pane
  vanished and VWAP, Volume and Volume Profile silently produced nothing on five of the
  fourteen chart types. A brick's volume is the sum of the source bars it spans.
- **Drawings jumped on a chart-type switch.** Anchors are index-based and a resampling
  type has its own index space, so bar 400 of the source became brick 400 — a different
  moment. Anchors are now remapped through TIME across the switch (`src/charts/remap.ts`),
  which keeps the frozen anchor rule and converts at the boundary.
- **The legend described one pane while sitting on another.** It reads the active chart
  but was pinned to the top-left of the whole plot area. Worse, its indicator rows are
  clickable, so it swallowed the clicks meant to activate the pane underneath — clicking
  pane 0 simply did nothing once pane 1 had an indicator.
- **Only the active pane was saved.** The workspace held one chart's state plus a list of
  pane symbols, so a reload restored what the other panes were showing and dropped every
  indicator, drawing and alert on them. The schema is per-pane now (version 2).
- **Alert toasts named the wrong instrument** — they read the active pane's symbol rather
  than the pane that fired.
- **Live ticks reached only the active pane**, so a multi-pane layout froze every chart
  you were not looking at.

## Found by driving long sessions

`tests/visual/workflow.spec.ts` strings features together the way a person would and
checks only that the chart is still healthy afterwards. Every bug found by hand rather
than by the suite had come from an interaction BETWEEN features, and none were reachable
from a test that exercised one at a time. It found three more:

- **`getIntegrityReport()` called correctly drawn charts broken.** §6's no-overlap
  invariant has a precondition the report ignored: a body is floored at 1px, so a 1px gap
  needs at least 2px per bar. Below that, bars necessarily share pixels — that is the
  regime §5.1 aggregates for — and the renderer's own unit tests had always skipped the
  check there. `ok` was false for any chart fitted to under 2px per bar, which is most of
  them at a wide zoom.
- **Shift-drag starting on a drawing grabbed the drawing as well as measuring.** Both
  handlers sit on the same element, so the measure handler's `stopPropagation` never
  stopped the selection one; the aborted drag also left an undo step behind.
- **A boot-time ReferenceError left every test green.** `setActivePane` began touching a
  `let` declared 500 lines further down, boot calls it while restoring a layout, and the
  restore died silently. `tests/visual/harness.ts` now fails a test on any uncaught page
  error, and was itself verified by injecting a throw.

## Found by looking at the built app

Two more, both in the seam between the built-in layers and the derived one:

- **The volume pane was empty for every non-candle chart type.** The built-in candle layer
  owns that pane and is skipped entirely for a custom type, so nine of the fourteen charts
  showed a blank band. The derived layer draws it now, over its own bars.
- **The derived layer never cleared the volume pane** (mandate #2). It cleared
  `plot.left + plot.width` by `plot.top + plot.height`, which stops exactly at the top of
  that pane, so the candle columns from before the switch stayed painted underneath —
  which is also why the empty pane above had gone unnoticed.
- **A chart-type switch remapped the drawings but not the view.** A chart fitted to 900
  source bars kept that bar spacing and scroll position over a 53-brick Renko series, so
  the bricks ended up crammed into the far left of an otherwise empty plot. The visible
  window is remapped through time now, the same way the anchors already were.

The test for the first two is one assertion with two halves, because each bug hid the
other: `ink > 0` passes on a chart that draws nothing while stale columns remain, and
"no ink outside a bar" passes on an empty pane. It also has to zoom in first — at the
default fit an index-preserving type sits under 2px per bar, the bodies tile the plot end
to end, and there is nowhere for stray ink to be detected. Both halves were verified by
reverting each fix separately.

Three more from the same pass, each of which only shows up on screen:

- **Every level label was drawn at `plot.left + 6`.** A fib placed on the right of the
  chart wrote its ratio labels over on the far left, on top of the legend and pointing at
  nothing. `Level` carries its own left edge now, clamped so the label stays inside the
  plot at either end — the layer clips to the plot, so an unclamped label is silently
  truncated rather than merely misplaced.
- **Crosshair sync broadcast the bar INDEX.** Index `i` is the same moment in two panes
  only when both hold the same series at the same timeframe. A 1m pane beside a 1H one
  sent an index past the end of the shorter series, so no synced line appeared at all —
  which is what a four-pane layout actually did. Time is the only coordinate the panes
  share; each converts it to its own index and shows nothing when the moment is outside
  its history.
- **The status readout sat off the right edge of the top bar**, clipped mid-word
  ("2 drawin"), at every window narrower than about 1650px. The bar scrolls horizontally
  and the status is its last item; it is stuck to the scrollport's right edge now.

## Tier 2 ✅

- **Toolbar overflow.** The bar held more than fits a 1440px window, so five controls sat
  past the right edge; reachable by scrolling, but nothing said so. Controls now move into
  an overflow panel — moved, not mirrored, so there is one widget per piece of state.
- **Ranked symbol search.** The matcher was a substring filter in declaration order, so
  `APL` found nothing and `A` returned eight symbols arbitrarily ordered. Now tiered —
  exact ticker, ticker prefix by coverage, label word start, substring, then subsequence
  over the ticker only — with recents breaking ties and match ranges for highlighting.
  Deliberately no fuzzy matching over LABELS: with two-to-four-word labels, subsequence
  matching makes everything match everything and the ranking stops meaning anything.
- **Fixed while wiring it:** the results list built `innerHTML` from the raw query, and
  the "fetch from the network" row carries that query verbatim — so a query containing
  markup was written straight into the page.

- **Compare a second symbol.** The largest gap in the plan. Alignment is by TIME, not by
  index: zipping the two bar arrays is the obvious implementation and it is wrong in a way
  that looks right — one extra holiday in the secondary shifts every later value by a bar,
  and the overlay reads as a plausible curve that is a day out and drifting. Forward-fill
  where the secondary did not trade, NaN before its first bar and after its last, so the
  line breaks rather than painting a flat quote across years the instrument did not exist.
  Both series are re-based to 0% at the left edge of the view and the comparison is
  projected back through the PRIMARY's price scale, so log mode and axis inversion apply to
  it for free rather than needing a second scale that could drift out of agreement.

- **Object tree.** `Drawing` has carried `visible` and `locked` since the store was
  written, and both were honoured by the renderer and the pointer layer — but the only way
  to reach either was the per-drawing context menu, so you had to find the shape on the
  plot before you could hide it, which is exactly the situation where you cannot find it.
  Hide/lock per row and in bulk, remove, and select; the panel subscribes to the store so
  an edit made on the canvas keeps it honest.

- **Resizable panes.** The split was a single fixed fraction, so an RSI squashed into 60px
  stayed squashed. Drag the gap between any two stacked panes; height moves between that
  pair only, their total is invariant (which is what makes a drag exactly reversible), and
  a drag past the limit clamps rather than inverting a pane. Starvation scales every pane
  down together rather than dropping one — a user who dragged two dividers should not have
  a pane vanish. Persisted without a schema bump, since the field is optional in both
  directions and bumping would have discarded every existing workspace.

- **Named layouts.** The autosave is where you are right now; a named layout is a snapshot
  you chose to keep, on its own key. Saving deliberately does NOT stop the autosave
  tracking the live chart, or "save" would quietly become "switch to" and the next edit
  would go to the saved copy. Opening one writes it to the autosave key and reloads, so
  the boot-time restore — which already knows how to rebuild symbols, panes, per-symbol
  drawings, indicators, alerts, pane heights and the view — does the work, rather than a
  second restore path that would drift from the one that runs every start.

- **A second price scale.** A comparison can be read on its own left-hand axis rather than
  as a percent of the primary. Percent stays the default — it is what makes two instruments
  comparable at all — and the axis appears only when asked for, taking its width from the
  plot. It is always LINEAR: inheriting the primary's log or percent mode would relabel a
  series in units it was never expressed in, which is the confusion a second scale exists
  to remove. The toggle exists only while a comparison does.
- **Fixed while mutation-testing it:** a dragged price axis rebuilt the frame without
  re-passing the left range, so the axis blanked mid-drag while the layout still held its
  width open. And the e2e ink metric counted the ALPHA channel on a layer that paints an
  opaque background — every pixel scored, and the measurement passed with the axis deleted.

## Tier 3 ✅

- **Eight drawing tools.** Horizontal ray, parallel channel, price range, date range, date
  and price range, trend angle, polyline, callout. Two things they forced: `barMs` is a
  param rather than something geometry derives, because `buildGeometry` is handed the two
  projectors and the plot box and nothing in there says how much TIME a bar spans; and the
  parallel channel's copy is translated in PIXELS, since the base is already a straight
  pixel segment between two projected anchors and a price-space offset would put the copy
  visibly off the handle it was dragged to on a log scale.
- **Nine indicators.** OBV, CCI, Williams %R, Donchian, Keltner, ADX, Supertrend, PSAR,
  Ichimoku. Rolling extremes use a monotonic-deque kernel, so nothing is O(n·period) on a
  52-bar window.
- **A grouped tool rail.** One slot per family, showing whichever member you used last,
  with a chevron for the rest. The flat rail listed fifteen tools against a catalogue of
  thirty — half of what this app can draw had no way to reach it — and eight more would
  have pushed it past the height of an 800px window, where the overflow is a scrollbar
  nobody looks for. Flyouts are positioned in code, because the rail is a left column on
  desktop and a bottom bar on phones and one static offset is wrong in the other.
- **The polyline finishes early**, with Enter or a double-click. Its eight anchors are a
  ceiling rather than a shape, so completeness is gated on `minAnchorCount`; requiring all
  eight rendered a four-legged path as nothing.

**One defect, found three times.** Three separate hand-maintained lists restated what an
indicator's own definition already declares, and all three had gone stale:

- The layout counted panes from a set of ids, so the six new pane indicators computed
  correctly, printed their values in the legend, and were allocated no pane to draw in.
- The MCP server restated the indicator ids, so the nine were addressable from the browser
  and invisible over MCP.
- `resolveToken` had two general-purpose line colours for an indicator that plots five, so
  Ichimoku's lagging span was drawn identically to its base line.

All three now derive from the registry, and a test walks it rather than naming ids.

- **Indicator on indicator.** An SMA of an RSI, a Bollinger band around an OBV. The source
  indicator's output is fed to the second one AS the price series, so all twenty stack on
  all twenty without a single definition learning about it — the alternative, threading an
  optional source array through every `compute`, would have touched every one and left each
  free to ignore it. `params.source` carries either a price field or `"<handle>:<plot>"`;
  one field rather than two, because two could disagree and there is no principled answer
  to which wins. A source must sit EARLIER in the stack, which makes a cycle impossible by
  construction rather than something to detect.

  Three things this turned up:

  - Warm-up has to be CLIPPED before computing and padded back after. The kernels carry
    running sums, and one NaN entering a running sum keeps it NaN for the rest of the
    array — a 9-period SMA over a 14-period RSI came out empty for all 200 bars, not
    merely late.
  - `readIndicator` recomputed from id and params alone, so the control API reported a
    curve with a different warm-up and different values from the one on the chart. It asks
    the chart now.
  - An overlay indicator has to draw where its SOURCE lives. An SMA of an RSI is in the
    RSI's units, so on the price plot it sat hundreds of points outside the visible range
    and was clipped away entirely: correct values, nothing on screen. It joins the RSI's
    pane, on the RSI's scale, in a colour the RSI is not already using.

- **Live prices, and every stock.** The provider layer is finished at both ends now.

  Search asks every ready provider in the chain and merges the answers with the bundled
  list into ONE ranking pass. Appending remote hits below local ones was the tempting
  shape and the wrong one — an exact remote ticker would then sit under every fuzzy
  bundled match, so typing the name of the thing you want returns four other things
  first. Hits are deduplicated by `(symbol, exchange)`, which is the pair that identifies
  an instrument: TSLA on NASDAQ and TSLA on BMV are different instruments in different
  currencies and both rows are kept.

  The Live toggle is no longer a synonym for the tick simulator. What it does is decided
  by where the bars came from: a generated series is walked forward with simulated ticks,
  a provider series is polled for a real quote, and bundled history refuses with a reason
  — no amount of polling makes a file move. The label distinguishes `Live`, `Sim`,
  `Closed` and `Stale`, because "not moving because the exchange is shut" and "not moving
  because the provider stopped answering" look identical on a chart and only one of them
  is worth acting on.

  Two things this turned up:

  - A quote is a price, not a trade report. It moves the close and widens the extremes; the
    open and the volume are left exactly as they were. And when a quote arrives from PAST
    the last bar, the honest move is to ask the provider for bars rather than synthesize
    one: a fabricated bar carries `v = 0` and an open equal to its close, which is a
    real-looking bar that never traded that way, and for a daily series the next bar's open
    time is a calendar question — weekends, holidays, half days — that a timestamp cannot
    answer.
  - `pushTick` used `replaceLast`, which answers a new bar open with `false`. A live source
    eventually crosses a bar boundary, so the series would have sat frozen on the last bar
    of the first minute while prices kept arriving — a stalled feed rather than a dropped
    bar. It applies the bar now, replacing or appending on its own open.

  A search failure also surfaced a real bug: the chain asked providers that had already
  declared themselves unready, and their "no key" refusal was recorded as the LAST failure
  — so a rate-limited Twelve Data reported "add an Alpha Vantage key" to someone who was
  not using Alpha Vantage.

- **The published artifact reaches real data.** That page runs with no outbound network at
  all, so every REST provider is dead there. The route that does work is the viewer's own
  connector: the page asks the claude.ai runtime to make the call, it runs with the
  viewer's credentials, and the page never sees a token. The transport is the only thing
  written twice — the CSV that comes back is byte-for-byte what the REST endpoint serves,
  so the parsing, the session-midnight stamping and the error classification are shared
  with the REST adapter.

  The chain is REPLACED rather than reordered when the connector is found. Left in, the
  REST providers would claim every timeframe natively, enable all six buttons, and fail on
  each press — exactly the lying-button problem the capability layer exists to remove.

  What the artifact gets is **daily bars and a quote, and nothing finer**, because Alpha
  Vantage gates intraday behind a premium key. 1m/5m/1h are real only when the app is run
  locally against a Twelve Data key.

- **Diagnosing the published page.** Two rounds of "it does not load and I see no intraday"
  could not be answered from outside the artifact, because nothing about the data path was
  visible: whether a runtime was found, whether the capability was granted, which providers
  were in the chain, what each would serve. Guessing produced two wrong theories before a
  stubbed-runtime test suite produced five right ones.

  The app now says so itself. The legend names the source — `demo data`, `bundled data`, or
  the provider's label — and clicking it opens a panel with the detection result, the chain,
  and the last refusal verbatim. The status line already carried failures, but it is
  transient by design and the question gets asked minutes later.

  What the tests turned up once the path could be driven at all:

  - **Detection looked exactly once**, at module-eval time. The app's script is a deferred
    module so the host normally wins that race, but losing it is not a graceful
    degradation: the REST providers stay in a chain that cannot reach anything.
  - **`series` was not a chain.** It resolved one provider and a failure there ended the
    request — no fallthrough to the bundled CSVs behind it. `quote` had looped since it was
    written; `series` never did.
  - **`loadTicker` short-circuited every bundled ticker to its CSV**, so AAPL and TSLA
    loaded months-old bars that look exactly like fresh ones. Every non-generated symbol
    goes through the chain now, and the CSV answers only when nothing live can — at which
    point it is marked `bundled`, so the Live toggle does not offer to poll a file.
  - **`loadTicker` set the symbol heading by hand** instead of calling `syncSymbolChrome`,
    so the Live toggle kept whatever enabled state the previous symbol had left behind.
  - **The legend's new source label was not clickable.** `#legend` is `pointer-events: none`
    so the crosshair works under it, which silently swallows clicks on any child that does
    not opt back in. It looked interactive and did nothing.

  And one thing that is not a bug and cannot be fixed in this repo: **Alpha Vantage's free
  tier gates intraday**, verified by calling `TIME_SERIES_INTRADAY` through the connector
  and reading back "This is a premium endpoint". The artifact gets daily. 1m/5m/1h need
  either a premium key or the app run locally against Twelve Data.

- **Intraday for every symbol, with no key: Yahoo Finance behind a proxy.**

  The complaint was "1 min and 5 min do not work for other stocks", and the cause was
  mundane: the app shipped Twelve Data's `demo` key, which serves **AAPL and nothing else**
  — every other ticker answers 401. The intraday plumbing was fine; it was being handed a
  one-symbol credential.

  Every free source was then tested rather than remembered, on the one axis that decides it
  for a browser-only app — whether the response carries `Access-Control-Allow-Origin`:

  | Source | CORS | Free intraday | Limit |
  |---|---|---|---|
  | Yahoo Finance | **none** | all symbols, 1m–1d, real time | needs a proxy |
  | Twelve Data (own key) | `*` | all symbols, real time | 8/min, 800/day |
  | Twelve Data (`demo`) | `*` | AAPL only | — |
  | Alpha Vantage | `*` | none — premium endpoint | 25/day |
  | Finnhub | `*` | none — candles 403 on free | — |
  | Polygon | yes | minute aggs, end-of-day only | 5/min |
  | Alpaca | `*` | IEX only, secret in the browser | 200/min |
  | Tiingo | none | — | unusable from a browser |

  Yahoo wins on data and loses on CORS, and CORS is the one that can be engineered away: the
  dev server proxies `/yahoo/*`, so the browser makes a same-origin request and the server
  makes the outbound one. `vite.config.ts` exists for exactly this.

  That buys something no other provider here has: **the whole path is verified in a real
  browser against the real endpoint.** This sandbox blocks browser egress, so every other
  adapter's browser hop is proven only against intercepted responses. Behind the proxy the
  browser only talks to localhost, so PLTR and ASML were driven live at 1d/1h/5m/1m with the
  last bar landing on the current minute.

  What the wire turned out to be, none of it guessable:

  - Timestamps are epoch **seconds, UTC, bar open** — no zone conversion, unlike Twelve Data.
  - The **last row is not a bar.** Yahoo appends the live quote at `meta.regularMarketTime`,
    a precise trade time, so it sits 23 seconds past a boundary. Kept, every intraday series
    ends with a bar open at 17:10:23.
  - Daily and 4-hour bars are stamped at the **session** open, and Yahoo's 4h buckets are
    session-aligned — better than rolling them up here, which buckets on UTC and splits
    every session in two.
  - `meta.validRanges` is **wrong**: it advertises `1y` and `max` for a 1-minute series that
    refuses anything past about eight days. The range table is measured instead.
  - Hourly bars therefore sit on the half hour for a US venue. A test asserting
    `t % 3600000 === 0` calls a correct series broken; the property is one consistent phase,
    not zero.

  The cost, stated plainly: it is an unofficial endpoint that can change without notice, and
  it works only where something is proxying — never in the published artifact. Both are
  priced in. It sits first in the chain precisely because the chain falls through when it
  breaks, and `ready` is passed in rather than sniffed so a build with no proxy does not
  light up six buttons it cannot serve.

- **Closing the gap to TradingView: a watchlist, and the timeframe that was never on screen.**

  Two things, found by looking at the app rather than at the code.

  **`4h` had no button.** It was in `TIMEFRAMES`, resolvable by the provider chain, and
  served natively by Yahoo with session-aligned buckets — and completely unreachable,
  because the toolbar built its buttons from a second hand-written list that had five
  entries instead of six. That is the same defect this document already records three
  times, in the pane allocator, the MCP server and `resolveToken`. The buttons are derived
  from `DATA_TIMEFRAMES` now, with a label map beside it: a missing key degrades to the
  timeframe's own name, where a missing array entry vanished silently.

  **A watchlist**, the most recognisable thing TradingView has that this did not. A column
  of symbols with live prices and a percentage, one click to chart any of them. The rules —
  membership, ordering, which price belongs to which row — are pure and unit-tested in
  `app/watchlist.ts`; the panel only draws. Three decisions worth recording:

  - It is a **sibling of the chart in the flex layout, not an overlay**. Overlaid, it would
    sit on the canvas the crosshair needs, and the chart would keep sizing itself as though
    the panel were not there.
  - Quotes are held **beside** the symbols rather than inside them, and a quote for an
    unlisted symbol is refused. Requests are in flight while the list is being edited, and a
    late answer would otherwise resurrect a row the reader had just deleted.
  - Only membership is persisted. A stored price is wrong the moment it is read back.

  This turned up something the provider layer had been discarding all along: **every quote
  endpoint sends the previous close**, and none of the adapters kept it. Without it a
  percentage could only be derived from the bars already on the chart — which meant a change
  column that was empty for every instrument except the one being charted. `Quote` carries
  `previousClose` now, and all four adapters populate it.

  Two smaller things the browser caught that no unit test would have: the panel's markup
  landed outside `#body` with unbalanced `div`s, and the block's `const` was read by
  `syncSymbolChrome` during boot before it was initialised — a temporal-dead-zone error that
  killed the whole module, silently, leaving a page that looked fine but had no watchlist.

- **A full-project audit.** Read for defects rather than for features, plus a live pass
  through every chart type and every indicator. Six things came out of it.

  **Dead code, and one piece of it dangerous.** Four exports were declared and referenced
  nowhere: `WS_CLOSING`, `anchorCountFor` (a one-line wrapper over a field its callers read
  directly), `getChartTransform`, and — the one worth naming — `expandDegenerateRange`, a
  SECOND implementation of the §2 degenerate-range guard. `RENDER_ALGORITHMS.md` is
  normative and the root mandate says not to re-derive it; a second copy of a normative rule
  is a drift waiting to happen, and this one had already drifted into a different return
  shape. The live one is `priceScale.expandDegenerate`, applied by `makePriceRange`, which
  every pane range already goes through.

  **A fifth hand-maintained list.** `PICKABLE_TYPES` in the toolbar enumerated all fourteen
  chart types — identical in content AND order to `CHART_TYPES`. Same defect as the pane
  allocator, the MCP server, `resolveToken` and the timeframe buttons. Derived now. A sweep
  for the same shape across the whole tree found only two others, and both are correct:
  a provider's `nativeTimeframes` is a claim about what THAT VENDOR serves, and deriving it
  from our own list would make every provider auto-claim any timeframe the app invents —
  the lying-capability bug the layer exists to prevent. Yahoo's second list was folded into
  the type-checked `INTERVAL` record it had to agree with.

  **`series` and `quote` had no deadline.** `search` was given a per-provider timeout when a
  blocked vendor was found stalling the dialog; the other two paths were left alone. They had
  the same hole and a worse symptom: loading a symbol no provider carried hung forever,
  because the first said not-found and the second never replied at all. Every path is bounded
  now, with a budget per kind — a series is the large payload worth waiting on, a quote is
  small and re-polled shortly, a search is interactive.

  **The status line raced its own outcome.** A fixed six-second hold against a load that took
  ten: the counters reclaimed the line, the chart looked settled and unchanged, and then a
  failure appeared out of nowhere seconds later. It is a flag now, released by the outcome
  rather than by a clock — which is only safe *because* every provider finally has a
  deadline, so the outcome always arrives. Both early returns release it too; one of them
  would otherwise have pinned the line forever.

## Deliberately still open
- **Pine Script.** A compiler that does not actually parse Pine would emit confident,
  wrong diagnostics. If scripting is wanted, the honest version is a small documented
  expression DSL with a real parser, named as itself.
- **A symbol universe of our own.** Search now merges every provider in the chain with the
  bundled list, so it reaches whatever the venues index — but the index is theirs, not
  ours, and it is only as complete and as current as the key in use. An unmatched query is
  still offered as a row, because the series endpoints accept tickers the search index
  does not list.
- **Broker/order integration.** Out of scope for a charting library.
- **Volume-weighted indicators on a resampling type** are computed over the brick series.
  With brick volume now summed from the source that is well defined, but a VWAP over
  Renko is a different statistic from a VWAP over minutes, and nothing says so in the UI.
- **A drawing survives a chart-type switch but is not pinned to it.** The remap is exact
  in time and lossy in index — Renko compresses many bars into one brick — so a round trip
  lands within a brick rather than exactly where it started.
