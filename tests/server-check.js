// Load/duplicate checks against the TEST Apps Script deployment (v5.1). Plain Node ≥ 18, no deps.
//   node tests/server-check.js
// Reads tests/server.config.json: { "testUrl": "https://script.google.com/macros/s/<TEST_ID>/exec",
//   "spreadsheetId": "...", "resetKey": "...", "expectedVersion": "v5.1" }
// Writes test-results/server-check.json and test-results/SERVER-CHECK.md.
// It resets the counter while it runs and restores the original value at the end, so do not run it
// while real participants are using a deployment that shares this script's counter.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results');
const CFG_FILE = path.join(__dirname, 'server.config.json');
const ATTEMPT_DELAYS = [1000, 2000, 4000, 8000]; // same backoff as the survey page: 5 attempts in total

const deploymentId = (u) => (/\/macros\/s\/([^/]+)\//.exec(u || '') || [])[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };

function loadConfig() {
  if (!fs.existsSync(CFG_FILE)) throw new Error(`Missing ${CFG_FILE}. Shape: {"testUrl","spreadsheetId","resetKey","expectedVersion"}`);
  const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  for (const k of ['testUrl', 'resetKey', 'expectedVersion']) if (!cfg[k]) throw new Error(`server.config.json: "${k}" is required`);
  const prodUrl = /var SHEET_URL\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  const testId = deploymentId(cfg.testUrl), prodId = prodUrl && deploymentId(prodUrl[1]);
  if (!testId) throw new Error('testUrl is not an Apps Script /macros/s/<id>/exec URL');
  if (!prodId) throw new Error('Could not read SHEET_URL from index.html — refusing to run without the production id to compare against');
  if (testId === prodId) throw new Error('REFUSING: testUrl is the production deployment used by index.html');
  return cfg;
}

// One HTTP call → { ok, httpStatus, json, snippet, ms }. Apps Script answers via a 302 to googleusercontent; fetch follows it.
async function call(url, init) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'follow', ...init });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { ok: r.ok && !!json, httpStatus: r.status, json, snippet: text.slice(0, 160).replace(/\s+/g, ' '), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, httpStatus: null, json: null, snippet: String(e.cause || e).slice(0, 160), ms: Date.now() - t0 };
  }
}

function makeApi(cfg) {
  const q = (params) => `${cfg.testUrl}?${new URLSearchParams(params)}`;
  const admin = async (action, extra = {}) => {
    const r = await call(q({ action, key: cfg.resetKey, ...extra }));
    if (!r.ok || !r.json || r.json.status === 'error') throw new Error(`${action} failed: HTTP ${r.httpStatus} ${r.snippet}`);
    return r.json;
  };
  // Client-like assign: same pid, up to 5 attempts with 1/2/4/8 s backoff.
  const assign = async (pid) => {
    const t0 = Date.now(), attempts = [];
    for (let i = 0; ; i++) {
      const r = await call(q({ action: 'assign', pid }));
      const j = r.json;
      const good = r.ok && j && j.status === 'success' && (j.condition === 'Control' || j.condition === 'Treatment');
      attempts.push({ httpStatus: r.httpStatus, ms: r.ms, ok: good, snippet: good ? undefined : r.snippet });
      if (good) return { pid, ok: true, condition: j.condition, participantNumber: j.participantNumber, repeat: j.repeat, attempts, totalMs: Date.now() - t0 };
      if (i >= ATTEMPT_DELAYS.length) return { pid, ok: false, attempts, totalMs: Date.now() - t0 };
      await sleep(ATTEMPT_DELAYS[i]);
    }
  };
  const post = (payload) => call(cfg.testUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
  return { plain: () => call(cfg.testUrl), admin, assign, post };
}

// ---- C1: N concurrent first-time assigns after reset → numbers exactly 1..N, balanced conditions ----
async function loadRun(api, n, label) {
  await api.admin('reset', { to: 0 });
  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: n }, (_, i) => api.assign(`TEST_LT${n}_${label}_${i + 1}`)));
  const wallMs = Date.now() - t0;
  const status = await api.admin('status');
  const nums = res.filter((r) => r.ok).map((r) => r.participantNumber).sort((a, b) => a - b);
  const control = res.filter((r) => r.condition === 'Control').length, treatment = res.filter((r) => r.condition === 'Treatment').length;
  const firstFails = res.filter((r) => !r.attempts[0].ok).map((r) => ({ pid: r.pid, httpStatus: r.attempts[0].httpStatus, snippet: r.attempts[0].snippet }));
  const problems = [];
  if (res.some((r) => !r.ok)) problems.push(`${res.filter((r) => !r.ok).length} pids never assigned after 5 attempts`);
  if (JSON.stringify(nums) !== JSON.stringify(Array.from({ length: n }, (_, i) => i + 1))) problems.push(`numbers not exactly 1..${n}: ${nums.join(',')}`);
  if (Math.abs(control - treatment) > 1) problems.push(`imbalance Control ${control} / Treatment ${treatment}`);
  if (status.counter !== n) problems.push(`status.counter ${status.counter} !== ${n}`);
  const lat = res.map((r) => r.totalMs);
  return {
    n, label, pass: !problems.length, problems, control, treatment, counter: status.counter, configB1: status.configB1, wallMs,
    latencyMs: { p50: pct(lat, 50), p95: pct(lat, 95), max: Math.max(...lat) },
    firstAttemptFailures: firstFails.length, retriedRequests: res.filter((r) => r.attempts.length > 1).length,
    firstFailureSamples: firstFails.slice(0, 5),
  };
}

