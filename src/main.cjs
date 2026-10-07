const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { performanceSettings, splitArguments, checksumAssetName } = require('./launcher-config.cjs');
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
  const temporary = `${destination}.${crypto.randomUUID()}.part`;
  try {
    const signal = AbortSignal.timeout(15 * 60 * 1000);
    const response = await fetch(url, { signal, headers: { 'User-Agent': 'XP Game Manager installer' } });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(temporary), { signal });
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}.`)));
  });
}

let geInstallPromise;
function installLatestGeProton(version = 'latest') {
  if (geInstallPromise) throw new Error('A GE-Proton installation is already running.');
  geInstallPromise = performGeProtonInstall(version).finally(() => { geInstallPromise = null; });
  return geInstallPromise;
}
async function validateProtonDirectory(directory) {
  if (!(await directoryExists(directory))) throw new Error('Proton must be a tool directory, not a script path.');
  await fs.access(path.join(directory, 'proton'), fsSync.constants.X_OK);
  await fs.access(path.join(directory, 'compatibilitytool.vdf'));
}
async function fetchGeRelease(version) {
  if (version !== 'latest' && !/^GE-Proton[0-9]+-[0-9]+$/.test(version)) throw new Error('Invalid GE-Proton version.');
  const endpoint = version === 'latest' ? 'latest' : `tags/${encodeURIComponent(version)}`;
  const response = await fetch(`https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/${endpoint}`, { signal: AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'XP Game Manager' } });
  if (!response.ok) throw new Error(`Could not fetch GE-Proton release (${response.status}).`);
  return response.json();
}
async function listGeReleases() {
  const response = await fetch('https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=100', { signal: AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'XP Game Manager' } });
  if (!response.ok) throw new Error(`Could not list GE-Proton versions (${response.status}).`);
  const releases = await response.json();
  return releases.filter(release => !release.draft && !release.prerelease && /^GE-Proton[0-9]+-[0-9]+$/.test(release.tag_name)).map(release => ({ version: release.tag_name }));
}
async function performGeProtonInstall(version) {
  if (process.platform !== 'linux') throw new Error('GE-Proton installation is only available on Linux.');
  const release = await fetchGeRelease(version);
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : '';
  if (!arch) throw new Error(`Unsupported architecture: ${process.arch}.`);
  let archive = release.assets?.find((asset) => new RegExp(`-${arch}\\.tar\\.gz$`).test(asset.name));
  const selectedArchive = archive || (arch === 'x86_64' ? release.assets?.find(asset => asset.name === `${release.tag_name}.tar.gz`) : null);
  if (!selectedArchive) throw new Error(`No ${arch} GE-Proton archive was found for ${release.tag_name}.`);
  archive = selectedArchive;
  const checksum = release.assets?.find((asset) => asset.name === checksumAssetName(archive.name));
  if (!checksum) throw new Error('This GE-Proton release does not include a SHA-512 checksum for this archive.');
  const installRoot = await geProtonInstallRoot();
  const releaseName = archive.name.replace(/\.tar\.gz$/, '');
  const installDirectory = path.join(installRoot, releaseName);
  try { await validateProtonDirectory(installDirectory); return { version: releaseName, protonPath: installDirectory, alreadyInstalled: true }; } catch {}
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'xp-game-manager-ge-'));
  try {
    const archivePath = path.join(tempDirectory, archive.name);
    const checksumPath = path.join(tempDirectory, checksum.name);
    await Promise.all([downloadFile(archive.browser_download_url, archivePath), downloadFile(checksum.browser_download_url, checksumPath)]);
    const expected = (await fs.readFile(checksumPath, 'utf8')).match(/^[a-fA-F0-9]{128}/m)?.[0]?.toLowerCase();
    if (!expected || await sha512File(archivePath) !== expected) throw new Error('GE-Proton checksum verification failed. Nothing was installed.');
    await fs.mkdir(installRoot, { recursive: true });
    const staging = await fs.mkdtemp(path.join(installRoot, '.xp-install-'));
    try {
      await runCommand('tar', ['-xzf', archivePath, '-C', staging, '--no-same-owner']);
      const entries = await fs.readdir(staging, { withFileTypes: true });
      const directories = entries.filter(entry => entry.isDirectory());
      if (directories.length !== 1) throw new Error('Unexpected GE-Proton archive layout.');
      const extracted = path.join(staging, directories[0].name);
      await validateProtonDirectory(extracted);
      if (await directoryExists(installDirectory)) throw new Error(`Incomplete installation at ${installDirectory}. Move it aside before reinstalling.`);
      await fs.rename(extracted, installDirectory);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
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
      sharedArguments: Array.isArray(manifest.windows?.arguments) && manifest.windows.arguments.every((item) => typeof item === 'string') ? manifest.windows.arguments : (Array.isArray(manifest.windows?.arguments?.args) && manifest.windows.arguments.args.every(item => typeof item === 'string') ? manifest.windows.arguments.args : []),
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
    windows: { executable, workingDirectory, arguments: splitArguments(configuration.arguments || '').args },
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
  const executables = [];
  while (queue.length) {
    const { directory, depth } = queue.shift(); let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 250)) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && /\.exe$/i.test(entry.name)) {
        if (!/unins|installer|crash|redist|dotnet|setup/i.test(entry.name)) {
          executables.push(candidate);
        }
      }
      if (entry.isDirectory() && depth < 4 && !entry.name.startsWith('.')) queue.push({ directory: candidate, depth: depth + 1 });
    }
  }
  if (!executables.length) return '';
  const shipping = executables.find(e => /Win64-Shipping\.exe$/i.test(e) || /Binaries\/Win64/i.test(e));
  if (shipping) return shipping;
  return executables[0];
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

async function fetchProtonDbSummary(appId) {
  if (!/^\d+$/.test(String(appId))) return null;
  const data = await fetchJson(`https://www.protondb.com/api/v1/reports/summaries/${appId}.json`);
  if (!data || typeof data !== 'object') return null;
  return {
    tier: typeof data.tier === 'string' ? data.tier : 'pending',
    trendingTier: typeof data.trendingTier === 'string' ? data.trendingTier : data.tier || 'pending',
    confidence: typeof data.confidence === 'string' ? data.confidence : '',
    score: typeof data.score === 'number' ? data.score : null,
    total: typeof data.total === 'number' ? data.total : 0
  };
}

