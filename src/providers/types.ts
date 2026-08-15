/**
 * What a market-data provider is, from the app's side.
 *
 * Three implementations sit behind this: Twelve Data over REST, Alpha Vantage over REST,
 * and Alpha Vantage through the artifact's MCP capability. They differ in what they can
 * actually serve — which is the point of `capabilities()`. Alpha Vantage gates every
 * intraday endpoint behind a premium key, so on a free key its native timeframes are the
 * daily ones and nothing else; a UI built from a hardcoded list would offer four buttons
 * that cannot work.
 *
 * Failure is a value, never an exception. A provider that throws takes down whatever
 * called it, and the useful information — *why* — arrives as a stack trace instead of a
 * sentence in the status line. `FailureKind` exists because the caller's correct response
 * differs: a rate limit is worth retrying later, an entitlement wall never is.
 */

import type { Bar, Timeframe, TimeMs } from '../data/types.js';

export type ProviderId =
  | 'yahoo'
  | 'twelve-data'
  | 'alpha-vantage'
  | 'alpha-vantage-mcp'
  | 'bundled';

/**
 * Why a request failed, in the terms the caller has to act on.
 *
 * - `no-key` — nothing was attempted; the provider has no credential.
 * - `entitlement` — the credential is real but does not cover this endpoint. Permanent
 *   until the user changes plan, so the caller should stop offering the thing.
 * - `rate-limit` — temporary. Back off; do not disable the feature.
 * - `not-found` — the symbol does not exist at this provider.
 * - `format` — a 200 whose body was not what the contract says. Usually a provider
 *   changing its shape, and worth surfacing loudly rather than treating as empty data.
 * - `network` — offline, CORS, CSP, DNS. The published artifact hits this for every
 *   direct HTTP call, by design.
 */
export type FailureKind =
  | 'no-key'
  | 'entitlement'
  | 'rate-limit'
  | 'not-found'
  | 'format'
  | 'network';

export interface ProviderFailure {
  readonly ok: false;
  readonly kind: FailureKind;
  /** One sentence, fit to print in the status line. */
  readonly reason: string;
}

export interface ProviderSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailure;

export const ok = <T>(value: T): ProviderSuccess<T> => ({ ok: true, value });
export const fail = (kind: FailureKind, reason: string): ProviderFailure => ({
  ok: false,
  kind,
  reason,
});

/**
 * A page of bars, with the rows that did not survive parsing counted.
 *
 * The count is carried rather than discarded because `src/data/CLAUDE.md` requires a
 * boundary rejection to be "a counted, non-throwing drop" — a provider quietly losing a
 * tenth of its rows to a format change looks exactly like a thin market. Same shape as
 * `rest/history.ts`'s `HistoryPage`, for the same reason.
 */
export interface SeriesPage {
  /** Ascending, de-duplicated, frozen. */
  readonly bars: readonly Bar[];
  readonly dropped: number;
}

/** One search hit. Exchange and currency are shown: TSLA and TL0.DEX are not the same. */
export interface SymbolHit {
  readonly symbol: string;
  readonly name: string;
  readonly exchange: string;
  readonly currency: string;
  readonly country: string;
}

/** The latest price, and whether the venue is open — which decides whether to keep polling. */
export interface Quote {
  readonly symbol: string;
  readonly price: number;
  readonly time: TimeMs;
  /** Null when the provider does not say, which is not the same as "closed". */
  readonly marketOpen: boolean | null;
  /**
   * The previous session's close, when the provider sends one.
   *
   * Every quote endpoint here carries it and this app used to throw it away, so a
   * percentage change had to be derived from whatever bars happened to be on the chart —
   * which meant no change at all for any instrument that was not the one being charted.
   * It is the baseline a quote is quoted AGAINST, so it belongs with the quote.
   */
  readonly previousClose: number | null;
}

export interface ProviderCapabilities {
  readonly id: ProviderId;
  readonly label: string;
  /**
   * Timeframes this provider fetches DIRECTLY with the credential it currently holds.
   *
   * Not "timeframes the vendor sells" — the free Alpha Vantage key reports the daily
   * family only, and the app builds its timeframe buttons from this. A coarser timeframe
   * may still be derivable by resampling a finer native one; that is the caller's
   * inference to make, not something to bake in here.
   */
  readonly nativeTimeframes: readonly Timeframe[];
  readonly canSearch: boolean;
  readonly canQuote: boolean;
  /** False when the provider has no usable credential and will refuse everything. */
  readonly ready: boolean;
}

export interface MarketDataProvider {
  capabilities(): ProviderCapabilities;
  /** `limit` is a request, not a guarantee — providers cap it their own way. */
  fetchSeries(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<ProviderResult<SeriesPage>>;
  searchSymbols(query: string): Promise<ProviderResult<readonly SymbolHit[]>>;
  fetchQuote(symbol: string): Promise<ProviderResult<Quote>>;
}

/**
 * The `fetch` slice a provider uses, injected.
 *
 * Injected for the same reason `HistoryTransport` is: it keeps the adapters testable
 * against scripted responses, with no network and no globals — and it is the seam the MCP
 * provider needs, since inside the artifact there is no `fetch` to the outside world at
 * all.
 */
export type HttpGet = (url: string) => Promise<{ readonly status: number; readonly body: string }>;

/** The default transport: the platform `fetch`, with network failure turned into a value. */
export const browserGet: HttpGet = async (url) => {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
};
