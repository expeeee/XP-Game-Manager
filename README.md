# XP Game Manager

An early, local-first Windows and Linux desktop framework for browsing installed
Steam games and games kept on a network server.

## What it does today

- Discovers Steam libraries from the current Linux user's standard Steam paths.
- Reads Steam `appmanifest_*.acf` files to list installed games.
- Starts with `/Beta/WindowsGames`, and lets you choose additional local or mounted folders to scan as game libraries.
- Saves selected folder locations in `~/.config/xp-game-manager/settings.json`.
- Saves per-game launch settings in `~/.config/xp-game-manager/game-launchers.json`.
- Lets you record a Proton compatibility rating from 0 (no reported support) to 5 (highest support) per game.
- Provides a command preview before an explicit launch action.
- Launches Steam games through Steam, or explicitly configured games through a native executable, Wine, or GE-Proton through UMU.
- Includes a desktop-only Torbox Downloads tab for user-supplied, authorized magnet links. It submits the link to Torbox, shows processing status, and saves selected completed files to a directory you choose.
- Serves a read-only browser library alongside the desktop app at port `3838`.

## Read-only web library

When Linux Game Manager is running, its browser interface is available on the
home network at `http://<server-ip>:3838/`. It uses the same scanner and saved
folder-library settings as the desktop application. The web interface exposes
only the game inventory; it has no configuration, folder-management, or launch
actions. Its discovery button writes only a local artwork/metadata cache. Torbox
downloads are available only in the desktop app and are never exposed through
the LAN interface.

## Torbox downloads

In the desktop app, open **Downloads**, enter your Torbox API token, select a
local destination folder, and paste a magnet link for content you are authorized
to download. The token is kept using Electron's operating-system credential
storage; it is not written to game folders or shown in download status. Once
Torbox has processed the torrent, choose an individual returned file to save it
to a new subdirectory named after the torrent within the selected directory.
Existing files are never overwritten.

Each Torbox item can be resumed if it is already paused in Torbox, and has a
**Delete** control. Delete removes the item from Torbox and this app's local job
list, but deliberately keeps files already saved on your computer.

Set `LGM_WEB_HOST` or `LGM_WEB_PORT` before starting the app to change the
bind address or port. For example, `LGM_WEB_HOST=127.0.0.1` keeps it available
only on the server itself. Do not expose this unauthenticated inventory outside
your trusted home network.

Use **Discover game info & art** from either interface to cache Steam artwork,
descriptions, genres, and store IDs in `~/.config/linux-game-manager/game-metadata.json`.
Steam games are identified by their app ID; folder games are cached only when
their folder name has an exact Steam-store title match. Discovery never changes
game folders, prefixes, or launcher settings.

## Home-server deployment

The web inventory is served by the Electron process, so it is available only
while Linux Game Manager is running. For a home server, use `LGM_WEB_ONLY=1`
to start the scanner and web server without creating a desktop window.

These instructions assume the service account is `xpchen` and the application
will live in `/home/xpchen/apps/linux-game-manager`. Replace the account, paths,
and LAN subnet to match your server.

### 1. Install and copy the application

On the Linux server, install a supported Node.js LTS release and the normal
Linux runtime libraries required by Electron for your distribution. Copy the
entire project directory to the server (including `package-lock.json`), then
install exactly the locked dependencies:

```bash
mkdir -p /home/xpchen/apps
# Copy from your development machine, or clone your source repository here.
cd /home/xpchen/apps/linux-game-manager
npm ci
```

Mount every Steam/server share before starting the service. The service runs as
the configured user, so that user must be able to read each mount.

### 2. Configure library locations and the web listener

The default Linux folder library is `/Beta/WindowsGames`. To add more mounted
folders without opening the desktop interface, create
`~/.config/linux-game-manager/settings.json` for the service user:

```bash
mkdir -p ~/.config/linux-game-manager
cat > ~/.config/linux-game-manager/settings.json <<'EOF'
{
  "serverLibraries": [
    "/Beta/WindowsGames",
    "/mnt/game-server"
  ]
}
EOF
```

Create the service environment file. Binding to `0.0.0.0` makes the site
available on the trusted LAN; use `127.0.0.1` when it should be reachable only
through a reverse proxy or on the server itself.

