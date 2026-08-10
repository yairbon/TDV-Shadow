# src/renderer — scope rules

Read `skills/chart-render/SKILL.md` before editing anything here. Transforms come from
`docs/RENDER_ALGORITHMS.md`; import them from `./scale/`, never re-derive inline.

- This directory is **pure**: it takes a frozen snapshot + scales + layout and paints.
  No fetching, no WebSocket, no store writes, no `setState`.
- Nothing here imports from `src/data/**` except types.
- Units are CSS pixels everywhere after the DPR transform is applied in `surface.ts`.
- Branded types: `Price`, `Pixel`, `BarIndex`, `TimeMs`. Conversions only via `scale/`.
- A PreToolUse hook blocks DOM-mutation APIs in this directory. That is intentional; if a
  change seems to need one, the design is wrong — put it in `src/ui/`.
