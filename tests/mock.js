// GAS（script.google.com）への通信を差し替える。
// fixtures/booths.json は本番の応答を 2026-09-29 に取ったもの（R8 の46件）。
// 混雑の表示を確かめられるよう、ここで状態・待ち人数をばらけさせる。
const fs = require('fs');
const path = require('path');

const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'booths.json'), 'utf8'));
const STATUSES = ['空いています', 'やや混雑', '混雑しています', '準備中', ''];

function snapshot({ notice = null } = {}) {
  const now = new Date().toISOString();
  const j = JSON.parse(JSON.stringify(BASE));
  j.updatedAt = now;
  j.notice = notice;
  j.booths.forEach((b, i) => {
    if (b.category === '受付') return;
    b.status = STATUSES[i % STATUSES.length];
    b.wait = b.status ? (i * 3) % 25 : null;
    b.time = b.status ? now : null;
    b.stale = false;
  });
  return j;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{mode?: 'ok'|'fail'|'slow', delayMs?: number, notice?: object}} opt
 * @returns {{posts: object[], gets: string[]}} 送られた内容（テストで確かめる用）
 */
async function mockGas(page, opt = {}) {
  const log = { posts: [], gets: [] };
  const mode = opt.mode || 'ok';
  await page.route(/script\.google(usercontent)?\.com\//, async route => {
    const req = route.request();
    if (mode === 'slow') await new Promise(r => setTimeout(r, opt.delayMs || 15000));
    if (mode === 'fail') return route.fulfill({ status: 404, contentType: 'text/html', body: '<html>404</html>' });
    const url = new URL(req.url());
    const headers = { 'access-control-allow-origin': '*' };
    if (req.method() === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      log.posts.push(body);
      const ok = { ok: true, sv: BASE.serverVersion };
      if (body.action === 'verify') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'パスワードが違います' }) });
      return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(ok) });
    }
    log.gets.push(url.search);
    if (url.searchParams.get('ledger')) {
      return route.fulfill({ status: 200, headers, contentType: 'application/json',
        body: JSON.stringify({ ok: true, sv: BASE.serverVersion, cid: url.searchParams.get('ledger'), stamps: [], spent: [] }) });
    }
    if (url.searchParams.get('report')) {
      return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ ok: true, booths: [], days: [] }) });
    }
    return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(snapshot(opt)) });
  });
  return log;
}

/** ページの例外とコンソールの赤いエラーを集める（通信の失敗は模擬なので除く） */
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|net::ERR_|status of 404/.test(t)) return;
    errors.push('console: ' + t);
  });
  return errors;
}

module.exports = { mockGas, watchErrors, snapshot, BASE };
