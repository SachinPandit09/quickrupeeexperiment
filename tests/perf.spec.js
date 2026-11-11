// Load / interaction latency on Pixel 7 (Chromium) with CDP network + 4x CPU throttling.
// Run alone: npx playwright test -c tests --project=perf --workers=1   → test-results/perf.json
const fs = require('fs');
const path = require('path');
const { test, expect, devices } = require('@playwright/test');
const H = require('./helpers');
const cfg = require('./playwright.config.js');

const CPU_RATE = 4;
const PROFILES = {
  none: null,
  fast3g: { latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 }, // 1.44 Mbps down
  slow4g: { latency: 150, downloadThroughput: 204800, uploadThroughput: 93750 }, // 1.6 Mbps down
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const round = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

// Merge into test-results/perf.json so the tests below can run in any order.
function savePerf(patch) {
  const f = path.join(H.OUT, 'perf.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* first writer */ }
  fs.mkdirSync(H.OUT, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...cur, ...patch }, null, 2));
}

// New context per measurement = cold load (cache also disabled over CDP).
async function open(browser, profile, lang) {
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL: cfg.use.baseURL, proxy: cfg.use.proxy });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const net = { bytes: 0, requests: 0 };
  cdp.on('Network.requestWillBeSent', () => net.requests++);
  cdp.on('Network.loadingFinished', (e) => { net.bytes += e.encodedDataLength; });
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const p = PROFILES[profile] || { latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...p });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  await page.addInitScript((l) => {
    if (window.top !== window) return;
    if (l) sessionStorage.setItem('qr_lang', l);
    const m = (window.__perf = { lcp: null, lcpEl: null, cls: 0, shifts: [] });
    addEventListener('message', (e) => { if (e.data && e.data.type === 'quickrupee-resize' && m.firstResize == null) m.firstResize = performance.now(); });
    const desc = (n) => (n && n.nodeType === 1 ? `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${n.className ? '.' + String(n.className).split(' ').join('.') : ''}` : n ? '#text' : null);
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { m.lcp = e.renderTime || e.startTime; m.lcpEl = desc(e.element); } })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => { for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      m.cls += e.value;
      m.shifts.push({ t: Math.round(e.startTime), value: Math.round(e.value * 1000) / 1000, sources: (e.sources || []).map((x) => desc(x.node)) });
    } })
      .observe({ type: 'layout-shift', buffered: true });
  }, lang);
  return { context, page, net };
}

async function coldLoad(page, net) {
  await page.goto('index.html?', { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { ttfb: n.responseStart, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd,
      fcp: fcp ? fcp.startTime : null, lcp: window.__perf.lcp, lcpElement: window.__perf.lcpEl, cls: window.__perf.cls, layoutShifts: window.__perf.shifts, htmlLang: document.documentElement.lang };
  });
  return { ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])), transferBytes: net.bytes, requests: net.requests };
}

// Click "Continue to loan application" → #screen-interface.active, measured in-page.
async function timeToInterface(page) {
  await H.mockEndpoint(page, { condition: 'Control' });
  await H.pick(page, 'consent', 'yes');
  await H.clickAct(page, 'consent');
  await H.waitScreen(page, 'demographics');
  for (const q of ['q2', 'q3', 'q4', 'q5', 'q6', 'q7']) {
    const v = await page.$eval(`input[name="${q}"]`, (e) => e.value);
    await H.pick(page, q, v);
  }
  return page.evaluate(() => new Promise((res) => {
    const s = document.getElementById('screen-interface');
    const t0 = performance.now();
    new MutationObserver((_, o) => { if (s.classList.contains('active')) { o.disconnect(); res(Math.round(performance.now() - t0)); } })
      .observe(s, { attributes: true, attributeFilter: ['class'] });
    document.querySelector('#screen-demographics [data-act="toLoan"]').click();
  }));
}

