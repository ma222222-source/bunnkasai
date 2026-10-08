// 通信がでたらめなとき（v181）。
// サーバーへの通信1回ごとに、成功・404 のページ・500・「混み合っています」・HTML のエラーページ・こわれた JSON・途中で切れた JSON・
// 中身のない返事（null・数字・空）・通信断・遅い返事 を乱数で返し、時計を早送りして長い時間ぶんの自動更新を回す。確かめること：
//   ・エラーで止まらない　・いつかはブースが出る　・一度出たブースが通信の失敗で消えない
//   ・通信が戻ったら立ち直る　・押したスタンプは端末に残り、控えがサーバーに届く（届いていないのに「保存済み」にしない）
// v181 より前は、中身のない返事（null）でブースが0件になり、スタンプの控えは届いていないのに保存済みになっていた
const { test, expect } = require('@playwright/test');
const { snapshot, BASE } = require('./mock');
const SEEDS = (process.env.SEEDS || '1,3,4,8').split(',').map(Number);
for (const seed of SEEDS) {
  test('通信がでたらめでも、ブースが消えず・立ち直り・スタンプの控えが届く（種 ' + seed + '）', async ({ page }) => {
    test.setTimeout(180000);
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message + ' @ ' + ((e.stack || '').split('\n')[1] || '').trim()));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|status of [45]|Access to fetch|CORS/.test(m.text())) errs.push('console: ' + m.text()); });
    let s = seed * 32452843; const rnd = n => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
    let chaos = true; const posts = []; const kinds = {};
    const headers = { 'access-control-allow-origin': '*' };
    await page.route(/script\.google(usercontent)?\.com\//, async route => {
      const req = route.request();
      const good = () => {
        if (req.method() === 'POST') { let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (e) {} posts.push(b);
          return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(b.action === 'verify' ? { ok: true, sv: BASE.serverVersion } : { ok: true }) }); }
        return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(snapshot({})) });
      };
      if (!chaos) return good();
      const k = ['ok', 'ok', 'ok', '404html', '500', '200html', 'badjson', 'trunc', 'okfalse', 'abort', 'slow', 'empty', 'null', 'num', '429'][rnd(15)];
      kinds[k] = (kinds[k] || 0) + 1; if (process.env.TRACE) console.log('   req', req.method(), k);
      try {
        if (k === 'ok') return good();
        if (k === '404html') return route.fulfill({ status: 404, headers, contentType: 'text/html', body: '<html><body>404</body></html>' });
        if (k === '500') return route.fulfill({ status: 500, headers, contentType: 'text/plain', body: 'Internal error' });
        if (k === '429') return route.fulfill({ status: 429, headers, contentType: 'text/html', body: '<html>Service invoked too many times</html>' });
        if (k === '200html') return route.fulfill({ status: 200, headers, contentType: 'text/html', body: '<!DOCTYPE html><html><body>スクリプトが完了しましたが、何も返されませんでした。</body></html>' });
        if (k === 'badjson') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: '{ok:true,' });
        if (k === 'trunc') { const t = JSON.stringify(snapshot({})); return route.fulfill({ status: 200, headers, contentType: 'application/json', body: t.slice(0, Math.floor(t.length * 0.6)) }); }
        if (k === 'okfalse') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'サーバーが混み合っています' }) });
        if (k === 'abort') return route.abort('internetdisconnected');
        if (k === 'slow') { await new Promise(r => setTimeout(r, 120)); return good(); }
        if (k === 'empty') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: '' });
        if (k === 'null') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: 'null' });
        if (k === 'num') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: req.method() === 'POST' ? '{}' : '7' });
      } catch (e) {}
    });
    await page.addInitScript(() => { try{ localStorage.setItem('kuroko_intro_v1', '1'); }catch(e){} });
    await page.clock.install();
    const tick = async sec => { for (let t = 0; t < sec; t += 2) { await page.clock.runFor(2000); } };
    await page.goto('/?tab=map');
    // 最初の表示：でたらめな通信でも、いつかはブースが出る（時計を進めてやり直させる）
    let first = -1;
    for (let i = 0; i < 40; i++) {
      await tick(16);
      const n = await page.evaluate(() => typeof S !== 'undefined' ? S.booths.length : -1).catch(() => -1);
      if (process.env.TRACE) console.log('  t', i, await page.evaluate(() => `n=${S.booths.length} fail=${S.failures} busy=${!!sync._busy} err=${S.errKind} timer=${!!S.timer}`).catch(() => '?'));
      if (n > 0) { first = i; break; }
    }
    if (first < 0) errs.push('でたらめな通信のままだと、10分たってもブースが出ない');
    // スタンプを2つ押す（送信も、でたらめな通信の中で）
    const k1 = await page.evaluate(() => { stampNow('1F-05'); if (showStampFx.close) showStampFx.close(); return 1; }).catch(e => { errs.push('stamp: ' + e); });
    let minBooths = 999, emptied = false;
    for (let i = 0; i < 60; i++) {
      await tick(20);
      if (i === 10) await page.evaluate(() => { stampNow('1F-07'); if (showStampFx.close) showStampFx.close(); }).catch(() => {});
      if (i % 7 === 3) await page.evaluate(() => { try{ sync(true); }catch(e){} }).catch(() => {});
      if (i % 9 === 4) await page.evaluate(() => { switchView(['list', 'stamp', 'info', 'map'][Math.floor(Math.random() * 4)]); }).catch(() => {});
      const n = await page.evaluate(() => S.booths.length).catch(() => -1);
      if (first >= 0 && n === 0) emptied = true;
      if (n >= 0) minBooths = Math.min(minBooths, n);
    }
    if (emptied) errs.push('一度出たブースが、通信の失敗で0件になった');
    // 通信が戻ったら、立ち直る
    chaos = false;
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await tick(20);
      const st = await page.evaluate(() => ({ n: S.booths.length, off: !document.getElementById('banner-offline').classList.contains('hide'), fail: S.failures, txt: document.getElementById('sync-text').textContent })).catch(() => null);
      if (st && st.n === 46 && !st.off && !st.fail) { ok = true; break; }
    }
    if (!ok) errs.push('通信が戻っても立ち直らない: ' + JSON.stringify(await page.evaluate(() => ({ n: S.booths.length, off: !document.getElementById('banner-offline').classList.contains('hide'), fail: S.failures, txt: document.getElementById('sync-text').textContent })).catch(() => null)));
    // スタンプは端末に残り、サーバーにも届く
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_stamps_v2') || '[]')).catch(() => []);
    if (!(st.includes('1F-05') && st.includes('1F-07'))) errs.push('スタンプが端末に残っていない: ' + JSON.stringify(st));
    for (let i = 0; i < 30 && !JSON.stringify(posts).includes('1F-07'); i++) await tick(20);
    const pj = JSON.stringify(posts);
    if (!(pj.includes('1F-05') && pj.includes('1F-07'))) errs.push('スタンプの控えがサーバーに届いていない（届いた送信 ' + posts.length + '件）');
    expect([...new Set(errs)].map(e => e.slice(0, 300)).concat(errs.length ? ['返した返事の内訳: ' + JSON.stringify(kinds)] : [])).toEqual([]);
  });
}
