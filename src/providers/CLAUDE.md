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
