const { fillStaffName } = require('./staff-name-helper');
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
  await fillStaffName(page); await page.locator('#btn-login').click();
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
  expect([r.in1, r.spread]).toEqual([47, 250]);        // v212：内側は［ごあいさつの細い列 47mm｜地図と一覧 250mm］（折り目は 100・200mm のまま）
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
  for (const s of ['黒工', '文化祭', 'KUROKO FESTIVAL', '10/23', '10/24', 'スタンプラリー', '7個ごとにお菓子抽選', '空き', 'タイムテーブル', 'ご来場のみなさまへ', '校内マップ', '1階'])
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
  expect(r.in1).toEqual([250, 297]);                   // v212：ごあいさつは 47mm の細い列（逆さなので右の端）
  expect(r.flap).toEqual([0, 97]);
  expect(r.spread).toEqual([0, 250]);
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
  expect(r.in1).toEqual([0, 47]);
  expect(r.spread).toEqual([47, 297]);
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

/* ---------------- v185：パンフレットの地図を大きく・体育館などに引き出し線・紙の空きを使い切る（ユーザーの依頼） ---------------- */
test('三つ折りパンフレット：地図は紙で読める大きさ（1階は2面いっぱい。番号の字は 5pt 以上）。体育館などは引き出し線つきの札', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await page.emulateMedia({ media: 'print' });
  const r = await page.evaluate(() => {
    const mm = 96 / 25.4;
    const maps = [...document.querySelectorAll('#pam .sheet-plan')].map(svg => {
      const b = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, k = b.width / mm / vb.width;      // 1単位が紙の上で何mmか
      const nums = [...svg.querySelectorAll('circle[fill="#b91c1c"] + text')].map(t => parseFloat(t.getAttribute('font-size')) * k);
      const inBox = el => { const e = el.getBBox(); return e.x >= vb.x - 0.5 && e.y >= vb.y - 0.5 && e.x + e.width <= vb.x + vb.width + 0.5 && e.y + e.height <= vb.y + vb.height + 0.5; };
      const calls = [...svg.querySelectorAll('.pl-call')].map(g => ({ id: g.dataset.call, text: g.textContent.replace(/\s+/g, ' ').trim(), box: (() => { const e = g.querySelector('rect').getBBox(); return [e.x, e.y, e.width, e.height]; })(),
        inside: inBox(g.querySelector('rect')), fs: parseFloat(g.querySelector('text').getAttribute('font-size')) * k }));
      // 札が、ブースの番号の丸に重なっていない
      const circles = [...svg.querySelectorAll('circle[fill="#b91c1c"]')].filter(c => !c.closest('.pl-call')).map(c => ({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), r: +c.getAttribute('r') }));
      const hit = calls.filter(c => circles.some(o => o.x + o.r > c.box[0] && o.x - o.r < c.box[0] + c.box[2] && o.y + o.r > c.box[1] && o.y - o.r < c.box[1] + c.box[3])).map(c => c.id);
      const cross = calls.filter((c, i) => calls.some((d, j) => j > i && c.box[0] < d.box[0] + d.box[2] && d.box[0] < c.box[0] + c.box[2] && c.box[1] < d.box[1] + d.box[3] && d.box[1] < c.box[1] + c.box[3])).map(c => c.id);
      return { w: Math.round(b.width / mm), h: Math.round(b.height / mm), k: +k.toFixed(3), minNum: +Math.min(...nums).toFixed(2), n: nums.length, calls, hit, cross };
    });
    const pn = s => document.querySelector(s);
    return { maps, over: document.querySelectorAll('#pam .pam-panel.over').length,
      // 番号の一覧の字
      listPt: parseFloat(getComputedStyle(pn('#pam .pam-list')).fontSize) * 0.75,
      // 折り目（短辺とじの向きで、紙の左から 100mm・200mm）をまたぐ一覧の行が無い。長辺とじ用は紙の上で 180度回るので、右から測る
      fold: (() => { const p = pn('.pam-s2 .pam-paper').getBoundingClientRect(), sc = p.width / (297 * mm), rot = getComputedStyle(pn('.pam-s2 .pam-paper')).transform.includes('-1');
        return [100, 200].map(f => { const fx = rot ? p.right - f * mm * sc : p.left + f * mm * sc;
          return [...document.querySelectorAll('#pam .pam-list li')].filter(li => { const b = li.getBoundingClientRect(); return b.left < fx - 2 && b.right > fx + 2; }).length; }); })(),
      // 番号の丸どうしが重ならない
      clash: [...document.querySelectorAll('#pam .sheet-plan')].map(svg => { const cs = [...svg.querySelectorAll('circle[fill="#b91c1c"]')].filter(c => !c.closest('.pl-call')).map(c => [+c.getAttribute('cx'), +c.getAttribute('cy'), +c.getAttribute('r')]);
        let n = 0; for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) if (Math.hypot(cs[i][0] - cs[j][0], cs[i][1] - cs[j][1]) < cs[i][2] + cs[j][2] - 0.2) n++; return n; }) };
  });
  expect(r.over).toBe(0);
  expect(r.maps.length).toBe(3);
  const [f1, f3, f2] = r.maps;                         // v212：並びは 1階・3階・2階（3階のまとまりを折り目の左に置く）
  expect(f1.w).toBeGreaterThanOrEqual(188);            // v212：1階は 180 → 189.5mm（ごあいさつを細くしたぶん）
  expect(f1.k).toBeGreaterThanOrEqual(0.42);
  expect(f2.w).toBeGreaterThanOrEqual(136);            // 2階は 122 → 137.5mm
  expect(f2.k).toBeGreaterThanOrEqual(0.4);
  expect(f3.k).toBeGreaterThanOrEqual(0.4);
  expect(f1.n + f2.n + f3.n).toBe(46);
  for (const m of r.maps) expect(m.minNum).toBeGreaterThanOrEqual(1.9);    // v212：番号の字は 5.4pt（1.9mm）以上（小さい教室の丸を大きくした。以前は 5pt）
  expect(r.clash).toEqual([0, 0, 0]);
  expect(r.listPt).toBeGreaterThanOrEqual(process.platform === 'win32' ? 8.4 : 6.6);   // v212：一覧の字（手元の Windows で 9pt 台。v211 までは 7.5pt）
  expect(r.fold).toEqual([0, 0]);
  // 引き出し線つきの札：体育館（ステージ・飲食）・受付（タイムテーブルに出てくる場所）
  const byId = Object.fromEntries(f1.calls.map(c => [c.id, c]));
  expect(byId['1F-42'].text).toContain('第一体育館');
  expect(byId['1F-42'].text).toContain('ステージ');
  expect(byId['1F-57'].text).toContain('第二体育館');
  expect(byId['1F-48'].text).toContain('受付');
  for (const c of f1.calls) { expect(c.inside, c.id).toBe(true); expect(c.fs, c.id).toBeGreaterThanOrEqual(2.1); }   // 札の字は 6pt 以上
  expect(f1.hit).toEqual([]);
  expect(f1.cross).toEqual([]);
});

