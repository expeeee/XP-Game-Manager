# FitGirl Repacks Tab — Work Plan

Branch: `proton-wip`. Goal: add a **FitGirl** tab that searches/browses FitGirl
repacks and hands the resolved magnet to the existing Torbox download flow.

Status: **COMPLETE & verified** (see [Verification](#verification)).

## Context / conventions

- Local-first Electron app. Main process `src/main.cjs` (CJS), preload
  `src/preload.cjs`, renderer `src/renderer/renderer.js` + `index.html` +
  `styles.css`.
- Torbox "Add to Torbox" path already existed: `torbox:add-magnet` handler
  (`src/main.cjs`) takes `{ magnet, destination }`; exposed in preload as
  `libraryApi.addTorboxMagnet(configuration)`.
- `torbox:choose-directory` → `libraryApi.chooseTorboxDirectory()`.
- Tests: `node --test test/*.test.cjs`; `test/launcher-config.test.cjs` uses
  `node:test` + `node:assert/strict`.
- FitGirl backend: `https://fitgirl-repacks.site/wp-json/wp/v2` (WordPress
  REST). Top pages: `pop-repacks/` (month),
  `popular-repacks-of-the-year/` (year).

## What was implemented

### 1. `src/launcher-config.cjs` — pure parsers (unit-tested)
- `decodeHtmlEntities(value)` — numeric, hex, and named HTML entities.
- `parseFitGirlRepack(content)` — extracts the primary magnet info-hash, a
  human download name (`dn=`), and the advertised size from a repack post's
  HTML. Returns `{ infoHash, downloadName, sizeLabel, magnet }` or `null`.
- `parseFitGirlTopList(html)` — scrapes the ordered `{slug,title}` list from a
  top-repacks page, scoped to `entry-content` so sidebar widgets are ignored,
  and de-duplicates by slug.

### 2. `src/main.cjs` — network + IPC
- `fitgirlFetch`, `fitgirlResult`, `searchFitGirlRepacks(query)`,
  `fetchFitGirlTopList(period)`, `resolveFitGirlRepack(slug)`.
- Search filters out "Updates Digest" posts and only returns results that have
  a resolvable magnet.
- IPC handlers: `fitgirl:search`, `fitgirl:top`, `fitgirl:resolve`.

### 3. `src/preload.cjs`
- `searchFitGirl`, `fitgirlTop`, `resolveFitGirl`.

### 4. `src/renderer/index.html`
- `fitgirl-tab` button + `#fitgirl-view` section: search input
  (`#fitgirl-search`), `#fitgirl-search-btn`, top toggle
  (`#fitgirl-top-month`, `#fitgirl-top-year`), `#fitgirl-status`,
  `#fitgirl-results`, and `#fitgirl-authorization` (checkbox
  `#fitgirl-auth-checked`, `#fitgirl-add`, `#fitgirl-auth-cancel`).

### 5. `src/renderer/renderer.js` — UI logic
- `switchView(view)` refactored to 3 views; opening the FitGirl view calls
  `loadFitGirlTop('month')`.
- `loadFitGirlTop(period)` — loads + renders the top list, toggles the
  active period button.
- `performFitGirlSearch()` — runs a search and renders results.
- `fitgirlResultRow` / `renderFitGirlResults` — renders each item with a
  **Download** action; top-list items (slug only) resolve slug → magnet on
  demand via `resolveFitGirl` before "Add to Torbox".
- `openFitGirlAuthorization` + `addFitGirlToTorbox` — authorization gate, then
  reuses the saved Torbox destination (or prompts for one) and calls
  `addTorboxMagnet({ magnet, destination })`. `#fitgirl-auth-cancel` hides the
  box.
- Wired tab/search/toggle/button event listeners.

### 6. `src/renderer/styles.css`
- Styles for `.fitgirl-toolbar`, `.fitgirl-top-toggle`, `.toggle-btn`
  (+ `.active`), `.fitgirl-results`, `.fitgirl-item`, and
  `.fitgirl-authorization`, matching the existing dark/purple theme.

### 7. `test/launcher-config.test.cjs`
- Coverage for `decodeHtmlEntities`, `parseFitGirlRepack` (info-hash, `dn`
  name, size), and `parseFitGirlTopList` (scoping, de-dupe, entity decoding).

### Bug fix found along the way
- Size-label extraction only searched the download name; it now falls back to
  the post text (where FitGirl advertises the size, e.g. "95.1 GB").

## Verification

- `node --test test/*.test.cjs` → **12/12 pass**.
- `node --check` clean on `renderer.js`, `main.cjs`, `preload.cjs`,
  `launcher-config.cjs`.
- Every element ID and `libraryApi.*` method the renderer uses exists in the
  HTML and preload.
- **Live check against `fitgirl-repacks.site`:**
  - Top list (`pop-repacks/`) → 50 clean `{slug,title}` entries.
  - Search ("grand theft auto v") → 6 qualifying repacks with valid 40-char
    info hashes, sizes, and decoded names (e.g. "Grand Theft Auto V Enhanced –
    95.1 GB").

## Assumptions
- "Add to Torbox" reuses the same destination flow as the Downloads tab; if a
  saved destination exists, prefer it, otherwise prompt.
- Top-list items resolve slug → magnet on demand (one request per click) rather
  than batch-fetching N up front.
- FitGirl may rate-limit; `fitgirlFetch` uses a 30s timeout and a browser-like
  User-Agent.

## Not yet done (optional)
- Committing the changes (currently in the working tree, uncommitted).
- Optional: a full `npm start` click-through on a real desktop session.
