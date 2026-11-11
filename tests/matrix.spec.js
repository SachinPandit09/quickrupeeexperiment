// Full participant journey on every device × language. Run: npx playwright test -c tests
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const H = require('./helpers');
const { LANGS, OUT, tr } = H;

const DEVICES = require('./playwright.config.js').projects.map((p) => p.name).filter((n) => n !== 'perf' && n !== 'i18n');
const SHOTS = path.join(OUT, 'screenshots');
const DATA = path.join(OUT, 'data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

const firstLine = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) || '';
const EXTRA_SHOTS = ['consent', 'demographics', 'interface', 'detection', 'thankyou'];

for (const [li, lang] of LANGS.entries()) {
  test.describe(`lang ${lang}`, () => {
    test('journey', async ({ page, browserName }, testInfo) => {
      const device = testInfo.project.name;
      const condition = (DEVICES.indexOf(device) + li) % 2 ? 'Treatment' : 'Control';
      const touch = !!testInfo.project.use.hasTouch;
      const rec = { device, lang, condition, browser: browserName, viewport: page.viewportSize(), touch, audits: {}, tapTargets: {} };
      const log = await H.mockEndpoint(page, { condition });
      const w = H.watchPage(page);

      const audit = async (screen, frame) => {
        const pick = ({ scrollWidth, clientWidth, hOverflow, outside, clipped, tight }) => ({ scrollWidth, clientWidth, hOverflow, outside, clipped, tight });
        const runs = { [screen]: await page.evaluate(H.layoutAudit) };
        if (frame) runs[`${screen}:iframe`] = await frame.evaluate(H.layoutAudit);
        for (const [k, a] of Object.entries(runs)) {
          rec.audits[k] = pick(a);
          expect.soft(a.hOverflow, `${k}: horizontal overflow ${a.scrollWidth}>${a.clientWidth}`).toBe(false);
          expect.soft(a.outside, `${k}: elements outside viewport`).toEqual([]);
          expect.soft(a.clipped, `${k}: clipped text`).toEqual([]);
          expect.soft(a.tight, `${k}: tight Devanagari line-height`).toEqual([]);
        }
        if (touch && !screen.includes('-')) {
          rec.tapTargets[screen] = await page.evaluate(H.smallTapTargets);
          expect.soft(rec.tapTargets[screen], `${screen}: tap targets < 44px`).toEqual([]);
        }
        if (screen === 'pressure') await page.screenshot({ path: path.join(SHOTS, `${device}-${lang}.png`), fullPage: true });
        else if (EXTRA_SHOTS.includes(screen)) await page.screenshot({ path: path.join(SHOTS, `${device}-${lang}-${screen}.jpg`), type: 'jpeg', quality: 70, fullPage: true });
      };

      try {
        const r = await H.walkSurvey(page, { lang, condition, touch, audit });
        Object.assign(rec, { choices: r.choices, validation: r.validation, langSwitch: r.langSwitch, likert: r.likert });
        rec.likertSigs = [...r.likert.pressure, ...r.likert.confidence].map((g) => g.sig);

        await H.clickAct(page, 'submit');
        await H.waitScreen(page, 'thankyou');
        await expect.soft(page.locator('#screen-thankyou h1')).toHaveText(tr(lang, 'ty.title'));
        await audit('thankyou');

        rec.assignRequests = log.assign;
        expect.soft(log.assign, 'exactly one assign GET').toBe(1);
        expect.soft(log.posts.length, 'exactly one POST').toBe(1);
        const p = log.posts[0] || {};
        rec.assignPid = log.assignPids[0];
        expect.soft(log.assignPids[0], 'assign pid === submitted participantId').toBe(p.participantId);
        rec.payload = p;
        const want = H.expectedPayload(r, { lang, condition });
        const keysOk = JSON.stringify(Object.keys(p)) === JSON.stringify(H.PAYLOAD_KEYS);
        const mismatches = Object.keys(want).filter((k) => p[k] !== want[k]).map((k) => `${k}: got ${JSON.stringify(p[k])}, want ${JSON.stringify(want[k])}`);
        const shapeOk = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d IST$/.test(p.timestamp) && /^P_\d+_\w+$/.test(p.participantId) && Number.isInteger(p.interfaceDuration);
        expect.soft(Object.keys(p), 'payload keys in order').toEqual(H.PAYLOAD_KEYS);
        expect.soft(mismatches, 'payload values').toEqual([]);
        expect.soft(shapeOk, `timestamp/participantId/interfaceDuration shape: ${p.timestamp} ${p.participantId} ${p.interfaceDuration}`).toBe(true);
        rec.payloadOk = keysOk && !mismatches.length && shapeOk && log.posts.length === 1;
        rec.payloadMismatches = mismatches;

        rec.fonts = await H.fontStatus(page);
        expect.soft(rec.fonts.errored, 'font faces errored').toBe(0);
        expect.soft(rec.fonts.devanagariOk, 'Devanagari webfont available').toBe(true);
      } catch (e) {
        rec.aborted = firstLine(e.message);
        throw e;
      } finally {
        Object.assign(rec, { consoleErrors: w.consoleErrors, pageErrors: w.pageErrors, failedRequests: w.failedRequests, missingKeys: w.missingKeys });
        if (!rec.aborted) {
          expect.soft(w.consoleErrors, 'console errors').toEqual([]);
          expect.soft(w.pageErrors, 'page errors').toEqual([]);
          expect.soft(w.failedRequests, 'failed requests').toEqual([]);
          expect.soft(w.missingKeys, 'missing translation keys').toEqual([]);
        }
        rec.softErrors = testInfo.errors.map((e) => firstLine(e.message));
        rec.passed = !rec.aborted && rec.softErrors.length === 0;
        fs.writeFileSync(path.join(DATA, `${device}-${lang}.json`), JSON.stringify(rec, null, 2));
      }
    });

    // Every kind of submit failure → failed screen; retry re-sends the identical row.
    test('submit failures', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'pixel-7', 'runs once, on pixel-7');
      test.setTimeout(120000);
      const condition = li % 2 ? 'Treatment' : 'Control';
      const MODES = ['http500', 'nonjson', 'abort', 'statusError'];
      const log = await H.mockEndpoint(page, { condition, post: MODES[0] });
      const w = H.watchPage(page);
      w.allowEndpointFailures = true;

      await H.walkSurvey(page, { lang, condition });
      for (const [i, mode] of MODES.entries()) {
        log.mode.post = mode;
        await H.clickAct(page, i === 0 ? 'submit' : 'retry');
        await H.waitScreen(page, 'failed');
        await expect(page.locator('#screen-failed h1'), `after ${mode}`).toHaveText(tr(lang, 'fail.title'));
        await expect(page.locator('#screen-failed [data-act="retry"]')).toHaveText(tr(lang, 'btn.retry'));
      }
      log.mode.post = 'ok';
      await H.clickAct(page, 'retry');
      await H.waitScreen(page, 'thankyou');
      await expect(page.locator('#screen-thankyou h1')).toHaveText(tr(lang, 'ty.title'));

      expect(log.postModes).toEqual([...MODES, 'ok']);
      for (const p of log.posts) expect(p).toEqual(log.posts[0]);
      expect(log.posts[0].participantId).toBe(log.assignPids[0]);
      expect(log.posts[0].language).toBe(lang);
      // Failed loads of the mocked endpoint are logged by the browser; anything else is a real problem.
      expect(w.consoleErrors.filter((m) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|script\.google\.com/.test(m))).toEqual([]);
      expect(w.pageErrors).toEqual([]);
      expect(w.failedRequests).toEqual([]);
      expect(log.assign, 'retry must not re-assign').toBe(1);
    });

    // Assign fails twice (HTML 500, then non-JSON) → automatic retries with the same pid succeed.
    test('assign retries until valid JSON', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'pixel-7', 'runs once, on pixel-7');
      test.setTimeout(60000);
      const condition = li % 2 ? 'Control' : 'Treatment';
      const log = await H.mockEndpoint(page, { condition, assign: ['html500', 'nonjson', 'ok'] });
      const w = H.watchPage(page);
      w.allowEndpointFailures = true;
      await beginAndFillDemographics(page, lang);
      await H.clickAct(page, 'toLoan');
      await H.waitScreen(page, 'interface');
      expect(log.assignModes).toEqual(['html500', 'nonjson', 'ok']);
      expect(new Set(log.assignPids).size, `pids ${log.assignPids}`).toBe(1);
      expect(log.assignPids[0]).toMatch(/^P_\d+_[a-z0-9]{1,4}$/);
      expect(page.frame({ url: new RegExp(`quickrupee_${condition.toLowerCase()}\.html`) }), 'iframe shows the mocked condition').toBeTruthy();
      expect(w.pageErrors).toEqual([]);
    });

    // Assign never succeeds → 5 attempts then stop, slow message + retry, never a random condition.
    test('assign keeps failing: no random fallback, retry recovers', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'pixel-7', 'runs once, on pixel-7');
      test.setTimeout(90000);
      const condition = li % 2 ? 'Treatment' : 'Control';
      const log = await H.mockEndpoint(page, { condition, assign: ['html500'] });
      const w = H.watchPage(page);
      w.allowEndpointFailures = true;
      const frameSrc = () => page.locator('#loanFrame').getAttribute('src');
      await beginAndFillDemographics(page, lang);
      await H.clickAct(page, 'toLoan');
      await H.waitScreen(page, 'loading');
      await expect(page.locator('#loadingSlow')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('#loadingSlow')).toHaveText(tr(lang, 'loading.slow'));
      const retry = page.locator('#screen-loading [data-act="retryFrame"]');
      await expect(retry).toBeVisible();
      await expect(retry).toHaveText(tr(lang, 'btn.retry'));
      // Attempts at ~0, 1, 3, 7, 15 s after Begin, then nothing until the participant retries.
      await expect.poll(() => log.assign, { timeout: 25000 }).toBe(5);
      await page.waitForTimeout(4000);
      expect(log.assign, 'stops after 5 attempts').toBe(5);
      expect(await frameSrc(), 'no iframe without a server-assigned condition').toBeFalsy();
      expect(page.frame({ url: /quickrupee_/ })).toBeNull();
      expect(await H.activeScreen(page)).toBe('loading');

      log.mode.assign = ['ok'];
      await retry.click();
      await H.waitScreen(page, 'interface');
      expect(log.assign).toBe(6);
      expect(new Set(log.assignPids).size, `pids ${log.assignPids}`).toBe(1);
      expect(await frameSrc()).toContain(`quickrupee_${condition.toLowerCase()}.html`);
      expect(w.pageErrors).toEqual([]);
    });

    // ---- Assignment starts at consent (pixel-7 only) ----
    test('consent=no makes no assign request', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'pixel-7', 'runs once, on pixel-7');
      const log = await H.mockEndpoint(page);
      await page.goto('index.html');
      if (lang !== 'en') await H.setLang(page, lang);
      await H.pick(page, 'consent', 'no');
      await H.clickAct(page, 'consent');
      await H.waitScreen(page, 'declined');
      await expect(page.locator('#screen-declined h1')).toHaveText(tr(lang, 'declined.title'));
      await page.waitForTimeout(1000);
      expect(log.assign).toBe(0);
    });

    test('treatment countdown starts at reveal', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'pixel-7', 'runs once, on pixel-7');
      const log = await H.mockEndpoint(page, { condition: 'Treatment' });
      await beginAndFillDemographics(page, lang);
      await page.waitForTimeout(5000); // iframe preloads (hidden) meanwhile
      await H.clickAct(page, 'toLoan');
      await H.waitScreen(page, 'interface');
      const cd = page.frame({ url: /quickrupee_treatment/ }).locator('#countdown');
      const first = await cd.textContent();
      expect(['09:47', '09:46'], `countdown at reveal was ${first}`).toContain(first);
      await page.waitForTimeout(3000);
      const later = await cd.textContent();
      const secs = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
      expect(secs(later), `countdown ${first} → ${later} after 3 s`).toBeLessThanOrEqual(secs(first) - 2);
      expect(log.assign).toBe(1);
    });

    test('slow iframe shows retry, retry keeps condition', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'pixel-7', 'runs once, on pixel-7');
      test.setTimeout(60000);
      const log = await H.mockEndpoint(page, { condition: 'Treatment' });
      const frameUrls = [];
      let aborted = false;
      await page.route('**/quickrupee_*.html*', (route) => {
        frameUrls.push(route.request().url());
        if (!aborted) { aborted = true; return route.abort('connectionreset'); }
        return route.continue();
      });
      await beginAndFillDemographics(page, lang);
      await H.clickAct(page, 'toLoan');
      await H.waitScreen(page, 'loading');
      await expect(page.locator('#screen-loading [data-i18n="loading"]')).toHaveText(tr(lang, 'loading'));
      await expect(page.locator('#loadingSlow')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('#loadingSlow')).toHaveText(tr(lang, 'loading.slow'));
      const retry = page.locator('#screen-loading [data-act="retryFrame"]');
      await expect(retry).toBeVisible();
      await expect(retry).toHaveText(tr(lang, 'btn.retry'));
      await retry.click();
      await H.waitScreen(page, 'interface');
      expect(frameUrls.length).toBe(2);
      expect(frameUrls.every((u) => /quickrupee_treatment\.html\?embedded=true&lang=/.test(u)), frameUrls.join(' ')).toBe(true);
      expect(page.frame({ url: /quickrupee_treatment/ })).toBeTruthy();
      expect(log.assign).toBe(1);
    });
  });
}

// Consent yes → Begin → answer demographics (Continue NOT clicked).
async function beginAndFillDemographics(page, lang) {
  await page.goto('index.html');
  if (lang !== 'en') await H.setLang(page, lang);
  await H.pick(page, 'consent', 'yes');
  await H.clickAct(page, 'consent');
  await H.waitScreen(page, 'demographics');
  for (const q of ['q2', 'q3', 'q4', 'q5', 'q6', 'q7']) await H.pick(page, q, await page.$eval(`input[name="${q}"]`, (e) => e.value));
}
