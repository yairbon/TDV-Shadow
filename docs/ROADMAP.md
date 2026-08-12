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

## Tier 2 — in progress

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

Still open in Tier 2: multiple price scales (left/right assignment per series), and named
layouts.

## Deliberately still open
- **Pine Script.** A compiler that does not actually parse Pine would emit confident,
  wrong diagnostics. If scripting is wanted, the honest version is a small documented
  expression DSL with a real parser, named as itself.
- **A live symbol universe.** Search over "every ticker" needs a backend this build does
  not have. Search covers bundled symbols plus a live-fetch escape hatch.
- **Broker/order integration.** Out of scope for a charting library.
- **Volume-weighted indicators on a resampling type** are computed over the brick series.
  With brick volume now summed from the source that is well defined, but a VWAP over
  Renko is a different statistic from a VWAP over minutes, and nothing says so in the UI.
- **A drawing survives a chart-type switch but is not pinned to it.** The remap is exact
  in time and lossy in index — Renko compresses many bars into one brick — so a round trip
  lands within a brick rather than exactly where it started.