// ---- C2: repeated and concurrent assigns for the same pid ----
async function dupCheck(api, ts) {
  const problems = [];
  const a = `TEST_DUP_A_${ts}`, b = `TEST_DUP_B_${ts}`;
  const first = await api.assign(a);
  const c0 = (await api.admin('status')).counter;
  const again = await Promise.all([api.assign(a), api.assign(a)]);
  const c1 = (await api.admin('status')).counter;
  if (!first.ok) problems.push('first assign of A failed');
  for (const r of again) {
    if (r.condition !== first.condition || r.participantNumber !== first.participantNumber) problems.push(`A repeat got ${r.condition}/${r.participantNumber}, first was ${first.condition}/${first.participantNumber}`);
    if (r.repeat !== true) problems.push(`A repeat flag ${r.repeat}`);
  }
  if (c1 !== c0) problems.push(`counter moved on repeats: ${c0} → ${c1}`);
  const both = await Promise.all([api.assign(b), api.assign(b)]);
  const c2 = (await api.admin('status')).counter;
  if (!both.every((r) => r.ok)) problems.push('B assign failed');
  if (both[0].condition !== both[1].condition || both[0].participantNumber !== both[1].participantNumber) problems.push(`concurrent first-time B answers differ: ${both.map((r) => `${r.condition}/${r.participantNumber}`).join(' vs ')}`);
  if (c2 !== c1 + 1) problems.push(`counter after concurrent B: ${c1} → ${c2} (want +1)`);
  return { pass: !problems.length, problems, first: { condition: first.condition, participantNumber: first.participantNumber }, repeats: again.map((r) => ({ condition: r.condition, participantNumber: r.participantNumber, repeat: r.repeat })), concurrentFirst: both.map((r) => ({ condition: r.condition, participantNumber: r.participantNumber, repeat: r.repeat })), counters: [c0, c1, c2] };
}

