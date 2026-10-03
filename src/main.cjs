const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const SETTINGS_DIR = process.platform === 'win32'
  ? app.getPath('userData')
  : path.join(app.getPath('home'), '.config', 'xp-game-manager');
const LEGACY_SETTINGS_DIR = process.platform === 'win32' ? path.join(app.getPath('appData'), 'linux-game-manager') : path.join(app.getPath('home'), '.config', 'linux-game-manager');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
const GAME_SETTINGS_FILE = path.join(SETTINGS_DIR, 'game-launchers.json');
const GAME_METADATA_FILE = path.join(SETTINGS_DIR, 'game-metadata.json');
const TORBOX_SECRET_FILE = path.join(SETTINGS_DIR, 'torbox-secret.bin');
const TORBOX_JOBS_FILE = path.join(SETTINGS_DIR, 'torbox-jobs.json');
const GAME_MANIFEST_FILE = '.linux-game-manager.json';
const DEFAULT_FOLDER_LIBRARIES = process.platform === 'win32' ? [] : ['/Beta/WindowsGames'];
const WEB_ROOT = path.join(__dirname, 'web');
const WEB_HOST = process.env.XPGM_WEB_HOST || process.env.LGM_WEB_HOST || '0.0.0.0';
const WEB_PORT = Number.parseInt(process.env.XPGM_WEB_PORT || process.env.LGM_WEB_PORT || '3838', 10);
const WEB_ONLY = process.env.XPGM_WEB_ONLY === '1' || process.env.LGM_WEB_ONLY === '1';
let metadataDiscovery = null;
let legacySettingsMigrated = false;
const torboxDownloadLocks = new Set();
let torboxJobWriteQueue = Promise.resolve();
async function migrateLegacySettings() { if (legacySettingsMigrated || LEGACY_SETTINGS_DIR === SETTINGS_DIR) return; legacySettingsMigrated = true; for (const filename of ['settings.json', 'game-launchers.json', 'game-metadata.json']) { try { await fs.access(path.join(SETTINGS_DIR, filename)); } catch { try { await fs.mkdir(SETTINGS_DIR, { recursive: true }); await fs.copyFile(path.join(LEGACY_SETTINGS_DIR, filename), path.join(SETTINGS_DIR, filename)); } catch {} } } }

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#111827',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/www\.protondb\.com\/app\/\d+\/?$/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function readSettings() {
  await migrateLegacySettings();
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
  } catch { return { serverLibraries: DEFAULT_FOLDER_LIBRARIES }; }
}

