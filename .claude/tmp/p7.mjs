import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', e => errs.push(String(e.message)));
await p.goto('http://127.0.0.1:4173/?sym=AAPL');
await p.waitForFunction(() => window.__tdv !== undefined, null, { timeout: 20000 });
await p.waitForTimeout(500);
await p.evaluate(() => localStorage.clear());

// place a trendline via the control API, then drag its second anchor with the mouse
const d = await p.evaluate(() => window.__tdv.drawShape('trendline',
  [{barIndex:20,price:260},{barIndex:70,price:300}], 'off'));
await p.waitForTimeout(300);
const before = JSON.parse(JSON.stringify(d.anchors));
const px = await p.evaluate(() => window.__tdv.listDrawings()[0].anchorPixels);
// Anchor pixels are relative to #chart; the mouse needs viewport coordinates, and #chart
// is offset by the top bar and the left rail.
const box = await p.evaluate(() => { const r = document.querySelector('#chart').getBoundingClientRect(); return { x: r.left, y: r.top }; });
const V = (pt) => ({ x: pt.x + box.x, y: pt.y + box.y });
console.log('container offset:', JSON.stringify(box));
console.log('placed anchors:', JSON.stringify(before));

// 7.1 drag the endpoint
const grab = V(px[1]);
await p.mouse.move(grab.x, grab.y);
await p.mouse.down();
await p.mouse.move(grab.x - 160, grab.y + 90, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(300);
const dragged = await p.evaluate(() => window.__tdv.listDrawings()[0]);
console.log('after drag  :', JSON.stringify(dragged.anchors.map(a => ({b:+a.barIndex.toFixed(2), p:+a.price.toFixed(2)}))));
console.log('anchor0 unchanged:', Math.abs(dragged.anchors[0].barIndex - before[0].barIndex) < 1e-9);
console.log('anchor1 moved    :', Math.abs(dragged.anchors[1].barIndex - before[1].barIndex) > 1);
console.log('selected         :', await p.evaluate(() => window.__chart.drawings.selected()));

// round-trip: projected pixels must match where we dropped it
const after = await p.evaluate(() => window.__tdv.listDrawings()[0].anchorPixels);
console.log('drop px vs projected px: dx=' + Math.abs(after[1].x - (px[1].x - 160)).toFixed(1) + ' dy=' + Math.abs(after[1].y - (px[1].y + 90)).toFixed(1));

// 7.2 undo restores exactly
await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
const undone = await p.evaluate(() => window.__tdv.listDrawings()[0]);
console.log('undo restored exactly:', JSON.stringify(undone.anchors) === JSON.stringify(before));
await p.keyboard.press('Control+Shift+z'); await p.waitForTimeout(300);
const redone = await p.evaluate(() => window.__tdv.listDrawings()[0]);
console.log('redo re-applied      :', Math.abs(redone.anchors[1].barIndex - dragged.anchors[1].barIndex) < 1e-9);

// delete + undo
await p.keyboard.press('Delete'); await p.waitForTimeout(250);
console.log('after Delete count:', await p.evaluate(() => window.__tdv.listDrawings().length));
await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
console.log('after undo  count:', await p.evaluate(() => window.__tdv.listDrawings().length));

// keyboard tool select
await p.keyboard.press('Alt+t'); await p.waitForTimeout(150);
console.log('Alt+T armed trendline:', (await p.textContent('#status')).includes('trendline'));
await p.keyboard.press('Escape'); await p.waitForTimeout(150);
console.log('Esc cleared          :', !(await p.textContent('#status')).includes('trendline'));

console.log('integrity:', JSON.stringify(await p.evaluate(() => window.__tdv.getIntegrityReport())));
console.log('errors:', errs.length ? errs.slice(0,3) : 'none');
await b.close();
