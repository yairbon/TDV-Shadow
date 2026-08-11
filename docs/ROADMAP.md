# What still separates TDV-Shadow from TradingView

Written after auditing the code rather than the screenshots. The conclusion changed the
plan: the gap is **not** feature count.

## Diagnosis

We have breadth — 14 chart types, 11 indicators, 20 drawing tools, two renderers, 524
unit tests. What we do not have is an **interaction layer**. Five facts, each verifiable
by grep:

| Finding | Evidence | Consequence |
| --- | --- | --- |
| `hitTest.ts` is never called by the app | zero imports outside `src/drawings/` | A drawing cannot be selected, moved, or individually deleted. 41 passing tests cover code the user can never reach. |
| `drawings.select()` is never called | only `drawings.selected()` is read, in `bootstrap.ts:350` | The selected-state rendering branch is unreachable. Nothing can ever be highlighted. |
| No undo stack exists | no `undo`/`redo` anywhere in `src/` | Erase is irreversible. One misclick loses the analysis. |
| `addIndicator` is called with no params from the UI | `main.ts:451` | You can add an SMA but never change it from 20 to 50. Every indicator is stuck on defaults. |
| No context menu, no shortcuts beyond ⌘K | one `keydown` handler, in `main.ts` | Everything requires a trip to the toolbar. |

That is why it still reads as a demo. In TradingView the chart is an **object you
manipulate**; here it is a picture you configure. Adding a twelfth indicator would not
close that gap — being able to grab a trendline and move it would.

A second, structural gap: `pointer.ts` knows only pan, zoom and pinch. There is no
selection model, no drag state machine, no command dispatch. Every feature below needs
that foundation, so it comes first.

---

## Phase 7 — Direct manipulation *(the one that matters)*

**7.1 Selection, drag, delete.** Wire `hitTest` into the pointer layer. Click selects
(nearest first, anchor handles win over the body); drag an anchor to reshape; drag the
body to move the whole shape; `Delete`/`Backspace` removes the selection; `Esc` cancels
an in-progress placement. Magnet applies while dragging, not only while placing.
*Done when:* dragging an endpoint changes the anchor in DATA space and the pixels follow
at any zoom and on a log scale — the same round-trip property the drawing tests already
assert, now driven by the mouse.

**7.2 Undo/redo.** A command stack over the drawing and indicator stores.
`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`. Commands are the only mutation path, so anything a user
can do is reversible by construction.
*Done when:* erase-all followed by undo restores every drawing with byte-identical
anchors, and redo re-removes them.

**7.3 Context menus.** Right-click a drawing (settings, clone, lock, remove, send to
back), the plot (reset scales, settings, add indicator), or an axis (auto-scale, log,
invert).

**7.4 Keyboard map.** Tool shortcuts (`Alt+T` trendline, `Alt+H` horizontal, `Alt+F`
fib), `M` magnet, arrow keys to nudge a selection, `+`/`-` zoom, `Home` jump to latest.

Phase 7 is the difference between a chart you look at and a chart you work in.

## Phase 8 — Configuration surfaces

**8.1 Indicator settings dialog** — double-click a legend row: period, source, stdDev,
fast/slow/signal, plus per-plot colour and line style. Params already flow through
`IndicatorParams`; only the UI is missing.
**8.2 Drawing style editor** — colour, width, dash, label visibility, per drawing.
**8.3 Chart settings** — gridlines on/off, price precision, right margin, timezone,
session breaks, candle colours.

## Phase 9 — Analysis features

**9.1 Measure tool** — drag on the plot for Δprice, Δ%, bar count and elapsed time, the
way TradingView's shift-drag ruler works.
**9.2 Price alerts** — a draggable alert line, triggered when a bar crosses it, with a
toast and a persisted list.
**9.3 Replay mode** — scrub to any bar, then step or play forward at 1×/2×/5×. The store
is append-only, so replay is a view truncation rather than a data mutation.

## Phase 10 — Scale and fidelity

**10.1 Large history.** Today the app tops out at a few hundred bars. Target 100k bars
at 60fps: level-of-detail downsampling for the series layer, a benchmark test that fails
if a frame exceeds the 8ms budget in `skills/chart-render/SKILL.md`.
**10.2 Session breaks and timezone** on the time axis — weekends and closed sessions
should not consume width, and labels should honour a chosen timezone.
**10.3 Resampling chart types into the picker.** Renko, Kagi, P&F, Line Break and Range
are built and tested but excluded from the UI because they index their own bar space
while the axis labels from the source series. 10.2 supplies the mapping that fixes it.
**10.4 Multi-chart layouts** — 2×2 grid, each pane its own symbol and workspace, with
optional crosshair sync.

---

## Order and reasoning

1. **7.1 first.** Highest leverage in the project: it converts twenty drawing tools from
   place-once decorations into real instruments, and it activates `hitTest.ts`, which is
   already written and tested.
2. **7.2 immediately after**, because direct manipulation without undo is worse than no
   direct manipulation — a stray drag silently destroys work.
3. **8.1 next.** "Add SMA" that cannot become SMA 50 is the most obviously missing thing
   after selection.
4. **9.x** are recognisable TradingView features but none of them is load-bearing for
   feel; they are additive.
5. **10.1 before 10.4.** Four charts on screen multiplies whatever the per-frame cost
   already is, so the performance work has to land first.

## Deliberately not planned

- **Pine Script.** A compiler that does not actually parse Pine would emit confident,
  wrong diagnostics. If scripting is wanted, the honest version is a small documented
  expression DSL with a real parser, named as itself.
- **A live symbol universe.** Search over "every ticker" needs a backend this build does
  not have. The current search covers bundled symbols plus a live-fetch escape hatch.
- **Broker/order integration.** Out of scope for a charting library.
