import { defineConfig } from 'vite';

/**
 * Dev-server config, and the reason this file exists at all: the Yahoo Finance proxy.
 *
 * Yahoo's chart endpoint serves every symbol at every timeframe this app draws, in real
 * time, with no key and no signup — and it sends no `Access-Control-Allow-Origin` header,
 * so a browser cannot call it directly. Every other free source is worse in a way that
 * matters: Alpha Vantage gates intraday behind a paid plan, Finnhub gates candles, Polygon
 * allows five calls a minute on end-of-day data, and Twelve Data's free key is real but
 * capped at 800 requests a day.
 *
 * Proxying moves the request to the dev server, where CORS does not apply, and the browser
 * calls this app's own origin. That is the whole mechanism.
 *
 * The consequence is a constraint the provider layer has to respect: this route exists
 * ONLY when something is proxying. It is not in a static build, and it is emphatically not
 * in the published artifact, which has no network at all. So the Yahoo provider declares
 * itself unready unless the app knows a proxy is in front of it — otherwise it would claim
 * every timeframe and fail on each press, which is the exact failure the capability layer
 * was built to prevent.
 */
export default defineConfig({
  server: {
    proxy: {
      '/yahoo': {
        target: 'https://query2.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yahoo/, ''),
        // Yahoo answers a bare programmatic client with a challenge page rather than JSON.
        headers: { 'User-Agent': 'Mozilla/5.0' },
      },
    },
  },
});
