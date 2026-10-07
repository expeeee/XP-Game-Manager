const $ = (selector) => document.querySelector(selector);
const cardTemplate = $('#game-card');
let libraryData = null;
let torboxSettings = null;
let torboxJobs = [];
let torboxRefreshTimer = null;
const torboxProgress = new Map();
const minimizedTorboxJobs = new Set();

function gameCard(game) {
  const card = cardTemplate.content.cloneNode(true);
  const article = card.querySelector('.game-card');
  const cover = document.createElement('div');
  cover.className = 'game-cover';
  if (game.artUrl) {
    const image = document.createElement('img'); image.src = game.artUrl; image.alt = '';
    image.addEventListener('error', () => {
      image.remove();
      if (!cover.textContent) cover.textContent = game.source === 'Steam' ? 'STEAM' : 'WINDOWS';
    });
    cover.append(image);
  }
  if (!game.artUrl) cover.textContent = game.source === 'Steam' ? 'STEAM' : 'WINDOWS';
  article.prepend(cover);
  card.querySelector('h3').textContent = game.name;

  if (game.protonDb?.tier) {
    const badge = card.querySelector('.protondb-badge');
    if (badge) {
      const tier = String(game.protonDb.tier).toLowerCase();
      badge.textContent = tier.toUpperCase();
      badge.className = `protondb-badge ${tier}`;
      badge.hidden = false;
    }
  }

  card.querySelector('.source').textContent = game.available ? game.source : `${game.source} · missing files`;

  const ratingText = game.protonDb?.tier
    ? `ProtonDB: ${game.protonDb.tier.toUpperCase()} (${game.protonDb.total || 0} reports)`
    : `Proton support ${game.protonCompatibility || 0}/5`;
  card.querySelector('.compatibility').textContent = ratingText;
  if (game.genres?.length) card.querySelector('.compatibility').textContent += ` · ${game.genres.join(', ')}`;

  if (libraryData?.hostPlatform === 'win32') {
    const compatibility = card.querySelector('.compatibility');
    compatibility.textContent = game.genres?.join(', ') || '';
    compatibility.hidden = !compatibility.textContent;
  }
  card.querySelector('.path').textContent = game.path;
  const select = () => selectGame(game);
  article.addEventListener('click', select);
  article.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') select(); });
  return card;
}

function showGames(container, games) { container.replaceChildren(...games.map(gameCard)); }

function filtered(games) {
  const term = $('#search-games').value.trim().toLowerCase();
  const source = $('#source-filter').value;
  return games.filter((game) => (source === 'all' || game.source === source) && (!term || game.name.toLowerCase().includes(term)));
}

function serverLibrary(folder) {
  const section = document.createElement('article');
  section.className = 'server-library';
  const heading = document.createElement('div');
  heading.className = 'library-heading';
  heading.innerHTML = `<div><h3>${folder.root}</h3><p>${folder.error || `${folder.games.length} folders discovered`}</p></div>`;
  const remove = document.createElement('button');
  remove.className = 'quiet'; remove.textContent = 'Remove';
  remove.addEventListener('click', async () => { await window.libraryApi.removeFolder(folder.root); await load(); });
  heading.append(remove); section.append(heading);
  const visibleGames = filtered(folder.games);
  if (visibleGames.length) { const games = document.createElement('div'); games.className = 'game-grid'; showGames(games, visibleGames); section.append(games); }
  return section;
}

function input(label, value, onChange, placeholder = '') {
  const field = document.createElement('label'); field.className = 'field';
  const title = document.createElement('span'); title.textContent = label;
  const control = document.createElement('input'); control.value = value || ''; control.placeholder = placeholder;
  control.addEventListener('input', () => onChange(control.value)); field.append(title, control); return field;
}

function protonDirectoryInput(label, value, onChange) {
  const field = input(label, value, onChange, '/path/to/GE-Proton');
  const browse = document.createElement('button'); browse.type = 'button'; browse.textContent = 'Browse…';
  browse.addEventListener('click', async () => {
    browse.disabled = true;
    try {
      const chosen = await window.libraryApi.chooseProtonDirectory();
      if (chosen) { field.querySelector('input').value = chosen; onChange(chosen); }
    } catch (error) { $('#status').textContent = error.message || 'Unable to select Proton directory.'; }
    finally { browse.disabled = false; }
  });
  field.append(browse);
  return field;
}