async function saveSettings(settings) {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function secureStorageAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

async function readTorboxToken() {
  if (!secureStorageAvailable()) return '';
  try {
    const encrypted = await fs.readFile(TORBOX_SECRET_FILE);
    return safeStorage.decryptString(encrypted);
  } catch { return ''; }
}

async function saveTorboxToken(token) {
  if (!secureStorageAvailable()) throw new Error('Secure credential storage requires an available operating-system keyring on this computer.');
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(TORBOX_SECRET_FILE, safeStorage.encryptString(token.trim()), { mode: 0o600 });
}

async function readTorboxJobs() {
  try { const jobs = JSON.parse(await fs.readFile(TORBOX_JOBS_FILE, 'utf8')); return Array.isArray(jobs) ? jobs : []; }
  catch { return []; }
}

async function saveTorboxJobs(jobs) {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(TORBOX_JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function updateTorboxJobs(update) {
  const work = torboxJobWriteQueue.then(async () => {
    const jobs = await readTorboxJobs();
    const result = await update(jobs);
    await saveTorboxJobs(jobs);
    return result;
  });
  torboxJobWriteQueue = work.catch(() => {});
  return work;
}

async function readGameSettings() {
  await migrateLegacySettings();
  try { return JSON.parse(await fs.readFile(GAME_SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

async function saveGameSettings(settings) {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(GAME_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

async function readGameMetadata() {
  await migrateLegacySettings();
  try { return JSON.parse(await fs.readFile(GAME_METADATA_FILE, 'utf8')); }
  catch { return {}; }
}

async function saveGameMetadata(metadata) {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(GAME_METADATA_FILE, JSON.stringify(metadata, null, 2));
}

async function directoryExists(candidate) {
  try { return (await fs.stat(candidate)).isDirectory(); } catch { return false; }
}

function protonSettings(settings) {
  return {
    protonPath: typeof settings.protonPath === 'string' ? settings.protonPath : '',
    umuPath: typeof settings.umuPath === 'string' && settings.umuPath ? settings.umuPath : 'umu-run',
    compatDataRoot: typeof settings.compatDataRoot === 'string' && settings.compatDataRoot
      ? settings.compatDataRoot
      : path.join(app.getPath('home'), '.local', 'share', 'xp-game-manager', 'compatdata')
  };
}

async function existingDirectory(candidate) {
  return (await directoryExists(candidate)) ? candidate : '';
}

async function geProtonInstallRoot() {
  const home = app.getPath('home');
  const steamRoots = [
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam')
  ];
  for (const root of steamRoots) if (await existingDirectory(root)) return path.join(root, 'compatibilitytools.d');
  return path.join(steamRoots[0], 'compatibilitytools.d');
}

async function sha512File(filename) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fsSync.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { headers: { 'User-Agent': 'XP Game Manager GE-Proton installer' } });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(destination));
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}.`)));
  });
}

async function installLatestGeProton() {
  if (process.platform !== 'linux') throw new Error('GE-Proton installation is only available on Linux.');
  const releaseResponse = await fetch('https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'XP Game Manager GE-Proton installer' } });
  if (!releaseResponse.ok) throw new Error(`Could not fetch the latest GE-Proton release (${releaseResponse.status}).`);
  const release = await releaseResponse.json();
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : '';
  if (!arch) throw new Error(`Unsupported architecture: ${process.arch}.`);
  const archive = release.assets?.find((asset) => new RegExp(`-${arch}\\.tar\\.gz$`).test(asset.name));
  if (!archive) throw new Error(`No ${arch} GE-Proton archive was found in the latest release.`);
  const checksum = release.assets?.find((asset) => asset.name === `${archive.name}.sha512sum`);
  if (!checksum) throw new Error('The latest GE-Proton release does not include a SHA-512 checksum for this archive.');
  const installRoot = await geProtonInstallRoot();
  const releaseName = archive.name.replace(/\.tar\.gz$/, '');
  const installDirectory = path.join(installRoot, releaseName);
  try { await fs.access(path.join(installDirectory, 'proton')); return { version: releaseName, protonPath: installDirectory, alreadyInstalled: true }; } catch {}
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'xp-game-manager-ge-'));
  try {
    const archivePath = path.join(tempDirectory, archive.name);
    const checksumPath = path.join(tempDirectory, checksum.name);
    await Promise.all([downloadFile(archive.browser_download_url, archivePath), downloadFile(checksum.browser_download_url, checksumPath)]);
    const expected = (await fs.readFile(checksumPath, 'utf8')).match(/^[a-fA-F0-9]{128}/m)?.[0]?.toLowerCase();
    if (!expected || await sha512File(archivePath) !== expected) throw new Error('GE-Proton checksum verification failed. Nothing was installed.');
    await fs.mkdir(installRoot, { recursive: true });
    await runCommand('tar', ['-xzf', archivePath, '-C', installRoot]);
    await fs.access(path.join(installDirectory, 'proton'));
    return { version: releaseName, protonPath: installDirectory, alreadyInstalled: false };
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

function gameCompatDataPath(root, gameId) {
  const key = crypto.createHash('sha256').update(gameId).digest('hex').slice(0, 16);
  return path.join(root, key);
}

function relativeGamePath(gamePath, candidate) {
  if (typeof candidate !== 'string' || !candidate) return '';
  const relative = path.relative(gamePath, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative : '';
}

function resolveGamePath(gamePath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || /^[a-z]:[\\/]/i.test(relativePath)) return '';
  const resolved = path.resolve(gamePath, relativePath);
  return relativeGamePath(gamePath, resolved) ? resolved : '';
}

async function readGameManifestDocument(gamePath) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(gamePath, GAME_MANIFEST_FILE), 'utf8'));
    return manifest && typeof manifest === 'object' ? manifest : {};
  } catch { return {}; }
}

async function readGameManifest(gamePath) {
  try {
    const manifest = await readGameManifestDocument(gamePath);
    const executable = resolveGamePath(gamePath, manifest.windows?.executable);
    const workingDirectory = resolveGamePath(gamePath, manifest.windows?.workingDirectory || '.') || gamePath;
    return {
      sharedSteamAppId: /^\d+$/.test(String(manifest.steamAppId || '')) ? String(manifest.steamAppId) : '',
      sharedExecutable: executable,
      sharedWorkingDirectory: workingDirectory,
      sharedArguments: Array.isArray(manifest.windows?.arguments) && manifest.windows.arguments.every((item) => typeof item === 'string') ? manifest.windows.arguments : [],
      sharedRunsOn: manifest.runsOn && typeof manifest.runsOn === 'object' ? { windows: Boolean(manifest.runsOn.windows), linux: Boolean(manifest.runsOn.linux) } : null
    };
  } catch { return {}; }
}

async function writeGameManifest(game, configuration) {
  if (game?.source !== 'Server folder' || typeof game.path !== 'string') return;
  const executable = relativeGamePath(game.path, configuration.executable);
  if (!executable) return;
  const workingDirectory = relativeGamePath(game.path, configuration.workingDirectory) || '.';
  const current = await readGameManifestDocument(game.path);
  const manifest = {
    schemaVersion: 1,
    ...current,
    ...(current.steamAppId || game.storeAppId ? { steamAppId: current.steamAppId || game.storeAppId } : {}),
    windows: { executable, workingDirectory, arguments: splitArguments(configuration.arguments || '') },
    runsOn: configuration.runsOn && typeof configuration.runsOn === 'object' ? { windows: Boolean(configuration.runsOn.windows), linux: Boolean(configuration.runsOn.linux) } : { windows: true, linux: false }
  };
  await fs.writeFile(path.join(game.path, GAME_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function discoverSteamLibraries() {
  const home = os.homedir();
  const linuxRoots = [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.local', 'share', 'Steam')
  ];
  const windowsRoots = [
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Steam'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Steam'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Steam')
  ].filter(Boolean);
  const roots = process.platform === 'win32' ? windowsRoots : linuxRoots;
  const libraries = new Set();
  for (const root of roots) {
    if (!(await directoryExists(root))) continue;
    libraries.add(root);
    try {
      const contents = await fs.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const match of contents.matchAll(/"path"\s+"([^"]+)"/g)) {
        libraries.add(path.normalize(match[1].replace(/\\\\/g, path.sep)));
      }
    } catch { /* A primary Steam library does not need this optional file. */ }
  }
  return [...libraries];
}

function acfValue(content, key) {
  const match = content.match(new RegExp(`"${key}"\\s+"([^"]*)"`));
  return match?.[1];
}

async function scanSteam() {
  const libraries = await discoverSteamLibraries();
  const games = [];
  for (const library of libraries) {
    const steamapps = path.join(library, 'steamapps');
    let entries = [];
    try { entries = await fs.readdir(steamapps); } catch { continue; }
    for (const file of entries.filter((name) => /^appmanifest_\d+\.acf$/.test(name))) {
      try {
        const manifest = await fs.readFile(path.join(steamapps, file), 'utf8');
        const id = acfValue(manifest, 'appid');
        const name = acfValue(manifest, 'name');
        const installDir = acfValue(manifest, 'installdir');
        if (!id || !name || !installDir) continue;
        const gamePath = path.join(steamapps, 'common', installDir);
        games.push({ id: `steam:${id}`, name, source: 'Steam', path: gamePath, appId: id, artUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`, available: await directoryExists(gamePath) });
      } catch { /* Ignore one malformed manifest and preserve the rest of the library. */ }
    }
  }
  return { libraries, games };
}

async function scanFolder(root) {
  const games = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith('.'))) {
      const gamePath = path.join(root, entry.name);
      games.push({ id: `folder:${gamePath}`, name: entry.name, source: 'Server folder', path: gamePath, available: true, ...(await readGameManifest(gamePath)) });
    }
  } catch (error) {
    return { root, games, error: error.code === 'EACCES' ? 'Permission denied' : 'Folder is unavailable' };
  }
  return { root, games, error: null };
}

async function findSuggestedExecutable(root) {
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const { directory, depth } = queue.shift(); let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 250)) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && /\.exe$/i.test(entry.name)) return candidate;
      if (entry.isDirectory() && depth < 3 && !entry.name.startsWith('.')) queue.push({ directory: candidate, depth: depth + 1 });
    }
  }
  return '';
}

function plainText(value) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 700) : '';
}

function metadataFromStore(appId, data) {
  return {
    storeAppId: String(appId),
    artUrl: typeof data.header_image === 'string' ? data.header_image : '',
    description: plainText(data.short_description),
    genres: Array.isArray(data.genres) ? data.genres.map((genre) => genre?.description).filter(Boolean).slice(0, 5) : [],
    discoveredAt: new Date().toISOString()
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Linux Game Manager metadata scanner' } });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

async function storeMetadata(appId) {
  if (!/^\d+$/.test(String(appId))) return null;
  const payload = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&l=english&cc=US`);
  const result = payload?.[appId];
  return result?.success && result.data ? metadataFromStore(appId, result.data) : null;
}

async function findStoreAppId(title) {
  const payload = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=US`);
  const normalized = title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const match = payload?.items?.find((item) => item?.name?.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === normalized);
  return match?.id ? String(match.id) : null;
}

async function discoverGameMetadata() {
  if (metadataDiscovery) return metadataDiscovery;
  metadataDiscovery = (async () => {
    const library = await loadLibrary();
    const games = [...library.steam.games, ...library.folders.flatMap((folder) => folder.games)];
    const metadata = await readGameMetadata();
    const candidates = games.filter((game) => !metadata[game.id]);
    let discovered = 0; let unmatched = 0;
    let index = 0;
    const workers = Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (index < candidates.length) {
        const game = candidates[index++];
        const appId = game.appId || await findStoreAppId(game.name);
        const details = appId ? await storeMetadata(appId) : null;
        if (details) {
          if (game.source === 'Server folder') {
            details.suggestedExecutable = await findSuggestedExecutable(game.path);
            if (details.suggestedExecutable) {
              try {
                await writeGameManifest({ ...game, storeAppId: details.storeAppId }, {
                  executable: details.suggestedExecutable,
                  workingDirectory: game.path,
                  arguments: '',
                  runsOn: { windows: true, linux: false }
                });
              } catch { /* Discovery remains useful for read-only library mounts. */ }
            }
          }
          metadata[game.id] = details;
          discovered += 1;
        } else unmatched += 1;
      }
    });
    await Promise.all(workers);
    await saveGameMetadata(metadata);
    return { discovered, skipped: games.length - candidates.length, unmatched, total: games.length };
  })();
  try { return await metadataDiscovery; }
  finally { metadataDiscovery = null; }
}

async function applyStoreAppId(game, appId) {
  if (!game || typeof game.id !== 'string') throw new Error('Choose a game before fetching metadata.');
  const pasted = String(appId || '').trim();
  const match = pasted.match(/(?:^|\/app\/)(\d+)(?:\D|$)/);
  const resolvedAppId = match?.[1] || (pasted ? null : await findStoreAppId(game.name));
  if (!resolvedAppId) throw new Error(pasted ? 'Enter a numeric Steam App ID or a Steam Store app URL.' : `No exact Steam Store match was found for “${game.name}”. Enter its App ID manually.`);
  const details = await storeMetadata(resolvedAppId);
  if (!details) throw new Error('Steam did not return metadata for that App ID. Check that it is a game App ID.');
  if (game.source === 'Server folder' && typeof game.path === 'string') details.suggestedExecutable = await findSuggestedExecutable(game.path);
  const metadata = await readGameMetadata();
  metadata[game.id] = details;
  await saveGameMetadata(metadata);
  return details;
}

async function loadLibrary() {
  const settings = await readSettings();
  const globalProton = protonSettings(settings);
  const steam = await scanSteam();
  const folders = await Promise.all((settings.serverLibraries || []).map(scanFolder));
  const gameSettings = await readGameSettings();
  const gameMetadata = await readGameMetadata();
  const attachCompatibility = (game) => {
    const metadata = gameMetadata[game.id] || {};
    const steamAppId = game.appId || metadata.storeAppId || game.sharedSteamAppId;
    return {
      ...game,
      ...metadata,
      artUrl: metadata.artUrl || game.artUrl,
      storeAppId: metadata.storeAppId || game.sharedSteamAppId,
      suggestedExecutable: game.sharedExecutable || metadata.suggestedExecutable,
      suggestedWorkingDirectory: game.sharedWorkingDirectory || game.path,
      suggestedArguments: game.sharedArguments || [],
      protonCompatibility: Number.isInteger(gameSettings[game.id]?.protonCompatibility)
        ? gameSettings[game.id].protonCompatibility
        : 0,
      runsOn: gameSettings[game.id]?.runsOn || game.sharedRunsOn || { windows: true, linux: true },
      defaultCompatDataPath: gameCompatDataPath(globalProton.compatDataRoot, game.id),
      protonDbUrl: process.platform === 'linux' && /^\d+$/.test(String(steamAppId || ''))
        ? `https://www.protondb.com/app/${steamAppId}`
        : undefined
    };
  };
  return {
    hostPlatform: process.platform,
    protonSettings: process.platform === 'linux' ? globalProton : null,
    steam: { ...steam, games: steam.games.map(attachCompatibility) },
    folders: folders.map((folder) => ({ ...folder, games: folder.games.map(attachCompatibility) })),
    serverLibraries: settings.serverLibraries || []
  };
}

function writeWebResponse(response, status, body, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cdn.akamai.steamstatic.com https://shared.akamai.steamstatic.com data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(body);
}

async function serveReadOnlyWeb(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/api/discover') {
    try {
      const body = JSON.stringify(await discoverGameMetadata());
      writeWebResponse(response, 200, body, 'application/json; charset=utf-8');
    } catch {
      writeWebResponse(response, 500, JSON.stringify({ error: 'Game discovery could not be completed.' }), 'application/json; charset=utf-8');
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeWebResponse(response, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    return;
  }
  if (url.pathname === '/api/games') {
    try {
      const body = JSON.stringify(await loadLibrary());
      writeWebResponse(response, 200, request.method === 'HEAD' ? '' : body, 'application/json; charset=utf-8');
    } catch {
      writeWebResponse(response, 500, JSON.stringify({ error: 'Unable to scan the game library.' }), 'application/json; charset=utf-8');
    }
    return;
  }
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
  const asset = assets[url.pathname];
  if (!asset) {
    writeWebResponse(response, 404, 'Not found', 'text/plain; charset=utf-8');
    return;
  }
  try {
    const body = await fs.readFile(path.join(WEB_ROOT, asset[0]));
    writeWebResponse(response, 200, request.method === 'HEAD' ? '' : body, asset[1]);
  } catch {
    writeWebResponse(response, 500, 'Web interface is unavailable', 'text/plain; charset=utf-8');
  }
}

function startReadOnlyWebServer() {
  if (!Number.isInteger(WEB_PORT) || WEB_PORT < 1 || WEB_PORT > 65535) throw new Error('LGM_WEB_PORT must be between 1 and 65535.');
  const server = http.createServer((request, response) => { void serveReadOnlyWeb(request, response); });
  server.on('error', (error) => console.error(`Read-only web library could not start: ${error.message}`));
  server.listen(WEB_PORT, WEB_HOST, () => {
    const addresses = Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal).map((item) => item.address);
    const urls = WEB_HOST === '0.0.0.0' ? addresses.map((address) => `http://${address}:${WEB_PORT}/`) : [`http://${WEB_HOST}:${WEB_PORT}/`];
    console.log(`Read-only web game library available at ${urls.join(', ') || `http://localhost:${WEB_PORT}/`}`);
  });
  return server;
}

const TORBOX_API = 'https://api.torbox.app/v1/api';

function torboxError(payload, fallback) {
  return payload?.detail || payload?.error || payload?.message || fallback;
}

async function torboxRequest(endpoint, options = {}, tokenOverride = '') {
  const token = tokenOverride || await readTorboxToken();
  if (!token) throw new Error('Connect Torbox with an API token before adding a download.');
  const response = await fetch(`${TORBOX_API}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* Torbox errors are normally JSON. */ }
  if (!response.ok || payload?.success === false) throw new Error(torboxError(payload, `Torbox request failed (${response.status}).`));
  return payload?.data ?? payload;
}

function torboxFiles(item) {
  const files = Array.isArray(item?.files) ? item.files : [];
  return files.map((file, index) => ({
    id: Number.isInteger(file?.id) ? file.id : index,
    name: typeof file?.name === 'string' ? file.name : typeof file?.short_name === 'string' ? file.short_name : `File ${index + 1}`,
    size: Number(file?.size || 0),
    mimeType: typeof file?.mimetype === 'string' ? file.mimetype : ''
  }));
}

function torboxJob(item, current = {}) {
  const { magnet: _magnet, ...safeCurrent } = current;
  const id = Number(item?.id ?? item?.torrent_id ?? current.torrentId);
  if (!Number.isInteger(id) || id < 1) throw new Error('Torbox did not return a usable torrent ID.');
  return {
    ...safeCurrent,
    torrentId: id,
    name: typeof item?.name === 'string' ? item.name : current.name || `Torrent ${id}`,
    status: String(item?.download_state || item?.status || current.status || 'queued'),
    progress: Number(item?.progress ?? current.progress ?? 0),
    files: torboxFiles(item).length ? torboxFiles(item) : (current.files || []),
    updatedAt: new Date().toISOString()
  };
}

function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function resolveTorboxDestination(job) {
  const configuredRoot = job.destinationRoot || path.dirname(job.destination || '');
  if (!configuredRoot || !job.destination) throw new Error('This download has no valid destination directory.');
  let root;
  let destination;
  try { root = await fs.realpath(configuredRoot); destination = await fs.realpath(job.destination); }
  catch { throw new Error('Choose an available destination directory before downloading files.'); }
  if (!isContainedPath(root, destination)) throw new Error('The download directory is outside its selected destination.');
  return { destination };
}

function validateMagnet(value) {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Paste a valid magnet link.');
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new Error('Paste a valid magnet link.'); }
  if (parsed.protocol !== 'magnet:' || !parsed.searchParams.get('xt')) throw new Error('Paste a valid magnet link with an info hash.');
  return value.trim();
}

async function getTorboxItems(id) {
  const query = id ? `?id=${encodeURIComponent(id)}` : '?limit=1000';
  const data = await torboxRequest(`/torrents/mylist${query}`);
  return Array.isArray(data) ? data : Array.isArray(data?.torrents) ? data.torrents : data ? [data] : [];
}

async function refreshTorboxJobs() {
  const jobs = await readTorboxJobs();
  if (!jobs.length) return jobs;
  const items = await getTorboxItems();
  const byId = new Map(items.map((item) => [Number(item?.id ?? item?.torrent_id), item]));
  return updateTorboxJobs((currentJobs) => {
    const refreshed = currentJobs.map((job) => byId.has(job.torrentId) ? torboxJob(byId.get(job.torrentId), job) : job);
    currentJobs.splice(0, currentJobs.length, ...refreshed);
    return refreshed;
  });
}

function safeDownloadName(name, fallback) {
  const base = path.basename(String(name || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : fallback;
}

async function recordTorboxFileSaved(torrentId, fileId, result) {
  await updateTorboxJobs((jobs) => {
    const job = jobs.find((item) => item.torrentId === torrentId);
    if (job) job.savedFiles = { ...(job.savedFiles || {}), [fileId]: { name: result.name, destination: result.destination, completedAt: new Date().toISOString() } };
  });
}

async function downloadTorboxFileFromJob(job, fileId, report = null) {
  const { destination: downloadDirectory } = await resolveTorboxDestination(job);
  const file = job.files.find((item) => item.id === Number(fileId));
  if (!file) throw new Error('Torbox did not return that file. Refresh the download first.');
  const lockKey = `${job.torrentId}:${file.id}`;
  if (torboxDownloadLocks.has(lockKey)) throw new Error('This file is already being saved.');
  torboxDownloadLocks.add(lockKey);
  try {
  const token = await readTorboxToken();
  if (!token) throw new Error('Connect Torbox with an API token before downloading files.');
  const link = new URL(`${TORBOX_API}/torrents/requestdl`);
  link.searchParams.set('token', token);
  link.searchParams.set('torrent_id', String(job.torrentId));
  link.searchParams.set('file_id', String(file.id));
  const response = await fetch(link, { redirect: 'follow' });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) throw new Error(torboxError(payload, `Torbox download-link request failed (${response.status}).`));
  const downloadUrl = typeof (payload?.data ?? payload) === 'string' ? (payload.data ?? payload) : (payload?.data?.url || payload?.url);
  if (!downloadUrl || !/^https:\/\//i.test(downloadUrl)) throw new Error('Torbox did not return a usable download link.');
  const destination = path.resolve(downloadDirectory, safeDownloadName(file.name, `torbox-${job.torrentId}-${file.id}`));
  if (path.dirname(destination) !== downloadDirectory) throw new Error('The requested file name is unsafe.');
  try { await fs.access(destination); throw new Error(`${path.basename(destination)} already exists. Rename or move it before downloading.`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const partial = `${destination}.${crypto.randomUUID()}.part`;
  const fileResponse = await fetch(downloadUrl, { redirect: 'follow' });
  if (!fileResponse.ok || !fileResponse.body) throw new Error(`The Torbox download failed (${fileResponse.status}).`);
  const totalBytes = Number.parseInt(fileResponse.headers.get('content-length') || '', 10) || file.size || 0;
  let receivedBytes = 0;
  report?.({ state: 'downloading', torrentId: job.torrentId, fileId: file.id, receivedBytes, totalBytes });
  const counter = new Transform({ transform(chunk, encoding, callback) {
    receivedBytes += chunk.length;
    report?.({ state: 'downloading', torrentId: job.torrentId, fileId: file.id, receivedBytes, totalBytes });
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(fileResponse.body), counter, fsSync.createWriteStream(partial, { flags: 'wx' }));
    await fs.rename(partial, destination);
  } catch (error) {
    try { await fs.rm(partial, { force: true }); } catch {}
    throw error;
  }
  const result = { name: path.basename(destination), destination, bytes: receivedBytes || totalBytes };
  await recordTorboxFileSaved(job.torrentId, file.id, result);
  report?.({ state: 'done', torrentId: job.torrentId, fileId: file.id, receivedBytes: result.bytes, totalBytes: totalBytes || result.bytes });
  return result;
  } finally {
    torboxDownloadLocks.delete(lockKey);
  }
}

async function downloadTorboxFile(jobId, fileId, report = null) {
  const jobs = await refreshTorboxJobs();
  const job = jobs.find((item) => item.torrentId === Number(jobId));
  if (!job) throw new Error('That Torbox download is not tracked by this app.');
  return downloadTorboxFileFromJob(job, fileId, report);
}

async function downloadAllTorboxFiles(jobId, report = null) {
  const jobs = await refreshTorboxJobs();
  const job = jobs.find((item) => item.torrentId === Number(jobId));
  if (!job) throw new Error('That Torbox download is not tracked by this app.');
  if (!job.files.length) throw new Error('Torbox has not returned any files for this download yet.');
  const pendingFiles = job.files.filter((file) => !job.savedFiles?.[file.id]);
  if (!pendingFiles.length) return [];
  const totalBytes = pendingFiles.reduce((total, file) => total + Number(file.size || 0), 0);
  let completedBytes = 0;
  const reportOverall = (progress) => {
    const effectiveTotal = totalBytes || progress.totalBytes || 0;
    report?.({ ...progress, overallReceivedBytes: completedBytes + progress.receivedBytes, overallTotalBytes: effectiveTotal });
  };
  const results = [];
  for (const file of pendingFiles) {
    try {
      const result = await downloadTorboxFileFromJob(job, file.id, reportOverall);
      completedBytes += result.bytes || file.size || 0;
      report?.({ state: 'overall', torrentId: job.torrentId, overallReceivedBytes: completedBytes, overallTotalBytes: totalBytes });
      results.push({ fileId: file.id, name: file.name, ...result, error: '' });
    } catch (error) {
      report?.({ state: 'failed', torrentId: job.torrentId, fileId: file.id, error: error.message || 'Unable to save this file.' });
      results.push({ fileId: file.id, name: file.name, error: error.message || 'Unable to save this file.' });
    }
  }
  const failures = results.filter((result) => result.error).length;
  report?.({ state: failures ? 'failed' : 'done', torrentId: job.torrentId, overallReceivedBytes: completedBytes, overallTotalBytes: totalBytes, error: failures ? `${failures} file${failures === 1 ? '' : 's'} could not be saved.` : '' });
  return results;
}

async function controlTorboxTorrent(torrentId, operation) {
  const id = Number(torrentId);
  if (!Number.isInteger(id) || id < 1) throw new Error('Choose a valid Torbox download.');
  if (!['reannounce', 'resume', 'delete'].includes(operation)) throw new Error('Unsupported Torbox control operation.');
  await torboxRequest('/torrents/controltorrent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ torrent_id: id, operation })
  });
  const jobs = await readTorboxJobs();
  if (operation === 'delete') {
    await saveTorboxJobs(jobs.filter((job) => job.torrentId !== id));
    return { deleted: true };
  }
  const job = jobs.find((item) => item.torrentId === id);
  if (job) {
    job.status = operation === 'resume' ? 'queued' : job.status;
    job.updatedAt = new Date().toISOString();
    await saveTorboxJobs(jobs);
  }
  return { deleted: false, status: job?.status || '' };
}

ipcMain.handle('library:load', loadLibrary);
ipcMain.handle('library:discover-metadata', discoverGameMetadata);
ipcMain.handle('library:apply-store-app-id', async (_event, game, appId) => applyStoreAppId(game, appId));

ipcMain.handle('library:choose-folder', async () => {
  const result = await dialog.showOpenDialog({ title: 'Choose a mounted game library folder', properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('library:add-folder', async (_event, folder) => {
  if (typeof folder !== 'string' || !(await directoryExists(folder))) throw new Error('That folder is unavailable. Mount the server share, then choose its local mount path.');
  const settings = await readSettings();
  settings.serverLibraries = [...new Set([...(settings.serverLibraries || []), folder])];
  await saveSettings(settings);
  return settings.serverLibraries;
});

ipcMain.handle('library:remove-folder', async (_event, folder) => {
  const settings = await readSettings();
  settings.serverLibraries = (settings.serverLibraries || []).filter((item) => item !== folder);
  await saveSettings(settings);
  return settings.serverLibraries;
});

ipcMain.handle('torbox:get-settings', async () => {
  const settings = await readSettings();
  return { connected: Boolean(await readTorboxToken()), destination: typeof settings.torboxDownloadDirectory === 'string' ? settings.torboxDownloadDirectory : '' };
});

ipcMain.handle('torbox:save-settings', async (_event, configuration) => {
  if (!configuration || typeof configuration !== 'object') throw new Error('Invalid Torbox settings.');
  const token = typeof configuration.token === 'string' ? configuration.token.trim() : '';
  if (token) { await torboxRequest('/user/me', {}, token); await saveTorboxToken(token); }
  const settings = await readSettings();
  settings.torboxDownloadDirectory = typeof configuration.destination === 'string' ? configuration.destination.trim() : '';
  await saveSettings(settings);
  return { connected: Boolean(await readTorboxToken()), destination: settings.torboxDownloadDirectory };
});

ipcMain.handle('torbox:choose-directory', async () => {
  const result = await dialog.showOpenDialog({ title: 'Choose Torbox download directory', properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('torbox:add-magnet', async (_event, configuration) => {
  const magnet = validateMagnet(configuration?.magnet);
  const destinationRoot = typeof configuration?.destination === 'string' ? configuration.destination.trim() : '';
  if (!destinationRoot || !(await directoryExists(destinationRoot))) throw new Error('Choose an available download directory.');
  try { await fs.access(destinationRoot, fsSync.constants.W_OK); }
  catch { throw new Error('Choose a writable download directory.'); }
  const body = new FormData();
  body.set('magnet', magnet);
  body.set('seed', '0');
  body.set('allow_zip', 'false');
  body.set('as_queued', 'false');
  const created = await torboxRequest('/torrents/createtorrent', { method: 'POST', body });
  const candidate = Array.isArray(created) ? created[0] : created;
  const job = torboxJob(candidate, { status: 'queued', files: [] });
  const root = await fs.realpath(destinationRoot);
  const destination = path.resolve(root, `${safeDownloadName(job.name, 'torbox')}-${job.torrentId}`);
  if (!isContainedPath(root, destination)) throw new Error('Torbox returned an unsafe torrent name.');
  const jobs = await readTorboxJobs();
  const index = jobs.findIndex((item) => item.torrentId === job.torrentId);
  if (index >= 0) return jobs[index];
  try { await fs.mkdir(destination); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('A download directory for this Torbox item already exists. Choose a different destination directory.');
    throw error;
  }
  const resolvedDestination = await fs.realpath(destination);
  if (!isContainedPath(root, resolvedDestination)) throw new Error('The Torbox download directory must not be a symbolic link.');
  job.destinationRoot = root;
  job.destination = resolvedDestination;
  jobs.unshift(job);
  await saveTorboxJobs(jobs);
  return job;
});

ipcMain.handle('torbox:list', async () => refreshTorboxJobs());
ipcMain.handle('torbox:download-file', async (event, jobId, fileId) => {
  const report = (progress) => event.sender.send('torbox:progress', progress);
  try { return await downloadTorboxFile(jobId, fileId, report); }
  catch (error) { report({ state: 'failed', torrentId: Number(jobId), fileId: Number(fileId), error: error.message || 'Unable to save this file.' }); throw error; }
});
ipcMain.handle('torbox:download-all-files', async (event, jobId) => downloadAllTorboxFiles(jobId, (progress) => event.sender.send('torbox:progress', progress)));
ipcMain.handle('torbox:control', async (_event, torrentId, operation) => controlTorboxTorrent(torrentId, operation));

ipcMain.handle('settings:save-proton', async (_event, configuration) => {
  if (process.platform !== 'linux') throw new Error('Global Proton settings are only available on Linux.');
  if (!configuration || typeof configuration !== 'object') throw new Error('Invalid Proton settings.');
  const settings = await readSettings();
  settings.protonPath = typeof configuration.protonPath === 'string' ? configuration.protonPath.trim() : '';
  settings.umuPath = typeof configuration.umuPath === 'string' ? configuration.umuPath.trim() : 'umu-run';
  settings.compatDataRoot = typeof configuration.compatDataRoot === 'string' ? configuration.compatDataRoot.trim() : '';
  await saveSettings(settings);
  return protonSettings(settings);
});

ipcMain.handle('settings:install-ge-proton', async () => {
  const installed = await installLatestGeProton();
  const settings = await readSettings();
  settings.protonPath = installed.protonPath;
  settings.umuPath = settings.umuPath || 'umu-run';
  await saveSettings(settings);
  return { ...installed, settings: protonSettings(settings) };
});

ipcMain.handle('launcher:choose-executable', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a game executable',
    properties: ['openFile'],
    filters: [{ name: 'Executables', extensions: ['exe', 'x86_64', 'sh', 'bin'] }, { name: 'All files', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('launcher:get', async (_event, gameId) => (await readGameSettings())[gameId] || null);

ipcMain.handle('launcher:save', async (_event, game, configuration) => {
  const gameId = game?.id;
  const runners = new Set(process.platform === 'win32'
    ? ['steam', 'native']
    : ['steam', 'native', 'wine', 'proton']);
  if (typeof gameId !== 'string' || !configuration || !runners.has(configuration.runner)) throw new Error('Invalid launcher configuration.');
  const protonCompatibility = Number(configuration.protonCompatibility);
  if (!Number.isInteger(protonCompatibility) || protonCompatibility < 0 || protonCompatibility > 5) throw new Error('Proton compatibility must be a whole number from 0 to 5.');
  const settings = await readGameSettings();
  const runsOn = configuration.runsOn && typeof configuration.runsOn === 'object' ? { windows: Boolean(configuration.runsOn.windows), linux: Boolean(configuration.runsOn.linux) } : { windows: true, linux: true };
  settings[gameId] = {
    runner: configuration.runner,
    executable: typeof configuration.executable === 'string' ? configuration.executable : '',
    workingDirectory: typeof configuration.workingDirectory === 'string' ? configuration.workingDirectory : '',
    wineBinary: typeof configuration.wineBinary === 'string' ? configuration.wineBinary : 'wine',
    winePrefix: typeof configuration.winePrefix === 'string' ? configuration.winePrefix : '',
    protonPath: typeof configuration.protonPath === 'string' ? configuration.protonPath : '',
    umuPath: typeof configuration.umuPath === 'string' ? configuration.umuPath : 'umu-run',
    arguments: typeof configuration.arguments === 'string' ? configuration.arguments : '',
    protonCompatibility,
    runsOn
  };
  await saveGameSettings(settings);
  await writeGameManifest(game, settings[gameId]);
  return settings[gameId];
});

function splitArguments(value) { return value.trim() ? value.trim().split(/\s+/) : []; }

function launchSpec(game, configuration) {
  const config = configuration || (game.source === 'Steam' ? { runner: 'steam' } : null);
  if (!config) throw new Error('Choose and save a launcher before launching this game.');
  if (config.runner === 'steam') {
    if (!game.appId) throw new Error('Steam launch is only available for a Steam game.');
    if (process.platform === 'win32') return { openExternal: `steam://rungameid/${game.appId}`, env: {} };
    return { command: 'xdg-open', args: [`steam://rungameid/${game.appId}`], env: {} };
  }
  if (!config.executable) throw new Error('Choose a game executable first.');
  const args = splitArguments(config.arguments);
  const cwd = config.workingDirectory || path.dirname(config.executable);
  if (config.runner === 'native' && process.platform === 'win32') return { openPath: config.executable, env: {} };
  if (config.runner === 'native') return { command: config.executable, args, env: {}, cwd };
  if (config.runner === 'wine') return { command: config.wineBinary || 'wine', args: [config.executable, ...args], env: config.winePrefix ? { WINEPREFIX: config.winePrefix } : {}, cwd };
  if (!config.protonPath) throw new Error('Choose a GE-Proton directory before launching with Proton.');
  if (!config.winePrefix) throw new Error('Choose a Wine prefix before launching with Proton.');
  const env = {
    WINEPREFIX: config.winePrefix,
    PROTONPATH: config.protonPath,
    GAMEID: game.umuGameId || 'umu-default',
    STORE: game.store || 'none',
    STEAM_COMPAT_LIBRARY_PATHS: game.path
  };
  return { command: config.umuPath || 'umu-run', args: [config.executable, ...args], env, cwd };
}

function printableSpec(spec) {
  if (spec.openExternal) return `Open ${JSON.stringify(spec.openExternal)}`;
  if (spec.openPath) return `Open ${JSON.stringify(spec.openPath)}`;
  const environment = Object.entries(spec.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  return `${environment ? `${environment} ` : ''}${JSON.stringify(spec.command)} ${spec.args.map((arg) => JSON.stringify(arg)).join(' ')}`;
}

ipcMain.handle('launcher:preview', async (_event, game, configuration) => ({ command: printableSpec(launchSpec(game, configuration)) }));

ipcMain.handle('launcher:launch', async (_event, game, configuration) => {
  const spec = launchSpec(game, configuration);
  if (spec.openExternal) {
    await shell.openExternal(spec.openExternal);
    return { command: printableSpec(spec) };
  }
  if (spec.openPath) {
    const error = await shell.openPath(spec.openPath);
    if (error) throw new Error(`Windows could not open ${spec.openPath}: ${error}`);
    return { command: printableSpec(spec) };
  }
  if (spec.env.STEAM_COMPAT_DATA_PATH) await fs.mkdir(spec.env.STEAM_COMPAT_DATA_PATH, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { command: printableSpec(spec) };
});

app.whenReady().then(() => {
  startReadOnlyWebServer();
  if (!WEB_ONLY) {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }
});
app.on('window-all-closed', () => { if (!WEB_ONLY && process.platform !== 'darwin') app.quit(); });
