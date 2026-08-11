import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const asset = readdirSync('dist/assets').find(f => f.endsWith('.js'));
const js = readFileSync(`dist/assets/${asset}`, 'utf8');

// dist/index.html is a full document; the Artifact host supplies <html>/<head>/<body>,
// so extract the style block and the body markup and re-emit them as page content.
const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, '') ?? '';

if (!style.trim() || !body.trim()) throw new Error('failed to extract style or body from dist/index.html');
if (/https?:\/\//.test(js.slice(0, 4000))) console.warn('note: check bundle for external URLs');

const out = `<title>TDV-Shadow — Canvas/WebGL candlestick chart</title>
<style>
html, body { height: 100%; margin: 0; }
${style}
#app { height: 100vh; }
</style>
${body}
<script type="module">
${js}
</script>
`;

writeFileSync('dist/tdv-shadow-app.html', out);
console.log('wrote dist/tdv-shadow-app.html', (out.length / 1024).toFixed(1) + 'KB');
console.log('external refs in page:', (out.match(/(src|href)="https?:\/\/[^"]+"/g) ?? []).length);
