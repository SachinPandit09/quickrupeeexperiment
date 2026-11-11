# Deploy order

Do these in order. The new Apps Script (v5.1) works with both the old and the new survey page, so deploying the script first never breaks the live study. The new page should only go live after the script is updated.

Use the scholar's own Apps Script project and Sheet. Do **not** add a `RESET_KEY` script property there.

- [ ] **(a) Paste v5.1 and deploy a new version**
  1. Open the scholar's Apps Script project → select all code → paste `google_apps_script_v5.js` (version string `v5.1`). Check that `SPREADSHEET_ID` is the scholar's Sheet. Save.
  2. Deploy → Manage deployments → pencil (edit) on the existing deployment → Version: **New version** → Deploy. The `/exec` URL stays the same, so `SHEET_URL` in `index.html` does not change.
  3. Open the `/exec` URL in a browser: it must show `"version":"v5.1"`.

- [ ] **(b) Check the counter**
  - In the editor run `showCounterInSheet` and read the log. Before the first participant on v5.1 it reports the current `Config!B1` and changes nothing; v5.1 continues numbering from that value.
  - Only if the study has not started (or the scholar wants to start again at participant 1): run `resetCounter`.

- [ ] **(c) `updateHeaders` — only if the Sheet is empty**
  - If "Question responses" has no data rows yet: run `updateHeaders` once (37-column header, ending in "Language").
  - If it already has data: leave it for the scholar to decide. Running it only rewrites row 1 (titles) and never moves data, but without it the new columns (pressure, confidence, noticed, Language) are saved without titles.

- [ ] **(d) Smoke test (old page, new script)**
  1. Open the live site in a private window and complete the survey once. At "highest education level" choose **Other** and type `SMOKE TEST` so the row is easy to find.
  2. In the Sheet: one new row in "Question responses" and one in Control or Treatment, with the expected participant number.
  3. Delete the two smoke-test rows. If the study has not started yet, run `resetCounter`.

- [ ] **(e) Merge the pull request** `feature/multilang-likert-fix` → `main`. GitHub Pages rebuilds from `main` in about a minute (Settings → Pages shows the status).

- [ ] **(f) Hard refresh and one more smoke test**
  1. Open the live site and hard refresh (Ctrl+F5, or Cmd+Shift+R on a Mac; on a phone use a private tab). The language selector (English | हिन्दी | मराठी) must be visible.
  2. Complete the survey once in Hindi, again choosing **Other** → `SMOKE TEST`.
  3. In the Sheet: one row each, Language column = `hi`, answers stored as the same English codes as before.
  4. Delete the smoke-test rows (and run `resetCounter` if the study has not started).

If anything looks wrong after (e), revert the merge on GitHub; the v5.1 script keeps working with the old page.
