# Changelog

Branch `feature/multilang-likert-fix`, compared with `main` on GitHub (commit `12a51c6`).

## Assignment and submission (needs Apps Script v5.1 — see DEPLOY-ORDER.md)

- **Assignment is keyed by participant id.** The page sends `?action=assign&pid=<participantId>`; the server remembers the answer for that id, so asking again (even at the same moment) returns the same group and number and does not move the counter. Groups still strictly alternate in arrival order under a lock. *Why:* makes retries safe, so no participant can end up with two groups.
- **The random fallback is removed.** Previously, if assignment failed or took more than 8 s, the page picked Control/Treatment at random. Now any failure (network error, HTTP error, HTML error page, non-JSON reply) is retried with the same id after 1, 2, 4 and 8 s; after that the participant sees a translated "taking longer than usual" message and a **Try again** button. *Why:* random assignment broke the strict alternation and gave participant number −1.
- **Submissions are deduplicated on the server.** A second submission with an id that was already saved writes nothing and still answers success. The page now reads the reply (normal CORS, no `no-cors`/`keepalive`) and only shows "thank you" for `{"status":"success"}`; anything else shows the retry screen, which re-sends the identical payload. *Why:* a lost reply no longer means either lost data or a duplicate row.
- **One URL, one Sheet ID.** `SHEET_URL` is set only in `index.html` (marked `>>> SHEET_URL`); the loan screens contain no URL and send nothing when opened on their own. `SPREADSHEET_ID` is set once in the Apps Script. See `SWITCHING.md`.
- **Tested against a test deployment of v5.1:** 30 and 60 simultaneous assignments (3 runs each) gave participant numbers exactly 1..N with Control/Treatment differing by at most 1; duplicate assignments and submissions behaved as above; full survey in en/hi/mr stored identical answer codes with the Language column filled. The old live page (no participant id) also works with v5.1.

## Fixed

- **The loan screen took 3–5 s to appear after the "About you" questions.** Cause: the `GET ?action=assign` call to Apps Script was only made when the participant clicked Continue, and the iframe could only start loading after it returned. A no-op GET to the real web app takes 1.4–2.2 s (Google routing + one redirect), and `assign` also takes a lock and opens the spreadsheet. The iframe adds 0.06–0.4 s and fonts do not block anything. Now:
  - the assign request starts as soon as the participant agrees to take part (Begin with consent = yes) and runs while they answer "About you". It is made once and kept in memory. Nobody who declines consent triggers it.
  - the matching loan screen (Control or Treatment) is preloaded hidden as soon as the group is known, and shown instantly on Continue.
  - if it is still pending, the existing "Setting up your application..." screen shows and switches over by itself. After 12 s a translated "taking longer than usual" message and a **Try again** button appear; retry reloads the same loan screen (same group, no new assign request).
  - the 8 s random fallback was later removed (see "Assignment and submission" above).
  - the treatment countdown now starts when the loan screen is shown (`quickrupee-show` message), so a preloaded screen still opens at 09:47. Standalone pages start the countdown immediately, as before.
  - measured with the assign call held 3 s (Pixel 7, 4x CPU, Hindi): participant spending ~5 s on "About you" waits **2–3 ms** (was ~3.1–3.4 s); a participant who clicks through instantly waits for the remaining ~2.7–3.1 s with the loading message shown. See `test-results/REPORT.md`, "Loan-screen wait".
  - balance note: the group is now drawn at consent instead of after "About you", so people who drop out during "About you" now use up a slot. Alternation itself is unchanged.
  *Why:* the wait came from the network round-trip, not from the page; starting it earlier hides it behind time the participant spends anyway.
- **Apps Script v5.1 (kept outside this repo because it contains the Sheet ID): lighter `assign`.** The counter moves from `Config!B1` to Script Properties, so `assign` no longer opens the spreadsheet; the lock is kept, so groups still strictly alternate. Seeds itself from B1 on first use. Reset with `resetCounter`, copy the count into B1 with `showCounterInSheet`. *Why:* opening the spreadsheet was the slowest part of each assign call.
- **Likert scales were confusing on phones.** The cause was `@media(max-width:500px){.likert{flex-direction:column}}`: on narrow screens it put "Strongly disagree" above the radio buttons and "Strongly agree" below them, so the ends of the scale no longer lined up with 1 and 5. On top of that, **P6** ("I felt calm and in control…") had its end labels reversed in the markup, with "Strongly agree" on the left. Every Likert item is now one horizontal row of five large numbered buttons (each at least 44 px wide and 52 px tall), identical at every screen width. 1 = Strongly disagree is on the left, the end labels sit under the two ends, and the chosen answer is spelled out under the row ("Your answer: Agree (4)"). *Why:* stops respondents misreading the scale direction, which would bias the PP and DC scores.
- **The "thank you" screen appeared even when the send failed.** Previously the request was sent in the background and the thank-you screen appeared straight away. Now the page waits for the request. If the network fails or 20 s pass, it shows a translated "Your responses were not sent" screen with a **Try again** button. *Why:* this used to lose data silently.
- **Loan screens: `alert()` for missing recall answers** is replaced by an inline message in the participant's language. *Why:* the native dialog was untranslated and is blocked or hidden in some in-app browsers.
- **Recall scoring accepts Devanagari digits** (`२४` scores like `24`, `५००` like `500`). *Why:* Hindi/Marathi keyboards often type these digits, and they would have been marked Incorrect.

