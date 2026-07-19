// Load index.html in a real browser and confirm the .af glyphs actually paint:
// every category's first tile must have set pixels, and distinct icons must
// differ. Exercises the full path fonts.js -> afParse -> afRender -> canvas.
// Screenshots a proof sheet.
//
// index.html loads af.js as an ES module, so it is served over a throwaway local
// HTTP server here (module scripts do not load from file://).
//
//   npm run verify:render
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve, extname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript',
                '.mjs': 'text/javascript', '.af': 'application/octet-stream' };

const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const body = await readFile(resolve(here, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('.cell canvas');

const stats = await page.evaluate(() => {
  const groups = [...document.querySelectorAll('.group')];
  return groups.map(group => {
    const title = group.querySelector('h2').textContent.split(' · ')[0];
    const canvas = group.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let set = 0, hash = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) { set++; hash = (hash * 31 + i) >>> 0; }
    }
    return { title, set, hash };
  });
});

let ok = true;
const hashes = new Set();
for (const s of stats) {
  const nonEmpty = s.set > 0;
  const distinct = !hashes.has(s.hash);
  hashes.add(s.hash);
  if (!nonEmpty || !distinct) ok = false;
  console.log(`${nonEmpty && distinct ? 'PASS' : 'FAIL'}  ${s.title.padEnd(16)} ` +
              `${s.set} set px  hash=${s.hash}`);
}

await page.screenshot({ path: resolve(here, 'proof.png'), fullPage: false });
await browser.close();
server.close();
console.log(ok
  ? `\nALL PASS - ${stats.length} category previews render distinct, non-empty glyphs`
  : '\nFAILURES DETECTED');
process.exit(ok ? 0 : 1);
