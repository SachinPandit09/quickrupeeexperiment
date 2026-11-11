// Builds test-results/REPORT.md from test-results/data/*.json and test-results/perf.json.
// Run after the suite: node tests/make-report.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'test-results');
const DATA = path.join(OUT, 'data');
const LANGS = ['en', 'hi', 'mr'];
const LIKERT_SIG = '1,2,3,4,5|row|ltr|anchor1-left|likert.1,likert.5';
const DEVICES = ['iphone-se-320', 'iphone-se-375', 'iphone-14', 'iphone-15', 'pixel-7', 'android-360', 'ipad-mini-portrait',
  'ipad-mini-landscape', 'ipad-pro-portrait', 'ipad-pro-landscape', 'laptop-1366', 'laptop-1440', 'laptop-1920'];

const recs = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))) : [];
const byKey = Object.fromEntries(recs.map((r) => [`${r.device}-${r.lang}`, r]));
const perf = fs.existsSync(path.join(OUT, 'perf.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'perf.json'), 'utf8')) : null;
const problems = (r) => (r.aborted ? [`aborted: ${r.aborted}`] : []).concat(r.softErrors || []).map((s) => s.replace(/^Error:\s*/, ''));
const short = (s) => (s.length > 60 ? s.slice(0, 57) + '…' : s).replace(/\|/g, '\\|');

const L = [];
L.push('# QuickRupee survey — cross-device test report', '', `Generated ${new Date().toISOString()}.`, '');
L.push('## Methods', '');
const seen = DEVICES.filter((d) => LANGS.some((l) => byKey[`${d}-${l}`]));
L.push(`- **Devices/browsers** (Playwright device emulation): ${seen.map((d) => { const r = LANGS.map((l) => byKey[`${d}-${l}`]).find(Boolean); return `${d} (${r.browser}, ${r.viewport.width}×${r.viewport.height}${r.touch ? ', touch' : ''})`; }).join('; ') || 'none run'}.`);
L.push('- **Journey** per device × language (en/hi/mr): consent → demographics → loan iframe → financial literacy → pressure → confidence → detection → submit. Checks: layout audit on every screen (and inside the iframe), tap targets ≥ 44 px on touch devices, validation messages in the active language, language switching mid-survey (survey + iframe), Likert orientation signature, the exact submitted row, console/page errors, failed requests, missing translation keys, Devanagari webfont loading. Condition (Control/Treatment) alternates by device and language.');
L.push('- **Endpoint**: the Google Apps Script URL is mocked with `page.route` (assignment GET and final POST); every other non-local host except Google Fonts goes to a dead proxy, so no request can reach the real sheet.');
if (perf) L.push(`- **Performance**: ${perf.device}, CPU ${perf.cpuThrottle}, cache ${perf.cache}. Network profiles: ${Object.entries(perf.profiles).map(([k, v]) => `\`${k}\` = ${v}`).join('; ')}.`);
L.push('');

L.push('## Pass/fail matrix', '', '| Device | en | hi | mr |', '|---|---|---|---|');
for (const d of DEVICES) {
  L.push(`| ${d} | ${LANGS.map((l) => { const r = byKey[`${d}-${l}`]; if (!r) return 'not run'; const p = problems(r); return p.length ? `FAIL (${r.condition}): ${short(p[0])}${p.length > 1 ? ` +${p.length - 1}` : ''}` : `PASS (${r.condition})`; }).join(' | ')} |`);
}
L.push('');

L.push('## Findings', '');
const failing = recs.filter((r) => problems(r).length);
if (!failing.length) L.push('No failures in the device × language runs.');
for (const r of failing) {
  L.push(`- **${r.device} / ${r.lang}** (${r.browser}, ${r.condition}):`);
  for (const p of problems(r)) L.push(`  - ${p}`);
  for (const [k, a] of Object.entries(r.audits || {})) {
    for (const f of ['outside', 'clipped', 'tight']) if (a[f] && a[f].length) L.push(`  - ${k} ${f}: ${a[f].slice(0, 3).join('; ')}${a[f].length > 3 ? ' …' : ''}`);
    if (a.hOverflow) L.push(`  - ${k}: page ${a.scrollWidth}px wide in a ${a.clientWidth}px viewport`);
  }
  for (const [k, t] of Object.entries(r.tapTargets || {})) if (t.length) L.push(`  - ${k} small tap targets: ${t.slice(0, 3).join('; ')}`);
}
L.push('');

const sigs = recs.flatMap((r) => r.likertSigs || []);
const odd = sigs.filter((s) => s !== LIKERT_SIG);
L.push('## Likert orientation', '', `${sigs.length} Likert items measured across ${recs.length} runs; ${odd.length ? `**${odd.length} differ** from` : 'all match'} the expected signature \`${LIKERT_SIG}\` (1→5 left to right on one row, "Strongly disagree" anchor on the left).`, '');