function renderGlobalProtonSettings() {
  $('#global-proton-settings')?.remove();
  if (libraryData?.hostPlatform !== 'linux') return;
  const configuration = { ...libraryData.protonSettings };
  const panel = document.createElement('details'); panel.id = 'global-proton-settings'; panel.className = 'advanced-proton';
  const summary = document.createElement('summary'); summary.textContent = 'Global Proton settings'; panel.append(summary);
  panel.append(protonDirectoryInput('GE-Proton directory', configuration.protonPath, value => { configuration.protonPath = value; }));
  panel.append(input('UMU launcher', configuration.umuPath, value => { configuration.umuPath = value; }, 'umu-run'));
  panel.append(input('Compatibility-data root', configuration.compatDataRoot, value => { configuration.compatDataRoot = value; }, '/home/user/.local/share/xp-game-manager/compatdata'));
  const actions = document.createElement('div'); actions.className = 'launcher-actions';
  const versionSelect = document.createElement('select');
  versionSelect.setAttribute('aria-label', 'GE-Proton version to install');
  const latest = document.createElement('option'); latest.value = 'latest'; latest.textContent = 'Latest GE-Proton'; versionSelect.append(latest);
  const versions = document.createElement('button'); versions.textContent = 'Load available versions';
  versions.addEventListener('click', async () => {
    versions.disabled = true;
    try {
      const releases = await window.libraryApi.listGeReleases();
      versionSelect.replaceChildren(latest);
      for (const release of releases) { const option = document.createElement('option'); option.value = release.version; option.textContent = release.version; versionSelect.append(option); }
      $('#status').textContent = `Loaded ${releases.length} GE-Proton versions.`;
    } catch (error) { $('#status').textContent = error.message || 'Unable to load versions.'; }
    finally { versions.disabled = false; }
  });
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Installs side by side in your home directory. Root access is not required. Existing game configurations retain their selected version.';
  panel.append(hint, versionSelect, versions);
  const installGe = document.createElement('button'); installGe.textContent = 'Install selected GE-Proton';
  installGe.addEventListener('click', async () => {
    installGe.disabled = true; versionSelect.disabled = true; versions.disabled = true; $('#status').textContent = `Downloading and verifying ${versionSelect.value} GE-Proton…`;
    try {
      const result = await window.libraryApi.installGeProton(versionSelect.value);
      libraryData.protonSettings = result.settings;
      discoveredProtonTools = await window.libraryApi.discoverCompatibilityTools();
      configuration.protonPath = result.protonPath;
      $('#status').textContent = result.alreadyInstalled ? `${result.version} is already installed.` : `${result.version} installed and selected.`;
      renderGlobalProtonSettings();
    } catch (error) { $('#status').textContent = error.message || 'Unable to install GE-Proton.'; }
    finally { installGe.disabled = false; versionSelect.disabled = false; versions.disabled = false; }
  });
  const save = document.createElement('button'); save.textContent = 'Save global Proton settings';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try { libraryData.protonSettings = await window.libraryApi.saveProtonSettings(configuration); $('#status').textContent = 'Global Proton settings saved.'; }
    catch (error) { $('#status').textContent = error.message || 'Unable to save global Proton settings.'; }
    finally { save.disabled = false; }
  });
  actions.append(installGe, save); panel.append(actions);

  // Diagnostics UI Container
  const diagContainer = document.createElement('div');
  diagContainer.className = 'health-diagnostics-container';
  diagContainer.style.marginTop = '16px';
  diagContainer.style.padding = '12px';
  diagContainer.style.background = 'rgba(0, 0, 0, 0.2)';
  diagContainer.style.borderRadius = '8px';
  diagContainer.style.border = '1px solid rgba(255, 255, 255, 0.1)';

  const diagHeader = document.createElement('div');
  diagHeader.style.display = 'flex'; diagHeader.style.justifyContent = 'space-between'; diagHeader.style.alignItems = 'center';
  const diagTitle = document.createElement('h4'); diagTitle.style.margin = '0'; diagTitle.textContent = 'Host System Health & Driver Diagnostics';
  const runDiagBtn = document.createElement('button'); runDiagBtn.textContent = 'Run Health Check';

  diagHeader.append(diagTitle, runDiagBtn);
  const diagResultsArea = document.createElement('div');
  diagResultsArea.style.marginTop = '12px';
  diagResultsArea.className = 'health-results-list';

  const runHealthCheck = async () => {
    runDiagBtn.disabled = true;
    diagResultsArea.innerHTML = '<p class="muted">Scanning system Vulkan drivers, Wine runners, and utilities...</p>';
    try {
      const health = await window.libraryApi.diagnoseSystemHealth();
      diagResultsArea.replaceChildren();
      const items = [
        { title: '64-bit Vulkan ICDs', data: health.vulkan64 },
        { title: '32-bit Vulkan ICDs', data: health.vulkan32 },
        { title: 'Wine Binary', data: health.wine },
        { title: 'UMU Launcher', data: health.umu },
        { title: 'GE-Proton Builds', data: health.geProton },
        { title: 'GameMode Utility', data: health.gamemode },
        { title: 'MangoHud Overlay', data: health.mangohud },
        { title: 'Unzip Utility', data: health.unzip },
        { title: 'NTLM Auth (winbind)', data: health.ntlmAuth },
        { title: 'Esync File Limit (ulimit -n)', data: health.ulimit }
      ];

      for (const item of items) {
        const row = document.createElement('div');
        row.style.display = 'flex'; row.style.alignItems = 'center'; row.style.gap = '10px'; row.style.marginBottom = '6px';
        const badge = document.createElement('span');
        badge.style.padding = '2px 8px'; badge.style.borderRadius = '4px'; badge.style.fontSize = '0.75rem'; badge.style.fontWeight = 'bold';
        if (item.data.status === 'PASS') {
          badge.style.background = '#1b5e20'; badge.style.color = '#81c784'; badge.textContent = 'PASS';
        } else if (item.data.status === 'WARNING') {
          badge.style.background = '#e65100'; badge.style.color = '#ffb74d'; badge.textContent = 'WARNING';
        } else {
          badge.style.background = '#b71c1c'; badge.style.color = '#ef9a9a'; badge.textContent = 'MISSING';
        }
        const text = document.createElement('span');
        text.innerHTML = `<strong>${item.title}:</strong> <span class="muted">${item.data.details}</span>`;
        row.append(badge, text);
        diagResultsArea.append(row);
      }
    } catch (err) {
      diagResultsArea.innerHTML = `<p class="error">Health check failed: ${err.message}</p>`;
    } finally {
      runDiagBtn.disabled = false;
    }
  };

  runDiagBtn.addEventListener('click', runHealthCheck);
  diagContainer.append(diagHeader, diagResultsArea);
  panel.append(diagContainer);
  runHealthCheck();

  document.querySelector('.intro').after(panel);
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (!size) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let unit = 0; let amount = size;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function progressPercent(progress) {
  return progress?.totalBytes ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)) : 0;
}