```bash
cat > ~/.config/linux-game-manager/web.env <<'EOF'
LGM_WEB_ONLY=1
LGM_WEB_HOST=0.0.0.0
LGM_WEB_PORT=3838
EOF
```

### 3. Install the systemd user service

The included service file assumes the application path above. Copy it into the
service user's systemd configuration, then enable it:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/linux-game-manager-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now linux-game-manager-web.service
```

To keep the user service running after logout and across server reboots, an
administrator must enable lingering once:

```bash
sudo loginctl enable-linger xpchen
```

### 4. Restrict network access and verify

Allow TCP port 3838 only from your LAN in the server firewall. For example, on
a UFW server whose home subnet is `192.168.1.0/24`:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 3838 proto tcp
```

Verify locally, then open the same URL using the server's LAN address:

```bash
curl http://127.0.0.1:3838/api/games
systemctl --user status linux-game-manager-web.service
journalctl --user -u linux-game-manager-web.service -f
```

Visit `http://<server-ip>:3838/` from a LAN browser. The API and UI are
read-only, but they reveal game names and filesystem paths, so do not port
forward this service or expose it to the public internet without adding
authentication and TLS.

### Updating or recovering

Before an update, back up `~/.config/linux-game-manager/`; it contains folder
and launcher settings. Replace the application files, run `npm ci`, then run
`systemctl --user restart linux-game-manager-web.service`. If a scan shows no
games, first verify the mounts and their permissions as the service user.

## Server folders on Linux

Mount the server share first (SMB/NFS/etc.), then choose the resulting local
mount path in the app, for example `/mnt/game-server`. The application only
reads the mounted directory; it does not handle server credentials or mounts.

## Launcher prototype

Select a game card to open its launcher panel. Steam cards default to Steam's
own Proton configuration. For a non-Steam game, choose an executable and save
an explicit runner configuration before launching. Wine settings support a
custom binary and `WINEPREFIX`; Proton settings require a GE-Proton directory, an installed UMU launcher,
and a local Wine prefix. On Linux, **Global Proton settings** can install
or update the latest GE-Proton release after verifying its SHA-512 checksum.
It configures GE-Proton to run non-Steam titles through `umu-run`, which
provides the Steam-compatible container runtime GE-Proton requires. The same
panel provides defaults for the GE-Proton directory, UMU launcher, and
compatibility-data root; each non-Steam game receives its own Wine prefix
below that root. The compatibility rating is informational and is shown by
both interfaces.

Discovery and saving a folder game's launcher write portable facts to
`<game folder>/.linux-game-manager.json`: relative Windows executable and
working-directory paths, arguments, supported platforms, and a known Steam App
ID. The Proton tool and compatibility-data paths remain local to the Linux host.

## Run

```bash
npm install
npm run dev
```

Electron builds need the normal Linux desktop dependencies available on the
host. This scaffold has intentionally kept the backend small so Steam, Lutris,
Heroic, Bottles, and per-game launch integrations can be added independently.

## Proton troubleshooting and verification

Install `umu-launcher` using your distribution's package manager before launching
non-Steam Windows games with Proton. In Global Proton settings, enter the full
path to `umu-run` if it is unavailable in the desktop session's PATH. Install
GE-Proton, then select Proton in the game's launcher and choose the executable.
The default prefix is stored locally, separately for each game.

Arguments support quoted values, empty arguments, and escaped spaces. Leading
assignments such as `PROTON_LOG=1 UMU_LOG=1 --windowed` set environment variables;
assignments after the first argument are passed to the game. Store metadata used
for artwork does not select the UMU storefront. Set Store Context to the actual
store (`steam`, `gog`, or `egs`) and use a UMU database ID for game-specific fixes.

Downloads have a timeout and enter the cache only after completion. GE-Proton
archives are checksum verified, extracted into staging, and validated before
installation. An incomplete existing installation produces an error asking you
to move it aside; it is not silently overwritten. Launcher startup errors are
reported before the app announces a running process.

Run `npm test` for launcher regression checks. Hardware Vulkan capability checks,
a first-run setup wizard, automatic UMU database lookup, global version
inheritance, and prefix backup/repair remain future improvements.
