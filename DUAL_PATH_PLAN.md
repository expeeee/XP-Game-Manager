# Dual-Path Linux Game Library Plan

## Goal

Provide one trustworthy view of locally installed Linux and Windows games, with
two complementary interfaces:

- **xp-home-dashboard** is the web-based control room for browsing and
  monitoring the library on the home server.
- **XP Game Manager** is the native desktop companion for launching and
  troubleshooting individual games through Steam, Proton, Wine, or Lutris.

The first configured non-Steam library is `/Beta/WindowsGames`.

## Shared foundation

Build the scanner and data contract before either UI grows beyond a prototype.

### Canonical game record

Every importer returns the same read-only record:

```ts
type GameRecord = {
  id: string;
  title: string;
  source: "steam" | "folder" | "lutris" | "heroic" | "bottles";
  installPath: string;
  available: boolean;
  platform: "linux" | "windows" | "unknown";
  launcher?: { kind: "steam" | "native" | "wine" | "lutris"; reference?: string };
  lastScannedAt: string;
};
```

The scanner must be read-only. It may report missing paths, but it must never
move, delete, install, or modify game files.

### Clean-room interface direction

Use a new Linux-first visual system inspired by the strengths of GameNative's
library experience, without copying its code, layouts, assets, or branding:

- dark, cover-forward game cards;
- prominent search and source/status filters;
- a concise status line for runner, availability, and source;
- one clear primary action (Play) with configuration in a detail panel;
- the dashboard stays read-only, while the native companion owns launching.

This remains an independently implemented Electron and Next.js interface; it
does not incorporate GameNative source code and does not inherit its license.

### Initial scan sources

1. Steam's `libraryfolders.vdf` for the active Linux user.
2. Installed Steam `appmanifest_*.acf` files.
3. `/Beta/WindowsGames`, ignoring hidden implementation folders such as
   `.lutris-prefixes`.
4. User-configured additional mounted directories.

The server already exposes these Steam libraries:

- `/home/xpchen/.local/share/Steam`
- `/Fast/Others/SteamLibrary`
- `/Fast/Misc/SteamLibrary`

## Phase 1 — Dashboard inventory

Add a `/games` module to **xp-home-dashboard**.

- Create a server-only scanner module and `GET /api/games` endpoint.
- Return source, path, availability, platform hint, and scan timestamp.
- Build a searchable game table/card view with source and storage filters.
- Add a manual rescan button and clear unavailable-path warnings.
- Add `/Beta/WindowsGames` as the initial folder source.

**Done when:** a browser on the LAN can browse every Steam game and the visible
folders in `/Beta/WindowsGames`, without changing any installation.

## Phase 2 — Shared configuration and diagnostics

- Store configured folder libraries in a small JSON settings file owned by the
  dashboard service user.
- Add scan errors, permission errors, missing folders, and duplicate detection.
- Resolve symlinked library roots deliberately and display the resolved path.
- Add an optional per-game notes field; do not add launch controls yet.

**Done when:** the dashboard is a dependable library inventory and can explain
why a game is unavailable.

## Phase 3 — Native desktop companion

Turn the existing **XP Game Manager** Electron scaffold into the desktop
client.

- Reuse the game-record schema and scan rules from Phase 1.
- Read the same library settings, or consume the dashboard API where practical.
- Add per-game details: executable, working directory, runner, prefix, launch
  arguments, and environment variables.
- Start with a dry-run command preview before enabling launch actions.

**Done when:** the desktop client displays the same game identities as the
dashboard and can safely show exactly what it would launch.

## Phase 4 — Launch integrations

Enable launching explicitly configured games, one backend at a time:

1. Native Linux executables.
2. Steam URLs / Steam-owned Proton games.
3. Existing Lutris entries.
4. Explicit Wine or Proton prefix configurations.

No automatic Wine-prefix mutation. Users choose or import a runner
configuration; the app records it and exposes logs for troubleshooting.

**Done when:** launch actions are opt-in, visible, and isolated to the selected
game's configuration.

## Phase 5 — Later enhancements

- Heroic and Bottles importers.
- Artwork and metadata caching.
- Game size and storage-volume reporting.
- Backup/export of per-game launch settings.
- Authorized installer/import workflows, kept separate from library discovery.

## Guardrails

- The dashboard manages metadata and configuration; it does not alter game
  folders during scans.
- The desktop companion never changes a prefix or runner without an explicit
  user action.
- Authentication and access controls are required before exposing game paths or
  launch actions outside the home LAN.
