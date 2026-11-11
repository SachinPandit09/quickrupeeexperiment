// LIVE run against the TEST Apps Script deployment — no dead proxy. Needs tests/server.config.json.
//   npx playwright test -c tests/playwright.server.config.js
// live-e2e.spec.js rewrites every request to the production deployment onto the TEST one and aborts any other deployment.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: /live-e2e\.spec\.js/,
  outputDir: '../test-results/.pw-live',
  timeout: 600000,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:8123/' },
  webServer: {
    command: 'python -m http.server 8123 --bind 127.0.0.1',
    cwd: '..',
    url: 'http://127.0.0.1:8123/index.html',
    reuseExistingServer: true,
  },
  projects: [{ name: 'live-chromium', use: { browserName: 'chromium' } }],
});