test('三つ折りパンフレット：折り込む面・裏表紙は、面の空きが無くなるまで中身を大きくする（はみ出さない。欄に書き足したら小さくなる）', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  const look = async () => {
    await page.emulateMedia({ media: 'print' });
    const o = await page.evaluate(() => ['flap', 'back'].map(role => {
      const pn = document.querySelector('.pam-' + role), inn = pn.querySelector('.pam-in'), mm = 96 / 25.4;
      const pb = pn.getBoundingClientRect();
      const last = [...inn.children].filter(e => getComputedStyle(e).display !== 'none').pop().getBoundingClientRect();
      return { role, zoom: +getComputedStyle(inn).zoom, kp: +pn.dataset.zoom, over: pn.classList.contains('over'),
        blank: Math.round((pb.bottom - last.bottom) / mm), fits: inn.scrollHeight <= inn.clientHeight + 1 };
    }));
    await page.emulateMedia({ media: 'screen' });
    return o;
  };
  let r = await look();
  for (const p of r) {
    expect(p.zoom, p.role).toBeGreaterThan(1.05);      // 等倍のままだと、下 1/4 が空いていた
    expect(p.zoom, p.role).toBe(p.kp);
    expect(p.over, p.role).toBe(false);
    expect(p.fits, p.role).toBe(true);
    expect(p.blank, p.role).toBeGreaterThanOrEqual(8); // 下の余白（9mm）には食い込まない
    expect(p.blank, p.role).toBeLessThanOrEqual(30);
  }
  const before = r.find(p => p.role === 'back').zoom;
  // 裏表紙に「アクセス」を書き足すと、そのぶん小さくして収める
  await page.locator('[data-ed="back.access"]').click();
  await page.keyboard.insertText('JR北上駅から車で10分。駐車場は校舎南東の一般駐車場をご利用ください。\n公共交通機関のご利用にご協力ください。');
  r = await look();
  const back = r.find(p => p.role === 'back');
  expect(back.zoom).toBeLessThan(before);
  expect(back.over).toBe(false);
  expect(back.fits).toBe(true);
});

