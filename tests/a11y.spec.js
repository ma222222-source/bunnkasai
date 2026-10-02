// アクセシビリティの自動点検（axe-core。WCAG 2 A/AA）。色の差（コントラスト）・名前の無いボタンなどを見つける。
// 重大（serious / critical）が1つでもあれば落とす。2つのテーマ（ふつう・暗い）で、来場者の主な画面を見る。
// 除外：meta-viewport（地図のピンチ拡大とページの拡大がぶつかるため user-scalable=no は方針。文字は「特大」で大きくできる）
//       本部ボードの戻るボタン（大画面で校内図を隠さないよう、わざと薄くしている。近づくと濃くなる）
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mockGas } = require('./mock');

const CASES = [
  ['マップ', '/?tab=map'], ['一覧', '/?tab=list'], ['スタンプ', '/?tab=stamp'], ['インフォ', '/?tab=info'],
  ['ブースの詳細', '/?booth=1F-02'],
  ['地図の検索', '/?tab=map', async p => { await p.locator('#map-q').fill('でんし'); await p.waitForTimeout(300); }],
  ['スタンプ5個', '/?tab=stamp', null, ['1F-02', '1F-03', '1F-05', '1F-07', '1F-08']],
  ['QRの案内', '/?tab=stamp', async p => { await p.addScriptTag({ content: 'delete window.BarcodeDetector' }); await p.locator('#stamp-scan').click(); await p.waitForTimeout(400); }],
  ['紙マップ', '/?mode=print'], ['本部ボード', '/?mode=board'], ['係員ログイン', '/?mode=admin'],
];

for (const theme of ['paper', 'heavy']) {
  for (const [name, url, act, stamps] of CASES) {
    test(`a11y（${theme === 'heavy' ? '暗い' : 'ふつう'}）：${name}`, async ({ page }) => {
      await page.setViewportSize({ width: name === '本部ボード' ? 1280 : 390, height: 844 });
      await page.addInitScript(([th, st]) => {
        localStorage.setItem('kuroko_theme', JSON.stringify(th));
        if (st) localStorage.setItem('kuroko_stamps_v2', JSON.stringify(st));
      }, [theme, stamps]);
      await mockGas(page);
      await page.goto(url);
      await expect.poll(() => page.evaluate(() => (typeof S !== 'undefined' && S.booths) ? S.booths.length : 0), { timeout: 15000 }).toBe(46);
      await page.waitForTimeout(name === '本部ボード' ? 3000 : 900);   // 画面の出る動きが終わってから測る
      if (act) await act(page);
      const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['meta-viewport'])
        .exclude('body.board-mode #staff-back')
        .analyze();
      const bad = r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
        .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' / ')}`);
      expect(bad).toEqual([]);
    });
  }
}
