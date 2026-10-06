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

/* ---------------- v178：QR をしっかり刷る ---------------- */
test('QR印刷シート：1ページ6枚の箱に入り、どのカードも箱からはみ出さない（刷る大きさで確かめる）', async ({ page }) => {
  await loginTo(page, 'qr');
  await page.evaluate(() => { window.publicBase = () => 'https://ma222222-source.github.io/bunnkasai/'; renderQrSheet(); });
  await expect.poll(() => page.locator('#qr-grid .qr-img svg').count()).toBe(47);
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 718, height: 1047 });      // A4 から余白 10mm×2 を引いた大きさ
  const r = await page.evaluate(() => {
    const mm = 96 / 25.4;
    const pages = [...document.querySelectorAll('#qr-grid .qr-page')];
    return {
      n: pages.length,
      perPage: pages.map(p => p.querySelectorAll('.qr-card').length),
      tooTall: pages.filter(p => p.getBoundingClientRect().height > 277 * mm + 1).length,
      over: [...document.querySelectorAll('#qr-grid .qr-card')].filter(c => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).length,
      qrMm: [...document.querySelectorAll('#qr-grid .qr-img svg')].map(s => s.getBoundingClientRect().width / mm),
      breaks: pages.slice(0, -1).every(p => /page|always/.test(getComputedStyle(p).breakAfter))
    };
  });
  expect(r.n).toBe(8);
  expect(r.perPage.slice(0, 7).every(n => n === 6)).toBe(true);
  expect(r.perPage[7]).toBe(5);
  expect(r.tooTall).toBe(0);
  expect(r.over).toBe(0);
  expect(Math.min(...r.qrMm)).toBeGreaterThanOrEqual(43);          // どのQRも 43mm 以上
  expect(r.breaks).toBe(true);
});

test('QR：横に続く黒いマスを1つの長方形にまとめて描く（白い筋を防ぐ）。読める中身は同じ', async ({ page }) => {
  await loginTo(page, 'qr');
  const r = await page.evaluate(() => {
    const u = 'https://ma222222-source.github.io/bunnkasai/?booth=1F-05&qr=1&k=' + sigOf('1F-05') + '&openExternalBrowser=1';
    const svg = QR.svgSafe(u, 300);
    const runs = (svg.match(/h(\d+)v1/g) || []).map(x => +x.match(/\d+/)[0]);
    return new Promise(res => { const im = new Image(); im.onload = () => {
      const c = document.createElement('canvas'); c.width = 340; c.height = 340; const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 340, 340); x.drawImage(im, 20, 20, 300, 300);
      res({ maxRun: Math.max(...runs), txt: QR.scanImageData(x.getImageData(0, 0, 340, 340)), u });
    }; im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  });
  expect(r.maxRun).toBeGreaterThanOrEqual(7);       // 位置合わせの印（7マス）が1本になっている
  expect(r.txt).toBe(r.u);
});

test('QRを1枚だけ大きく刷る：そのカードだけが残り、刷り終わると元に戻る', async ({ page }) => {
  await loginTo(page, 'qr');
  await expect.poll(() => page.locator('#qr-grid .qr-img svg').count()).toBe(47);
  await page.evaluate(() => { window.print = () => { window.__printed = document.body.classList.contains('print-one') ? document.querySelectorAll('.qr-card.one').length : -1; }; });
  await page.locator('#qr-grid [data-one="3"]').click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('body')).not.toHaveClass(/print-one/);
});

/* ---------------- v178：三つ折りパンフレット ---------------- */
test('三つ折りパンフレット（?mode=pamphlet）：A4横・両面2ページ、面の幅は 97/100/100mm（折り込む面だけ狭い）、はみ出しなし', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator('#pam .pam-sheet')).toHaveCount(2);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  expect(pdfPages(pdf)).toBe(2);
  // A4 横（842×595pt）
  expect(pdf.toString('latin1')).toMatch(/MediaBox\s*\[\s*0\s+0\s+84[12](\.\d+)?\s+59[45](\.\d+)?\s*\]/);
  await page.emulateMedia({ media: 'print' });
  const r = await page.evaluate(() => {
    const mm = 96 / 25.4, w = s => Math.round(document.querySelector(s).getBoundingClientRect().width / mm);
    return { flap: w('.pam-flap'), back: w('.pam-back'), cover: w('.pam-cover'), in1: w('.pam-in1'), spread: w('.pam-spread'),
      paper: [w('.pam-s1 .pam-paper'), Math.round(document.querySelector('.pam-s1 .pam-paper').getBoundingClientRect().height / mm)],
      over: document.querySelectorAll('#pam .pam-panel.over').length,
      order: [...document.querySelectorAll('.pam-s1 .pam-panel')].map(p => p.dataset.panel).join(','),
      maps: document.querySelectorAll('#pam .sheet-plan').length, list: document.querySelectorAll('#pam .pam-list li').length };
  });
  expect(r.paper).toEqual([297, 210]);
  expect([r.flap, r.back, r.cover]).toEqual([97, 100, 100]);
  expect([r.in1, r.spread]).toEqual([100, 197]);
  expect(r.order).toBe('flap,back,cover');             // 外側：左から 折り込む面・裏表紙・表紙
  expect(r.over).toBe(0);
  expect(r.maps).toBe(3);
  expect(r.list).toBe(46);
  expect(errors).toEqual([]);
});

test('三つ折りパンフレット：文字を書き換えると覚え、「元に戻す」で戻る', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  const t = page.locator('[data-ed="cover.theme"]');
  await t.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('テーマ：つなぐ');
  await page.reload();
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator('[data-ed="cover.theme"]')).toHaveText('テーマ：つなぐ');
  await page.locator('#pam-reset').click();
  await expect(page.locator('[data-ed="cover.theme"]')).toContainText('ここにテーマ');
});