test('紙マップ（?mode=print）にも、体育館などの引き出し線つきの札が出る（A4 2ページのまま）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?mode=print');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  const calls = await page.locator('#print-sheet .pl-call').evaluateAll(gs => gs.map(g => g.textContent.replace(/\s+/g, ' ').trim()));
  expect(calls.join('|')).toContain('第一体育館');
  expect(calls.join('|')).toContain('第二体育館');
  expect(pdfPages(await page.pdf({ format: 'A4', printBackground: true }))).toBe(2);
});

/* ---------------- v204：パンフレットをもっと見やすく（ユーザーの依頼） ---------------- */
test('三つ折りパンフレット：ごあいさつは細い列、一覧は大きな字で地図のとなり・下（1階＝右の列、2階＝地図の下に3段、3階＝地図の下）。印の説明・赤い丸の番号・つぶれる部屋名は描かない', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 1123, height: 794 });
  // 位置を比べるので、2ページ目を回さない向き（短辺とじ用）で測る
  await page.evaluate(() => { localStorage.setItem('kuroko_pamphlet_v1', JSON.stringify({ _flip: 'short' })); renderPamphlet(); });
  const r = await page.evaluate(() => {
    const mm = 96 / 25.4, q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)];
    const paper = q('.pam-s2 .pam-paper').getBoundingClientRect();
    const X = el => { const b = el.getBoundingClientRect(); return [+((b.left - paper.left) / mm).toFixed(1), +((b.right - paper.left) / mm).toFixed(1)]; };
    const sp = q('#pam .pam-spread'), body = q('#pam .pam-sp-body'), b = q('#pam .pam-list1 .pam-list b'), cs = getComputedStyle(b);
    const lum = c => { const m = c.match(/[\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    const rooms = qa('#pam .sheet-plan').map(svg => { const k = svg.getBoundingClientRect().width / mm / svg.viewBox.baseVal.width;
      return [...svg.querySelectorAll('text[fill="#777"][font-weight="600"]')].filter(t => !/昇|降|口/.test(t.textContent)).map(t => +(parseFloat(t.getAttribute('font-size')) * k).toFixed(2)); });
    const pb = parseFloat(getComputedStyle(sp).paddingBottom) || 0;
    const fitsAt = pt => { sp.style.setProperty('--pl', pt.toFixed(1) + 'pt');
      const top = body.offsetParent === sp ? body.offsetTop : body.offsetTop - sp.offsetTop, h = Math.max(...[...body.children].map(c => c.offsetHeight));
      return top + h <= sp.clientHeight - pb + 0.5 && !qa('#pam .pam-spread .pam-list').some(l => l.scrollWidth > l.clientWidth + 1); };
    const cur = parseFloat(sp.dataset.pl);
    const fit = { fitsCur: fitsAt(cur), fitsMore: cur >= 9.55 ? false : fitsAt(cur + 0.1) };
    sp.style.setProperty('--pl', cur.toFixed(1) + 'pt');
    return {
      greet: X(q('#pam .pam-in1')), greetBody: +(q('#pam .pam-in1 .pam-gbody').getBoundingClientRect().width / mm).toFixed(1),
      map1: X(q('#pam .pam-spread-top svg')), m3: X(q('#pam .pam-mini.m3')), m2: X(q('#pam .pam-mini.m2')), list1: X(q('#pam .pam-list1')),
      l2: qa('#pam .pam-l2 .pam-list').map(X), l2n: qa('#pam .pam-l2 .pam-list').map(o => o.children.length),
      pl: cur, listPt: parseFloat(getComputedStyle(q('#pam .pam-list1 .pam-list')).fontSize) * 0.75, ...fit, tight: sp.dataset.tight,
      bBg: lum(cs.backgroundColor), bInk: lum(cs.color), bRound: cs.borderRadius, bW: b.getBoundingClientRect().width / mm,
      l1: qa('#pam .pam-list1 .pam-list li').length, l1head: qa('#pam .pam-list1 .pam-h4').map(h => h.textContent.trim()),
      l3: qa('#pam .pam-mini.m3 .pam-list li').map(li => li.textContent.trim()), total: qa('#pam .pam-list li').length,
      // 一覧は、その階の地図のすぐ下
      m3Below: q('#pam .pam-mini.m3 .pam-list').getBoundingClientRect().top >= q('#pam .pam-mini.m3 svg').getBoundingClientRect().bottom - 1,
      m2Below: q('#pam .pam-l2').getBoundingClientRect().top >= q('#pam .pam-mini.m2 svg').getBoundingClientRect().bottom - 1,
      bottom: (sp.getBoundingClientRect().bottom - Math.max(...[...body.children].map(c => c.getBoundingClientRect().bottom))) / mm,
      lm: qa('#pam .pam-list li.lm').map(li => li.textContent.trim()), lmWeight: +getComputedStyle(q('#pam .pam-list li.lm')).fontWeight,
      key: q('#pam .pam-key').textContent.replace(/\s+/g, ' ').trim(), keyWc: !!q('#pam .pam-key .pk-wc svg'),
      rooms, over: qa('#pam .pam-panel.over').length,
    };
  });
  expect(r.over).toBe(0);
  expect(r.tight).toBe('');
  // ごあいさつ：紙の左の 47mm（v211 までは 100mm）。文を書く幅は 36mm
  expect(r.greet).toEqual([0, 47]);
  expect(r.greetBody).toBeGreaterThanOrEqual(35);
  // 地図：1階 189.5mm。3階のまとまりは折り目（100mm）の左、2階は右。1階の一覧は折り目（200mm）より右の列
  expect(r.map1[1] - r.map1[0]).toBeGreaterThanOrEqual(188);
  expect(r.m3[1]).toBeLessThanOrEqual(98.5);
  expect(r.m2[0]).toBeGreaterThanOrEqual(101.5);
  expect(r.list1[0]).toBeGreaterThanOrEqual(240);
  expect(r.list1[1]).toBeLessThanOrEqual(291.5);          // 紙の右の端 5.5mm には置かない（v236：8mm → 6mm。空きを使い切る）
  // 2階の一覧は3段。2段目と3段目の切れ目が、折り目（200mm）
  expect(r.l2.length).toBe(3);
  expect(r.l2[1][1]).toBeLessThanOrEqual(198.5);
  expect(r.l2[2][0]).toBeGreaterThanOrEqual(201.5);
  expect(r.l2n.reduce((a, c) => a + c, 0)).toBe(13);
  // どの階の一覧も、その階の地図のとなり・下。1件も落としていない
  expect(r.l1).toBe(29); expect(r.l1head).toEqual(['1階']);
  expect(r.l3.length).toBe(4);
  expect(r.m3Below).toBe(true); expect(r.m2Below).toBe(true);
  expect(r.total).toBe(46);
  // 字の大きさ：入るなかでいちばん大きい（書体で変わる。手元の Windows で 9pt 台。v211 までは 7.5pt、v203 までは 6.6pt）
  expect(r.listPt).toBeGreaterThanOrEqual(process.platform === 'win32' ? 8.4 : 6.6);
  expect(r.listPt).toBeLessThanOrEqual(9.7);
  expect(Math.abs(r.listPt - r.pl)).toBeLessThan(0.15);
  expect(r.fitsCur).toBe(true);
  expect(r.fitsMore).toBe(false);
  expect(r.bottom).toBeGreaterThanOrEqual(5.5);           // 下の余白（6mm）に食い込まない
  // 一覧の番号：赤い丸に白い字
  expect(r.bBg).toBeLessThan(0.3); expect(r.bInk).toBeGreaterThan(0.9); expect(r.bRound).toBe('50%');
  expect(r.bW).toBeGreaterThanOrEqual(2.8);
  // 目当てになる所は太字。印の説明
  expect(r.lm.join(' ')).toContain('ステージ'); expect(r.lm.join(' ')).toContain('受付'); expect(r.lm.join(' ')).toContain('飲食ブース');
  expect(r.lm.length).toBeLessThanOrEqual(8);
  expect(r.lmWeight).toBeGreaterThanOrEqual(700);
  expect(r.key).toContain('ブース'); expect(r.key).toContain('トイレ'); expect(r.key).toContain('会場');
  expect(r.keyWc).toBe(true);
  // ブースの無い部屋の名前は、紙で 5.5pt（1.95mm）以上のものだけ
  for (const fs of r.rooms.flat()) expect(fs).toBeGreaterThanOrEqual(1.94);
  expect(r.rooms[0].length).toBeGreaterThanOrEqual(6);
});

