// LIVE end-to-end against the TEST Apps Script deployment (writes real rows, then deletes them).
//   npx playwright test -c tests/playwright.server.config.js
// Every request the page makes to the production deployment is rewritten onto the TEST deployment, and its
// participant id P_… becomes TEST_E2E_<lang>_… so cleanup can find it. Any other deployment id is aborted.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const CFG_FILE = path.join(__dirname, 'server.config.json');
const deploymentId = (u) => (/\/macros\/s\/([^/]+)\//.exec(u || '') || [])[1];
const cfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : null;
const PROD_ID = deploymentId((/var SHEET_URL\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8')) || [])[1]);
const TEST_ID = cfg && deploymentId(cfg.testUrl);
// Question-sheet answer codes, in payload order (timestamp, pid, participant#, condition, interface duration excluded).
const ANSWER_KEYS = H.PAYLOAD_KEYS.slice(H.PAYLOAD_KEYS.indexOf('age'), H.PAYLOAD_KEYS.indexOf('detect4') + 1).filter((k) => k !== 'interfaceDuration');

async function getJson(params) {
  const r = await fetch(`${cfg.testUrl}?${new URLSearchParams(params)}`, { redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { throw new Error(`HTTP ${r.status}, not JSON: ${text.slice(0, 120)}`); }
}
const admin = async (action, extra = {}) => {
  const j = await getJson({ action, key: cfg.resetKey, ...extra });
  if (j.status === 'error') throw new Error(`${action}: ${j.message}`);
  return j;
};
// Greedy in-order match of the expected codes inside a sheet row → the matched values (or null if one is missing).
function matchCodes(row, want) {
  const got = [];
  let i = 0;
  for (const w of want) {
    while (i < row.length && String(row[i]) !== String(w)) i++;
    if (i >= row.length) return null;
    got.push(String(row[i++]));
  }
  return got;
}

test('live survey en/hi/mr writes one correct row each', async ({ browser }) => {
  test.skip(!cfg, `no ${CFG_FILE}`);
  expect(TEST_ID, 'testUrl must be a /macros/s/<id>/exec URL').toBeTruthy();
  expect(PROD_ID, 'SHEET_URL in index.html').toBeTruthy();
  expect(TEST_ID, 'REFUSING: testUrl is the production deployment').not.toBe(PROD_ID);
  const hello = await getJson({});
  expect(hello.version, 'TEST deployment version').toBe(cfg.expectedVersion);

  const before = await admin('status');
  const out = { startedAt: new Date().toISOString(), testDeploymentId: TEST_ID, before, runs: {} };
  try {
    for (const lang of H.LANGS) {
      const toTest = (pid) => String(pid).replace(/^P_/, `TEST_E2E_${lang}_`);
      const run = { pids: new Set(), aborted: [] };
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('**/macros/s/**', async (route) => {
        const req = route.request();
        const id = deploymentId(req.url());
        if (id === TEST_ID) return route.continue();
        if (id !== PROD_ID) { run.aborted.push(req.url()); return route.abort(); }
        const src = new URL(req.url()), target = new URL(cfg.testUrl);
        src.searchParams.forEach((v, k) => target.searchParams.set(k, k === 'pid' ? toTest(v) : v));
        if (target.searchParams.has('pid')) run.pids.add(target.searchParams.get('pid'));
        const opts = { url: target.href };
        if (req.method() === 'POST') {
          const body = JSON.parse(req.postData());
          body.participantId = toTest(body.participantId);
          run.pids.add(body.participantId);
          opts.postData = JSON.stringify(body);
        }
        return route.continue(opts);
      });
      const r = await H.walkSurvey(page, { lang, condition: null });
      await H.clickAct(page, 'submit');
      await page.waitForSelector('#screen-thankyou.active', { timeout: 60000 });
      await context.close();
      expect(run.aborted, `${lang}: requests to unknown deployments`).toEqual([]);
      expect(run.pids.size, `${lang}: one pid for assign + submit (${[...run.pids]})`).toBe(1);
      const want = H.expectedPayload(r, { lang, condition: r.condition });
      out.runs[lang] = { pid: [...run.pids][0], condition: r.condition, expectedCodes: ANSWER_KEYS.map((k) => want[k]) };
    }

    for (const lang of H.LANGS) {
      const run = out.runs[lang];
      const look = await admin('lookup', { pid: run.pid });
      const sheet = run.condition === 'Treatment' ? 'treatment' : 'control', other = sheet === 'control' ? 'treatment' : 'control';
      run.rows = look;
      expect.soft((look.question || []).length, `${lang}: question rows`).toBe(1);
      expect.soft((look[sheet] || []).length, `${lang}: ${sheet} rows`).toBe(1);
      expect.soft((look[other] || []).length, `${lang}: ${other} rows`).toBe(0);
      const q = (look.question || [])[0] || [];
      expect.soft(q.length, `${lang}: question row columns`).toBe(37);
      expect.soft(q[36], `${lang}: Language column`).toBe(lang);
      run.matchedCodes = matchCodes(q, run.expectedCodes);
      expect.soft(run.matchedCodes, `${lang}: answer codes in the question row`).toEqual(run.expectedCodes.map(String));
    }
    // Same answers in every language → identical rows apart from timestamp, pid, participant#, condition, duration, Language.
    const rows = H.LANGS.map((l) => ((out.runs[l].rows || {}).question || [])[0] || []);
    const differing = [];
    for (let c = 2; c < 36; c++) if (new Set(rows.map((row) => JSON.stringify(row[c]))).size > 1) differing.push({ col: c + 1, values: rows.map((row) => row[c]) });
    out.differingColumns = differing;
    expect.soft(differing.length, `columns differing across en/hi/mr (allowed: participant#, condition, interface duration): ${JSON.stringify(differing)}`).toBeLessThanOrEqual(3);
    expect.soft(differing.every((d) => d.values.every((v) => typeof v === 'number' || v === 'Control' || v === 'Treatment')), 'only numeric / condition columns may differ').toBe(true);
  } finally {
    out.cleanup = await admin('cleanup').catch((e) => ({ error: e.message }));
    out.reset = await admin('reset', { to: before.counter }).catch((e) => ({ error: e.message }));
    out.after = await admin('status').catch((e) => ({ error: e.message }));
    const left = [];
    for (const r of Object.values(out.runs)) {
      const look = await admin('lookup', { pid: r.pid }).catch(() => null);
      if (!look || ['question', 'control', 'treatment'].some((k) => (look[k] || []).length)) left.push(r.pid);
    }
    out.rowsLeftAfterCleanup = left;
    fs.mkdirSync(H.OUT, { recursive: true });
    fs.writeFileSync(path.join(H.OUT, 'live-e2e.json'), JSON.stringify(out, null, 2));
    console.log(`counter ${before.counter} → ${out.after.counter}; Config!B1 ${before.configB1} → ${out.after.configB1}; cleanup ${JSON.stringify(out.cleanup)}; TEST_E2E rows left: ${left.length}`);
  }
  expect(out.rowsLeftAfterCleanup, 'TEST_E2E rows remaining after cleanup').toEqual([]);
  expect(out.after.counter, 'counter restored').toBe(before.counter);
});
