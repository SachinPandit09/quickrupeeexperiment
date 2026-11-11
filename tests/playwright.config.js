// Run from the repo root:  npx playwright test -c tests
const { defineConfig, devices } = require('@playwright/test');

const DEVICES = {
  'iphone-se-320': devices['iPhone SE'],
  'iphone-se-375': devices['iPhone SE (3rd gen)'],
  'iphone-14': devices['iPhone 14'],
  'iphone-15': devices['iPhone 15'],
  'pixel-7': devices['Pixel 7'],
  'android-360': devices['Galaxy S8'],
  'ipad-mini-portrait': devices['iPad Mini'],
  'ipad-mini-landscape': devices['iPad Mini landscape'],
  'ipad-pro-portrait': devices['iPad Pro 11'],
  'ipad-pro-landscape': devices['iPad Pro 11 landscape'],
  'laptop-1366': { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
  'laptop-1440': { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  'laptop-1920': { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
};

module.exports = defineConfig({
  testDir: '.',
  outputDir: '../test-results/.pw',
  timeout: 180000,
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8123/',
    // Safety net: every host except localhost and Google Fonts goes to a dead proxy, so even a request
    // that slipped past page.route() could never reach the real Apps Script endpoint.
    proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost,fonts.googleapis.com,fonts.gstatic.com' },
  },
  webServer: {
    command: 'python -m http.server 8123 --bind 127.0.0.1',
    cwd: '..',
    url: 'http://127.0.0.1:8123/index.html',
    reuseExistingServer: true,
  },
  projects: [
    ...Object.entries(DEVICES).map(([name, use]) => ({ name, use, testMatch: /matrix\.spec\.js/ })),
    { name: 'perf', use: { ...devices['Pixel 7'] }, testMatch: /perf\.spec\.js/ },
    { name: 'i18n', testMatch: /i18n\.spec\.js/ },
  ],
});
