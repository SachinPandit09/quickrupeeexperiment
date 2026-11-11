// Shared helpers for the Playwright suite: translations, endpoint mock, layout audit, survey walk-through.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results');
const LANGS = ['en', 'hi', 'mr'];

function readI18n(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return JSON.parse(/<script id="i18n" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
}
const I18N = {
  survey: readI18n('index.html'),
  control: readI18n('quickrupee_control.html'),
  treatment: readI18n('quickrupee_treatment.html'),
};
const tr = (lang, key, vars) => {
  let s = I18N.survey[lang][key];
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return s;
};

// Mock the Apps Script web app. Nothing is ever forwarded to Google.
// Assign replies follow the script `assign` (each GET takes the next entry; the last one repeats).
// Modes: 'ok' | 'html500' = 'http500' (500 text/html error page) | 'nonjson' (200 '<html>Error</html>') | 'statusError' | 'abort'.
// POST modes: same set ('fail' = 'abort'). Switch at runtime: log.mode.post = 'ok'; log.mode.assign = ['ok'].
// delayMs holds the POST, assignDelayMs holds the assignment GET.
const ACAO = { 'Access-Control-Allow-Origin': '*' };
function reply(route, mode, okBody) {
  switch (mode) {
    case 'ok': return route.fulfill({ status: 200, headers: { ...ACAO, 'Content-Type': 'application/json' }, body: JSON.stringify(okBody) });
    case 'html500': case 'http500': return route.fulfill({ status: 500, headers: { ...ACAO, 'Content-Type': 'text/html' }, body: '<!DOCTYPE html><html><body><h1>Error</h1><p>Server error, please try again later.</p></body></html>' });
    case 'nonjson': return route.fulfill({ status: 200, headers: { ...ACAO, 'Content-Type': 'text/html' }, body: '<html>Error</html>' });
    case 'statusError': return route.fulfill({ status: 200, headers: { ...ACAO, 'Content-Type': 'application/json' }, body: '{"status":"error","message":"mocked failure"}' });
    case 'abort': case 'fail': return route.abort('internetdisconnected');
    default: throw new Error(`unknown mock mode ${mode}`);
  }
}
async function mockEndpoint(page, { condition = 'Control', post = 'ok', assign = ['ok'], delayMs = 0, assignDelayMs = 0 } = {}) {
  const log = { assign: 0, assignPids: [], assignModes: [], posts: [], postModes: [], mode: { post, assign: [...assign] } };
  const seen = new Set();
  await page.route('**/script.google.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...ACAO, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' } });
    if (req.method() === 'GET') {
      log.assign++;
      log.assignPids.push(new URL(req.url()).searchParams.get('pid'));
      const mode = log.mode.assign.length > 1 ? log.mode.assign.shift() : log.mode.assign[0];
      log.assignModes.push(mode);
      if (assignDelayMs) await new Promise((r) => setTimeout(r, assignDelayMs));
      return reply(route, mode, { status: 'success', condition, participantNumber: 42, repeat: log.assign > 1, version: 'mock' });
    }
    const body = JSON.parse(req.postData());
    log.posts.push(body);
    const mode = log.mode.post;
    log.postModes.push(mode);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const duplicate = mode === 'ok' && seen.has(body.participantId);
    if (mode === 'ok') seen.add(body.participantId);
    return reply(route, mode, { status: 'success', duplicate, version: 'mock' });
  });
  return log;
}

