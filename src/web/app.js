const $ = (selector) => document.querySelector(selector);
const template = $('#game-card');
let library = null;

function card(game) {
  const fragment = template.content.cloneNode(true);
  const cover = fragment.querySelector('.cover');
  if (game.artUrl) {
    const image = new Image(); image.src = game.artUrl; image.alt = '';
    image.addEventListener('error', () => { cover.textContent = 'STEAM'; }); cover.append(image);
  } else cover.textContent = game.source === 'Steam' ? 'STEAM' : 'FOLDER';
  fragment.querySelector('h2').textContent = game.name;
  fragment.querySelector('.details').textContent = `${game.source} · ${game.available ? 'Available' : 'Missing files'}`;
  const compatibility = fragment.querySelector('.compatibility');
  if (library?.hostPlatform === 'win32') compatibility.remove();
  else compatibility.textContent = `Proton support ${game.protonCompatibility || 0}/5`;
  fragment.querySelector('.genres').textContent = game.genres?.join(' · ') || '';
  fragment.querySelector('.summary').textContent = game.description || '';
  if (game.protonDbUrl) {
    const protonDbLink = document.createElement('a');
    protonDbLink.className = 'protondb';
    protonDbLink.href = game.protonDbUrl;
    protonDbLink.target = '_blank';
    protonDbLink.rel = 'noreferrer';
    protonDbLink.textContent = 'View on ProtonDB';
    fragment.querySelector('code').before(protonDbLink);
  }
  fragment.querySelector('code').textContent = game.path;
  return fragment;
}

function visible(games) {
  const query = $('#search').value.trim().toLowerCase(); const source = $('#source').value;
  return games.filter((game) => (source === 'all' || game.source === source) && (!query || game.name.toLowerCase().includes(query)));
}

function section(title, label, games, message = '') {
  const element = document.createElement('section');
  const header = document.createElement('div'); header.className = 'section-heading';
  const heading = document.createElement('h2'); heading.textContent = title;
  const count = document.createElement('span'); count.textContent = label; header.append(heading, count); element.append(header);
  if (message) { const error = document.createElement('p'); error.className = 'notice'; error.textContent = message; element.append(error); }
  const grid = document.createElement('div'); grid.className = 'grid'; grid.append(...visible(games).map(card)); element.append(grid);
  return element;
}

function render() {
  if (!library) return;
  const root = $('#libraries'); root.replaceChildren();
  root.append(section('Steam', `${visible(library.steam.games).length} shown · ${library.steam.games.length} installed`, library.steam.games));
  for (const folder of library.folders) root.append(section(folder.root, folder.error || `${visible(folder.games).length} shown · ${folder.games.length} folders`, folder.games, folder.error));
  if (!library.folders.length) { const empty = document.createElement('p'); empty.className = 'notice'; empty.textContent = 'No folder libraries are configured in the desktop app.'; root.append(empty); }
}

async function load() {
  $('#status').textContent = 'Scanning library…';
  try {
    const response = await fetch('/api/games', { cache: 'no-store' });
    if (!response.ok) throw new Error('The library scan could not be completed.');
    library = await response.json(); render(); $('#status').textContent = 'Library scan complete.';
  } catch (error) { $('#status').textContent = error.message || 'The library scan could not be completed.'; }
}

$('#rescan').addEventListener('click', load); $('#search').addEventListener('input', render); $('#source').addEventListener('change', render); load();
$('#discover').addEventListener('click', async () => {
  $('#status').textContent = 'Discovering game details and artwork from Steam…';
  try {
    const response = await fetch('/api/discover', { method: 'POST' });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    await load();
    $('#status').textContent = `Discovery complete: ${result.discovered} updated, ${result.skipped} already cached, ${result.unmatched} unmatched.`;
  } catch (error) { $('#status').textContent = error.message || 'Game discovery could not be completed.'; }
});
