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

/* ---------------- v178・v183：三つ折りパンフレット ---------------- */
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

test('三つ折りパンフレット：そのまま刷れる（仮の文字・作る人への説明が紙に出ない。空の欄は見出しごと出ない）', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await page.emulateMedia({ media: 'print' });
  const r = await page.evaluate(() => {
    const shown = el => { const c = getComputedStyle(el); return c.display !== 'none' && c.visibility !== 'hidden' && el.getClientRects().length > 0; };
    const pam = document.querySelector('#pam');
    return {
      text: pam.innerText,                                                        // 紙に出る文字
      // 空の欄の薄い案内（data-ph）は画面にだけ出す
      ph: [...pam.querySelectorAll('.pam-ed')].filter(e => !e.textContent.trim() && getComputedStyle(e, '::before').content !== 'none').length,
      emptyOptShown: [...pam.querySelectorAll('.pam-opt.is-empty')].filter(shown).length,
      emptyOpt: pam.querySelectorAll('.pam-opt.is-empty').length,
      old: pam.querySelectorAll('.pam-todo,.pam-role').length,
      ui: [...document.querySelectorAll('#v-pamphlet .no-print')].filter(shown).length,
      outline: [...pam.querySelectorAll('.pam-ed')].filter(e => getComputedStyle(e).outlineStyle !== 'none' && parseFloat(getComputedStyle(e).outlineWidth) > 0).length,
    };
  });
  expect(r.text).not.toMatch(/ここに|押して|空なら|空のまま|仮の|見本|あとで|資料|折り込む面|裏表紙|中面/);
  expect(r.ph).toBe(0);
  expect(r.emptyOpt).toBeGreaterThan(0);               // 何も書いていない欄がある
  expect(r.emptyOptShown).toBe(0);                     // それは紙に出ない
  expect(r.old).toBe(0);
  expect(r.ui).toBe(0);
  expect(r.outline).toBe(0);
  // 載せるもの：表紙（題・日にち・QR）、スタンプラリー、混み具合の見かた、タイムテーブル、来場の案内、地図と番号
  for (const s of ['黒工', '文化祭', 'KUROKO FESTIVAL', '10/23', '10/24', 'スタンプラリー', '個でお菓子と交換', '空き', 'タイムテーブル', 'ご来場のみなさまへ', '校内マップ', '1階'])
    expect(r.text.replace(/\s+/g, ''), s).toContain(s.replace(/\s+/g, ''));
  expect(await page.locator('.pam-cover .pam-qr-img svg').count()).toBe(1);
});

test('三つ折りパンフレット：校長・生徒会長のあいさつの欄がある（空でも見出しと空白を刷る。書けば覚える。長すぎれば知らせる）', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator('.pam-in1 .pam-greet')).toHaveCount(2);
  await expect(page.locator('[data-ed="greet.principal.title"]')).toHaveText('校長あいさつ');
  await expect(page.locator('[data-ed="greet.president.title"]')).toHaveText('生徒会長あいさつ');
  await expect(page.locator('[data-ed="greet.principal.body"]')).toHaveText('');
  await page.emulateMedia({ media: 'print' });
  const blank = await page.evaluate(() => {
    const mm = 96 / 25.4;
    return [...document.querySelectorAll('.pam-in1 .pam-greet')].map(g => ({
      h: Math.round(g.getBoundingClientRect().height / mm), body: Math.round(g.querySelector('.pam-gbody').getBoundingClientRect().height / mm),
      shown: getComputedStyle(g).display !== 'none', sign: g.querySelector('.pam-gsign').textContent }));
  });
  // 空でも、2つの欄が面を半分ずつ使って刷られる（文を書く・貼る場所が 5cm 以上ある）
  expect(blank.map(b => b.shown)).toEqual([true, true]);
  expect(blank.map(b => b.sign)).toEqual(['校長', '生徒会長']);
  for (const b of blank) expect(b.body).toBeGreaterThanOrEqual(50);
  expect(Math.abs(blank[0].h - blank[1].h)).toBeLessThanOrEqual(4);
  await page.emulateMedia({ media: 'screen' });
  // 書くと覚える
  const body = page.locator('[data-ed="greet.principal.body"]');
  await body.click();
  await page.keyboard.insertText('本日はご来場いただき、ありがとうございます。生徒たちが日ごろの学習の成果を発表します。');
  await page.locator('[data-ed="greet.principal.name"]').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('校長　黒沢 太郎');
  await page.reload();
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator('[data-ed="greet.principal.body"]')).toContainText('日ごろの学習の成果');
  await expect(page.locator('[data-ed="greet.principal.name"]')).toHaveText('校長　黒沢 太郎');
  expect(await page.locator('#pam .pam-panel.over').count()).toBe(0);
  // 面に入りきらない長さを書いたら、刷る前に分かる（面に赤い印）
  await page.locator('[data-ed="greet.president.body"]').click();
  await page.keyboard.insertText('文化祭を楽しんでください。'.repeat(160));
  await expect(page.locator('.pam-in1')).toHaveClass(/over/);
  // 「書いた文字を消す」で、空の欄に戻る
  await page.locator('#pam-reset').click();
  await expect(page.locator('[data-ed="greet.president.body"]')).toHaveText('');
  await expect(page.locator('[data-ed="greet.principal.name"]')).toHaveText('校長');
  expect(await page.locator('#pam .pam-panel.over').count()).toBe(0);
});

test('三つ折りパンフレット：文字を書き換えると覚え、「書いた文字を消す」で空に戻る', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  const t = page.locator('[data-ed="cover.theme"]');
  await expect(t).toHaveText('');                      // はじめは空（紙に出ない）
  await t.click();
  await page.keyboard.insertText('テーマ：つなぐ');
  await page.reload();
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator('[data-ed="cover.theme"]')).toHaveText('テーマ：つなぐ');
  await page.locator('#pam-reset').click();
  await expect(page.locator('[data-ed="cover.theme"]')).toHaveText('');
});