// ---- C5: duplicate submissions write one row ----
function fullPayload(pid, a) {
  return {
    timestamp: '2026-01-01 10:00:00 IST', participantId: pid, participantNumber: a.participantNumber, condition: a.condition,
    age: '25–30 years', education: 'Other: Diploma in nursing', employment: 'Salaried-government sector', monthlyIncome: 'Rs 15000–30000',
    lendingExperience: 'Yes, I have applied but not complete the process', lendingAppsCount: '3–5',
    fl1Answer: '₹1,02,000', fl1Correct: 'Yes', fl2Answer: 'Less than today', fl2Correct: 'Yes', fl3Answer: 'More than ₹1,50,000', fl3Correct: 'Yes',
    fl4Answer: 'Buying shares in one company is less risky than a mutual fund', fl4Correct: 'No', fl5Answer: '₹6,000', fl5Correct: 'No',
    flScore: 3, interfaceDuration: 42,
    pressure1: '2', pressure2: '4', pressure3: '5', pressure4: '1', pressure5: '3', pressure6: '5',
    confidence1: '3', confidence2: '4', confidence3: '2', confidence4: '5', confidence5: '1',
    detect1: 'No', detect2: 'Maybe, but I am not certain', detect3: 'Yes, a higher amount was already selected', detect4: 'Somewhat difficult — I had to look for it',
    loanAmountRequested: 25000, overborrowingAmount: 5000, tenureSelected: 18, insuranceAdded: 'No', emiAmount: 1668, totalRepayment: 30524,
    decisionConfidence: '5', recallAPR: '24%', recallAPRCorrect: 'Correct', recallFee: '500', recallFeeCorrect: 'Correct', perceivedFairness: '1',
    language: 'en',
  };
}
async function submitCheck(api, ts) {
  const problems = [];
  const pid = `TEST_SUB_${ts}`;
  const a = await api.assign(pid);
  if (!a.ok) return { pass: false, problems: ['assign for submission pid failed'] };
  const payload = fullPayload(pid, a);
  const conc = await Promise.all([api.post(payload), api.post(payload)]);
  const later = await api.post(payload);
  const replies = [...conc, later].map((r) => ({ httpStatus: r.httpStatus, ok: r.ok, status: r.json && r.json.status, duplicate: r.json && r.json.duplicate, snippet: r.ok ? undefined : r.snippet }));
  if (!replies.every((r) => r.ok && r.status === 'success')) problems.push(`not all POSTs answered status:success — ${JSON.stringify(replies)}`);
  const dups = replies.filter((r) => r.duplicate === true).length;
  if (dups !== 2) problems.push(`expected 2 replies with duplicate:true, got ${dups}`);
  const look = await api.admin('lookup', { pid });
  const sheet = a.condition === 'Treatment' ? 'treatment' : 'control', other = sheet === 'control' ? 'treatment' : 'control';
  const n = (k) => (look[k] || []).length;
  if (n('question') !== 1) problems.push(`question rows: ${n('question')} (want 1)`);
  if (n(sheet) !== 1) problems.push(`${sheet} rows: ${n(sheet)} (want 1)`);
  if (n(other) !== 0) problems.push(`${other} rows: ${n(other)} (want 0)`);
  const q = (look.question || [])[0] || [];
  if (q.length && q.length !== 37) problems.push(`question row has ${q.length} columns (want 37)`);
  if (q.length && q[36] !== 'en') problems.push(`Language column = ${JSON.stringify(q[36])} (want "en")`);
  return { pass: !problems.length, problems, pid, condition: a.condition, replies, rows: { question: n('question'), control: n('control'), treatment: n('treatment') }, questionRow: q };
}

function markdown(res) {
  const L = ['# Apps Script server check', '', `Run ${res.startedAt} against deployment \`${res.testDeploymentId}\` (version ${res.version}).`, ''];
  if (res.fatal) L.push(`**Stopped:** ${res.fatal}`, '');
  if (res.before) L.push(`- Before: counter ${res.before.counter}, Config!B1 ${res.before.configB1}`);
  if (res.after) L.push(`- After restore: counter ${res.after.counter}, Config!B1 ${res.after.configB1}${res.after.counter === res.original && res.after.configB1 === res.original ? ' (restored)' : ' (**NOT restored — check manually**)'}`);
  if (res.cleanup) L.push(`- Cleanup deleted: ${JSON.stringify(res.cleanup.deleted)}`);
  L.push('');
  if (res.C1 && res.C1.length) {
    L.push('## C1 — concurrent assignment', '', '| N | Run | Result | Control/Treatment | Counter | p50 / p95 / max (ms) | 1st-attempt failures | Problems |', '|---|---|---|---|---|---|---|---|');
    for (const r of res.C1) L.push(`| ${r.n} | ${r.label} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.control}/${r.treatment} | ${r.counter} | ${r.latencyMs.p50} / ${r.latencyMs.p95} / ${r.latencyMs.max} | ${r.firstAttemptFailures} | ${r.problems.join('; ').replace(/\|/g, '/') || '—'} |`);
    L.push('', 'Google caps simultaneous executions (about 30 per account), so first-attempt failures at N=60 are expected; what matters is that client-style retries still yield exactly 1..N.', '');
  }
  for (const k of ['C2', 'C5']) if (res[k]) L.push(`## ${k} — ${k === 'C2' ? 'same pid twice / concurrently' : 'duplicate submissions'}: ${res[k].pass ? 'PASS' : 'FAIL'}`, '', ...(res[k].problems.length ? res[k].problems.map((p) => `- ${p}`) : ['- no problems']), '');
  return L.join('\n');
}

