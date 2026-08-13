/**
 * Who owns what, across a symbol change.
 *
 * TradingView splits chart state along a seam this app did not have: drawings belong to
 * the SYMBOL, indicators belong to the CHART. Change instrument and your drawings are put
 * away and come back on return; your SMA stays and recomputes on the new series.
 *
 * Before this, `switchSymbol` called `build()`, which disposes the chart — so both were
 * destroyed outright and neither came back. Alerts sitting beside them survived, because
 * `AlertStore` already keys by symbol; that asymmetry is what these tests pin down.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';
import { clickControl, fillControl, selectControl } from './controls.js';

interface Counts {
  readonly symbol: string;
  readonly indicators: number;
  readonly drawings: number;
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(400);
}

const counts = (page: Page): Promise<Counts> =>
  page.evaluate(() => {
    const api = (window as {
      __tdv?: {
        getState: () => { symbol: string; indicators: readonly unknown[] };
        listDrawings: () => readonly unknown[];
      };
    }).__tdv;
    const state = api?.getState();
    return {
      symbol: state?.symbol ?? '',
      indicators: state?.indicators.length ?? -1,
      drawings: api?.listDrawings().length ?? -1,
    };
  });

/** Places `n` trendlines through the control API. */
async function draw(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    const win = window as {
      __tdv?: { drawShape: (k: string, a: unknown[], m: string) => unknown };
      __chart?: { series: { get: () => { bars: readonly { c: number }[] } } };
    };
    const bars = win.__chart?.series.get().bars ?? [];
    for (let i = 0; i < count; i++) {
      const a = 10 + i * 4;
      win.__tdv?.drawShape(
        'trendline',
        [
          { barIndex: a, price: bars[a].c },
          { barIndex: a + 6, price: bars[a + 6].c },
        ],
        'off',
      );
    }
  }, n);
  await page.waitForTimeout(250);
}

async function pick(page: Page, symbol: string): Promise<void> {
  await page.selectOption('#symbol-pick', symbol);
  await page.waitForTimeout(600);
}

