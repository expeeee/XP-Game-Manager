const $ = (selector) => document.querySelector(selector);
const cardTemplate = $('#game-card');
let libraryData = null;

function gameCard(game) {
  const card = cardTemplate.content.cloneNode(true);
  const article = card.querySelector('.game-card');
  const cover = document.createElement('div');
  cover.className = 'game-cover';
  if (game.artUrl) {
    const image = document.createElement('img'); image.src = game.artUrl; image.alt = '';
    image.addEventListener('error', () => image.remove()); cover.append(image);
  }
  if (!game.artUrl) cover.textContent = game.source === 'Steam' ? 'STEAM' : 'WINDOWS';
  article.prepend(cover);
  card.querySelector('h3').textContent = game.name;
  card.querySelector('.source').textContent = game.available ? game.source : `${game.source} · missing files`;
  card.querySelector('.compatibility').textContent = `Proton support ${game.protonCompatibility || 0}/5`;
  if (game.genres?.length) card.querySelector('.compatibility').textContent += ` · ${game.genres.join(', ')}`;
  card.querySelector('.summary').textContent = game.description || '';
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

function renderGlobalProtonSettings() {
  $('#global-proton-settings')?.remove();
  if (libraryData?.hostPlatform !== 'linux') return;
  const configuration = { ...libraryData.protonSettings };
  const panel = document.createElement('details'); panel.id = 'global-proton-settings'; panel.className = 'advanced-proton';
  const summary = document.createElement('summary'); summary.textContent = 'Global Proton settings'; panel.append(summary);
  panel.append(input('GE-Proton directory', configuration.protonPath, value => { configuration.protonPath = value; }, '/path/to/GE-Proton'));
  panel.append(input('UMU launcher', configuration.umuPath, value => { configuration.umuPath = value; }, 'umu-run'));
  panel.append(input('Compatibility-data root', configuration.compatDataRoot, value => { configuration.compatDataRoot = value; }, '/home/user/.local/share/xp-game-manager/compatdata'));
  const actions = document.createElement('div'); actions.className = 'launcher-actions';
  const installGe = document.createElement('button'); installGe.textContent = 'Install / update latest GE-Proton';
  installGe.addEventListener('click', async () => {
    installGe.disabled = true; $('#status').textContent = 'Downloading and verifying the latest GE-Proton release…';
    try {
      const result = await window.libraryApi.installGeProton();
      libraryData.protonSettings = result.settings;
      configuration.protonPath = result.protonPath;
      $('#status').textContent = result.alreadyInstalled ? `${result.version} is already installed.` : `${result.version} installed and selected.`;
      renderGlobalProtonSettings();
    } catch (error) { $('#status').textContent = error.message || 'Unable to install GE-Proton.'; }
    finally { installGe.disabled = false; }
  });
  const save = document.createElement('button'); save.textContent = 'Save global Proton settings';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try { libraryData.protonSettings = await window.libraryApi.saveProtonSettings(configuration); $('#status').textContent = 'Global Proton settings saved.'; }
    catch (error) { $('#status').textContent = error.message || 'Unable to save global Proton settings.'; }
    finally { save.disabled = false; }
  });
  actions.append(installGe, save); panel.append(actions);
  document.querySelector('.intro').after(panel);
}

async function selectGame(game) {
  const saved = await window.libraryApi.getLauncher(game.id);
  const config = saved || { runner: game.source === 'Steam' ? 'steam' : 'wine', executable: game.suggestedExecutable || '', workingDirectory: game.suggestedWorkingDirectory || game.path, wineBinary: 'wine', winePrefix: game.defaultCompatDataPath || '', protonPath: libraryData?.protonSettings?.protonPath || '', umuPath: libraryData?.protonSettings?.umuPath || 'umu-run', arguments: game.suggestedArguments?.join(' ') || '', protonCompatibility: game.protonCompatibility || 0, runsOn: game.runsOn || { windows: true, linux: true } };
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
  const runnerOptions = libraryData?.hostPlatform === 'win32'
    ? ['steam', ...(config.runsOn.windows ? ['native'] : [])]
    : ['steam', ...(config.runsOn.linux ? ['native'] : []), ...(config.runsOn.windows ? ['wine', 'proton'] : [])];
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
  const compatibilityField = document.createElement('label'); compatibilityField.className = 'field'; compatibilityField.innerHTML = '<span>Proton compatibility</span>'; compatibilityField.append(compatibility); protonSettings.append(compatibilityField);
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
  const applyStoreId = document.createElement('button'); applyStoreId.textContent = 'Find / fetch game info & art';
  applyStoreId.addEventListener('click', async () => {
    $('#status').textContent = 'Fetching Steam game information…';
    try { await window.libraryApi.applyStoreAppId(game, storeIdControl.value.trim()); await load(); $('#status').textContent = 'Steam game information applied.'; }
    catch (error) { $('#status').textContent = error.message || 'Unable to fetch Steam game information.'; }
  });
  const storeIdActions = document.createElement('div'); storeIdActions.className = 'launcher-actions'; storeIdActions.append(applyStoreId); panel.append(storeId, storeIdActions);
  if (game.protonDbUrl) {
    const protonDbLink = document.createElement('a');
    protonDbLink.className = 'button-link';
    protonDbLink.href = game.protonDbUrl;
    protonDbLink.target = '_blank';
    protonDbLink.rel = 'noreferrer';
    protonDbLink.textContent = 'View on ProtonDB';
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
      panel.append(input('GE-Proton directory', config.protonPath, value => { config.protonPath = value; }, '/path/to/GE-Proton')); 
      panel.append(input('UMU launcher', config.umuPath, value => { config.umuPath = value; }, 'umu-run'));
      panel.append(input('Wine prefix', config.winePrefix, value => { config.winePrefix = value; }, '/path/to/prefix'));
    }
    panel.append(input('Arguments', config.arguments, value => { config.arguments = value; }, '-windowed'));
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
  launch.addEventListener('click', async () => { try { $('#status').textContent = `Launch requested: ${(await window.libraryApi.launch(game, config)).command}`; } catch (error) { $('#status').textContent = error.message; } });
  actions.append(save, preview, launch); panel.append(actions);
}

async function load() {
  $('#status').textContent = 'Scanning installed libraries…';
  try {
    libraryData = await window.libraryApi.load();
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
load();
