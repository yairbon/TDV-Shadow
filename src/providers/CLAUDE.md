# src/providers — scope rules

The **ingest boundary**. Everything below it is pure; this is where the outside world is
allowed in.

- This directory MAY do I/O (`fetch`), and MAY use `Date` and `Intl`. `src/data/**` may do
  neither — its rule is "no `Date`, no timezone math below `src/ui/`", and the way to
  honour that is to convert here, once, on the way in.
- Everything a provider emits is already mandate-#5 compliant: `t` is integer UTC epoch
  milliseconds of the bar **open**. A provider that returns exchange-local wall-clock time
  converts it with `zonedTime.ts` before constructing a `Bar`.
- Every bar is built through `makeBar`, so it is frozen and validated. A row that fails
  validation is a counted drop, never a throw and never a silent zero.
- Failure is a value. No provider throws: a network error, a rate limit, an entitlement
  wall and a malformed body all come back as a typed result with a reason a human can
  read. The reason reaches the status line — it is never swallowed.
- A provider declares what it can actually serve (`capabilities()`), and the UI is built
  from that declaration rather than from a hardcoded list. An endpoint that is premium on
  the caller's key is *not available*, and saying so is the provider's job.
- The chain is a chain. A request tries every provider that could serve it, in order, and
  only fails when all of them have. `series` named one provider and gave up on its failure,
  so a momentarily unreachable connector did not fall through to the CSVs sitting behind it
  in the same chain — the chart refused to load a symbol it already had the data for.
- When every provider refuses, the reported reason is the FIRST one's. The list is ordered
  best-resolution-first, so the head is the provider that should have answered; the tail is
  usually the bundled CSV pointing out that a ticker it never shipped with is not in the
  build, which is true and useless.
- A provider that reports `ready: false` is not called. It has already said it will refuse
  everything, so calling it spends budget for nothing and — worse — its refusal becomes the
  reason the chain reports when a request fails, drowning out the provider that actually
  had something to say.
- Credentials come from the URL and are never persisted. A credential in `localStorage`
  outlives the intent to use it.
- A quote is a price and a timestamp, and nothing more may be inferred from it. It may move
  a bar's close and widen its extremes; it may not set an open, a volume, or bring a new
  bar into existence.