test('三つ折りパンフレット：名前が長くて行が増えたら、字のほうを小さくする。いちばん小さい字でも入らなければ、はみ出しの印で知らせる（黙って重ねない）', async ({ page }) => {
  const open = async suffix => {
    await page.unroute(/script\.google(usercontent)?\.com\//).catch(() => {});
    await mockGas(page, { mutate: j => { j.booths.forEach(b => { b.name = b.name + suffix; }); } });
    await page.emulateMedia({ media: null });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/?mode=pamphlet');
    await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: 1123, height: 794 });
    await page.evaluate(() => renderPamphlet());
    return page.evaluate(() => {
      const sp = document.querySelector('#pam .pam-spread'), body = document.querySelector('#pam .pam-sp-body'), pb = parseFloat(getComputedStyle(sp).paddingBottom) || 0;
      const top = body.offsetParent === sp ? body.offsetTop : body.offsetTop - sp.offsetTop, h = Math.max(...[...body.children].map(c => c.offsetHeight));
      return { pl: parseFloat(sp.dataset.pl), inside: top + h <= sp.clientHeight - pb + 0.5, total: document.querySelectorAll('#pam .pam-list li').length, over: sp.classList.contains('over') };
    });
  };
  const base = await open('');
  expect(base.inside).toBe(true);
  expect(base.over).toBe(false);
  // 少し長い名前：行が増えるぶん、字が小さくなる（入らないときは必ず印が付く）
  const a = await open('・体験コーナー');
  expect(a.total).toBe(46);
  expect(a.pl).toBeGreaterThanOrEqual(6.6);
  expect(a.pl).toBeLessThanOrEqual(base.pl);
  expect(a.inside || a.over).toBe(true);
  if (a.pl > 6.65) { expect(a.inside).toBe(true); expect(a.over).toBe(false); }
  // とても長い名前：いちばん小さい字（6.6pt）でも入らない → 面にはみ出しの印
  const b = await open('（とても長い名前のブースの例です。とても長い名前のブースの例です。とても長い名前のブースの例です）');
  expect(b.pl).toBe(6.6);
  expect(b.over).toBe(true);
});