test.describe('state ownership across a symbol change', () => {
  test('drawings belong to the symbol and come back on return', async ({ page }) => {
    await open(page);
    await draw(page, 2);
    expect(await counts(page)).toMatchObject({ symbol: 'DEMO', drawings: 2 });

    await pick(page, 'AAPL');
    // Hidden, not shown on the wrong instrument…
    expect(await counts(page)).toMatchObject({ symbol: 'AAPL', drawings: 0 });

    await pick(page, 'DEMO');
    // …and not destroyed either, which is what used to happen.
    expect(await counts(page)).toMatchObject({ symbol: 'DEMO', drawings: 2 });
  });

  test('two symbols keep separate drawing sets', async ({ page }) => {
    await open(page);
    await draw(page, 2);
    await pick(page, 'AAPL');
    await draw(page, 3);
    expect(await counts(page)).toMatchObject({ symbol: 'AAPL', drawings: 3 });

    await pick(page, 'DEMO');
    expect(await counts(page)).toMatchObject({ symbol: 'DEMO', drawings: 2 });
    await pick(page, 'AAPL');
    expect(await counts(page)).toMatchObject({ symbol: 'AAPL', drawings: 3 });
  });

  test('indicators belong to the chart and follow it across a symbol change', async ({ page }) => {
    // The opposite rule to drawings, and the reason "just keep everything" is wrong.
    await open(page);
    await page.evaluate(() => {
      (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv?.addIndicator('sma');
    });
    await page.waitForTimeout(300);
    expect(await counts(page)).toMatchObject({ indicators: 1 });

    await pick(page, 'AAPL');
    expect(await counts(page)).toMatchObject({ symbol: 'AAPL', indicators: 1 });
    await pick(page, 'DEMO');
    expect(await counts(page)).toMatchObject({ symbol: 'DEMO', indicators: 1 });
  });

  test('an indicator that followed the symbol actually recomputed on the new bars', async ({
    page,
  }) => {
    // Carrying the handle across is not enough — a stale table would still report a
    // length and look fine. The values have to belong to the new instrument.
    await open(page);
    const before = await page.evaluate(() => {
      const api = (window as {
        __tdv?: {
          addIndicator: (i: string) => { handleId: string };
          readIndicator: (h: string) => readonly { values: Record<string, number> }[];
        };
      }).__tdv;
      const handle = api?.addIndicator('sma');
      const rows = handle === undefined ? [] : (api?.readIndicator(handle.handleId) ?? []);
      return rows[rows.length - 1]?.values['sma'] ?? Number.NaN;
    });
    await page.waitForTimeout(300);
    expect(Number.isFinite(before)).toBe(true);

    await pick(page, 'AAPL');
    const after = await page.evaluate(() => {
      const api = (window as {
        __tdv?: {
          getState: () => { indicators: readonly { handleId: string }[] };
          readIndicator: (h: string) => readonly { values: Record<string, number> }[];
        };
      }).__tdv;
      const handle = api?.getState().indicators[0];
      const rows = handle === undefined ? [] : (api?.readIndicator(handle.handleId) ?? []);
      return rows[rows.length - 1]?.values['sma'] ?? Number.NaN;
    });
    expect(Number.isFinite(after)).toBe(true);
    // DEMO trades near 100, AAPL near 300 — a stale table would still read like DEMO.
    expect(Math.abs(after - before)).toBeGreaterThan(10);
  });

  test('a theme rebuild keeps the drawings and indicators on screen', async ({ page }) => {
    // `build()` runs on a theme toggle too, so the same dispose destroyed everything
    // whenever the user changed theme — the reported bug wearing a different hat.
    await open(page);
    await draw(page, 2);
    await page.evaluate(() => {
      (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv?.addIndicator('sma');
    });
    await page.waitForTimeout(300);

    await clickControl(page, '#theme-toggle');
    await page.waitForTimeout(600);
    expect(await counts(page)).toMatchObject({ drawings: 2, indicators: 1 });
  });

  test('every symbol’s drawings survive a reload, not only the visible one', async ({ page }) => {
    await open(page);
    await draw(page, 2);
    await pick(page, 'AAPL');
    await draw(page, 3);

    // The autosave runs on an interval and on unload; give the interval a turn.
    await page.waitForTimeout(2400);
    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(800);

    expect(await counts(page)).toMatchObject({ symbol: 'AAPL', drawings: 3 });
    await pick(page, 'DEMO');
    // The set for the symbol that was NOT on screen at save time.
    expect(await counts(page)).toMatchObject({ symbol: 'DEMO', drawings: 2 });
  });

  test('alerts keep behaving per symbol, as they already did', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          alerts: { add: (s: string, p: number) => unknown };
          series: { get: () => { bars: readonly { c: number }[] } };
        };
      }).__chart;
      const bars = chart?.series.get().bars ?? [];
      chart?.alerts.add('DEMO', bars[bars.length - 1].c);
    });
    await page.waitForTimeout(300);

    const visible = (): Promise<number> =>
      page.evaluate(() => {
        const win = window as {
          __chart?: { alerts: { forSymbol: (s: string) => readonly unknown[] } };
          __tdv?: { getState: () => { symbol: string } };
        };
        const symbol = win.__tdv?.getState().symbol ?? '';
        return win.__chart?.alerts.forSymbol(symbol).length ?? -1;
      });

    expect(await visible()).toBe(1);
    await pick(page, 'AAPL');
    expect(await visible()).toBe(0);
    await pick(page, 'DEMO');
    expect(await visible()).toBe(1);
  });
});

