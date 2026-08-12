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

## Deliberately still open

- **Pine Script.** A compiler that does not actually parse Pine would emit confident,
  wrong diagnostics. If scripting is wanted, the honest version is a small documented
  expression DSL with a real parser, named as itself.
- **A live symbol universe.** Search over "every ticker" needs a backend this build does
  not have. Search covers bundled symbols plus a live-fetch escape hatch.
- **Broker/order integration.** Out of scope for a charting library.
- **Per-pane indicators on a resampling type.** Indicators compute over whatever series is
  being rendered, which for Renko is the brick series. That is the right answer for most
  indicators and the wrong one for volume-weighted ones; nothing currently distinguishes
  them.
- **Drawings across a chart-type switch.** A drawing anchored to bar 400 of the source
  series points at brick 400 after switching to Renko. Making annotations survive that
  needs anchors in TIME rather than in index, which is a change to the frozen drawing
  contract.