async function main() {
  const cfg = loadConfig();
  const api = makeApi(cfg);
  const run = Date.now().toString(36);
  const res = { startedAt: new Date().toISOString(), testDeploymentId: deploymentId(cfg.testUrl), spreadsheetId: cfg.spreadsheetId, C1: [] };
  const save = () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'server-check.json'), JSON.stringify(res, null, 2));
    fs.writeFileSync(path.join(OUT, 'SERVER-CHECK.md'), markdown(res));
  };
  const log = (name, r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} ${name}${r.problems && r.problems.length ? ' — ' + r.problems.join('; ') : ''}`);

  // (0) version gate — nothing else runs against an old deployment
  const hello = await api.plain();
  res.version = hello.json && hello.json.version;
  console.log(`Endpoint: HTTP ${hello.httpStatus}, version ${res.version}`);
  if (res.version !== cfg.expectedVersion) {
    console.log(`still old version (got ${res.version}, expected ${cfg.expectedVersion}) — redeploy the TEST web app and run again`);
    res.fatal = 'still old version';
    save();
    process.exit(1);
  }

  // (1) original state
  res.before = await api.admin('status');
  console.log(`Before: counter ${res.before.counter}, Config!B1 ${res.before.configB1}, assigned ${res.before.assignedRecords}, submitted ${res.before.submittedRecords}`);
  let failed = false;
  try {
    for (const n of [30, 60]) for (let i = 1; i <= 3; i++) {
      const r = await loadRun(api, n, `${run}r${i}`);
      res.C1.push(r);
      log(`C1 N=${n} run ${i} (p50 ${r.latencyMs.p50} ms, p95 ${r.latencyMs.p95} ms, max ${r.latencyMs.max} ms, 1st-attempt failures ${r.firstAttemptFailures})`, r);
      failed = failed || !r.pass;
    }
    res.C2 = await dupCheck(api, run);
    log('C2 duplicate assign', res.C2);
    res.C5 = await submitCheck(api, run);
    log('C5 duplicate submit', res.C5);
    failed = failed || !res.C2.pass || !res.C5.pass;
  } catch (e) {
    res.fatal = String(e.message || e);
    console.log(`ERROR: ${res.fatal}`);
    failed = true;
  } finally {
    // Always: delete TEST_ rows, restore the counter, show the final state.
    try { res.cleanup = await api.admin('cleanup'); } catch (e) { console.log(`cleanup FAILED: ${e.message}`); failed = true; }
    // Before the first assign the counter property does not exist yet and Config!B1 is the real value.
    res.original = res.before.counterStored ? res.before.counter : res.before.configB1;
    try { await api.admin('reset', { to: res.original }); } catch (e) { console.log(`counter restore FAILED: ${e.message}`); failed = true; }
    try { res.after = await api.admin('status'); } catch (e) { console.log(`final status FAILED: ${e.message}`); failed = true; }
    if (res.after) console.log(`After: counter ${res.after.counter}, Config!B1 ${res.after.configB1} (original ${res.original}); cleanup ${JSON.stringify(res.cleanup && res.cleanup.deleted)}`);
    save();
  }
  console.log(`\n${failed ? 'FAILED' : 'ALL PASSED'} — details in test-results/SERVER-CHECK.md`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message || e); process.exit(2); });