test.describe('the status line reports what happened', () => {
  test('an unloadable ticker says why instead of going quiet', async ({ page }) => {
    // `status()` runs on a 1s interval and overwrote the message, so pressing Load on an
    // unlisted ticker looked like the button did nothing at all.
    await open(page);
    await fillControl(page, '#symbol-input', 'GOOG');
    await clickControl(page, '#symbol-load');
    await page.waitForTimeout(1500);

    const text = (await page.textContent('#status')) ?? '';
    expect(text).toContain('GOOG');
    // Whatever the reason is, it must not have been replaced by the idle counters.
    expect(text).not.toMatch(/^\d+ indicator/);
  });

  test('the counters come back once the message has had its turn', async ({ page }) => {
    // The hold must expire, or the first transient message pins the line forever.
    await open(page);
    await fillControl(page, '#symbol-input', 'GOOG');
    await clickControl(page, '#symbol-load');
    await page.waitForTimeout(1000);
    expect((await page.textContent('#status')) ?? '').toContain('GOOG');

    await page.waitForTimeout(7000);
    expect((await page.textContent('#status')) ?? '').toMatch(/^\d+ indicator/);
  });
});

test.describe('symbol search', () => {
  const openSearch = async (page: Page): Promise<void> => {
    await page.click('#symbol-button');
    await page.waitForSelector('#search-input', { state: 'visible' });
  };

  const results = (page: Page): Promise<string[]> =>
    page.$$eval('#search-results li', (nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset['symbol'] ?? ''),
    );

  const type = async (page: Page, query: string): Promise<void> => {
    await page.fill('#search-input', query);
    await page.waitForTimeout(200);
  };

  test('finds a ticker whose letters are not contiguous', async ({ page }) => {
    // The matcher this replaced was a substring filter, so "APL" found nothing at all.
    await open(page);
    await openSearch(page);
    await type(page, 'APL');
    expect((await results(page))[0]).toBe('AAPL');
  });

  test('orders by relevance, not by declaration order', async ({ page }) => {
    await open(page);
    await openSearch(page);
    await type(page, 'A');
    // AMD is a 1-of-3 ticker match; the others are 1-of-4. Declaration order would put
    // AAPL first, and so would plain alphabetical.
    expect((await results(page))[0]).toBe('AMD');
  });

  test('matches a company name, not just a ticker', async ({ page }) => {
    await open(page);
    await openSearch(page);
    await type(page, 'gold');
    expect((await results(page))[0]).toBe('GLD');
  });

  test('never writes the query into the page as markup', async ({ page }) => {
    // The unmatched query is offered as a "fetch from the network" row, so it reaches
    // the results list verbatim. It used to go through innerHTML unescaped.
    await open(page);
    await openSearch(page);
    await type(page, '<img src=x onerror=alert(1)>');
    expect(await page.locator('#search-results img').count()).toBe(0);
    // …and it is still offered, rather than being dropped to dodge the problem.
    expect(await page.locator('#search-results li').count()).toBeGreaterThan(0);
  });

  test('floats a symbol you have loaded to the top of an empty query', async ({ page }) => {
    await open(page);
    await pick(page, 'NVDA');
    await openSearch(page);
    expect((await results(page))[0]).toBe('NVDA');
  });

  test('highlights the characters that matched', async ({ page }) => {
    await open(page);
    await openSearch(page);
    await type(page, 'GGL');
    const marked = await page.$$eval('#search-results li:first-child mark', (nodes) =>
      nodes.map((n) => n.textContent).join(''),
    );
    expect(marked).toBe('GGL');
  });
});