// Collect console errors, page errors, failed requests, missing-translation warnings.
// Set w.allowEndpointFailures = true in tests that make the mocked endpoint fail on purpose.
function watchPage(page) {
  const w = { consoleErrors: [], pageErrors: [], failedRequests: [], missingKeys: [], expectedFailures: 0 };
  const endpoint = (u) => /script\.google\.com/.test(u) && w.allowEndpointFailures;
  page.on('console', (m) => {
    if (m.type() === 'error') w.consoleErrors.push(m.text());
    if (/Missing translation key/.test(m.text())) w.missingKeys.push(m.text());
  });
  page.on('pageerror', (e) => w.pageErrors.push(String(e)));
  page.on('requestfailed', (r) => {
    if (endpoint(r.url())) { w.expectedFailures++; return; }
    w.failedRequests.push(`${r.method()} ${r.url()} — ${r.failure() && r.failure().errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (endpoint(r.url())) { w.expectedFailures++; return; }
    w.failedRequests.push(`${r.status()} ${r.url()}`);
  });
  return w;
}

// Runs in the browser: horizontal overflow, elements outside the viewport, clipped text, tight Devanagari line-height.
function layoutAudit() {
  const de = document.documentElement, vw = de.clientWidth;
  const out = { scrollWidth: de.scrollWidth, clientWidth: vw, hOverflow: de.scrollWidth > vw + 1, outside: [], clipped: [], tight: [] };
  const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList].join('.') : ''} "${(el.textContent || '').trim().slice(0, 30)}"`;
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('.sr-only') || el.matches('script,style,iframe *')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    if (r.left < -1 || r.right > vw + 1) out.outside.push(`${desc(el)} [${Math.round(r.left)}..${Math.round(r.right)} of ${vw}]`);
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!ownText || cs.display === 'inline') continue;
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.clipped.push(`${desc(el)} (width ${el.scrollWidth}>${el.clientWidth})`);
    if (cs.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1) out.clipped.push(`${desc(el)} (height)`);
    const lh = parseFloat(cs.lineHeight), fsz = parseFloat(cs.fontSize);
    // 0.005 slack: WebKit lays out in 1/64 px, so line-height:1.3 computes to 1.2998.
    if (/[ऀ-ॿ]/.test(el.textContent) && lh && lh / fsz < 1.295) out.tight.push(`${desc(el)} lh=${(lh / fsz).toFixed(2)}`);
  }
  return out;
}

// Runs in the browser: geometry of every visible Likert item.
function likertGeometry() {
  return [...document.querySelectorAll('.screen.active .likert')].map((fs) => {
    const pts = [...fs.querySelectorAll('.pt')].map((l) => ({ v: l.querySelector('input').value, r: l.getBoundingClientRect() }));
    const [a1, a5] = [...fs.querySelectorAll('.anchors span')];
    const ra1 = a1.getBoundingClientRect(), ra5 = a5.getBoundingClientRect();
    const sameRow = pts.every((p) => Math.abs(p.r.top - pts[0].r.top) < 1);
    const ltr = pts.every((p, i) => i === 0 || p.r.left > pts[i - 1].r.left);
    return {
      id: fs.id,
      sig: `${pts.map((p) => p.v).join(',')}|${sameRow ? 'row' : 'NOT-ROW'}|${ltr ? 'ltr' : 'NOT-LTR'}|${ra1.left < ra5.left ? 'anchor1-left' : 'ANCHOR-ORDER'}|${a1.getAttribute('data-i18n')},${a5.getAttribute('data-i18n')}`,
      minW: Math.min(...pts.map((p) => p.r.width)),
      minH: Math.min(...pts.map((p) => p.r.height)),
    };
  });
}
const LIKERT_SIG = '1,2,3,4,5|row|ltr|anchor1-left|likert.1,likert.5';

// Runs in the browser: touch targets smaller than 44x44 on the survey page.
function smallTapTargets() {
  const sel = '.screen.active .option, .screen.active .pt, .screen.active .btn, .screen.active .other-field:not([hidden]), #langNav button';
  return [...document.querySelectorAll(sel)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width && (r.width < 44 || r.height < 44))
    .map(({ el, r }) => `${el.className} "${el.textContent.trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
}

async function fontStatus(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter((f) => /Noto Sans Devanagari/.test(f.family));
    // Only the Devanagari-range subset matters: Latin text uses system fonts, so Noto's Latin faces stay 'unloaded'.
    const deva = faces.filter((f) => /U\+0?9[0-7][0-9A-F]?/i.test(f.unicodeRange));
    const devaLoaded = deva.filter((f) => f.status === 'loaded').length;
    return {
      loaded: faces.filter((f) => f.status === 'loaded').length,
      devanagariLoaded: devaLoaded,
      errored: faces.filter((f) => f.status === 'error').length,
      // No space in the sample: U+0020 maps to the (unneeded, unloaded) Latin face and would make check() false.
      devanagariOk: devaLoaded > 0 && document.fonts.check('16px "Noto Sans Devanagari"', 'हिन्दीमराठी'),
    };
  });
}

async function activeScreen(page) {
  return page.evaluate(() => document.querySelector('.screen.active').id.replace('screen-', ''));
}
async function waitScreen(page, id) {
  await page.waitForSelector(`#screen-${id}.active`, { timeout: 30000 });
}
async function clickAct(page, act) {
  await page.locator(`#screen-${await activeScreen(page)} [data-act="${act}"]`).click();
}
async function pick(page, name, value) {
  // Click the visible label, like a person would.
  await page.locator(`input[name="${name}"][value="${value}"]`).locator('xpath=ancestor::label[1]').click();
}
async function errorTexts(page) {
  return page.$$eval('.screen.active .error-msg:not([hidden])', (els) => els.map((e) => e.textContent));
}

// ---- Survey walk-through shared by matrix, failure and perf tests ----
const { expect } = require('@playwright/test');

const PAYLOAD_KEYS = ['timestamp', 'participantId', 'participantNumber', 'condition', 'age', 'education', 'employment',
  'monthlyIncome', 'lendingExperience', 'lendingAppsCount', 'fl1Answer', 'fl1Correct', 'fl2Answer', 'fl2Correct',
  'fl3Answer', 'fl3Correct', 'fl4Answer', 'fl4Correct', 'fl5Answer', 'fl5Correct', 'flScore', 'interfaceDuration',
  'pressure1', 'pressure2', 'pressure3', 'pressure4', 'pressure5', 'pressure6',
  'confidence1', 'confidence2', 'confidence3', 'confidence4', 'confidence5', 'detect1', 'detect2', 'detect3', 'detect4',
  'loanAmountRequested', 'overborrowingAmount', 'tenureSelected', 'insuranceAdded', 'emiAmount', 'totalRepayment',
  'decisionConfidence', 'recallAPR', 'recallAPRCorrect', 'recallFee', 'recallFeeCorrect', 'perceivedFairness', 'language'];
const FL_CORRECT = { q8: '₹1,02,000', q9: 'Less than today', q10: 'More than ₹1,50,000', q11: 'A mutual fund is less risky than buying shares in one company', q12: '₹5,000' };
const APR_TYPED = { en: '24%', hi: '२४%', mr: '24 टक्के' };
const PRESSURE = { p1: '2', p2: '4', p3: '5', p4: '1', p5: '3', p6: '5' };
const CONFIDENCE = { d1: '3', d2: '4', d3: '2', d4: '5', d5: '1' };
const calcEMI = (p, m) => { const r = 0.24 / 12; return Math.round(p * r * Math.pow(1 + r, m) / (Math.pow(1 + r, m) - 1)); };

async function pollUntil(fn, want, timeout = 5000) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) { v = await fn(); if (v === want) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
const setLang = (page, l) => page.locator(`#langNav button[data-lang="${l}"]`).click();
const radioValues = (page, name) => page.$$eval(`input[name="${name}"]`, (els) => els.map((e) => e.value));
const shownErrors = (page) => page.$$eval('.screen.active .error-msg:not([hidden])', (els) => els.map((e) => [e.id.replace('err-', ''), e.textContent]));

// Walks consent → detection (answers filled, Submit NOT clicked). condition = null: take it from the iframe (live runs). Records validation/lang-switch results in `r`.
// `audit(screen, frame?)` is called at the moments worth auditing/screenshotting; pass null to skip.
async function walkSurvey(page, { lang, condition, touch = false, audit = null }) {
  const other = LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length];
  const hook = async (s, frame) => { if (audit) await audit(s, frame); };
  const r = { other, choices: {}, validation: {}, langSwitch: {}, likert: {} };
  const soft = (key, ok, msg) => { r.validation[key] = ok; expect.soft(ok, msg).toBe(true); };

  await page.goto('index.html');
  if (lang !== 'en') await setLang(page, lang);
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page.locator(`#langNav button[data-lang="${lang}"]`)).toHaveAttribute('aria-pressed', 'true');

  // Consent
  await waitScreen(page, 'consent');
  await clickAct(page, 'consent');
  const ce = await errorTexts(page);
  soft('consent', ce.length === 1 && ce[0] === tr(lang, 'err.consent'), `consent error: ${JSON.stringify(ce)}`);
  await hook('consent');
  await pick(page, 'consent', 'yes');
  await clickAct(page, 'consent');

  // Demographics
  await waitScreen(page, 'demographics');
  await clickAct(page, 'toLoan');
  const de = await errorTexts(page);
  soft('demoRequired', de.length === 6 && de.every((t) => t === tr(lang, 'err.required')), `demographics errors: ${JSON.stringify(de)}`);
  await pick(page, 'q3', 'other');
  await clickAct(page, 'toLoan');
  const q3e = await page.locator('#err-q3').textContent();
  soft('demoOther', q3e === tr(lang, 'err.other') && (await page.locator('#err-q3').isVisible()), `q3 other error: ${q3e}`);
  await hook('demographics');
  r.choices.q3 = 'Other: Diploma in nursing';
  await page.locator('#q3-other').fill('Diploma in nursing');
  for (const q of ['q2', 'q4', 'q5', 'q6', 'q7']) {
    const v = (await radioValues(page, q)).filter((x) => x !== 'other')[1];
    r.choices[q] = v;
    await pick(page, q, v);
  }
  await clickAct(page, 'toLoan');

  // Loan interface (iframe)
  await waitScreen(page, 'interface');
  const frame = page.frame({ url: /quickrupee_/ });
  if (!condition) condition = /quickrupee_treatment/.test(frame.url()) ? 'Treatment' : 'Control'; // live runs: server decides
  r.condition = condition;
  const file = condition === 'Treatment' ? 'treatment' : 'control';
  soft('frameCondition', frame.url().includes(`quickrupee_${file}.html`), `iframe url ${frame.url()}`);
  await frame.locator('#loanSlider').waitFor();
  const fLang = () => frame.evaluate(() => document.documentElement.lang);
  const fCta = () => frame.locator('.cta-btn').textContent();
  r.langSwitch.frameInitial = await pollUntil(fLang, lang);
  await setLang(page, other);
  r.langSwitch.frameToOther = (await pollUntil(fLang, other)) && (await pollUntil(fCta, I18N[file][other].cta));
  await setLang(page, lang);
  r.langSwitch.frameBack = (await pollUntil(fLang, lang)) && (await pollUntil(fCta, I18N[file][lang].cta));
  expect.soft(r.langSwitch, 'iframe follows language switch').toEqual({ frameInitial: true, frameToOther: true, frameBack: true });
  await hook('interface', frame);

  await frame.locator('#loanSlider').fill('25000');
  await frame.locator('.tenure-opt[data-months="18"]').click();
  if (condition === 'Treatment') await frame.locator('#noInsurance').check();
  await frame.locator('.cta-btn').click();
  await frame.locator('#confirmScreen .submit-btn').first().click();
  const finish = frame.locator('#submittedScreen .submit-btn');
  await finish.click();
  const recallErr = frame.locator('#recallErr');
  const recallOk = (await recallErr.isVisible()) && (await recallErr.textContent()) === I18N[file][lang]['err.recall'];
  soft('recallErr', recallOk, `recall error: visible=${await recallErr.isVisible()} text=${await recallErr.textContent()}`);
  await hook('interface-recall', frame);
  await frame.locator('#recall-apr').fill(APR_TYPED[lang]);
  await frame.locator('#recall-fee').fill('500');
  await finish.click();

  // Financial literacy: q8–q10 right, q11–q12 wrong → flScore 3
  await waitScreen(page, 'financial');
  for (const [i, q] of Object.keys(FL_CORRECT).entries()) {
    const v = i < 3 ? FL_CORRECT[q] : (await radioValues(page, q)).find((x) => x !== FL_CORRECT[q]);
    r.choices[q] = v;
    await pick(page, q, v);
  }
  await hook('financial');
  await clickAct(page, 'toPressure');

  // Pressure (Likert)
  await waitScreen(page, 'pressure');
  for (const q of ['p1', 'p2', 'p3']) await pick(page, q, PRESSURE[q]);
  r.likert.pressure = await page.evaluate(likertGeometry);
  for (const g of r.likert.pressure) {
    expect.soft(g.sig, `${g.id} orientation`).toBe(LIKERT_SIG);
    if (touch) expect.soft(Math.min(g.minW, g.minH), `${g.id} Likert point size ${g.minW}x${g.minH}`).toBeGreaterThanOrEqual(44);
  }
  await setLang(page, other);
  let keep = true;
  for (const q of ['p1', 'p2', 'p3']) {
    const v = await page.locator(`input[name="${q}"]:checked`).getAttribute('value').catch(() => null);
    const picked = await page.locator(`#picked-${q}`).textContent();
    keep = keep && v === PRESSURE[q] && picked === tr(other, 'likert.picked', { label: tr(other, `likert.${v}`), n: v });
  }
  r.langSwitch.likertKept = keep;
  expect.soft(keep, 'Likert answers + "your answer" text survive language switch').toBe(true);
  await clickAct(page, 'toConfidence');
  const want = (l) => JSON.stringify(['p4', 'p5', 'p6'].map((q) => [q, tr(l, 'err.required')]));
  const e1 = JSON.stringify(await shownErrors(page));
  await setLang(page, lang);
  const e2 = JSON.stringify(await shownErrors(page));
  soft('pressureErrOther', e1 === want(other), `pressure errors in ${other}: ${e1}`);
  soft('pressureErrBack', e2 === want(lang), `pressure errors back in ${lang}: ${e2}`);
  for (const q of ['p4', 'p5', 'p6']) await pick(page, q, PRESSURE[q]);
  await hook('pressure');
  await clickAct(page, 'toConfidence');

  // Confidence (Likert)
  await waitScreen(page, 'confidence');
  for (const q of Object.keys(CONFIDENCE)) await pick(page, q, CONFIDENCE[q]);
  r.likert.confidence = await page.evaluate(likertGeometry);
  for (const g of r.likert.confidence) expect.soft(g.sig, `${g.id} orientation`).toBe(LIKERT_SIG);
  await hook('confidence');
  await clickAct(page, 'toDetection');

  // Detection
  await waitScreen(page, 'detection');
  for (const [i, q] of ['x1', 'x2', 'x3', 'x4'].entries()) {
    const v = (await radioValues(page, q))[[1, 2, 0, 3][i]];
    r.choices[q] = v;
    await pick(page, q, v);
  }
  await hook('detection');
  return r;
}

