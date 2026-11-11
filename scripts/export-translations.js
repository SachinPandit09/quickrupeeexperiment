#!/usr/bin/env node
// Exports every UI string (English / Hindi / Marathi) to translations-review.csv
// for a bilingual reviewer. No dependencies.  Usage:  node scripts/export-translations.js
//
// Output: UTF-8 with BOM (so Excel shows Devanagari), CRLF line endings, RFC 4180 quoting.
// Columns: key, English, Hindi, Marathi, Notes. Keys are prefixed by source page.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = [
  ['survey', 'index.html'],
  ['control', 'quickrupee_control.html'],
  ['treatment', 'quickrupee_treatment.html'],
];
const LANGS = ['en', 'hi', 'mr'];
const BOM = String.fromCharCode(0xFEFF); // so Excel detects UTF-8

// Reviewer flags, shown in the Notes column.
const FL_ITEMS = 'Adapted from Lusardi & Mitchell "Big Three", the OECD/INFE toolkit and S&P Global FinLit items. No official Hindi/Marathi version found (NCFE-FLIS 2019 uses different wording). Back-translation recommended.';
const NAME = 'Confirm the Devanagari spelling of the scholar\'s name ("संजोगिता आर.") and of the institute name.';
const NEUTRAL = 'Gender-neutral wording chosen deliberately (Hindi/Marathi first-person verbs are gendered); check it reads naturally.';
const TITLE = 'Study title rendered as "अंधेरा पहलू" (hi) / "काळी बाजू" (mr); the scholar may prefer to keep the English title. "Dark patterns" kept as a loanword (डार्क पैटर्न / डार्क पॅटर्न). Note: the title reveals the study\'s purpose before the loan screen (priming risk); this is true in English too.';
const NOTES = {
  'survey.lang.name': 'GENERAL: Hindi uses the nukta consistently (ज़, फ़, ख़). Marathi uses ॲ (U+0972) in "ॲप"; check it renders on older Android phones. Recall answers on the loan screen accept Devanagari digits (२४ = 24).',
  'survey.meta.title': TITLE,
  'survey.consent.title': TITLE,
  'survey.consent.intro': NAME + ' Wording is gender-neutral (passive voice: "…द्वारा किया जा रहा है").',
  'survey.ty.name': NAME,
  'survey.ty.inst': NAME,
  'survey.consent.o0': 'Marathi: ' + NEUTRAL,
  'survey.consent.o1': NEUTRAL,
  'survey.q5.o5': NEUTRAL,
  'survey.yn.o2': NEUTRAL,
  'survey.brief.li1': 'REVIEW WITH EXTRA CARE: carries the experimental baseline (₹20,000 urgent medical need) used to compute over-borrowing.',
  'survey.q2.o4': 'English options overlap at 45 ("41–45" and "45 and above"). Instrument issue carried over unchanged.',
  'survey.q2.o5': 'English options overlap at 45 ("41–45" and "45 and above"). Instrument issue carried over unchanged.',
  'survey.q3.label': 'No option below 12th standard; may matter more for Hindi/Marathi respondents (instrument decision, not a translation issue).',
  'survey.q5.o0': '"Rs" rendered as रुपये. Digits kept Western (0–9) in all languages.',
  'survey.q6.o1': 'English reads "applied but not complete the process"; translated as "did not complete".',
  'survey.q8.label': FL_ITEMS,
  'survey.q9.label': FL_ITEMS + ' Hindi: rephrased as "how much can be bought with this money" to avoid a gendered verb; check equivalence.',
  'survey.q10.label': FL_ITEMS + ' The English stem does not say interest is compounded/reinvested; translations keep this ambiguity deliberately.',
  'survey.q11.label': FL_ITEMS,
  'survey.q12.label': FL_ITEMS,
  'survey.pp.title': 'Construct name shown to participants; translated plainly.',
  'survey.dc.title': 'Construct name shown to participants; translated plainly.',
  'survey.p6.label': 'Scale direction is now standard (1 = Strongly disagree, on the left). Previously this item\'s anchors were reversed on screen.',
  'survey.d5.label': 'Hindi: rephrased as "मेरी इच्छा होगी कि मैं…पढ़ूँ" to avoid a gendered verb (चाहूँगा/चाहूँगी).',
  'survey.likert.3': '"न सहमत, न असहमत" / "सहमतही नाही, असहमतही नाही". "तटस्थ" (neutral) is a common alternative in Indian survey literature; no authoritative standard found.',
  'survey.x3.o0': 'English "higher amount" is ambiguous (higher than what?). Hindi uses "बड़ी रकम" (a large amount).',
  'survey.x4.o2': '"Neutral" rendered as "neither easy nor difficult"; more explicit than the English.',
  'control.kfs.title': '"मुख्य तथ्य विवरण": confirm against RBI\'s official Hindi term for Key Fact Statement.',
  'treatment.kfs.title': '"मुख्य तथ्य विवरण": confirm against RBI\'s official Hindi term for Key Fact Statement.',
  'control.kfs.cooling': 'Confirm the official Hindi/Marathi title of "RBI Digital Lending Directions, 2025".',
  'treatment.ins.no': 'Confirm-shaming wording: must keep the same emotional force as the English (this is the experimental manipulation).',
  'treatment.fee.text': 'English says the fee is deducted at disbursement, but the screen\'s totals add ₹500 to repayment. Inconsistency in the original stimulus, left unchanged.',
  'treatment.ins.sub': '"9 out of 10" here vs "94%" in treatment.ins.social. Inconsistency in the original stimulus, left unchanged.',
  'treatment.ins.social': '"94%" here vs "9 out of 10" in treatment.ins.sub. Inconsistency in the original stimulus, left unchanged.',
  'control.r2': 'Original English differs from treatment.r2 ("shown" vs "charged"); kept as is.',
  'treatment.r2': 'Original English differs from control.r2 ("charged" vs "shown"); kept as is.',
};

function readI18n(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = /<script id="i18n" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('No i18n block in ' + file);
  return JSON.parse(m[1]);
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const rows = [['key', 'English', 'Hindi', 'Marathi', 'Notes']];
const seen = new Set();
let warnings = 0;
for (const [prefix, file] of SOURCES) {
  const tr = readI18n(file);
  // Source order = English order, plus any keys that exist only in hi/mr.
  const keys = [...new Set(LANGS.flatMap((l) => Object.keys(tr[l] || {})))];
  for (const k of keys) {
    const key = prefix + '.' + k;
    seen.add(key);
    for (const l of LANGS) {
      if (tr[l] == null || tr[l][k] == null) { console.log(`WARNING: ${key} missing in ${l}`); warnings++; }
    }
    rows.push([key, ...LANGS.map((l) => (tr[l] || {})[k]), NOTES[key] || '']);
  }
}
for (const k of Object.keys(NOTES)) {
  if (!seen.has(k)) { console.log(`WARNING: note for unknown key ${k}`); warnings++; }
}

const out = path.join(ROOT, 'translations-review.csv');
fs.writeFileSync(out, BOM + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n', 'utf8');
console.log(`Wrote ${rows.length - 1} keys to ${path.relative(process.cwd(), out) || out}` +
  (warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ' (no missing keys)'));
