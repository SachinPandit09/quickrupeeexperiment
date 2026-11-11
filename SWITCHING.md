# Switching between the test and the live (scholar's) deployment

The site talks to exactly one Google Apps Script web app, and that script writes to exactly one Google Sheet. Each is set in one place.

| What | Where | Constant |
|---|---|---|
| Web app URL used by the survey | `index.html` (search for `>>> SHEET_URL`) | `SHEET_URL` |
| Sheet the script writes to | the Apps Script project (`google_apps_script_v5.js`, kept outside this repo) | `SPREADSHEET_ID` |

The two loan screens (`quickrupee_control.html`, `quickrupee_treatment.html`) contain no URL. Opened on their own they send nothing; inside the survey their answers are sent by `index.html`.

## Go live with the scholar's deployment

1. **Apps Script (scholar's project, scholar's Sheet):**
   1. Paste `google_apps_script_v5.js`. Set `SPREADSHEET_ID` to the scholar's Sheet ID. Save.
   2. Run `updateHeaders` once (adds the 37-column header; old rows untouched).
   3. Do **not** add a `RESET_KEY` script property here. Without it the admin actions (status/reset/lookup/cleanup) are switched off.
   4. Run `resetCounter` if the study should start again at participant 1 (otherwise numbering continues from `Config!B1`).
   5. Deploy → Manage deployments → Edit (pencil) → Version: **New version** → Deploy. The URL stays the same.
   6. Check: open the `/exec` URL in a browser. It must show `"version":"v5.1"`.
2. **Website:** in `index.html` replace the value of `SHEET_URL` with the scholar's `/exec` URL. Publish `index.html`, `quickrupee_control.html`, `quickrupee_treatment.html` and `.nojekyll` together (the loan screens and the survey page depend on each other).

## Test deployment

- Use a separate Apps Script project and a **copy** of the Sheet, so tests never write into real data.
- Add the script property `RESET_KEY` (Project Settings → Script properties) **only in the test project**. The test tools use it to read the counter, reset it, look up rows and delete rows whose Participant ID starts with `TEST_`.
- The test URL, Sheet ID and key live only in `tests/server.config.json`, which git ignores. The test tools rewrite the survey's requests to that URL, so `index.html` does not need to change for testing.

## How assignment works (v5.1)

- The survey sends `?action=assign&pid=<participantId>` once consent is given. The server alternates Control, Treatment, Control, ... in arrival order, under a lock, and remembers the answer for that id. Asking again with the same id returns the same group and number and does not move the counter. So the page can safely retry; there is no random fallback.
- Submissions are keyed on the same id: a second submission with an id that was already saved writes nothing and still answers success.
- The counter is kept in Script Properties. `Config!B1` is only a copy: run `showCounterInSheet` to refresh it.