test('perf', async ({ browser }) => {
  test.setTimeout(900000);
  const out = {
    device: 'Pixel 7 (Playwright descriptor), Chromium', cpuThrottle: `${CPU_RATE}x (Emulation.setCPUThrottlingRate)`,
    cache: 'disabled (Network.setCacheDisabled), new browser context per measurement',
    profiles: {
      none: 'no network throttling',
      fast3g: 'latency 562.5 ms, download 180000 B/s (1.44 Mbps), upload 84375 B/s (675 kbps)',
      slow4g: 'latency 150 ms, download 204800 B/s (1.6 Mbps), upload 93750 B/s (750 kbps)',
    },
    notes: 'Apps Script endpoint mocked via page.route (assign GET instant); every non-local, non-Google-Fonts host is sent to a dead proxy. Google Fonts are fetched live. Times in ms from navigationStart unless stated.',
    loads: {}, interfaceMs: {}, langSwitch: null, submit: null,
  };

  for (const profile of Object.keys(PROFILES)) {
    out.loads[profile] = {};
    for (const lang of H.LANGS) {
      const { context, page, net } = await open(browser, profile, lang);
      out.loads[profile][lang] = await coldLoad(page, net);
      if (lang === 'hi') out.interfaceMs[profile] = await timeToInterface(page);
      await context.close();
    }
  }

  // Language switch, no network throttle + 4x CPU: click → two animation frames.
  {
    const { context, page } = await open(browser, 'none', 'en');
    await page.goto('index.html?');
    const samples = [];
    for (const l of ['hi', 'mr', 'en', 'hi', 'mr', 'en']) {
      samples.push(await page.evaluate((l) => new Promise((res) => {
        const b = document.querySelector(`#langNav button[data-lang="${l}"]`);
        const t0 = performance.now();
        b.click();
        requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round((performance.now() - t0) * 10) / 10)));
      }), l));
    }
    out.langSwitch = { samples, medianMs: median(samples), method: 'performance.now() before btn.click() to after 2 requestAnimationFrame; en→hi→mr cycled twice' };
    await context.close();
  }

  // Submit round trip with the POST mock delayed 800 ms, no network throttle + 4x CPU.
  {
    const { context, page } = await open(browser, 'none', null);
    const log = await H.mockEndpoint(page, { condition: 'Control', delayMs: 800 });
    await H.walkSurvey(page, { lang: 'en', condition: 'Control' });
    const total = await page.evaluate(() => new Promise((res) => {
      const s = document.getElementById('screen-thankyou');
      const t0 = performance.now();
      new MutationObserver((_, o) => { if (s.classList.contains('active')) { o.disconnect(); res(Math.round(performance.now() - t0)); } })
        .observe(s, { attributes: true, attributeFilter: ['class'] });
      document.querySelector('#screen-detection [data-act="submit"]').click();
    }));
    out.submit = { totalMs: total, minusMockDelayMs: total - 800, mockDelayMs: 800, posts: log.posts.length };
    await context.close();
  }

  savePerf(out);
  console.log(JSON.stringify({ loads: out.loads, interfaceMs: out.interfaceMs, langSwitch: out.langSwitch.medianMs, submit: out.submit }, null, 1));

  for (const lang of H.LANGS) {
    expect.soft(out.loads.slow4g[lang].lcp, `LCP slow4g ${lang}`).toBeLessThanOrEqual(2500);
    for (const profile of Object.keys(PROFILES)) {
      expect.soft(out.loads[profile][lang].cls, `CLS ${profile} ${lang}`).toBeLessThanOrEqual(0.1);
      expect.soft(out.loads[profile][lang].htmlLang, `first paint language ${profile} ${lang}`).toBe(lang);
    }
  }
  expect.soft(out.langSwitch.medianMs, 'language switch median').toBeLessThanOrEqual(100);
  expect.soft(out.submit.posts, 'one POST on submit').toBe(1);
});

