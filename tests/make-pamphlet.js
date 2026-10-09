// 三つ折りパンフレットを PDF にする（v183）。
//   cd tests && npm run pamphlet            … 本番のサーバーから、いまのブースの一覧を取って作る → ../docs/pamphlet.pdf
//   cd tests && npm run pamphlet -- --mock  … 手元の写し（fixtures/booths.json）で作る（通信しない）
// 中身は ?mode=pamphlet の画面そのもの（A4 横・両面2ページ・余白なし）。ブースの名前や数が変わったら作り直す。
// 見本の画像（1ページ目・2ページ目）も tests/shots/ に出す（GitHub には上げない）
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');
const MOCK = process.argv.includes('--mock');
const OUT = path.join(ROOT, 'docs', 'pamphlet.pdf');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.pdf': 'application/pdf' };

(async () => {
  // このフォルダを配るだけの小さなサーバー
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, u === '/' ? 'index.html' : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await ctx.newPage();
    if (MOCK) { const { mockGas } = require('./mock'); await mockGas(page); }
    // 刷る紙には、公開しているアドレスの QR を入れる（手元のアドレスにしない）
    await page.addInitScript(() => { window.__PAM_PUBLIC = true; });
    await page.goto(`http://127.0.0.1:${port}/?mode=pamphlet`);
    await page.waitForFunction(() => typeof S !== 'undefined' && S.booths.length > 0, null, { timeout: 60000 });
    await page.evaluate(() => {
      const m = document.querySelector('meta[property="og:url"]');
      if (m && m.content) { window.publicBase = () => m.content.replace(/[^/]*$/, ''); }
      localStorage.removeItem('kuroko_pamphlet_v1');
      renderPamphlet();
    });
    await page.waitForTimeout(600);
    const info = await page.evaluate(() => ({ booths: S.booths.length, over: [...document.querySelectorAll('#pam .pam-panel.over')].map(p => p.dataset.panel),
      url: (typeof publicBase === 'function' ? publicBase() : ''), build: CONFIG.BUILD }));
    if (info.over.length) throw new Error('面から中身がはみ出しています：' + info.over.join(', '));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pages !== 2) throw new Error('ページ数が 2 ではありません：' + pages);
    fs.writeFileSync(OUT, pdf);
    // 見本の画像
    const shots = path.join(__dirname, 'shots');
    fs.mkdirSync(shots, { recursive: true });
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: 1123, height: 794 });
    await page.locator('.pam-s1 .pam-paper').screenshot({ path: path.join(shots, 'pamphlet-1.png'), scale: 'device' });
    await page.locator('.pam-s2 .pam-paper').screenshot({ path: path.join(shots, 'pamphlet-2.png'), scale: 'device' });
    console.log(`作りました：${OUT}（${Math.round(pdf.length / 1024)}KB・2ページ・ブース${info.booths}件・${MOCK ? '手元の写し' : '本番のデータ'}・BUILD ${info.build}・QR ${info.url}）`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch(e => { console.error('失敗：' + (e && e.message || e)); process.exit(1); });