test('作ってある PDF（docs/pamphlet.pdf）：A4 横・2ページ。画面の「作ってあるPDFを開く」から届く', async ({ page, request }) => {
  const res = await request.get('/docs/pamphlet.pdf');
  expect(res.status()).toBe(200);
  const buf = await res.body();
  expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdfPages(buf)).toBe(2);
  expect(buf.toString('latin1')).toMatch(/MediaBox\s*\[\s*0\s+0\s+84[12](\.\d+)?\s+59[45](\.\d+)?\s*\]/);
  await mockGas(page);
  await page.goto('/?mode=pamphlet');
  await expect(page.locator('#pam-pdf')).toHaveAttribute('href', 'docs/pamphlet.pdf');
});

/* ---------------- v184：両面印刷のとじ方（ユーザーの報告：内側が上下逆に刷れた） ---------------- */
test('三つ折りパンフレット：ふつうの両面印刷（長辺とじ）用に、2ページ目を上下逆に刷る。短辺とじ用にも切り替えられ、覚える', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  // 紙の上での面の位置（mm）。表の折り目は左から 97・197mm
  const lay = () => page.evaluate(() => {
    const mm = 96 / 25.4, q = s => document.querySelector(s);
    const x = (s, sh) => { const b = q(s).getBoundingClientRect(), p = q(sh).getBoundingClientRect(); return [Math.round((b.left - p.left) / mm), Math.round((b.right - p.left) / mm)]; };
    const top = (s, sh) => Math.round((q(s).getBoundingClientRect().top - q(sh).getBoundingClientRect().top) / mm);
    return { flip: q('#pam').dataset.flip, tr: getComputedStyle(q('.pam-s2 .pam-paper')).transform, tr1: getComputedStyle(q('.pam-s1 .pam-paper')).transform,
      flap: x('.pam-flap', '.pam-s1'), cover: x('.pam-cover', '.pam-s1'), in1: x('.pam-in1', '.pam-s2'), spread: x('.pam-spread', '.pam-s2'),
      h3top: top('.pam-in1 .pam-h3', '.pam-s2'), folds: [x('.pam-s2 .pam-fold.f1', '.pam-s2')[0], x('.pam-s2 .pam-fold.f2', '.pam-s2')[0]].sort((a, b) => a - b),
      long: q('#pam-flip-long').getAttribute('aria-pressed'), href: q('#pam-pdf').getAttribute('href') };
  });
  await page.emulateMedia({ media: 'print' });
  let r = await lay();
  // はじめは長辺とじ用：2ページ目だけ 180度。長辺とじは「上の辺でめくる」ので、左右はそのまま重なる
  //（表紙＝右の 100mm の裏に、あいさつの面が来る。折り込む面＝左の 97mm の裏に、地図の右の面）
  expect(r.flip).toBe('long');
  expect(r.long).toBe('true');
  expect(r.tr).toBe('matrix(-1, 0, 0, -1, 0, 0)');
  expect(r.tr1).toBe('none');
  expect(r.cover).toEqual([197, 297]);
  expect(r.in1).toEqual([197, 297]);
  expect(r.flap).toEqual([0, 97]);
  expect(r.spread).toEqual([0, 197]);
  expect(r.folds).toEqual([97, 197]);                  // 裏の折り目の印が、表の折り目と同じ位置
  expect(r.h3top).toBeGreaterThan(150);                // 見出しが紙の下のほう＝上下逆
  expect(r.href).toBe('docs/pamphlet.pdf');
  expect(pdfPages(await page.pdf({ preferCSSPageSize: true, printBackground: true }))).toBe(2);
  // 画面では逆さにしない（読める・書ける）
  await page.emulateMedia({ media: 'screen' });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pam-s2 .pam-paper')).transform)).not.toContain('-1');
  await expect(page.locator('#pam-flip-msg')).toContainText('上下逆に刷ります');
  // 短辺とじ用：2ページ目も同じ向き。「横にめくる」ので、左右は入れ替わって重なる
  await page.locator('#pam-flip-short').click();
  await page.emulateMedia({ media: 'print' });
  r = await lay();
  expect(r.flip).toBe('short');
  expect(r.tr).toBe('none');
  expect(r.in1).toEqual([0, 100]);
  expect(r.spread).toEqual([100, 297]);
  expect(r.h3top).toBeLessThan(20);
  expect(r.href).toBe('docs/pamphlet-tanpen.pdf');
  await page.emulateMedia({ media: 'screen' });
  // 覚える。「書いた文字を消す」でも、とじ方は残る
  await page.locator('[data-ed="cover.theme"]').click();
  await page.keyboard.insertText('テーマ');
  await page.locator('#pam-reset').click();
  await expect(page.locator('[data-ed="cover.theme"]')).toHaveText('');
  await page.reload();
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator('#pam-flip-short')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.getElementById('pam').dataset.flip)).toBe('short');
});

test('作ってある PDF は2種類（長辺とじ用・短辺とじ用）。どちらも A4 横・2ページ', async ({ request }) => {
  for (const f of ['/docs/pamphlet.pdf', '/docs/pamphlet-tanpen.pdf']) {
    const res = await request.get(f);
    expect(res.status(), f).toBe(200);
    const buf = await res.body();
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfPages(buf), f).toBe(2);
    expect(buf.toString('latin1')).toMatch(/MediaBox\s*\[\s*0\s+0\s+84[12](\.\d+)?\s+59[45](\.\d+)?\s*\]/);
  }
});
