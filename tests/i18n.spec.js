// Static checks of the translation tables. No browser. Run: npx playwright test -c tests --project=i18n
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { ROOT, LANGS, I18N } = require('./helpers');

const FILES = { 'index.html': I18N.survey, 'quickrupee_control.html': I18N.control, 'quickrupee_treatment.html': I18N.treatment };
const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');

for (const [file, tbl] of Object.entries(FILES)) {
  test.describe(file, () => {
    test('en/hi/mr have identical key sets and no empty strings', () => {
      const en = Object.keys(tbl.en).sort();
      for (const l of LANGS) {
        expect(Object.keys(tbl[l]).sort(), `${l} keys`).toEqual(en);
        const empty = Object.entries(tbl[l]).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
        expect(empty, `${l} empty strings`).toEqual([]);
      }
    });

    test('placeholders match across languages', () => {
      const bad = [];
      for (const k of Object.keys(tbl.en)) for (const l of LANGS) if (tbl[l][k] != null && vars(tbl[l][k]) !== vars(tbl.en[k])) bad.push(`${l}:${k}`);
      expect(bad).toEqual([]);
    });

    test('Marathi has no Hindi danda', () => {
      expect(Object.entries(tbl.mr).filter(([, v]) => v.includes('।')).map(([k]) => k)).toEqual([]);
    });

    if (file !== 'index.html') {
      test('every data-i18n / -html / -ph key in the markup exists in en', () => {
        const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const keys = [...html.matchAll(/data-i18n(?:-html|-ph)?="([^"]+)"/g)].map((m) => m[1]);
        expect(keys.length).toBeGreaterThan(20);
        expect([...new Set(keys)].filter((k) => !(k in tbl.en))).toEqual([]);
      });
    }
  });
}
