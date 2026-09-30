// 画面のテスト。リポジトリ直下を python の簡易サーバーで配り、GAS の通信は tests/mock.js で差し替える
// （本番のスプレッドシートには一切届かない）
const { defineConfig } = require('@playwright/test');
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
  webServer: {
    command: `${process.platform === 'win32' ? 'python' : 'python3'} -m http.server ${PORT} --bind 127.0.0.1 --directory ..`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 20000,
  },
});