## ⚠️ Data note: P6 coding changed

Rows submitted **before** this change stored P6 with **reversed coding** (1 = Strongly agree). Rows from this version use the standard coding (1 = Strongly disagree), and their `language` value is never empty. If any P6 data was collected with the old version, recode the old rows with **`P6 = 6 − x`** wherever the Language cell is empty. The Language column needs Apps Script v5. If the new site went live before v5 was deployed, use the go-live timestamp as the cut-off instead.

## Added

- **Hindi and Marathi** next to English.
  - One `translations` JSON block per page (`<script id="i18n" type="application/json">`, keys `en` / `hi` / `mr`). *Why:* everything is in one place for review and stays a static site, with no build step.
  - Language selector in the top bar (**English | हिन्दी | मराठी**). The choice is remembered for the browser session (`sessionStorage`) and `<html lang>` is updated. *Why:* correct screen-reader voice and font selection.
  - Switching language keeps all answers. Radio values are language-independent codes, so only the visible text changes.
  - Noto Sans Devanagari with system fallbacks (Nirmala UI, Kohinoor Devanagari, Mangal) loads without blocking the page (`media="print"` swap, `font-display: swap`). *Why:* text appears at once on slow mobile connections.
  - The loan screens are translated too. The survey passes `?lang=` to the iframe and sends a `postMessage` when the language changes. On the loan screens the font stack keeps Latin text in the original system font, so the English stimulus looks the same as before.
- **`language` field** in the submitted data (`en`/`hi`/`mr`, the language in use at Submit). It is appended **last**, so nothing else moves.
- **Progress indicator**: "Step n of 6: <section name>". *Why:* tells respondents how much is left and reduces drop-off.
- **Validation in the chosen language**: each missing answer is marked and labelled, and focus moves to the first error, or to the "Other" text box if that is what is missing.

## Changed

- **Design**: a calm single-column layout with WCAG AA text contrast and visible keyboard focus. Every question is a native radio group in a `<fieldset>`/`<legend>`. *Why:* readable on cheap phones, usable with a keyboard or screen reader, and neutral, so the survey itself does not add pressure next to the stimulus.
- **The parent page only accepts `postMessage`s from its own loan iframe** (`event.source` check). The loan pages only accept language messages from their parent. *Why:* another window cannot inject fake loan data.
- **Retry is safe to deduplicate**: the payload is built once, so a retry re-sends the identical row with the same `participantId`. With Apps Script v5.1 the server ignores the repeat, so no duplicate row is created (with the old script, deduplicate on Participant ID).

## Unchanged (on purpose)

- **Data contract**: every existing payload field keeps its name, order and value format. Radio values are still the original English strings (e.g. `"Less than today"`, `"Other: …"`), so existing Sheet columns and financial-literacy scoring stay consistent.
- **Loan stimuli**: dark patterns, amounts (₹20,000 / ₹50,000 defaults), APR, fee, EMI and total calculations, and insurance logic all behave as before (condition assignment changed — see "Assignment and submission"). Known inconsistencies in the original English stimulus are kept and flagged in `translations-review.csv`.

## Tooling

- `tests/`: a Playwright suite covering the device/language matrix, performance and i18n checks (`@playwright/test` dev dependency in `package.json`).
- `scripts/export-translations.js`: run `node scripts/export-translations.js` to write `translations-review.csv`. It lists every string in English/Hindi/Marathi with reviewer notes and opens correctly in Excel (UTF-8 BOM). It warns about any key missing in a language.
- `.gitignore`: covers `node_modules/` and Playwright output.

## Deployment

- GitHub Pages needs only **`index.html`, `quickrupee_control.html`, `quickrupee_treatment.html` and `.nojekyll`**. Everything else (tests, scripts, CSV, `package*.json`) is development-only.
- Apps Script: v4 keeps working with the new site (it ignores `language`). To store the Language column, deploy **v5** (kept outside the repo because it contains the Sheet ID). See `APPS_SCRIPT_V5_GUIDE.txt`.