test.describe('compare a second symbol', () => {
  const overlayInk = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '#chart canvas[data-layer="overlay"]',
      );
      const ctx = canvas?.getContext('2d') ?? null;
      if (canvas === null || ctx === null) return -1;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let offset = 3; offset < data.length; offset += 4) if (data[offset] > 40) count++;
      return count;
    });

  const compared = (page: Page): Promise<string | null> =>
    page.evaluate(() => {
      const chart = (window as { __chart?: { compareSymbol: () => string | null } }).__chart;
      return chart?.compareSymbol() ?? null;
    });

  test('draws a second instrument over the price plot', async ({ page }) => {
    await open(page);
    await pick(page, 'AAPL');
    const before = await overlayInk(page);

    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(700);

    expect(await compared(page)).toBe('SPY');
    expect(await overlayInk(page)).toBeGreaterThan(before + 500);
  });

  test('clears when set back to none', async ({ page }) => {
    await open(page);
    await pick(page, 'AAPL');
    const bare = await overlayInk(page);

    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(700);
    // Prove the measurement can move at all, or "back to bare" is satisfied by a
    // comparison that never drew anything.
    expect(await overlayInk(page)).toBeGreaterThan(bare + 500);

    await selectControl(page, '#compare-pick', '');
    await page.waitForTimeout(700);
    expect(await compared(page)).toBeNull();
    expect(await overlayInk(page)).toBe(bare);
  });

  test('follows the chart across a symbol change, like an indicator', async ({ page }) => {
    // The comparison describes the view you set up, not the instrument — so it belongs to
    // the chart, the same way indicators do, and must survive the rebuild.
    await open(page);
    // What NVDA's overlay looks like with no comparison, for comparison.
    await pick(page, 'NVDA');
    const bareNvda = await overlayInk(page);

    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(700);

    await pick(page, 'NVDA');
    expect(await compared(page)).toBe('SPY');
    // …and it actually re-drew against NVDA's bars rather than merely being remembered.
    expect(await overlayInk(page)).toBeGreaterThan(bareNvda + 500);
  });

  test('comparing a symbol with itself draws nothing', async ({ page }) => {
    // A self-comparison is flat by construction and only clutters the plot.
    await open(page);
    await pick(page, 'AAPL');
    const bare = await overlayInk(page);
    await selectControl(page, '#compare-pick', 'AAPL');
    await page.waitForTimeout(700);
    expect(await compared(page)).toBeNull();
    expect(await overlayInk(page)).toBe(bare);

    // A different symbol does draw, so the assertion above is about the self-comparison
    // rather than about comparisons never drawing.
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(700);
    expect(await overlayInk(page)).toBeGreaterThan(bare + 500);
  });

  test('survives a chart-type switch without erroring', async ({ page }) => {
    await open(page);
    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(500);
    const beforeSwitch = await overlayInk(page);
    expect(beforeSwitch).toBeGreaterThan(0);
    await page.selectOption('#chart-type', 'renko');
    await page.waitForTimeout(700);
    // Renko has its own index space, so the comparison is realigned onto it; what must
    // not happen is the overlay going blank or the frame throwing.
    expect(await overlayInk(page)).toBeGreaterThan(0);
  });
});

