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
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = c.getContext('2d'); ctx.fillRect(0, 0, 64, 64);
      return c.captureStream(5);
    };
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

test('カメラで黒工祭のQRを読むと、スタンプが付く', async ({ page }) => {
  const errors = watchErrors(page);
  await mockGas(page);
  await fakeCamera(page, `https://ma222222-source.github.io/bunnkasai/?booth=1F-03&qr=1&k=${sigs['1F-03']}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kuroko_stamps_v2') || '[]')), { timeout: 15000 })
    .toContain('1F-03');
  // 公式アドレスのQRでも、いま開いている場所（ここでは手元のサーバー）で付く
  expect(new URL(page.url()).host).toBe('127.0.0.1:8732');
  expect(errors).toEqual([]);
});

test('黒工祭以外のQRではスタンプは付かず、案内が出る', async ({ page }) => {
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

test('画面の中で読めない端末（iPhone など）では、標準のカメラで読む方法を出す', async ({ page }) => {
  await mockGas(page);
  await page.addInitScript(() => { delete window.BarcodeDetector; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?tab=stamp');
  await ready(page);
  await page.locator('#stamp-scan').click();
  await expect(page.locator('#scan')).toHaveClass(/no-cam/);
  await expect(page.locator('#scan-help')).toContainText('カメラ');
  await page.locator('#scan-ok').click();
  await expect(page.locator('#scan')).toBeHidden();
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
