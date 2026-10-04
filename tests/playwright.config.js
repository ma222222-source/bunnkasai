// 画面のテスト。リポジトリ直下を python の簡易サーバーで配り、GAS の通信は tests/mock.js で差し替える
// （本番のスプレッドシートには一切届かない）
const { defineConfig, devices } = require('@playwright/test');
const PORT = 8732;
module.exports = defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  timeout: 45000,
  // GitHub Actions では1回だけやり直す（やり直して通ったものは flaky と表示されるので、見落とさない）
  retries: process.env.CI ? 1 : 0,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',   // SW が通信を握ると差し替えが効かない。SW 自体は static テストで構文だけ見る
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  },
  // v161：来場者の多くは iPhone（Safari）。WebKit（Safari と同じ仕組み）と、指で操作する Android も真似て回す。
  // 端末ごとに見る中身は来場者の画面（app.spec）と QR（scan.spec）。係員・印刷・サーバーは chromium だけ
  projects: [
    { name: 'chromium', use: {} },
    { name: 'iphone', use: { ...devices['iPhone 13'], serviceWorkers: 'block', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
      testMatch: /(app|scan)\.spec\.js$/ },
    { name: 'android', use: { ...devices['Pixel 7'], serviceWorkers: 'block', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
      testMatch: /(app|scan)\.spec\.js$/ },
  ],
  webServer: {
    command: `${process.platform === 'win32' ? 'python' : 'python3'} -m http.server ${PORT} --bind 127.0.0.1 --directory ..`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 20000,
  },
});
