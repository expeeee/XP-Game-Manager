# Linux Game Manager: Feature and Tauri Migration Plan

## Outcome

Deliver a richer, lawful local-game library without incorporating Fit-Launcher
code, assets, branding, download flows, scraping, torrent support, or installer
automation. Keep Electron as the shipping implementation until the product
contract is stable; migrate to Tauri/Rust only after the decision gate below.

Fit-Launcher is GPL-3.0-only. No source code from it may be copied into this
project unless the project is intentionally relicensed and distributed under
GPL-3.0. Its UI may inform high-level product ideas only through clean-room
design and implementation.

## Product boundary

In scope:

- Installed-game discovery from Steam and user-selected local or mounted paths.
- Metadata and artwork from authorized public store APIs.
- Game collections, search, filters, details, configuration, and explicit
  launch actions.
- Native Linux, Steam, Wine, Proton/UMU, and later Lutris/Heroic/Bottles
  integrations for games already installed or legitimately supplied by users.
- An optional Torbox transfer client for user-supplied, authorized magnet links.

Out of scope:

- Piracy-oriented game discovery, download sources, content-site scraping,
  cracking, or installer automation.

## Optional Torbox transfer integration

Torbox support is an explicit, desktop-only action for content the user is
authorized to download. The application neither searches for, recommends, nor
bundles magnet links or torrent files. It must not be exposed through the LAN
read-only web interface.

### User flow

1. The user connects their own Torbox account using an API token stored with
   Electron `safeStorage` (or an equivalent operating-system credential store
   after a Tauri migration). Never store it in a game folder, manifest, source
   file, log, or command preview.
2. The user chooses a local destination directory and pastes a magnet link.
3. The desktop app validates the link locally, displays an authorization notice,
   and submits it only after explicit confirmation.
4. The app creates the Torbox torrent, polls its status, and shows queue,
   processing, completed, incomplete, and failed states.
5. Once completed, the user chooses all files or individual files. The app asks
   Torbox for short-lived download URLs and streams those files to the selected
   directory.
6. The completed transfer becomes a normal local folder library only if the
   user explicitly adds that directory to the library scanner.

### Implementation safeguards

- Use Torbox's authenticated create-torrent, torrent-list, and download-link
  endpoints; use a bearer token where supported and redact query-token URLs
  everywhere else.
- Keep a local resumable job record containing only Torbox item/file IDs,
  sanitized destination-relative names, progress, and failure state--never the
  API token or a download URL.
- Require an existing, writable destination chosen through the native directory
  picker. Reject traversal paths, symlinks that escape the selected directory,
  and overwrite attempts unless a future explicit replace flow is added.
- Default to selecting files rather than downloading an opaque multi-file
  torrent wholesale. Enforce a user-visible size confirmation before transfer.
- Treat Torbox rate-limit and account-state errors as actionable UI states;
  current Torbox documentation limits uncached torrent creation separately from
  general API calls.
- Run all calls only in the privileged desktop process. The renderer receives
  redacted status and progress, never credentials or signed URLs.

### Delivery steps

1. Add secure credential storage plus an account test (`GET /user/me`).
2. Add destination-directory selection and a magnet-entry dialog.
3. Add create/status polling and a persistent, resumable transfer-job model.
4. Add completed-torrent file selection and a streaming downloader with safe
   names, partial files, resume, checksum support when available, and progress.
5. Add cancel/retry behavior and diagnostic logs with token/URL redaction.
6. Test with a public-domain or self-created torrent on Windows and Linux.

**Exit criterion:** a user can paste an authorized magnet, select files, and
receive them intact in a chosen local directory without exposing credentials or
making the LAN API writable.

## Phase 0 - Freeze the contract (1-2 days)

1. Write a versioned `GameRecord` schema shared by desktop and LAN interfaces.
2. Document the settings contract:
   - `settings.json` for configured library roots and global Proton settings;
   - `game-launchers.json` for host-local launch configuration;
   - `.linux-game-manager.json` for portable, per-folder facts;
   - `game-metadata.json` as a replaceable metadata cache.
3. Add fixture directories and tests for Steam VDF/ACF parsing, folder scans,
   manifest validation, path containment, and launch-spec generation.
4. Treat every scan as read-only; configuration writes remain explicit actions.

**Exit criterion:** fixtures establish the current scanner and launcher behavior
so it can be improved or ported without data loss.

## Phase 1 - Improve the existing Electron product (1-2 weeks)

Implement these independently; no Rust migration is required.

1. Replace the single-purpose renderer flow with a library page and game-detail
   panel.
2. Add case-insensitive search; source, availability, platform, runner, and
   compatibility filters; and sort by name, source, or recently discovered.
3. Add user-owned collections and tags stored in settings, not game folders.
4. Show clear status badges: installed/missing, Steam/folder source, native/Wine/
   Proton runner, and metadata availability.
5. Keep one primary Play action. Require an explicit saved runner configuration
   and retain the command preview immediately before launch.
