// 印刷物の番人。刷ったあとでは直せないので、刷る前にここで確かめる。
// - QR印刷シート（?mode=qr）：全カードの QR を、アプリ自前の読み取り（QR.scanImageData）で実際に読み、
//   ブースの id・署名（sigOf）・外部ブラウザの引数が正しいこと。小さく刷った場合（1枚 120px 相当）も読めること
// - ページ数（A4）：紙マップ 2ページ（30件超で両面）、QR シートのページ数
const { test, expect } = require('@playwright/test');
const { mockGas } = require('./mock');

async function loginTo(page, mode) {
  await mockGas(page, { verifyOk: true });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/?mode=' + mode);
  await page.locator('#pw').fill('test-password-1234');
  await page.locator('#btn-login').click();
  await expect.poll(() => page.evaluate(() => (typeof S !== 'undefined' && S.booths) ? S.booths.length : 0), { timeout: 15000 }).toBe(46);
}

/** PDF のページ数（/Type /Page の数） */
function pdfPages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

test('QR印刷シート：全カードのQRが読め、ブース・署名・引数が正しい（ふつうの大きさ・小さく刷った場合）', async ({ page }) => {
  await loginTo(page, 'qr');
  await expect(page.locator('#v-qr')).toBeVisible({ timeout: 10000 });
  // 本番で刷るのは公式アドレス（https://ma222222-source.github.io/bunnkasai/…）。手元のアドレスより長く、
  // QR の目が細かくなるので、本番と同じアドレスで作り直してから読む
  await page.evaluate(() => { window.publicBase = () => 'https://ma222222-source.github.io/bunnkasai/'; renderQrSheet(); });
  await expect.poll(() => page.locator('#qr-grid .qr-img svg').count()).toBe(47);
  expect(await page.locator('#qr-grid').innerHTML()).not.toContain('127.0.0.1');
  const r = await page.evaluate(async () => {
    const svgs = [...document.querySelectorAll('#qr-grid .qr-img svg')].map(s => s.outerHTML);
    const out = { ok: 0, bad: [], ids: [], top: null, small: 0 };
    const read = async (svg, px) => {
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej;
        i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      // 紙に刷ってスマホで写した状態に近づける：少し傾け、灰色の背景に置く
      const cv = document.createElement('canvas'); cv.width = 480; cv.height = 360;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#8c8c86'; ctx.fillRect(0, 0, 480, 360);
      ctx.translate(240, 180); ctx.rotate(0.12); ctx.drawImage(im, -px / 2, -px / 2, px, px);
      return QR.scanImageData(ctx.getImageData(0, 0, 480, 360));
    };
    for (const svg of svgs){
      const txt = await read(svg, 260);
      if (!txt){ out.bad.push('読めない'); continue; }
      const u = new URL(txt);
      if (u.searchParams.get('openExternalBrowser') !== '1'){ out.bad.push('外部ブラウザの引数なし：' + txt); continue; }
      const id = u.searchParams.get('booth');
      if (!id){ out.top = txt; out.ok++; continue; }                      // 入口の案内（地図そのもの）
      if (u.searchParams.get('qr') !== '1' || u.searchParams.get('k') !== sigOf(id)){ out.bad.push('署名ちがい：' + txt); continue; }
      out.ids.push(id); out.ok++;
      if (await read(svg, 120)) out.small++;                              // 小さく刷った場合
    }
    out.expected = S.booths.map(b => b.id).sort();
    return out;
  });
  expect(r.bad).toEqual([]);
  expect(r.ok).toBe(47);
  expect(r.top).not.toBeNull();
  expect(r.ids.slice().sort()).toEqual(r.expected);
  expect(r.small).toBe(46);
});

test('紙マップ（?mode=print）：A4で2ページ（46件・両面）', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto('/?mode=print');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await page.waitForTimeout(800);
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  expect(pdfPages(pdf)).toBe(2);
});

test('QR印刷シート：A4で9ページ以内（47枚）', async ({ page }) => {
  await loginTo(page, 'qr');
  await expect.poll(() => page.locator('#qr-grid .qr-img svg').count()).toBe(47);
  await page.waitForTimeout(500);
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  const n = pdfPages(pdf);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(9);
});