// The assign GET (slow Apps Script) now starts at Begin and the iframe preloads hidden, so the
// participant should not wait for either when they click Continue after reading the demographics page.
test('assign latency hidden', async ({ browser }) => {
  test.setTimeout(600000);
  const ASSIGN_DELAY = 3000;
  const READING_MS = 5000;
  const res = {
    assignDelayMs: ASSIGN_DELAY, lang: 'hi', cpuThrottle: `${CPU_RATE}x`,
    scenarios: {
      realistic: `after Begin, ${READING_MS / 1000} s idle on demographics (simulated reading time), then answer the 6 questions and click Continue`,
      fastClicker: 'after Begin, answer the 6 questions immediately and click Continue',
    },
    waitDefinition: 'Continue click → #screen-interface.active, measured in-page (performance.now + MutationObserver)',
    oldFlowDefinition: 'estimate of the previous flow (assign started at Continue): assign delay + iframe-ready time (iframe request start → first quickrupee-resize) measured in the realistic run; the old flow also added an 80 ms post-onload delay, not included',
    results: {}, oldFlowEstimateMs: {},
  };
  for (const profile of ['none', 'slow4g']) {
    res.results[profile] = {};
    for (const scenario of ['realistic', 'fastClicker']) {
      const { context, page } = await open(browser, profile, 'hi');
      const log = await H.mockEndpoint(page, { condition: 'Control', assignDelayMs: ASSIGN_DELAY });
      await page.goto('index.html?', { waitUntil: 'load', timeout: 120000 });
      await H.pick(page, 'consent', 'yes');
      await page.evaluate(() => { window.__perf.beginAt = performance.now(); document.querySelector('#screen-consent [data-act="consent"]').click(); });
      await H.waitScreen(page, 'demographics');
      if (scenario === 'realistic') await page.waitForTimeout(READING_MS);
      for (const q of ['q2', 'q3', 'q4', 'q5', 'q6', 'q7']) await H.pick(page, q, await page.$eval(`input[name="${q}"]`, (e) => e.value));
      const r = await page.evaluate(() => new Promise((resolve) => {
        const iface = document.getElementById('screen-interface'), load = document.getElementById('screen-loading');
        let loadingShown = false;
        const t0 = performance.now();
        const o = new MutationObserver(() => {
          if (load.classList.contains('active')) loadingShown = true;
          if (!iface.classList.contains('active')) return;
          o.disconnect();
          const m = window.__perf, fr = performance.getEntriesByType('resource').find((e) => /quickrupee_/.test(e.name));
          resolve({
            waitMs: Math.round(performance.now() - t0), loadingShown,
            beginToContinueMs: Math.round(t0 - m.beginAt),
            frameReadyMs: fr && m.firstResize != null ? Math.round(m.firstResize - fr.startTime) : null,
            frameRequestAfterBeginMs: fr ? Math.round(fr.startTime - m.beginAt) : null,
          });
        });
        o.observe(load, { attributes: true, attributeFilter: ['class'] });
        o.observe(iface, { attributes: true, attributeFilter: ['class'] });
        document.querySelector('#screen-demographics [data-act="toLoan"]').click();
      }));
      res.results[profile][scenario] = { ...r, assignRequests: log.assign };
      await context.close();
    }
    const fr = res.results[profile].realistic.frameReadyMs;
    res.oldFlowEstimateMs[profile] = fr == null ? null : ASSIGN_DELAY + fr;
  }
  savePerf({ assignHidden: res });
  console.log(JSON.stringify(res.results, null, 1), res.oldFlowEstimateMs);
  for (const profile of ['none', 'slow4g']) {
    expect.soft(res.results[profile].realistic.waitMs, `realistic wait ${profile}`).toBeLessThanOrEqual(500);
    for (const sc of ['realistic', 'fastClicker']) expect.soft(res.results[profile][sc].assignRequests, `one assign GET ${profile} ${sc}`).toBe(1);
  }
});