/* ---------------- v205：パンフレットの文は文節で折り返す ---------------- */
test('三つ折りパンフレット：文は文節で折り返す（1文字だけ次の行に落とさない）。あいさつ文も文節で折る。はみ出しなし', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 1123, height: 794 });
  await page.evaluate(() => { localStorage.setItem('kuroko_pamphlet_v1', JSON.stringify({ _flip: 'short' })); renderPamphlet(); });
  const r = await page.evaluate(() => {
    const q = s => document.querySelector(s), cs = el => getComputedStyle(el);
    const flapP = q('#pam [data-panel="flap"] p') || q('#pam [data-panel="flap"] li');
    // 行ごとの文字数：ひとつの段落を Range で1文字ずつ測り、最後の行が1文字だけの段落を数える
    const orphans = [...document.querySelectorAll('#pam [data-panel="flap"] p, #pam [data-panel="flap"] li, #pam [data-panel="flap"] span, #pam [data-panel="back"] p, #pam [data-panel="back"] li, #pam [data-panel="back"] span')].filter(el => {
      const tn = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim().length > 6).pop();
      if (!tn) return false;
      const rg = document.createRange(), tops = [];
      for (let i = 0; i < tn.textContent.length; i++){ rg.setStart(tn, i); rg.setEnd(tn, i + 1); const b = rg.getBoundingClientRect(); if (b.width) tops.push(Math.round(b.top)); }
      const last = tops[tops.length - 1];
      return tops.length > 8 && tops[0] !== last && tops.filter(t => t === last).length === 1;
    }).map(el => el.textContent.trim().slice(-12));
    return { wb: cs(flapP).wordBreak, tw: cs(flapP).textWrapStyle || cs(flapP).textWrap, gwb: cs(q('#pam .pam-gbody')).wordBreak, gal: cs(q('#pam .pam-gbody')).textAlign,
      orphans, over: document.querySelectorAll('#pam .pam-panel.over').length };
  });
  expect(r.wb).toBe('auto-phrase');
  expect(String(r.tw)).toContain('pretty');
  expect(r.gwb).toBe('auto-phrase');                  // v212：あいさつ文は細い列になったので、両端そろえをやめて文節で折る
  expect(r.gal).toBe('left');
  expect(r.orphans).toEqual([]);
  expect(r.over).toBe(0);
});

/* ---------------- v236 ---------------- */
test('三つ折りパンフレット（v236）：学校名の下は学校の公式サイト。表紙のQRの下は、このマップのアドレスのまま。面の左右の余白は紙の端 6mm・折り目の側 3.5mm', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?mode=pamphlet');
  await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
  await expect(page.locator('#pam .pam-foot')).toContainText('www2.iwate-ed.jp/kst-h');
  await expect(page.locator('#pam .pam-foot')).not.toContainText('github.io');
  await page.emulateMedia({ media: 'print' });
  const pad = await page.evaluate(() => { const mm = 96 / 25.4, p = s => { const c = getComputedStyle(document.querySelector(s)); return [Math.round(parseFloat(c.paddingLeft) / mm * 10) / 10, Math.round(parseFloat(c.paddingRight) / mm * 10) / 10]; };
    return { flap: p('.pam-s1 .pam-flap'), back: p('.pam-s1 .pam-back') }; });
  expect(pad.flap).toEqual([6, 3.5]);
  expect(pad.back).toEqual([3.5, 3.5]);
});