if (perf) {
  L.push('## Latency (Pixel 7, Chromium, 4x CPU, cold cache)', '', '| Network | Lang | TTFB | DCL | Load | FCP | LCP | CLS | KB | Req | Continue→loan screen |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [prof, o] of Object.entries(perf.loads)) for (const [l, m] of Object.entries(o)) {
    L.push(`| ${prof} | ${l} | ${Math.round(m.ttfb)} | ${Math.round(m.domContentLoaded)} | ${Math.round(m.load)} | ${Math.round(m.fcp)} | ${Math.round(m.lcp)} | ${m.cls.toFixed(3)} | ${Math.round(m.transferBytes / 1024)} | ${m.requests} | ${l === 'hi' ? perf.interfaceMs[prof] + ' ms' : ''} |`);
  }
  L.push('', 'Times in ms. "Continue→loan screen" is measured in Hindi with an instant mocked assignment.', '');
  L.push(`- Language switch (no network throttle, 4x CPU): median **${perf.langSwitch.medianMs} ms** (samples ${perf.langSwitch.samples.join(', ')}).`);
  L.push(`- Submit → thank-you with the POST held 800 ms: **${perf.submit.totalMs} ms** total, ${perf.submit.minusMockDelayMs} ms excluding the mock delay.`);
  const bad = [];
  for (const [prof, o] of Object.entries(perf.loads)) for (const [l, m] of Object.entries(o)) {
    if (prof === 'slow4g' && m.lcp > 2500) bad.push(`LCP ${Math.round(m.lcp)} ms > 2500 (${prof}, ${l})`);
    if (m.cls > 0.1) bad.push(`CLS ${m.cls.toFixed(3)} > 0.1 (${prof}, ${l}; shifted: ${[...new Set((m.layoutShifts || []).filter((s) => s.value > 0.01).flatMap((s) => s.sources))].join(', ')})`);
  }
  if (perf.langSwitch.medianMs > 100) bad.push(`language switch median ${perf.langSwitch.medianMs} ms > 100`);
  L.push(`- Budgets (LCP ≤ 2500 ms on slow4g, CLS ≤ 0.1, switch ≤ 100 ms): ${bad.length ? bad.map((b) => `**${b}**`).join('; ') : 'all met'}.`, '');
}

const ah = perf && perf.assignHidden;
if (ah) {
  L.push(`## Loan-screen wait (assignment delayed ${ah.assignDelayMs} ms, ${ah.lang}, ${ah.cpuThrottle} CPU)`, '');
  L.push(`Wait = ${ah.waitDefinition}. Scenarios: realistic = ${ah.scenarios.realistic}; fast clicker = ${ah.scenarios.fastClicker}.`, '');
  L.push('| Network | Scenario | Wait (ms) | Loading screen shown? |', '|---|---|---|---|');
  for (const [prof, o] of Object.entries(ah.results)) for (const [sc, r] of Object.entries(o)) L.push(`| ${prof} | ${sc} | ${r.waitMs} | ${r.loadingShown ? 'yes' : 'no'} |`);
  L.push('', `- Old flow for comparison (assignment started at Continue): ≈ ${Object.entries(ah.oldFlowEstimateMs).map(([p, v]) => `${v == null ? 'n/a' : v + ' ms'} (${p})`).join(', ')} — ${ah.oldFlowDefinition}.`);
  const slow = Object.entries(ah.results).filter(([, o]) => o.realistic.waitMs > 500).map(([p, o]) => `${p} ${o.realistic.waitMs} ms`);
  L.push(`- Budget (realistic wait ≤ 500 ms): ${slow.length ? `**missed: ${slow.join(', ')}**` : 'met'}.`, '');
}

fs.writeFileSync(path.join(OUT, 'REPORT.md'), L.join('\n'));
console.log(`Wrote ${path.join(OUT, 'REPORT.md')} (${recs.length} runs${perf ? ' + perf' : ''})`);
