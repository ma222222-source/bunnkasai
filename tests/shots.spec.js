// 目視確認用のスクリーンショット。ふだんのテストでは飛ばす。
// 撮るとき：SHOTS=shots npx playwright test shots.spec.js（tests/shots/ に保存。GitHub には上げない）
const { test, expect } = require('@playwright/test');
const { mockGas } = require('./mock');
const OUT = process.env.SHOTS;
test('screens', async ({ page }) => {
  test.skip(!OUT, 'SHOTS を指定したときだけ撮る');
  await page.setViewportSize({ width: 390, height: 844 });
  await mockGas(page);
  for (const t of ['map', 'list', 'stamp', 'info']) {
    await page.goto('/?tab=' + t);
    await expect.poll(() => page.evaluate(() => S.booths.length), { timeout: 15000 }).toBe(46);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${t}.png`, fullPage: t !== 'map' });
  }
  await page.goto('/?booth=1F-02');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/booth.png` });
});