function progressElement(progress, label) {
  const wrapper = document.createElement('div'); wrapper.className = 'transfer-progress';
  const bar = document.createElement('progress'); bar.max = progress?.totalBytes || 1; bar.value = Math.min(progress?.receivedBytes || 0, progress?.totalBytes || 1);
  const text = document.createElement('span'); text.textContent = progress?.totalBytes ? `${label} ${progressPercent(progress)}% · ${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}` : `${label} ${formatBytes(progress?.receivedBytes || 0)} downloaded`;
  wrapper.append(bar, text); return wrapper;
}

function isOverallProgress(progress) {
  return Boolean(progress && Object.prototype.hasOwnProperty.call(progress, 'overallReceivedBytes'));
}

function switchView(view) {
  const downloads = view === 'downloads';
  $('#library-view').hidden = downloads;
  $('#downloads-view').hidden = !downloads;
  $('#library-tab').classList.toggle('active', !downloads);
  $('#downloads-tab').classList.toggle('active', downloads);
  $('#library-tab').setAttribute('aria-selected', String(!downloads));
  $('#downloads-tab').setAttribute('aria-selected', String(downloads));
  clearInterval(torboxRefreshTimer);
  torboxRefreshTimer = downloads ? setInterval(() => { void loadTorboxJobs(); }, 15000) : null;
  if (downloads) void loadTorbox();
}

function downloadsMessage(message, isError = false) {
  const messageElement = $('#torbox-message');
  if (messageElement) { messageElement.textContent = message; messageElement.classList.toggle('error', isError); }
}

function renderTorbox() {
  const panel = $('#torbox-panel'); panel.replaceChildren();
  const settings = torboxSettings || { connected: false, destination: '' };
  const token = input('Torbox API token', '', () => {}, settings.connected ? 'Connected — paste a replacement token to update it' : 'Paste your Torbox API token');
  const tokenControl = token.querySelector('input'); tokenControl.type = 'password'; tokenControl.autocomplete = 'off';
  const destination = input('Download directory', settings.destination, () => {}, 'Choose a local directory');
  const destinationControl = destination.querySelector('input');
  const destinationRow = document.createElement('div'); destinationRow.className = 'executable-row'; destinationRow.append(destination);
  const choose = document.createElement('button'); choose.textContent = 'Choose';
  choose.addEventListener('click', async () => { const picked = await window.libraryApi.chooseTorboxDirectory(); if (picked) destinationControl.value = picked; });
  destinationRow.append(choose);
  const save = document.createElement('button'); save.textContent = settings.connected ? 'Save directory / token' : 'Connect Torbox';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try { torboxSettings = await window.libraryApi.saveTorboxSettings({ token: tokenControl.value, destination: destinationControl.value }); renderTorbox(); downloadsMessage(torboxSettings.connected ? 'Torbox settings saved.' : 'Choose an API token to connect Torbox.', !torboxSettings.connected); }
    catch (error) { downloadsMessage(error.message || 'Unable to save Torbox settings.', true); }
    finally { save.disabled = false; }
  });
  const magnet = document.createElement('label'); magnet.className = 'field'; magnet.innerHTML = '<span>Magnet link</span>';
  const magnetControl = document.createElement('textarea'); magnetControl.placeholder = 'magnet:?xt=urn:btih:…'; magnetControl.rows = 4; magnet.append(magnetControl);
  const add = document.createElement('button'); add.className = 'primary'; add.textContent = 'Add to Torbox';
  const authorization = document.createElement('label'); authorization.className = 'authorization-notice';
  const authorizationControl = document.createElement('input'); authorizationControl.type = 'checkbox';
  authorization.append(authorizationControl, ' I confirm I am authorized to download this content.');
  add.addEventListener('click', async () => {
    if (!authorizationControl.checked) { downloadsMessage('Confirm that you are authorized to download this content before adding it.', true); return; }
    add.disabled = true;
    try { await window.libraryApi.addTorboxMagnet({ magnet: magnetControl.value, destination: destinationControl.value }); magnetControl.value = ''; downloadsMessage('Added to Torbox. Refreshing its status…'); await loadTorboxJobs(); }
    catch (error) { downloadsMessage(error.message || 'Unable to add the magnet to Torbox.', true); }
    finally { add.disabled = false; }
  });
  const actions = document.createElement('div'); actions.className = 'launcher-actions'; actions.append(save, add);
  const connection = document.createElement('p'); connection.className = settings.connected ? 'connection-ok' : 'connection-warning'; connection.textContent = settings.connected ? 'Torbox is connected. The API token is kept in encrypted local credential storage.' : 'Connect a Torbox account before adding a magnet.';
  const message = document.createElement('p'); message.id = 'torbox-message'; message.className = 'status';
  panel.append(connection, token, destinationRow, magnet, authorization, actions, message);
}