// The row the page should send for a walkSurvey() run.
function expectedPayload(r, { lang, condition }) {
  const emi = calcEMI(25000, 18);
  const c = r.choices, fl = {};
  Object.keys(FL_CORRECT).forEach((q, i) => {
    fl[`fl${i + 1}Answer`] = c[q];
    fl[`fl${i + 1}Correct`] = c[q] === FL_CORRECT[q] ? 'Yes' : 'No';
  });
  return {
    participantNumber: 42, condition,
    age: c.q2, education: c.q3, employment: c.q4, monthlyIncome: c.q5, lendingExperience: c.q6, lendingAppsCount: c.q7,
    ...fl, flScore: 3,
    ...Object.fromEntries(Object.entries(PRESSURE).map(([k, v]) => [`pressure${k[1]}`, v])),
    ...Object.fromEntries(Object.entries(CONFIDENCE).map(([k, v]) => [`confidence${k[1]}`, v])),
    detect1: c.x1, detect2: c.x2, detect3: c.x3, detect4: c.x4,
    loanAmountRequested: 25000, overborrowingAmount: 5000, tenureSelected: 18, insuranceAdded: 'No',
    emiAmount: emi, totalRepayment: emi * 18 + 500, decisionConfidence: '5',
    recallAPR: APR_TYPED[lang], recallAPRCorrect: 'Correct', recallFee: '500', recallFeeCorrect: 'Correct',
    perceivedFairness: '1', language: lang,
  };
}

module.exports = {
  ROOT, OUT, LANGS, I18N, tr, LIKERT_SIG, PAYLOAD_KEYS, FL_CORRECT,
  mockEndpoint, watchPage, layoutAudit, likertGeometry, smallTapTargets, fontStatus,
  activeScreen, waitScreen, clickAct, pick, errorTexts, setLang, walkSurvey, expectedPayload,
};