6. Add diagnostics for inaccessible roots, invalid manifests, missing executables,
   and unavailable runner binaries.

**Exit criterion:** the desktop library is useful enough to ship and retains all
existing Steam, mounted-folder, Wine, GE-Proton, and UMU behavior.

## Phase 2 - Strengthen platform seams (1 week)

1. Move pure backend functions out of `src/main.cjs` into small modules:
   scanner, settings, manifests, metadata, runners, and LAN API.
2. Give renderer IPC calls typed request/response shapes, even while JavaScript
   remains the implementation language.
3. Add a migration/version field to every owned JSON document and backups before
   schema changes.
4. Keep the LAN endpoint read-only and add authentication/TLS before any use
   outside the trusted home network.

**Exit criterion:** Electron-specific APIs are limited to window, dialog, IPC,
and shell adapters; core rules can be ported or tested independently.

## Decision gate - choose Electron or Tauri

Stay on Electron when the primary goal is feature velocity and Node tooling is
adequate. Choose Tauri/Rust only if at least two of these are true:

- installer/runtime footprint or idle memory is a material user problem;
- one native backend is needed for Windows and Linux packaging and lifecycle;
- scanner/launcher concurrency, safety, or reliability needs Rust-level control;
- the team can maintain Rust, Cargo, WebKitGTK/Linux build dependencies, and
  Windows signing/release pipelines.

The decision must include a spike that builds Windows and Linux installers and
passes the Phase 0 fixture suite against both backends.

## Phase 3 - Tauri/Rust proof of concept (1 week, only after the gate)

1. Create a separate `tauri-poc` branch or worktree; do not replace production
   Electron files.
2. Use Tauri 2 with the existing web UI or a small TypeScript frontend. Rust is
   the backend only; a frontend rewrite is not required to prove the approach.
3. Port read-only settings and scanning first, preserving current file locations,
   IDs, and JSON formats.
4. Implement Tauri commands for `loadLibrary`, folder selection, and metadata
   reads. Do not enable launch or write operations in the POC.
5. Compare the Electron and Tauri outputs against the same fixture library and
   a real Linux user profile.

**Exit criterion:** both backends return equivalent library records and the
Tauri application packages and runs on supported Windows and Linux hosts.

## Phase 4 - Incremental Tauri migration (2-4 weeks, if approved)

1. Port settings, manifests, and metadata cache writes with atomic writes and
   backwards-compatible migrations.
2. Port runner-command preview and compare each result with Electron tests.
3. Port launching last, beginning with Steam URLs, then native Linux, Wine, and
   Proton/UMU. Preserve the explicit-confirmation model.
4. Replace the read-only Node LAN server with a small Rust HTTP service only
   after API compatibility and network-security tests pass.
5. Run Electron and Tauri release candidates in parallel against copies of the
   same configuration. Provide export/import and rollback instructions.

**Exit criterion:** users can upgrade without losing settings or changing launch
behavior; Electron is retired only after a full release cycle without parity
regressions.

## Acceptance and release checklist

- No Fit-Launcher code or GPL-only dependencies/assets are present.
- All scanner paths remain containment-checked and scan operations are read-only.
- Existing configuration files survive upgrade and downgrade.
- Command previews match launched commands.
- Windows and Linux packaging are verified from clean machines.
- LAN inventory remains read-only, authenticated before untrusted-network use,
  and does not expose writable launch controls.

## First execution backlog

Work through these in order. Each item should be its own small pull request
with tests and a manual smoke check on the target platform.

| Order | Deliverable | Primary areas | Verification |
| --- | --- | --- | --- |
| 1 | Define `GameRecord` and JSON schema versions | `src/main.cjs`, new schema docs/tests | Existing Steam and folder records remain readable |
| 2 | Extract pure scan and path-validation modules | new backend modules, `src/main.cjs` | Fixture tests cover VDF, ACF, missing paths, and containment |
| 3 | Extract settings/manifest persistence module | new backend module | Existing settings and `.linux-game-manager.json` files round-trip unchanged |
| 4 | Add library search, filters, and sorting | `src/renderer/*`, `src/web/*` | Filters agree with the source/availability status displayed |
| 5 | Add game detail/status panel and collections | renderer plus settings model | Play remains unavailable until a valid saved runner is selected |
| 6 | Add scanner and launcher diagnostics | backend plus renderer | Permission, unavailable-path, executable, and runner errors are actionable |
| 7 | Add fixtures and regression tests for launch preview | runner module | Preview output is stable for Steam, native, Wine, and Proton/UMU |
| 8 | Run the Tauri decision gate | separate POC branch/worktree | Clean Windows/Linux builds and equivalent read-only scan results |

### Definition of done for the next release

The release is complete when items 1 through 7 are done, the existing launcher
flows still work, and the desktop plus LAN library both display accurate game
source and availability information. Item 8 is a decision experiment, not a
requirement for this release.