function renderTorboxJobs() {
  const container = $('#torbox-jobs'); container.replaceChildren();
  if (!torboxJobs.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No Torbox downloads have been added from this computer.'; container.append(empty); return; }
  for (const job of torboxJobs) {
    const minimized = minimizedTorboxJobs.has(job.torrentId);
    const card = document.createElement('article'); card.className = `download-job${minimized ? ' minimized' : ''}`;
    const heading = document.createElement('div'); heading.className = 'library-heading';
    const details = document.createElement('div'); const title = document.createElement('h3'); title.textContent = job.name; const status = document.createElement('p'); status.textContent = `${job.status} · ${job.progress ? `${job.progress}%` : 'waiting for status'}`; details.append(title, status); heading.append(details);
    const savedFiles = job.savedFiles || {};
    const pendingFiles = (job.files || []).filter((file) => !savedFiles[file.id]);
    const overallProgress = torboxProgress.get(`${job.torrentId}:overall`);
    const controls = document.createElement('div'); controls.className = 'download-controls';
    const minimize = document.createElement('button'); minimize.textContent = minimized ? 'Expand' : 'Minimize';
    minimize.addEventListener('click', () => {
      if (minimized) minimizedTorboxJobs.delete(job.torrentId); else minimizedTorboxJobs.add(job.torrentId);
      renderTorboxJobs();
    });
    controls.append(minimize);
    if (job.files?.length) {
      const saveAll = document.createElement('button'); saveAll.className = 'primary'; saveAll.textContent = pendingFiles.length ? `Save ${pendingFiles.length === job.files.length ? 'all files' : 'remaining files'}` : 'All files saved'; saveAll.disabled = !pendingFiles.length || overallProgress?.state === 'downloading' || overallProgress?.state === 'overall';
      saveAll.addEventListener('click', async () => {
        const bytes = pendingFiles.reduce((total, file) => total + Number(file.size || 0), 0);
        if (!window.confirm(`Save ${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'} (${formatBytes(bytes)}) to ${job.destination}?`)) return;
        saveAll.disabled = true; downloadsMessage(`Saving ${job.files.length} Torbox file${job.files.length === 1 ? '' : 's'}…`);
        try {
          const results = await window.libraryApi.downloadAllTorboxFiles(job.torrentId);
          const failed = results.filter((result) => result.error);
          downloadsMessage(failed.length ? `Saved ${results.length - failed.length} file${results.length - failed.length === 1 ? '' : 's'}; ${failed.length} could not be saved. Use Save file to retry.` : `Saved all ${results.length} file${results.length === 1 ? '' : 's'} to ${job.destination}.`, Boolean(failed.length));
          await loadTorboxJobs();
        } catch (error) { downloadsMessage(error.message || 'Unable to save the Torbox files.', true); }
        finally { saveAll.disabled = false; }
      });
      controls.append(saveAll);
    }
    const paused = String(job.status || '').toLowerCase() === 'paused';
    const control = document.createElement('button'); control.textContent = 'Resume';
    control.addEventListener('click', async () => {
      control.disabled = true;
      try { await window.libraryApi.controlTorbox(job.torrentId, 'resume'); await loadTorboxJobs(); downloadsMessage(`Resumed ${job.name}.`); }
      catch (error) { downloadsMessage(error.message || 'Unable to resume the Torbox download.', true); }
      finally { control.disabled = false; }
    });
    const remove = document.createElement('button'); remove.className = 'quiet'; remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${job.name}” from Torbox? Files already saved in ${job.destination} will be kept.`)) return;
      remove.disabled = true;
      try { await window.libraryApi.controlTorbox(job.torrentId, 'delete'); await loadTorboxJobs(); downloadsMessage(`Deleted ${job.name} from Torbox. Local files were kept.`); }
      catch (error) { downloadsMessage(error.message || 'Unable to delete the Torbox download.', true); }
      finally { remove.disabled = false; }
    });
    if (paused) controls.append(control);
    controls.append(remove); heading.append(controls);
    card.append(heading);
    if (minimized) { container.append(card); continue; }
    const destination = document.createElement('p'); destination.className = 'path'; destination.textContent = job.destination; card.append(destination);
    if (isOverallProgress(overallProgress)) card.append(progressElement({ receivedBytes: overallProgress.overallReceivedBytes || 0, totalBytes: overallProgress.overallTotalBytes || 0 }, overallProgress.state === 'done' ? 'Overall done' : overallProgress.state === 'failed' ? 'Overall finished with errors' : 'Overall'));
    if (job.files?.length) {
      const files = document.createElement('div'); files.className = 'download-files';
      for (const file of job.files) {
        const row = document.createElement('div'); row.className = 'download-file';
        const label = document.createElement('span'); label.textContent = `${file.name} · ${formatBytes(file.size)}`;
        const fileProgress = torboxProgress.get(`${job.torrentId}:${file.id}`);
        const saved = savedFiles[file.id];
        const download = document.createElement('button'); download.textContent = saved ? 'Done' : fileProgress?.state === 'downloading' ? 'Saving…' : 'Save file'; download.disabled = Boolean(saved) || fileProgress?.state === 'downloading';
        download.addEventListener('click', async () => {
          if (!window.confirm(`Save ${file.name} (${formatBytes(file.size)}) to ${job.destination}?`)) return;
          download.disabled = true; downloadsMessage(`Getting a Torbox download link for ${file.name}…`);
          try { const result = await window.libraryApi.downloadTorboxFile(job.torrentId, file.id); downloadsMessage(`Saved ${result.name} to ${result.destination}.`); await loadTorboxJobs(); }
          catch (error) { downloadsMessage(error.message || 'Unable to save the Torbox file.', true); }
          finally { download.disabled = false; }
        });
        const fileDetails = document.createElement('div'); fileDetails.append(label);
        if (fileProgress?.state === 'downloading') fileDetails.append(progressElement(fileProgress, 'Saving'));
        if (saved) { const complete = document.createElement('p'); complete.className = 'transfer-complete'; complete.textContent = `Done · ${saved.destination}`; fileDetails.append(complete); }
        if (fileProgress?.state === 'failed') { const failed = document.createElement('p'); failed.className = 'transfer-failed'; failed.textContent = fileProgress.error || 'Save failed.'; fileDetails.append(failed); }
        row.append(fileDetails, download); files.append(row);
      }
      card.append(files);
    } else { const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'Files appear here after Torbox finishes processing the torrent.'; card.append(note); }
    container.append(card);
  }
}

async function loadTorboxJobs() {
  try { torboxJobs = await window.libraryApi.listTorboxJobs(); renderTorboxJobs(); }
  catch (error) { downloadsMessage(error.message || 'Unable to refresh Torbox status.', true); }
}

let activeGameForSearch = null;
let discoveredProtonTools = [];

async function loadTorbox() {
  try { torboxSettings = await window.libraryApi.getTorboxSettings(); renderTorbox(); await loadTorboxJobs(); }
  catch (error) { downloadsMessage(error.message || 'Unable to load Torbox settings.', true); }
}

async function selectGame(game) {
  const saved = await window.libraryApi.getLauncher(game.id);
  const config = saved || {
    runner: game.source === 'Steam' ? 'steam' : 'wine',
    executable: game.suggestedExecutable || '',
    workingDirectory: game.suggestedWorkingDirectory || game.path,
    wineBinary: 'wine',
    winePrefix: game.defaultCompatDataPath || '',
    protonPath: libraryData?.protonSettings?.protonPath || '',
    umuPath: libraryData?.protonSettings?.umuPath || 'umu-run',
    arguments: game.suggestedArguments?.map(arg => JSON.stringify(arg)).join(' ') || '',
    protonCompatibility: game.protonCompatibility || 0,
    runsOn: game.runsOn || { windows: true, linux: true },
    gameMode: false,
    mangoHud: false,
    useWineD3D: false,
    noEsync: false,
    noFsync: false,
    dxvkHud: '',
    store: '',
    umuGameId: ''
  };
  if (libraryData?.hostPlatform === 'win32' && !['steam', 'native'].includes(config.runner)) config.runner = game.source === 'Steam' ? 'steam' : 'native';
  if (libraryData?.hostPlatform === 'linux' && config.runner === 'proton') {
    config.protonPath ||= libraryData.protonSettings?.protonPath || '';
    config.umuPath ||= libraryData.protonSettings?.umuPath || 'umu-run';
    config.winePrefix ||= game.defaultCompatDataPath || '';
  }
  if (!Number.isInteger(config.protonCompatibility)) config.protonCompatibility = game.protonCompatibility || 0;
  if (!config.runsOn) config.runsOn = game.runsOn || { windows: true, linux: true };
  renderLauncher(game, config);
}

function renderLauncher(game, config) {
  const panel = $('#launcher-panel'); panel.replaceChildren();
  panel.innerHTML = `<p class="eyebrow">LAUNCHER</p><h2>${game.name}</h2><p class="muted">${game.path}</p>`;
  const runner = document.createElement('select');
  // Compatibility metadata describes the game; it must not block launcher setup.
  const runnerOptions = libraryData?.hostPlatform === 'win32'
    ? ['steam', 'native']
    : ['steam', 'native', 'wine', 'proton'];
  for (const option of runnerOptions) {
    const item = document.createElement('option'); item.value = option;
    item.textContent = option === 'steam'
      ? (libraryData?.hostPlatform === 'win32' ? 'Steam-managed' : 'Steam / Proton-managed')
      : option[0].toUpperCase() + option.slice(1);
    item.selected = config.runner === option; runner.append(item);
  }
  const runnerField = document.createElement('label'); runnerField.className = 'field'; runnerField.innerHTML = '<span>Runner</span>'; runnerField.append(runner); panel.append(runnerField);
  runner.addEventListener('change', () => { config.runner = runner.value; renderLauncher(game, config); });

  const protonSettings = document.createElement('div');
  const compatibility = document.createElement('select');
  for (let rating = 0; rating <= 5; rating += 1) {
    const item = document.createElement('option'); item.value = String(rating);
    item.textContent = rating === 0 ? '0 / 5 — No reported support' : `${rating} / 5${rating === 5 ? ' — Highest support' : ''}`;
    item.selected = config.protonCompatibility === rating; compatibility.append(item);
  }
  const compatibilityField = document.createElement('label'); compatibilityField.className = 'field'; compatibilityField.innerHTML = '<span>Proton compatibility rating</span>'; compatibilityField.append(compatibility); protonSettings.append(compatibilityField);
  compatibility.addEventListener('change', () => { config.protonCompatibility = Number(compatibility.value); });
  const platforms = document.createElement('div'); platforms.className = 'platforms';
  for (const platform of ['windows', 'linux']) { const label = document.createElement('label'); const box = document.createElement('input'); box.type = 'checkbox'; box.checked = config.runsOn[platform]; box.addEventListener('change', () => { config.runsOn[platform] = box.checked; }); label.append(box, ` Runs on ${platform === 'windows' ? 'Windows' : 'Linux'}`); platforms.append(label); }
  protonSettings.append(platforms);
  if (libraryData?.hostPlatform === 'win32') {
    const advanced = document.createElement('details'); advanced.className = 'advanced-proton';
    const summary = document.createElement('summary'); summary.textContent = 'Advanced Proton settings';
    advanced.append(summary, protonSettings); panel.append(advanced);
  } else panel.append(protonSettings);

  const storeId = input('Steam App ID (optional)', game.storeAppId || '', () => {}, 'Auto-match, App ID, or Steam Store URL');
  const storeIdControl = storeId.querySelector('input');
  const applyStoreId = document.createElement('button'); applyStoreId.textContent = 'Apply App ID';
  applyStoreId.addEventListener('click', async () => {
    $('#status').textContent = 'Fetching Steam game information…';
    try { await window.libraryApi.applyStoreAppId(game, storeIdControl.value.trim()); await load(); $('#status').textContent = 'Steam game information applied.'; }
    catch (error) { $('#status').textContent = error.message || 'Unable to fetch Steam game information.'; }
  });
  const searchStore = document.createElement('button'); searchStore.textContent = 'Search Steam Store';
  searchStore.addEventListener('click', () => openSteamSearchModal(game));

  const storeIdActions = document.createElement('div'); storeIdActions.className = 'launcher-actions'; storeIdActions.append(applyStoreId, searchStore); panel.append(storeId, storeIdActions);
  if (game.protonDbUrl) {
    const protonDbLink = document.createElement('a');
    protonDbLink.className = 'button-link';
    protonDbLink.href = game.protonDbUrl;
    protonDbLink.target = '_blank';
    protonDbLink.rel = 'noreferrer';
    protonDbLink.textContent = game.protonDb?.tier ? `ProtonDB (${game.protonDb.tier.toUpperCase()})` : 'View on ProtonDB';
    storeIdActions.append(protonDbLink);
  }

  if (config.runner === 'steam') panel.insertAdjacentHTML('beforeend', libraryData?.hostPlatform === 'win32'
    ? '<p class="hint">Steam launches this game with its own configured settings.</p>'
    : '<p class="hint">Steam launches this game with the Proton version and compatibility settings already configured in Steam.</p>');
  else {
    const exeRow = document.createElement('div'); exeRow.className = 'executable-row';
    exeRow.append(input('Executable', config.executable, value => { config.executable = value; }, '/path/to/game.exe'));
    const pick = document.createElement('button'); pick.textContent = 'Choose';
    pick.addEventListener('click', async () => { const chosen = await window.libraryApi.chooseExecutable(); if (chosen) { config.executable = chosen; renderLauncher(game, config); } });
    exeRow.append(pick); panel.append(exeRow);
    panel.append(input('Working directory', config.workingDirectory, value => { config.workingDirectory = value; }, game.path));
    if (config.runner === 'wine') {
      panel.append(input('Wine binary', config.wineBinary, value => { config.wineBinary = value; }, 'wine'));
      panel.append(input('Wine prefix (optional)', config.winePrefix, value => { config.winePrefix = value; }, '/path/to/prefix'));
    }
    if (config.runner === 'proton') {
      const protonField = document.createElement('label'); protonField.className = 'field'; protonField.innerHTML = '<span>GE-Proton directory / tool</span>';
      const protonSelect = document.createElement('select');
      const customOpt = document.createElement('option'); customOpt.value = 'custom'; customOpt.textContent = 'Custom Path...';
      protonSelect.append(customOpt);
      for (const tool of discoveredProtonTools) {
        const opt = document.createElement('option'); opt.value = tool.path; opt.textContent = tool.name;
        if (config.protonPath === tool.path) opt.selected = true;
        protonSelect.append(opt);
      }
      if (!discoveredProtonTools.some(t => t.path === config.protonPath) && config.protonPath) {
        customOpt.selected = true;
      }
      protonField.append(protonSelect); panel.append(protonField);

      const protonPathInput = protonDirectoryInput('Proton directory', config.protonPath, value => { config.protonPath = value; });
      protonPathInput.hidden = protonSelect.value !== 'custom';
      panel.append(protonPathInput);

      protonSelect.addEventListener('change', () => {
        if (protonSelect.value === 'custom') {
          protonPathInput.hidden = false;
        } else {
          protonPathInput.hidden = true;
          config.protonPath = protonSelect.value;
          protonPathInput.querySelector('input').value = config.protonPath;
        }
      });

      panel.append(input('UMU launcher', config.umuPath, value => { config.umuPath = value; }, 'umu-run'));
      panel.append(input('Wine prefix', config.winePrefix, value => { config.winePrefix = value; }, '/path/to/prefix'));
    }
    panel.append(input('Arguments', config.arguments, value => { config.arguments = value; }, '-windowed'));

    // Launch Environment & Performance Toggles
    const envSection = document.createElement('details'); envSection.className = 'advanced-proton';
    const envSummary = document.createElement('summary'); envSummary.textContent = 'Launch Environment & Performance Toggles'; envSection.append(envSummary);

    const togglesGrid = document.createElement('div'); togglesGrid.className = 'toggles-grid';
    const addToggle = (key, labelText) => {
      const label = document.createElement('label'); label.className = 'toggle-label';
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = Boolean(config[key]);
      box.addEventListener('change', () => { config[key] = box.checked; });
      label.append(box, labelText); togglesGrid.append(label);
    };

    if (config.runner === 'proton') addToggle('debugLogging', 'Enable Proton / UMU debug logs');
    addToggle('gameMode', 'GameMode');
    addToggle('mangoHud', 'MangoHud');
    addToggle('useWineD3D', 'WineD3D');
    addToggle('noEsync', 'No Esync');
    addToggle('noFsync', 'No Fsync');
    addToggle('enableFsr', 'Wine FSR Upscaler');
    addToggle('enableRdnaRayTracing', 'AMD RDNA Ray Tracing (DXR)');
    addToggle('hideNvidiaGpu', 'Hide NVIDIA GPU');
    addToggle('enableNvapi', 'NVIDIA NVAPI / DLSS');
    addToggle('enableMesaGlThread', 'Mesa OpenGL Threading');
    addToggle('largeAddressAware', 'Force 4GB LAA (32-bit patch)');
    addToggle('dxvkAsync', 'DXVK Async Shader Cache');
    envSection.append(togglesGrid);

    // AMD Vulkan Driver Field
    const amdDriverField = document.createElement('label'); amdDriverField.className = 'field';
    amdDriverField.innerHTML = '<span>AMD Vulkan Driver (AMD_VULKAN_ICD)</span>';
    const amdDriverSelect = document.createElement('select');
    const amdOptions = [
      { value: 'default', label: 'Default (System Driver)' },
      { value: 'radv', label: 'Mesa RADV (Open Source - Recommended)' },
      { value: 'amdvlk', label: 'AMDVLK (Official Open Source)' },
      { value: 'pro', label: 'AMDGPU-PRO (Proprietary Driver)' }
    ];
    for (const opt of amdOptions) {
      const item = document.createElement('option'); item.value = opt.value; item.textContent = opt.label;
      if ((config.amdVulkanDriver || 'default') === opt.value) item.selected = true;
      amdDriverSelect.append(item);
    }
    amdDriverSelect.addEventListener('change', () => { config.amdVulkanDriver = amdDriverSelect.value; });
    amdDriverField.append(amdDriverSelect); envSection.append(amdDriverField);

    // FSR Strength Field
    const fsrField = document.createElement('label'); fsrField.className = 'field';
    fsrField.innerHTML = '<span>FSR Sharpening Strength (WINE_FULLSCREEN_FSR_STRENGTH)</span>';
    const fsrSelect = document.createElement('select');
    const fsrOptions = [
      { value: '0', label: '0 — Ultra Sharp' },
      { value: '1', label: '1 — High Sharpness' },
      { value: '2', label: '2 — Balanced (Default)' },
      { value: '3', label: '3 — Medium' },
      { value: '4', label: '4 — Soft' },
      { value: '5', label: '5 — Softest' }
    ];
    for (const opt of fsrOptions) {
      const item = document.createElement('option'); item.value = opt.value; item.textContent = opt.label;
      if (String(config.fsrStrength ?? '2') === opt.value) item.selected = true;
      fsrSelect.append(item);
    }
    fsrSelect.addEventListener('change', () => { config.fsrStrength = fsrSelect.value; });
    fsrField.append(fsrSelect); envSection.append(fsrField);

    envSection.append(input('DXVK HUD (optional)', config.dxvkHud || '', value => { config.dxvkHud = value; }, 'compiler,fps'));
    envSection.append(input('UMU Store Context', config.store || '', value => { config.store = value; }, 'steam / gog / egs'));
    envSection.append(input('UMU Game ID Override', config.umuGameId || '', value => { config.umuGameId = value; }, 'umu-default or a UMU database ID'));

    panel.append(envSection);
  }

  const actions = document.createElement('div'); actions.className = 'launcher-actions';
  const save = document.createElement('button'); save.textContent = 'Save settings';
  save.addEventListener('click', async () => {
    save.disabled = true; $('#status').textContent = 'Saving launcher settings…';
    try {
      const saved = await window.libraryApi.saveLauncher(game, config);
      Object.assign(config, saved);
      $('#status').textContent = `Saved launcher for ${game.name}.`;
    } catch (error) { $('#status').textContent = error.message || 'Unable to save launcher settings.'; }
    finally { save.disabled = false; }
  });
  const preview = document.createElement('button'); preview.textContent = 'Preview command';
  preview.addEventListener('click', async () => { try { $('#status').textContent = (await window.libraryApi.previewLaunch(game, config)).command; } catch (error) { $('#status').textContent = error.message; } });
  const launch = document.createElement('button'); launch.className = 'primary'; launch.textContent = 'Launch';
  launch.addEventListener('click', async () => {
    try {
      expandDebugDrawer();
      $('#status').textContent = `Launching ${game.name}...`;
      await window.libraryApi.launch(game, config);
    } catch (error) { $('#status').textContent = error.message; }
  });
  actions.append(save, preview);
  if (config.runner === 'wine' || config.runner === 'proton') {
    const addonContainer = document.createElement('div'); addonContainer.className = 'addon-installer-row';
    addonContainer.style.display = 'inline-flex'; addonContainer.style.gap = '8px'; addonContainer.style.alignItems = 'center';

    const addonSelect = document.createElement('select');
    const addonOptions = [
      { value: 'vc_redist', label: 'Visual C++ 2015-2022' },
      { value: 'directx', label: 'DirectX Web Runtime' },
      { value: 'dotnet', label: 'Microsoft .NET Desktop 8' },
      { value: 'openal', label: 'OpenAL Audio Installer' }
    ];
    for (const opt of addonOptions) {
      const item = document.createElement('option'); item.value = opt.value; item.textContent = opt.label;
      addonSelect.append(item);
    }

    const installAddonBtn = document.createElement('button');
    installAddonBtn.textContent = 'Install Addon';
    installAddonBtn.title = 'Downloads and installs selected Windows runtime into this game prefix';
    installAddonBtn.addEventListener('click', async () => {
      const selectedKey = addonSelect.value;
      const selectedLabel = addonSelect.options[addonSelect.selectedIndex].text;
      installAddonBtn.disabled = true;
      try {
        expandDebugDrawer();
        $('#status').textContent = `Installing ${selectedLabel} into prefix...`;
        await window.libraryApi.installRuntimeAddon(game, config, selectedKey);
        $('#status').textContent = `${selectedLabel} installation finished.`;
      } catch (error) {
        $('#status').textContent = error.message || `Failed to install ${selectedLabel}.`;
      } finally {
        installAddonBtn.disabled = false;
      }
    });

    addonContainer.append(addonSelect, installAddonBtn);
    actions.append(addonContainer);
  }
  actions.append(launch); panel.append(actions);
}

// Debug Terminal drawer functions
function expandDebugDrawer() {
  $('#debug-drawer')?.classList.remove('collapsed');
  $('#debug-drawer')?.classList.add('expanded');
  const toggleBtn = $('#toggle-debug-drawer');
  if (toggleBtn) toggleBtn.textContent = 'Collapse Console';
}

function collapseDebugDrawer() {
  $('#debug-drawer')?.classList.remove('expanded');
  $('#debug-drawer')?.classList.add('collapsed');
  const toggleBtn = $('#toggle-debug-drawer');
  if (toggleBtn) toggleBtn.textContent = 'Expand Log Terminal';
}

$('#toggle-debug-drawer')?.addEventListener('click', () => {
  if ($('#debug-drawer')?.classList.contains('expanded')) collapseDebugDrawer();
  else expandDebugDrawer();
});

$('#clear-debug-logs')?.addEventListener('click', () => {
  $('#debug-terminal-logs').replaceChildren();
});

function appendDebugLog(logObj) {
  const terminal = $('#debug-terminal-logs');
  if (!terminal) return;
  const span = document.createElement('span');
  span.className = `log-${logObj.type || 'stdout'}`;
  span.textContent = logObj.text;
  terminal.append(span);
  const drawerBody = $('.debug-drawer-body');
  if (drawerBody) drawerBody.scrollTop = drawerBody.scrollHeight;
}

function updateLaunchStatus(statusObj) {
  const badge = $('#launch-status-badge');
  if (!badge) return;
  badge.className = `badge ${statusObj.state}`;
  badge.textContent = statusObj.state.toUpperCase();
  if (statusObj.state === 'starting' || statusObj.state === 'running') {
    expandDebugDrawer();
  }
}

if (window.libraryApi?.onLaunchLog) window.libraryApi.onLaunchLog(appendDebugLog);
if (window.libraryApi?.onLaunchStatus) window.libraryApi.onLaunchStatus(updateLaunchStatus);

// Steam Store Search Modal logic
function openSteamSearchModal(game) {
  activeGameForSearch = game;
  $('#steam-search-input').value = game.name;
  $('#steam-search-results').replaceChildren();
  $('#steam-search-status').textContent = '';
  $('#steam-search-modal').hidden = false;
  void performSteamSearch();
}

function closeSteamSearchModal() {
  $('#steam-search-modal').hidden = true;
  activeGameForSearch = null;
}

$('#close-steam-search')?.addEventListener('click', closeSteamSearchModal);
$('#steam-search-modal')?.addEventListener('click', (e) => {
  if (e.target === $('#steam-search-modal')) closeSteamSearchModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#steam-search-modal') && !$('#steam-search-modal').hidden) {
    closeSteamSearchModal();
  }
});

async function performSteamSearch() {
  const query = $('#steam-search-input').value.trim();
  if (!query) return;
  $('#steam-search-status').textContent = 'Searching Steam Store...';
  $('#steam-search-results').replaceChildren();
  try {
    const results = await window.libraryApi.searchSteamStore(query);
    if (!results.length) {
      $('#steam-search-status').textContent = 'No matching Steam Store items found.';
      return;
    }
    $('#steam-search-status').textContent = `Found ${results.length} results:`;
    for (const item of results) {
      const row = document.createElement('div'); row.className = 'search-result-item';
      const img = document.createElement('img'); img.src = item.tiny_image; img.alt = '';
      const title = document.createElement('span'); title.className = 'item-title'; title.textContent = item.name;
      const appId = document.createElement('span'); appId.className = 'item-id'; appId.textContent = `ID: ${item.id}`;
      row.append(img, title, appId);
      row.addEventListener('click', async () => {
        if (!activeGameForSearch) return;
        $('#steam-search-status').textContent = `Applying App ID ${item.id} to ${activeGameForSearch.name}...`;
        try {
          await window.libraryApi.applyStoreAppId(activeGameForSearch, item.id);
          closeSteamSearchModal();
          await load();
          $('#status').textContent = `Applied App ID ${item.id} to ${activeGameForSearch.name}.`;
        } catch (err) {
          $('#steam-search-status').textContent = err.message || 'Error applying App ID.';
        }
      });
      $('#steam-search-results').append(row);
    }
  } catch (err) {
    $('#steam-search-status').textContent = err.message || 'Error searching Steam Store.';
  }
}

$('#steam-search-btn')?.addEventListener('click', performSteamSearch);
$('#steam-search-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') void performSteamSearch(); });

async function load() {
  $('#status').textContent = 'Scanning installed libraries…';
  try {
    libraryData = await window.libraryApi.load();
    try { if (window.libraryApi.discoverCompatibilityTools) discoveredProtonTools = await window.libraryApi.discoverCompatibilityTools(); } catch {}
    renderGlobalProtonSettings();
    renderLibrary();
    $('#status').textContent = 'Library scan complete.';
  } catch (error) { $('#status').textContent = error.message || 'Unable to scan libraries.'; }
}

function renderLibrary() {
    const data = libraryData;
    if (!data) return;
    const steamGames = filtered(data.steam.games);
    showGames($('#steam-games'), steamGames);
    $('#steam-count').textContent = `${steamGames.length} shown · ${data.steam.games.length} installed · ${data.steam.libraries.length} librar${data.steam.libraries.length === 1 ? 'y' : 'ies'}`;
    $('#steam-empty').hidden = steamGames.length > 0;
    const server = $('#server-libraries'); server.replaceChildren(...data.folders.map(serverLibrary));
    if (!data.folders.length) server.innerHTML = '<p class="empty">No folder library added. Choose a mounted folder such as <code>/mnt/game-server</code>.</p>';
    $('#server-count').textContent = `${data.folders.length} location${data.folders.length === 1 ? '' : 's'}`;
}

$('#add-library').addEventListener('click', async () => {
  const folder = await window.libraryApi.chooseFolder(); if (!folder) return;
  try { await window.libraryApi.addFolder(folder); await load(); } catch (error) { $('#status').textContent = error.message; }
});
$('#rescan').addEventListener('click', load);
$('#discover-games').addEventListener('click', async () => {
  $('#status').textContent = 'Discovering game details and artwork from Steam…';
  try {
    const result = await window.libraryApi.discoverMetadata();
    await load();
    $('#status').textContent = `Discovery complete: ${result.discovered} updated, ${result.skipped} already cached, ${result.unmatched} unmatched.`;
  } catch (error) { $('#status').textContent = error.message || 'Game discovery could not be completed.'; }
});
$('#search-games').addEventListener('input', renderLibrary);
$('#source-filter').addEventListener('change', renderLibrary);
$('#library-tab').addEventListener('click', () => switchView('library'));
$('#downloads-tab').addEventListener('click', () => switchView('downloads'));
$('#refresh-downloads').addEventListener('click', loadTorboxJobs);
window.libraryApi.onTorboxProgress((progress) => {
  if (progress?.torrentId == null) return;
  if (progress.fileId != null) torboxProgress.set(`${progress.torrentId}:${progress.fileId}`, progress);
  if (isOverallProgress(progress)) torboxProgress.set(`${progress.torrentId}:overall`, progress);
  renderTorboxJobs();
});
load();
