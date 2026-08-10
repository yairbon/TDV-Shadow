# TDV-Shadow — Root Mandates

Compaction-survival tier. Only non-negotiable, project-wide laws live here.
Everything else belongs in path-scoped `CLAUDE.md` files or `docs/`.

## Rendering
1. All chart visuals are drawn with the Canvas 2D / WebGL API. **No DOM node ever
   represents a candle, wick, axis tick, gridline, or crosshair.** DOM is allowed only
   for the `<canvas>` elements themselves and for chrome outside the plot (toolbar, legend
   text, dialogs).
2. Every frame clears its layer before drawing. No incremental smear.
3. All drawing happens inside one `requestAnimationFrame` callback per frame. Never draw
   from an event handler, a `setTimeout`, or a WebSocket message handler.

## Data
4. Bar data is immutable. Mutating an existing OHLCV object is forbidden — produce a new
   frozen object and swap the reference. The only in-place-looking operation permitted is
   replacing the last bar of a series with a new object (live tick update).
5. Time is UTC epoch milliseconds, integer, always the **bar open** time. No `Date` objects
   in the data layer, no local-time arithmetic.

## Types
6. TypeScript `strict` is on. No `any`, no non-null `!` in `src/renderer/**` or `src/data/**`.
   Numeric domain types (`Price`, `Pixel`, `BarIndex`, `TimeMs`) are branded — do not
   cross-assign them without an explicit conversion function.

## Canonical references
- Coordinate math: `docs/RENDER_ALGORITHMS.md` (authoritative; do not re-derive from memory)
- Architecture / schema: `docs/ARCHITECTURE.md`
- Rendering rules: `skills/chart-render/SKILL.md`
