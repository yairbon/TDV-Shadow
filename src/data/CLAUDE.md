# src/data — scope rules

- Every bar object is `Object.freeze`d on construction. Series are append-only arrays;
  the live bar is replaced by reference, never mutated in place.
- `t` is integer UTC epoch **milliseconds** of the bar *open*. No `Date`, no timezone math
  below `src/ui/`.
- Sequence gaps from the WebSocket are recovered by REST backfill, not by interpolation.
  A gap that cannot be filled marks the series `stale` — the renderer draws it dimmed
  rather than lying.
- All prices/volumes are parsed once at the boundary into `number`. No strings past the
  codec layer. Reject NaN/Infinity at the boundary with a counted, non-throwing drop.
- Reconnect uses exponential backoff with jitter and resubscribes idempotently.
- Schema of record: `docs/ARCHITECTURE.md` §3 (wire, store, and PostgreSQL/Timescale DDL).
