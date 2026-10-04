// QRを読むカメラ（v140）。本物のカメラは使わず、BarcodeDetector と getUserMedia を差し替えて確かめる
const { test, expect } = require('@playwright/test');
const { mockGas, watchErrors } = require('./mock');
const sigs = require('./fixtures/sigs.json');

async function ready(page) {
  await expect.poll(() => page.evaluate(() => (typeof S !== 'undefined' && S.booths) ? S.booths.length : 0), { timeout: 15000 }).toBe(46);
}

/** カメラとQRの読み取りを差し替える。rawValue を読んだことにする */
async function fakeCamera(page, rawValue) {
  await page.addInitScript(raw => {
    window.BarcodeDetector = class {
      static async getSupportedFormats() { return ['qr_code']; }
      async detect() { return window.__scanRaw ? [{ rawValue: window.__scanRaw }] : []; }
    };
    window.__scanRaw = raw;
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    (window.__setGUM = window.__setGUM || (fn => { const md = navigator.mediaDevices || {}; md.getUserMedia = fn; try{ Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); }catch(e){} }))(async () => {
      const ctx = c.getContext('2d'); ctx.fillRect(0, 0, 64, 64);
      return c.captureStream(5);
    });
  }, rawValue);
}

test('カメラのボタンが見出し・スタンプ・ブースの詳細にある', async ({ page }) => {
  await mockGas(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await expect(page.locator('#btn-scan')).toBeVisible();
  await expect(page.locator('#stamp-scan')).toBeVisible();
  const box = await page.locator('#stamp-scan').boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.goto('/?booth=1F-02');
  await expect(page.locator('#bsh')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#bsh-body [data-scan]')).toBeVisible();
});

test('カメラで黒工祭のQRを読むと、スタンプが付く', async ({ page, browserName }) => {
  // Windows の Playwright の WebKit には canvas の captureStream が無く、カメラの代わりの映像を作れない（本物の iPhone の Safari にはある）
  test.skip(browserName === 'webkit', 'テスト用の WebKit にカメラの代わりの映像が作れない');
  const errors = watchErrors(page);
  await mockGas(page);
  await fakeCamera(page, `https://ma222222-source.github.io/bunnkasai/?booth=1F-03&qr=1&k=${sigs['1F-03']}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  // 読み取ると画面を開き直す。開き直している瞬間に調べると「ページが消えた」になるので、その回は空として数え直す
  // （GitHub Actions で1回それで落ちた。アプリの不具合ではない）
  const stamps = () => page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_stamps_v2') || '[]')).catch(() => []);
  await expect.poll(stamps, { timeout: 15000 }).toContain('1F-03');
  await page.waitForLoadState('load');
  // 公式アドレスのQRでも、いま開いている場所（ここでは手元のサーバー）で付く
  expect(new URL(page.url()).host).toBe('127.0.0.1:8732');
  expect(errors).toEqual([]);
});

test('黒工祭以外のQRではスタンプは付かず、案内が出る', async ({ page, browserName }) => {
  // Windows の Playwright の WebKit には canvas の captureStream が無く、カメラの代わりの映像を作れない（本物の iPhone の Safari にはある）
  test.skip(browserName === 'webkit', 'テスト用の WebKit にカメラの代わりの映像が作れない');
  await mockGas(page);
  await fakeCamera(page, 'https://example.com/?booth=1F-03');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#btn-scan').click();
  await expect(page.locator('#scan')).toBeVisible();
  await expect(page.locator('#scan-help')).toContainText('ブースのQRではない', { timeout: 5000 });
  await page.locator('#scan-close').click();
  await expect(page.locator('#scan')).toBeHidden();
  // カメラは止まっている
  expect(await page.evaluate(() => SCAN.stream)).toBeNull();
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_stamps_v2') || '[]'));
  expect(st).not.toContain('1F-03');
});

test('QR を読む機能が無い端末（iPhone の Safari など）でも、カメラを開いて自前で読み、スタンプが付く', async ({ page, browserName }) => {
  // Windows の Playwright の WebKit には canvas の captureStream が無く、カメラの代わりの映像を作れない（本物の iPhone の Safari にはある）
  test.skip(browserName === 'webkit', 'テスト用の WebKit にカメラの代わりの映像が作れない');
  const errors = watchErrors(page);
  await mockGas(page);
  // BarcodeDetector を消し、カメラの代わりに QR を描いた画面を流す（傾けて少し小さめ）
  await page.addInitScript(() => {
    delete window.BarcodeDetector;
    (window.__setGUM = window.__setGUM || (fn => { const md = navigator.mediaDevices || {}; md.getUserMedia = fn; try{ Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); }catch(e){} }))(async () => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const ctx = c.getContext('2d');
      const draw = () => {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#8a8a84'; ctx.fillRect(0, 0, 640, 480);
        if (window.__qrImg){ ctx.translate(330, 230); ctx.rotate(0.3); ctx.drawImage(window.__qrImg, -130, -130, 260, 260); }
        requestAnimationFrame(draw);
      };
      draw();
      return c.captureStream(15);
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.evaluate(() => new Promise(res => {
    const u = 'https://ma222222-source.github.io/bunnkasai/?booth=1F-05&qr=1&k=' + sigOf('1F-05');
    const im = new Image(); im.onload = () => { window.__qrImg = im; res(); };
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(QR.svg(u, 300));
  }));
  await page.locator('#stamp-scan').click();
  const stamps = () => page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_stamps_v2') || '[]')).catch(() => []);
  await expect.poll(stamps, { timeout: 15000 }).toContain('1F-05');
  await page.waitForLoadState('load');
  expect(errors).toEqual([]);
});

test('カメラが使えない端末では、標準のカメラで読む方法を出す', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { delete window.BarcodeDetector; try{ Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); }catch(e){} });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  await expect(page.locator('#scan')).toHaveClass(/no-cam/);
  await expect(page.locator('#scan-help')).toContainText('カメラ');
  await page.locator('#scan-ok').click();
  await expect(page.locator('#scan')).toBeHidden();
});

test('カメラを許可しなかったときは、許可のしかたを出す', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => {
    delete window.BarcodeDetector;
    (window.__setGUM = window.__setGUM || (fn => { const md = navigator.mediaDevices || {}; md.getUserMedia = fn; try{ Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); }catch(e){} }))(async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  await expect(page.locator('#scan-help')).toContainText('カメラを許可するには');
});

test('自前の QR 読み取り：格子・誤り訂正・回転・斜め・ぼけ・雑音・遠く', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  const r = await page.evaluate(async () => {
    const out = {};
    const u = 'https://ma222222-source.github.io/bunnkasai/?booth=1F-02&qr=1&k=' + sigOf('1F-02');
    const long = 'https://ma222222-source.github.io/bunnkasai/?restore=ABCD-EFGH&x=' + 'y'.repeat(120);
    out.grid = [u, 'hello', long].every(t => { const e = QR.encode(t); return QR.decodeGrid((r, c) => e.get(r, c), e.size) === t; });
    const e = QR.encode(u);
    const flip = new Set(['20,20', '25,30', '30,12', '33,22']);
    out.corrected = QR.decodeGrid((r, c) => flip.has(r + ',' + c) ? 1 - e.get(r, c) : e.get(r, c), e.size) === u;
    const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(QR.svg(u, 300)); });
    const cases = { plain: [0, 1, 0, 0], r15: [15, 1, 0, 0], r45: [45, .7, 0, 0], r90: [90, 1, 0, 0], r180: [180, .8, 0, 0], r270: [270, .9, 0, 0],
                    far: [-8, .42, 0, 0], skew: [5, .9, .18, 0], blur: [3, .9, 0, 1.2], noise: [-12, .8, .1, .6] };
    out.img = {};
    for (const [k, [deg, sc, sk, blur]] of Object.entries(cases)){
      const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#9a9a92'; ctx.fillRect(0, 0, 640, 480);
      ctx.filter = blur ? 'blur(' + blur + 'px)' : 'none';
      ctx.translate(320, 240); ctx.rotate(deg * Math.PI / 180); ctx.transform(1, sk, 0, 1, 0, 0); ctx.scale(sc, sc);
      ctx.drawImage(img, -150, -150, 300, 300);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = 'none';
      const g = ctx.createLinearGradient(0, 0, 640, 480); g.addColorStop(0, 'rgba(255,255,255,.3)'); g.addColorStop(1, 'rgba(0,0,0,.25)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 480);
      if (k === 'noise'){
        const d = ctx.getImageData(0, 0, 640, 480); let sd = 7; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < d.data.length; i += 4){ const n = (rnd() - .5) * 60; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; }
        ctx.putImageData(d, 0, 0);
      }
      out.img[k] = QR.scanImageData(ctx.getImageData(0, 0, 640, 480)) === u;
    }
    // QR が写っていない画像では null（すぐ返る）
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480;
    const ctx = cv.getContext('2d');
    for (let i = 0; i < 400; i++){ ctx.fillStyle = i % 2 ? '#000' : '#fff'; ctx.fillRect((i * 37) % 640, (i * 53) % 480, 20, 12); }
    const t0 = performance.now();
    out.none = QR.scanImageData(ctx.getImageData(0, 0, 640, 480)) === null;
    out.noneMs = performance.now() - t0;
    return out;
  });
  expect(r.grid).toBe(true);
  expect(r.corrected).toBe(true);
  for (const [k, ok] of Object.entries(r.img)) expect(ok, k).toBe(true);
  expect(r.none).toBe(true);
  expect(r.noneMs).toBeLessThan(500);
});

test('自前の QR 読み取り：斜め下から写した（遠近のある）画像でも読める', async ({ page, context }) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  const u = await page.evaluate(() => 'https://ma222222-source.github.io/bunnkasai/?booth=2F-12&qr=1&k=' + sigOf('2F-12'));
  const svg = await page.evaluate(t => QR.svg(t, 300), u);
  // CSS の3D変形で「斜め下から見上げて写した」画像を作り、その画面写真を読む
  const p2 = await context.newPage();
  await p2.setViewportSize({ width: 640, height: 480 });
  await p2.setContent('<body style="margin:0;background:#888;display:grid;place-items:center;height:480px;perspective:500px">'
    + '<div style="transform:rotateX(32deg) rotateZ(8deg)">' + svg + '</div></body>');
  const shot = (await p2.screenshot({ type: 'png' })).toString('base64');
  await p2.close();
  const ok = await page.evaluate(async ([b64, t]) => {
    const im = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64; });
    // 本物のカメラと同じく、長い辺 640px に縮めてから読む（Android の画面は密度が高く、写真が大きくなる）
    const k = Math.min(1, 640 / Math.max(im.width, im.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
    const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0, cv.width, cv.height);
    return QR.scanImageData(ctx.getImageData(0, 0, cv.width, cv.height)) === t;
  }, [shot, u]);
  expect(ok).toBe(true);
});

test('QRの文字列の見分け（stampUrlFrom）', async ({ page }) => {
  await mockGas(page);
  await page.goto('/?tab=info');
  const r = await page.evaluate(() => [
    stampUrlFrom('https://ma222222-source.github.io/bunnkasai/?booth=1F-02&qr=1&k=abc123'),
    stampUrlFrom('https://ma222222-source.github.io/bunnkasai/?booth=1F-02'),
    stampUrlFrom('javascript:alert(1)//?booth=1&qr=1&k=1'),
    stampUrlFrom('ただの文字'),
  ]);
  expect(r[0]).toBe('/?booth=1F-02&qr=1&k=abc123');
  expect(r[1]).toBeNull();
  expect(r[2]).toBeNull();
  expect(r[3]).toBeNull();
});

test('カメラの拡大が使える端末では「2倍」が出て、押すとカメラを2倍にする', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'テスト用の WebKit にカメラの代わりの映像が作れない');
  await mockGas(page);
  await page.addInitScript(() => {
    const md = navigator.mediaDevices || {};
    md.getUserMedia = async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      c.getContext('2d').fillRect(0, 0, 64, 64);
      const st = c.captureStream(5), tr = st.getVideoTracks()[0];
      tr.getCapabilities = () => ({ zoom: { min: 1, max: 5 } });
      tr.applyConstraints = async x => { window.__zc = x; };
      return st;
    };
    try{ Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); }catch(e){}
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  await expect(page.locator('#scan-zoom')).toBeVisible();
  await page.locator('#scan-zoom').click();
  await expect(page.locator('#scan-zoom')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__zc.advanced[0].zoom)).toBe(2);
  await page.locator('#scan-zoom').click();
  await expect(page.locator('#scan-zoom')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.__zc.advanced[0].zoom)).toBe(1);
});