async function storeMetadata(appId) {
  if (!/^\d+$/.test(String(appId))) return null;
  const [payload, protonDb] = await Promise.all([
    fetchJson(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&l=english&cc=US`),
    fetchProtonDbSummary(appId)
  ]);
  const result = payload?.[appId];
  if (!result?.success || !result.data) return null;
  const meta = metadataFromStore(appId, result.data);
  if (protonDb) meta.protonDb = protonDb;
  return meta;
}

async function searchSteamStoreApi(query) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];
  const payload = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query.trim())}&l=english&cc=US`);
  if (!payload?.items || !Array.isArray(payload.items)) return [];
  return payload.items.slice(0, 15).map((item) => ({
    id: String(item.id),
    name: item.name,
    tiny_image: item.tiny_image || `https://cdn.akamai.steamstatic.com/steam/apps/${item.id}/header.jpg`
  }));
}

async function discoverCompatibilityTools() {
  if (process.platform !== 'linux') return [];
  const home = app.getPath('home');
  const candidateRoots = [
    path.join(home, '.local', 'share', 'Steam', 'compatibilitytools.d'),
    path.join(home, '.steam', 'steam', 'compatibilitytools.d'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam', 'compatibilitytools.d'),
    '/usr/share/steam/compatibilitytools.d'
  ];
  const tools = [];
  const seenPaths = new Set();
  for (const root of candidateRoots) {
    if (!(await directoryExists(root))) continue;
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const toolDir = path.join(root, entry.name);
        if (seenPaths.has(toolDir)) continue;
        seenPaths.add(toolDir);
        const protonExec = path.join(toolDir, 'proton');
        try {
          await fs.access(protonExec);
          tools.push({
            name: entry.name,
            path: toolDir,
            isGe: /GE-Proton/i.test(entry.name)
          });
        } catch {}
      }
    } catch {}
  }
  return tools;
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
    const protonDbTierToRating = { platinum: 5, gold: 4, silver: 3, bronze: 2, borked: 1 };
    const defaultRating = metadata.protonDb?.tier ? (protonDbTierToRating[metadata.protonDb.tier.toLowerCase()] || 0) : 0;
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
        : defaultRating,
      runsOn: gameSettings[game.id]?.runsOn || game.sharedRunsOn || { windows: true, linux: true },
      defaultCompatDataPath: gameCompatDataPath(globalProton.compatDataRoot, game.id),
      protonDb: metadata.protonDb || null,
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

ipcMain.handle('settings:choose-proton-directory', async () => {
  const result = await dialog.showOpenDialog({ title: 'Choose a GE-Proton tool directory', properties: ['openDirectory'] });
  if (result.canceled) return null;
  await validateProtonDirectory(result.filePaths[0]);
  return result.filePaths[0];
});

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

ipcMain.handle('settings:list-ge-releases', async () => listGeReleases());
ipcMain.handle('settings:install-ge-proton', async (_event, version = 'latest') => {
  const installed = await installLatestGeProton(version);
  const settings = await readSettings();
  settings.protonPath = installed.protonPath;
  settings.umuPath = settings.umuPath || 'umu-run';
  await saveSettings(settings);
  return { ...installed, settings: protonSettings(settings) };
});

async function diagnoseSystemHealth() {
  const isLinux = process.platform === 'linux';
  const results = {
    platform: process.platform,
    vulkan64: { status: 'MISSING', details: 'No 64-bit Vulkan ICD manifest found' },
    vulkan32: { status: 'MISSING', details: 'No 32-bit Vulkan ICD manifest found (Required for 32-bit Windows games)' },
    wine: { status: 'MISSING', details: 'Wine binary not found in PATH' },
    umu: { status: 'MISSING', details: 'umu-run launcher binary not found in PATH' },
    geProton: { status: 'MISSING', details: 'No GE-Proton installation detected' },
    gamemode: { status: 'WARNING', details: 'GameMode (gamemoderun) not installed (Optional performance tool)' },
    mangohud: { status: 'WARNING', details: 'MangoHud overlay not installed (Optional performance tool)' },
    unzip: { status: 'WARNING', details: 'unzip utility missing (Required for archive extractions)' },
    ntlmAuth: { status: 'WARNING', details: 'ntlm_auth missing (Install winbind package for EOS / Epic Online Services support)' },
    ulimit: { status: 'PASS', details: 'File descriptor limit OK' }
  };

  if (!isLinux) return results;

  const icdSearchPaths = [
    '/usr/share/vulkan/icd.d',
    '/etc/vulkan/icd.d',
    path.join(os.homedir(), '.local/share/vulkan/icd.d')
  ];

  const foundVulkan64 = [];
  const foundVulkan32 = [];

  for (const icdPath of icdSearchPaths) {
    try {
      const files = await fs.readdir(icdPath);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const fullPath = path.join(icdPath, file);
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          const parsed = JSON.parse(content);
          const libPath = parsed?.ICD?.library_path || file;
          if (file.includes('i686') || file.includes('x86_32') || file.includes('lib32') || libPath.includes('32')) {
            foundVulkan32.push(file);
          } else {
            foundVulkan64.push(file);
          }
        } catch {}
      }
    } catch {}
  }

  if (foundVulkan64.length > 0) {
    results.vulkan64 = { status: 'PASS', details: `Found 64-bit Vulkan ICDs: ${foundVulkan64.join(', ')}` };
  }
  if (foundVulkan32.length > 0) {
    results.vulkan32 = { status: 'PASS', details: `Found 32-bit Vulkan ICDs: ${foundVulkan32.join(', ')}` };
  } else {
    results.vulkan32 = { status: 'WARNING', details: 'Missing 32-bit Vulkan drivers (Install lib32-vulkan-radeon or vulkan-radeon:i386 for 32-bit games)' };
  }

  const checkBinary = async (binaryName) => {
    return new Promise((resolve) => {
      const child = spawn('which', [binaryName], { stdio: 'ignore' });
      child.once('exit', (code) => resolve(code === 0));
      child.once('error', () => resolve(false));
    });
  };

  if (await checkBinary('wine')) results.wine = { status: 'PASS', details: 'Wine binary found in PATH' };
  const configured = protonSettings(await readSettings());
  if (await checkBinary(configured.umuPath)) results.umu = { status: 'PASS', details: `Configured UMU launcher found: ${configured.umuPath}` };
  if (await checkBinary('gamemoderun')) {
    let hasLibGameMode = false;
    try {
      await new Promise((resolve) => {
        const child = spawn('sh', ['-c', 'ldconfig -p | grep libgamemode'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', c => { out += c.toString('utf8'); });
        child.once('exit', () => {
          hasLibGameMode = out.includes('libgamemode');
          resolve();
        });
        child.once('error', resolve);
      });
    } catch {}
    if (hasLibGameMode) {
      results.gamemode = { status: 'PASS', details: 'GameMode (gamemoderun and libgamemode.so) found' };
    } else {
      results.gamemode = { status: 'WARNING', details: 'gamemoderun found, but libgamemode.so is missing (Install package gamemode)' };
    }
  }
  if (await checkBinary('mangohud')) results.mangohud = { status: 'PASS', details: 'MangoHud overlay found' };
  if (await checkBinary('unzip')) results.unzip = { status: 'PASS', details: 'unzip utility found' };
  if (await checkBinary('ntlm_auth')) results.ntlmAuth = { status: 'PASS', details: 'ntlm_auth (winbind) found' };

  try {
    const protonTools = (await discoverCompatibilityTools()).filter(tool => tool.isGe);
    if (configured.protonPath) {
      try { await validateProtonDirectory(configured.protonPath); protonTools.push({ name: 'Configured Proton', path: configured.protonPath }); } catch {}
    }
    if (protonTools && protonTools.length > 0) {
      results.geProton = { status: 'PASS', details: `Found ${protonTools.length} compatibility tool(s): ${protonTools.map(t => t.name).join(', ')}` };
    }
  } catch {}

  try {
    await new Promise((resolve) => {
      const child = spawn('sh', ['-c', 'ulimit -n'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
      child.once('exit', () => {
        const num = Number.parseInt(output.trim(), 10);
        if (num && num < 524288) {
          results.ulimit = { status: 'WARNING', details: `File descriptor limit is ${num} (>= 524288 recommended for Esync stability)` };
        } else if (num) {
          results.ulimit = { status: 'PASS', details: `File descriptor limit is ${num}` };
        }
        resolve();
      });
      child.once('error', resolve);
    });
  } catch {}

  return results;
}

ipcMain.handle('system:diagnose-health', async () => diagnoseSystemHealth());
ipcMain.handle('settings:discover-proton-tools', async () => discoverCompatibilityTools());
ipcMain.handle('library:search-steam-store', async (_event, query) => searchSteamStoreApi(query));

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
  splitArguments(configuration.arguments);
  const settings = await readGameSettings();
  const runsOn = configuration.runsOn && typeof configuration.runsOn === 'object' ? { windows: Boolean(configuration.runsOn.windows), linux: Boolean(configuration.runsOn.linux) } : { windows: true, linux: true };
  settings[gameId] = {
    ...performanceSettings(configuration),
    runner: configuration.runner,
    executable: typeof configuration.executable === 'string' ? configuration.executable : '',
    workingDirectory: typeof configuration.workingDirectory === 'string' ? configuration.workingDirectory : '',
    wineBinary: typeof configuration.wineBinary === 'string' ? configuration.wineBinary : 'wine',
    winePrefix: typeof configuration.winePrefix === 'string' ? configuration.winePrefix : '',
    protonPath: typeof configuration.protonPath === 'string' ? configuration.protonPath : '',
    umuPath: typeof configuration.umuPath === 'string' ? configuration.umuPath : 'umu-run',
    arguments: typeof configuration.arguments === 'string' ? configuration.arguments : '',
    protonCompatibility,
    runsOn,
    gameMode: Boolean(configuration.gameMode),
    mangoHud: Boolean(configuration.mangoHud),
    useWineD3D: Boolean(configuration.useWineD3D),
    noEsync: Boolean(configuration.noEsync),
    noFsync: Boolean(configuration.noFsync),
    dxvkHud: typeof configuration.dxvkHud === 'string' ? configuration.dxvkHud : '',
    store: typeof configuration.store === 'string' ? configuration.store : '',
    umuGameId: typeof configuration.umuGameId === 'string' ? configuration.umuGameId : ''
  };
  await saveGameSettings(settings);
  await writeGameManifest(game, settings[gameId]);
  return settings[gameId];
});

function launchSpec(game, configuration) {
  const config = configuration || (game.source === 'Steam' ? { runner: 'steam' } : null);
  if (!config) throw new Error('Choose and save a launcher before launching this game.');
  if (config.runner === 'steam') {
    if (!game.appId) throw new Error('Steam launch is only available for a Steam game.');
    if (process.platform === 'win32') return { openExternal: `steam://rungameid/${game.appId}`, env: {} };
    return { command: 'xdg-open', args: [`steam://rungameid/${game.appId}`], env: {} };
  }
  if (!config.executable) throw new Error('Choose a game executable first.');
  const { args, envInjected } = splitArguments(config.arguments);
  if (args.some(arg => /^(PROTON_|UMU_|WINE)[A-Z0-9_]*=/.test(arg))) {
    throw new Error('Put Proton/UMU environment assignments before all game arguments, for example: PROTON_LOG=1 UMU_LOG=1 -dx11');
  }
  const cwd = config.workingDirectory || path.dirname(config.executable);
  if (config.runner === 'native' && process.platform === 'win32') {
    if (!args.length && !config.workingDirectory) return { openPath: config.executable, env: {} };
    return { command: config.executable, args, env: {}, cwd };
  }

  let command = config.executable;
  let commandArgs = args;
  const env = { ...envInjected };

  if (config.mangoHud) env.MANGOHUD = '1';
  if (config.useWineD3D) env.PROTON_USE_WINED3D = '1';
  if (config.noEsync) env.PROTON_NO_ESYNC = '1';
  if (config.noFsync) env.PROTON_NO_FSYNC = '1';
  if (config.dxvkHud) env.DXVK_HUD = config.dxvkHud;
  if (config.amdVulkanDriver && config.amdVulkanDriver !== 'default') env.AMD_VULKAN_ICD = config.amdVulkanDriver;
  if (config.enableFsr) env.WINE_FULLSCREEN_FSR = '1';
  if (config.fsrStrength !== undefined && config.fsrStrength !== '') env.WINE_FULLSCREEN_FSR_STRENGTH = String(config.fsrStrength);
  if (config.enableRdnaRayTracing) {
    env.RADV_PERFTEST = env.RADV_PERFTEST ? `${env.RADV_PERFTEST},rt` : 'rt';
    env.VKD3D_CONFIG = env.VKD3D_CONFIG ? `${env.VKD3D_CONFIG},dxr,dxr11` : 'dxr,dxr11';
  }
  if (config.hideNvidiaGpu) env.PROTON_HIDE_NVIDIA_GPU = '1';
  if (config.enableNvapi) env.PROTON_ENABLE_NVAPI = '1';
  if (config.enableMesaGlThread) env.mesa_glthread = 'true';
  if (config.largeAddressAware) env.PROTON_FORCE_LARGE_ADDRESS_AWARE = '1';
  if (config.dxvkAsync) env.DXVK_ASYNC = '1';

  if (config.runner === 'wine') {
    command = config.wineBinary || 'wine';
    commandArgs = [config.executable, ...args];
    if (config.winePrefix) env.WINEPREFIX = config.winePrefix;
  } else if (config.runner === 'proton') {
    if (!config.protonPath) throw new Error('Choose a GE-Proton directory before launching with Proton.');
    if (!config.winePrefix) throw new Error('Choose a Wine prefix before launching with Proton.');
    if (config.debugLogging) { env.PROTON_LOG = '1'; env.UMU_LOG = '1'; }
    env.WINEPREFIX = config.winePrefix;
    env.PROTONPATH = config.protonPath;
    env.GAMEID = config.umuGameId || 'umu-default';
    env.STORE = config.store || (game.source === 'Steam' ? 'steam' : 'none');
    command = config.umuPath || 'umu-run';
    commandArgs = [config.executable, ...args];
  }

  if (config.gameMode) {
    commandArgs = [command, ...commandArgs];
    command = 'gamemoderun';
  }

  return { command, args: commandArgs, env, cwd };
}

function printableSpec(spec) {
  if (spec.openExternal) return `Open ${JSON.stringify(spec.openExternal)}`;
  if (spec.openPath) return `Open ${JSON.stringify(spec.openPath)}`;
  const environment = Object.entries(spec.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  return `${environment ? `${environment} ` : ''}${JSON.stringify(spec.command)} ${spec.args.map((arg) => JSON.stringify(arg)).join(' ')}`;
}

ipcMain.handle('launcher:preview', async (_event, game, configuration) => ({ command: printableSpec(launchSpec(game, configuration)) }));

async function validateLaunchSpec(spec) {
  if (spec.openExternal || spec.openPath || process.platform !== 'linux') return;
  if (spec.cwd && !(await directoryExists(spec.cwd))) throw new Error(`Working directory does not exist: ${spec.cwd}`);
  if (spec.env.PROTONPATH) await validateProtonDirectory(spec.env.PROTONPATH);
  const commands = [spec.command];
  if (spec.command === 'gamemoderun') commands.push(spec.args[0]);
  for (const command of commands) {
    const candidates = command.includes('/') ? [command] : (process.env.PATH || '').split(path.delimiter).map(root => path.join(root, command));
    let found = false;
    for (const candidate of candidates) { try { if ((await fs.stat(candidate)).isFile()) { await fs.access(candidate, fsSync.constants.X_OK); found = true; break; } } catch {} }
    if (!found) throw new Error(`Launcher is missing or not executable: ${command}. Install it or choose its full path in settings.`);
  }
}
async function installRuntimeAddon(game, configuration, addonKey) {
  if (process.platform !== 'linux') throw new Error('Runtime addon installer is for Linux Wine/Proton setups.');
  const config = configuration || {};
  if (!config.winePrefix) throw new Error('Specify a Wine prefix before installing runtime addons.');

  const cacheDir = path.join(SETTINGS_DIR, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(config.winePrefix, { recursive: true });

  const broadcastLog = (logObj) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('launcher:log', logObj);
    });
  };

  const addons = {
    vc_redist: {
      name: 'Visual C++ 2015-2022 Redistributable (x64)',
      filename: 'vc_redist.x64.exe',
      url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
      args: '/quiet /norestart'
    },
    directx: {
      name: 'DirectX End-User Web Runtimes',
      filename: 'dxwebsetup.exe',
      url: 'https://download.microsoft.com/download/1/7/1/1718FBA5-5F5B-4192-A022-88B989C9A13F/dxwebsetup.exe',
      args: '/q'
    },
    dotnet: {
      name: 'Microsoft .NET Desktop Runtime 8.0 (x64)',
      filename: 'windowsdesktop-runtime-8.0-win-x64.exe',
      url: 'https://download.visualstudio.microsoft.com/download/pr/499b9cfd-cfc5-4fb5-90df-0b4457e53f1c/70db6422d7d56bb5fcfb95e3dd9c585c/windowsdesktop-runtime-8.0.10-win-x64.exe',
      args: '/quiet /norestart'
    },
    openal: {
      name: 'OpenAL Audio Installer',
      filename: 'oalinst.exe',
      url: 'https://openal.org/downloads/oalinst.zip',
      isZip: true,
      args: '/s'
    }
  };

  const addon = addons[addonKey || 'vc_redist'];
  if (!addon) throw new Error(`Unknown runtime addon: ${addonKey}`);

  broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] ${addon.name} installer initiated for ${game.name}.\n` });

  const targetExePath = path.join(cacheDir, addon.filename);

  try {
    await fs.access(targetExePath);
    broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] Using cached ${addon.filename} installer.\n` });
  } catch {
    broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] Downloading ${addon.name}...\n` });
    if (addon.isZip) {
      const zipPath = path.join(cacheDir, 'oalinst.zip');
      await downloadFile(addon.url, zipPath);
      broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] Extracting ${addon.filename} from archive...\n` });
      await runCommand('unzip', ['-o', zipPath, '-d', cacheDir]);
    } else {
      await downloadFile(addon.url, targetExePath);
    }
    broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] Download complete.\n` });
  }

  const installerConfig = {
    ...config,
    executable: targetExePath,
    arguments: addon.args,
    workingDirectory: cacheDir
  };

  const spec = launchSpec(game, installerConfig);
  await validateLaunchSpec(spec);
  const printable = printableSpec(spec);
  broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] Running ${addon.name} installer in prefix...\nCommand: ${printable}\n` });

  return new Promise((resolve, reject) => {
    try {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.stdout.on('data', (chunk) => {
        broadcastLog({ type: 'stdout', text: chunk.toString('utf8') });
      });

      child.stderr.on('data', (chunk) => {
        broadcastLog({ type: 'stderr', text: chunk.toString('utf8') });
      });

      child.once('error', (err) => {
        broadcastLog({ type: 'error', text: `[RUNTIME INSTALL ERROR] ${err.message}\n` });
        reject(err);
      });

      child.once('exit', (code) => {
        if (code === 0 || code === 3010) {
          broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] ${addon.name} installed successfully into prefix!\n` });
          resolve({ success: true, code });
        } else {
          broadcastLog({ type: 'error', text: `[RUNTIME INSTALL ERROR] Installer exited with code ${code}.\n` });
          reject(new Error(`${addon.name} installer exited with code ${code}`));
        }
      });
    } catch (err) {
      broadcastLog({ type: 'error', text: `[RUNTIME INSTALL ERROR] ${err.message}\n` });
      reject(err);
    }
  });
}

async function installVcRedist(game, configuration) {
  return installRuntimeAddon(game, configuration, 'vc_redist');
}

ipcMain.handle('launcher:install-vc-redist', async (_event, game, configuration) => installVcRedist(game, configuration));
ipcMain.handle('launcher:install-runtime-addon', async (_event, game, configuration, addonKey) => installRuntimeAddon(game, configuration, addonKey));

ipcMain.handle('launcher:launch', async (_event, game, configuration) => {
  const spec = launchSpec(game, configuration);
  await validateLaunchSpec(spec);
  if (configuration?.executable && configuration.runner !== 'steam') await fs.access(configuration.executable);
  const printable = printableSpec(spec);

  const broadcastStatus = (statusObj) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('launcher:status', statusObj);
    });
  };

  const broadcastLog = (logObj) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('launcher:log', logObj);
    });
  };

  broadcastStatus({ state: 'starting', command: printable, gameName: game.name });
  broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] Launching ${game.name}...\nCommand: ${printable}\nWorking Directory: ${spec.cwd || 'default'}\n` });

  if (spec.openExternal) {
    await shell.openExternal(spec.openExternal);
    broadcastStatus({ state: 'running', command: printable, gameName: game.name });
    broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] External protocol launch requested.\n` });
    return { command: printable };
  }
  if (spec.openPath) {
    const error = await shell.openPath(spec.openPath);
    if (error) {
      broadcastStatus({ state: 'error', error: `Could not open path: ${error}` });
      broadcastLog({ type: 'error', text: `[ERROR] ${error}\n` });
      throw new Error(`Windows could not open ${spec.openPath}: ${error}`);
    }
    broadcastStatus({ state: 'running', command: printable, gameName: game.name });
    return { command: printable };
  }

  if (spec.env.WINEPREFIX) await fs.mkdir(spec.env.WINEPREFIX, { recursive: true });
  if (spec.env.STEAM_COMPAT_DATA_PATH) await fs.mkdir(spec.env.STEAM_COMPAT_DATA_PATH, { recursive: true });

  return new Promise((resolve, reject) => {
    try {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.once('spawn', () => {
        broadcastStatus({ state: 'running', pid: child.pid, command: printable, gameName: game.name });
        resolve({ command: printable, pid: child.pid });
      });

      child.stdout.on('data', (chunk) => {
        broadcastLog({ type: 'stdout', text: chunk.toString('utf8') });
      });

      child.stderr.on('data', (chunk) => {
        broadcastLog({ type: 'stderr', text: chunk.toString('utf8') });
      });

      child.once('error', (err) => {
        broadcastStatus({ state: 'error', error: err.message });
        broadcastLog({ type: 'error', text: `[LAUNCH ERROR] ${err.stack || err.message}\n` });
        reject(err);
      });

      child.once('exit', (code, signal) => {
        const statusText = code !== null ? `exited with code ${code}` : `terminated by signal ${signal}`;
        broadcastStatus({ state: 'exited', exitCode: code, signal, command: printable, gameName: game.name });
        broadcastLog({ type: 'system', text: `[${new Date().toLocaleTimeString()}] Process ${statusText}.\n` });
      });

      child.unref();
    } catch (err) {
      broadcastStatus({ state: 'error', error: err.message });
      broadcastLog({ type: 'error', text: `[LAUNCH ERROR] ${err.message}\n` });
      reject(err);
    }
  });
});

app.whenReady().then(() => {
  startReadOnlyWebServer();
  if (!WEB_ONLY) {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }
});
app.on('window-all-closed', () => { if (!WEB_ONLY && process.platform !== 'darwin') app.quit(); });