test.describe('a second price scale', () => {
  const geometry = (page: Page): Promise<{ left: number; plotLeft: number }> =>
    page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          layout: () => {
            plot: { left: number };
            leftPriceGutter: { width: number } | null;
          };
        };
      }).__chart;
      const l = chart?.layout();
      return {
        left: l?.leftPriceGutter === null || l === undefined ? 0 : l.leftPriceGutter.width,
        plotLeft: l?.plot.left ?? -1,
      };
    });

  /**
   * Pixels in the left gutter that are not the background.
   *
   * Counting alpha does not work on the grid layer: it paints an opaque background across
   * the whole viewport, so every pixel scores 255 and the measurement passes with the axis
   * deleted. The background is whatever colour dominates the region, and ink is everything
   * that differs from it.
   */
  const gutterInk = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const chart = (window as {
        __chart?: { layout: () => { leftPriceGutter: { width: number; height: number } | null } };
      }).__chart;
      const gutter = chart?.layout().leftPriceGutter ?? null;
      const canvas = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="grid"]');
      const ctx = canvas?.getContext('2d') ?? null;
      if (gutter === null || canvas === null || ctx === null) return -1;
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const data = ctx.getImageData(
        0,
        0,
        Math.round(gutter.width * dpr),
        Math.round(gutter.height * dpr),
      ).data;

      const tally = new Map<number, number>();
      for (let o = 0; o < data.length; o += 4) {
        const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      let background = 0;
      let best = -1;
      for (const [key, n] of tally) if (n > best) [background, best] = [key, n];

      const br = (background >> 16) & 0xff;
      const bg = (background >> 8) & 0xff;
      const bb = background & 0xff;
      let ink = 0;
      for (let o = 0; o < data.length; o += 4) {
        const distance =
          Math.abs(data[o] - br) + Math.abs(data[o + 1] - bg) + Math.abs(data[o + 2] - bb);
        if (distance > 40) ink++;
      }
      return ink;
    });

  test('offers no scale toggle until there is something to scale', async ({ page }) => {
    // A control for a series that is not on the chart does nothing, and it was costing a
    // permanent slot in a bar that overflows even a 1920px window — so the overflow panel
    // hid a working control to make room for a dead one.
    // Its own `hidden`, not `isHidden()`: at this viewport the toolbar overflows and the
    // toggle may legitimately be parked in the (closed) overflow panel, which would make
    // every reading come back hidden and the test pass without proving anything.
    const suppressed = (): Promise<boolean> =>
      page.evaluate(() => document.querySelector<HTMLElement>('#compare-scale')?.hidden ?? true);

    await open(page);
    await pick(page, 'AAPL');
    expect(await suppressed()).toBe(true);

    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(600);
    expect(await suppressed()).toBe(false);

    await selectControl(page, '#compare-pick', '');
    await page.waitForTimeout(600);
    expect(await suppressed()).toBe(true);
  });

  test('no left axis exists until a comparison asks for one', async ({ page }) => {
    await open(page);
    await pick(page, 'AAPL');
    expect(await geometry(page)).toMatchObject({ left: 0, plotLeft: 0 });

    // A comparison in percent mode still needs no second axis — that is the point of
    // projecting it through the primary's scale.
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(700);
    expect((await geometry(page)).left).toBe(0);
  });

  test('switching the comparison to its own scale opens a left gutter', async ({ page }) => {
    await open(page);
    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(700);

    await clickControl(page, '#compare-scale');
    await page.waitForTimeout(700);
    const after = await geometry(page);
    expect(after.left).toBeGreaterThan(0);
    // The plot moved right to make room rather than overlapping the axis.
    expect(after.plotLeft).toBe(after.left);
  });

  test('the left axis is labelled in the compared instrument’s own prices', async ({ page }) => {
    // The whole point of a second scale: labelling it with the primary's prices would be
    // the exact confusion it exists to remove.
    await open(page);
    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(600);
    await clickControl(page, '#compare-scale');
    await page.waitForTimeout(800);

    // Labels are actually painted in there, not just space reserved.
    expect(await gutterInk(page)).toBeGreaterThan(200);
  });

  test('scales the compared line to its own axis, not the primary’s domain', async ({ page }) => {
    // SPY trades near 750 and AAPL near 250, so a left axis autoscaled from the wrong
    // series puts the line entirely off the plot. §4's 10% padding then fixes what is left:
    // the line fills 1/1.2 of the plot, so a missing pad (span 1.0) is caught as well as a
    // domain taken from bars that are not on screen (span far below).
    await open(page);
    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(600);
    await clickControl(page, '#compare-scale');
    await page.waitForTimeout(800);

    const spanOfPlot = (): Promise<number> =>
      page.evaluate(() => {
        const chart = (window as { __chart?: { layout: () => { plot: { height: number } } } })
          .__chart;
        const plotHeight = chart?.layout().plot.height ?? 0;
        const canvas = document.querySelector<HTMLCanvasElement>(
          '#chart canvas[data-layer="overlay"]',
        );
        const ctx = canvas?.getContext('2d') ?? null;
        if (canvas === null || ctx === null || plotHeight === 0) return -1;
        const dpr = canvas.width / canvas.getBoundingClientRect().width;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let top = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        for (let o = 3; o < data.length; o += 4) {
          if (data[o] <= 40) continue;
          const y = Math.floor(o / 4 / canvas.width);
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
        if (!Number.isFinite(top)) return 0;
        return (bottom - top) / dpr / plotHeight;
      });

    expect(await spanOfPlot()).toBeGreaterThan(0.72);
    expect(await spanOfPlot()).toBeLessThan(0.95);

  });

  test('re-autoscales the left axis to whatever window is on screen', async ({ page }) => {
    // A domain computed from the whole history — or from bar 0 to the right edge — looks
    // right at full zoom and stays frozen as you pan, so the compared line drifts off its
    // own axis. The domain has to move when the window does.
    await open(page);
    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(600);
    await clickControl(page, '#compare-scale');
    await page.waitForTimeout(800);

    const domain = (): Promise<{ min: number; max: number } | null> =>
      page.evaluate(() => {
        const chart = (window as {
          __chart?: { leftPriceRange: () => { min: number; max: number } | null };
        }).__chart;
        return chart?.leftPriceRange() ?? null;
      });

    const zoom = async (spacing: number, scroll: number): Promise<void> => {
      await page.evaluate(
        ([s, k]) => {
          const view = (window as {
            __chart?: {
              view: { setBarSpacing: (s: number) => void; setScrollPosition: (k: number) => void };
            };
          }).__chart?.view;
          view?.setBarSpacing(s);
          view?.setScrollPosition(k);
        },
        [spacing, scroll],
      );
      await page.waitForTimeout(600);
    };

    // Two narrow, non-overlapping windows. They have to be late in the series: the
    // comparison is NaN before the compared instrument's first bar, and an axis with
    // nothing to scale is correctly absent rather than wrong.
    await zoom(110, 99);
    const late = await domain();
    await zoom(110, 75);
    const early = await domain();

    expect(late).not.toBeNull();
    expect(early).not.toBeNull();
    if (late === null || early === null) return;
    // Two disjoint windows of a trending series do not share a price range. A domain that
    // always ran to the last bar would report the same top for both.
    expect(Math.abs(late.max - early.max)).toBeGreaterThan(5);
    // And the earlier window spans only what it shows. SPY's full demo history is ~57
    // wide and the ten bars on screen here are ~27, so a domain that still reaches back
    // to bar 0 cannot fit under this bound.
    expect(early.max - early.min).toBeLessThan(35);
  });

  test('turning it back off reclaims the width', async ({ page }) => {
    await open(page);
    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(600);
    await clickControl(page, '#compare-scale');
    await page.waitForTimeout(700);
    expect((await geometry(page)).left).toBeGreaterThan(0);

    await clickControl(page, '#compare-scale');
    await page.waitForTimeout(700);
    expect(await geometry(page)).toMatchObject({ left: 0, plotLeft: 0 });
  });

  test('survives a price-axis drag with the axis still drawn', async ({ page }) => {
    // The frame is rebuilt when the price axis is dragged. A rebuild that forgets the
    // left range leaves the layout holding 64px open for an axis nobody paints.
    await open(page);
    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(600);
    await clickControl(page, '#compare-scale');
    await page.waitForTimeout(700);

    const before = await gutterInk(page);
    expect(before).toBeGreaterThan(200);

    const box = await page.locator('#chart').boundingBox();
    if (box === null) throw new Error('no chart');
    // Drag the RIGHT price axis, which is what puts priceZoom off 1.
    const axisX = box.x + box.width - 24;
    await page.mouse.move(axisX, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(axisX, box.y + box.height / 2 + 90, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    expect(await gutterInk(page)).toBeGreaterThan(before / 2);
  });

  test('clearing the comparison closes the left axis too', async ({ page }) => {
    // An axis with nothing assigned to it is dead width taken from the plot.
    await open(page);
    await pick(page, 'AAPL');
    await selectControl(page, '#compare-pick', 'SPY');
    await page.waitForTimeout(600);
    await clickControl(page, '#compare-scale');
    await page.waitForTimeout(700);

    await selectControl(page, '#compare-pick', '');
    await page.waitForTimeout(700);
    expect((await geometry(page)).left).toBe(0);
  });
});
