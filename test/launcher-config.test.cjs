const test = require('node:test');
const assert = require('node:assert/strict');
const {splitArguments, performanceSettings, checksumAssetName, decodeHtmlEntities, parseFitGirlRepack, parseFitGirlArtwork, fitGirlPlainText, parseFitGirlTopList, generateGameFolderName} = require('../src/launcher-config.cjs');
test('quoted, empty, escaped and Windows path arguments survive parsing', () => {
  assert.deepEqual(splitArguments('--name "My Game" "" C:\\Games\\foo.exe escaped\\ space').args, ['--name','My Game','','C:\\Games\\foo.exe','escaped space']);
  assert.throws(() => splitArguments('"unfinished'), /unmatched quote/);
});
test('only leading assignments become environment variables', () => {
  assert.deepEqual(splitArguments('PROTON_LOG=1 LABEL="My Game" --option KEY=value'), {args:['--option','KEY=value'],envInjected:{PROTON_LOG:'1',LABEL:'My Game'}});
});
test('all performance settings survive normalization', () => {
  const config = {enableFsr:true,enableNvapi:true,hideNvidiaGpu:true,enableRdnaRayTracing:true,enableMesaGlThread:true,largeAddressAware:true,dxvkAsync:true,amdVulkanDriver:'radv',fsrStrength:'3'};
  const result = performanceSettings(config);
  for (const [key,value] of Object.entries(config)) assert.equal(result[key], value);
  assert.throws(() => performanceSettings({fsrStrength:'7'}));
});
test('checksum matches upstream naming for both architectures', () => {
  for (const arch of ['x86_64','aarch64']) assert.equal(checksumAssetName(`GE-Proton11-7-${arch}.tar.gz`), `GE-Proton11-7-${arch}.sha512sum`);
});
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const context = { process: {platform: 'linux'}, path, splitArguments };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function launchSpec('), source.indexOf('function printableSpec(')), context);
test('metadata IDs do not invent a Steam storefront or UMU game ID', () => {
  const game = {source:'Server folder',path:'/games/test',storeAppId:'123'};
  const config = {runner:'proton',executable:'/games/test/game.exe',protonPath:'/tools/GE',winePrefix:'/prefix',arguments:'--name "My Game"'};
  const spec = context.launchSpec(game,config);
  assert.equal(spec.env.STORE, 'none'); assert.equal(spec.env.GAMEID, 'umu-default');
  assert.equal(JSON.stringify(spec.args), JSON.stringify([config.executable,'--name','My Game']));
  const custom = context.launchSpec(game,{...config,store:'gog',umuGameId:'umu-example'});
  assert.equal(custom.env.STORE,'gog'); assert.equal(custom.env.GAMEID,'umu-example');
});
test('Steam launch remains delegated to Steam', () => {
  const spec = context.launchSpec({source:'Steam',appId:'123'},null);
  assert.equal(spec.command,'xdg-open');
  assert.equal(spec.args[0],'steam://rungameid/123');
});

test('Proton debug toggle enables real environment logging without false library roots', () => {
  const config = {runner:'proton',executable:'/games/test/game.exe',protonPath:'/tools/GE',winePrefix:'/prefix',debugLogging:true};
  const spec = context.launchSpec({source:'Server folder',path:'/games/test'},config);
  assert.equal(spec.env.PROTON_LOG,'1'); assert.equal(spec.env.UMU_LOG,'1');
  assert.equal(spec.env.STEAM_COMPAT_LIBRARY_PATHS,undefined);
  assert.throws(() => context.launchSpec({path:'/games/test'}, {...config,arguments:'-dx11 PROTON_LOG=1 UMU_LOG=1'}), /before all game arguments/);
  assert.equal(performanceSettings(config).debugLogging,true);
});

test('decodeHtmlEntities converts numeric, hex, and named entities', () => {
  assert.equal(decodeHtmlEntities(''), '');
  assert.equal(decodeHtmlEntities(null), '');
  assert.equal(decodeHtmlEntities('A&nbsp;B &amp; C &lt;tag&gt;'), 'A B & C <tag>');
  assert.equal(decodeHtmlEntities('&#8217;rsquo &ndash; ndash &mdash; mdash'), '\u2019rsquo \u2013 ndash \u2014 mdash');
  assert.equal(decodeHtmlEntities('&#x41;&#66;'), 'AB');
  assert.equal(decodeHtmlEntities('&#8220;quoted&#8221;'), '\u201cquoted\u201d');
  assert.equal(decodeHtmlEntities('a&#39;b'), 'a\u0027b');
});

test('parseFitGirlRepack extracts info-hash, name, and size', () => {
  const hash = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  const content = `<p>Download link</p>
    <a href="magnet:?xt=urn:btih:${hash}&amp;dn=Game.Name-v1.0-FG&amp;tr=udp%3A%2F%2Ftracker" title="Game Name v1.0">
      Game Name v1.0 (4.2 GB)
    </a>`;
  const result = parseFitGirlRepack(content);
  assert.equal(result.infoHash, hash);
  assert.equal(result.magnet, `magnet:?xt=urn:btih:${hash}`);
  assert.match(result.downloadName, /Game\.Name-v1\.0-FG/);
  assert.equal(result.sizeLabel, '4.2 GB');
});

test('parseFitGirlRepack returns null without a magnet hash', () => {
  assert.equal(parseFitGirlRepack('<p>No download link here</p>'), null);
  assert.equal(parseFitGirlRepack(''), null);
  assert.equal(parseFitGirlRepack(null), null);
});

test('parseFitGirlTopList scopes to entry-content and dedupes', () => {
  const html = `
    <div class="entry-content">
      <a href="https://fitgirl-repacks.site/elden-ring-1080p/" title="Elden Ring 1080p"><img src="https://fitgirl-repacks.site/wp-content/uploads/elden-ring.jpg" alt="Elden Ring"></a>
      <a href="https://fitgirl-repacks.site/cyberpunk-2077/" title="Cyberpunk 2077">Cyberpunk</a>
      <a href="https://fitgirl-repacks.site/elden-ring-1080p/" title="Elden Ring 1080p">dup</a>
    </div>
    <aside>
      <a href="https://fitgirl-repacks.site/sidebar-game/" title="Sidebar">ignored</a>
    </aside>`;
  const games = parseFitGirlTopList(html);
  assert.deepEqual(games, [
    { slug: 'elden-ring-1080p', title: 'Elden Ring 1080p', imageUrl: 'https://fitgirl-repacks.site/wp-content/uploads/elden-ring.jpg' },
    { slug: 'cyberpunk-2077', title: 'Cyberpunk 2077', imageUrl: '' }
  ]);
});

test('parseFitGirlTopList decodes entities in titles', () => {
  const html = `<div class="entry-content"><a href="https://fitgirl-repacks.site/hot-s-t/" title="The &amp; Co &#8212; Game">x</a></div>`;
  const games = parseFitGirlTopList(html);
  assert.equal(games[0].slug, 'hot-s-t');
  assert.equal(games[0].title, 'The & Co \u2014 Game');
});

test('parseFitGirlArtwork accepts secure FitGirl art and rejects other origins', () => {
  assert.equal(parseFitGirlArtwork('<img src="https://fitgirl-repacks.site/wp-content/uploads/game.jpg">'), 'https://fitgirl-repacks.site/wp-content/uploads/game.jpg');
  assert.equal(parseFitGirlArtwork('<img data-src="https://cdn.fitgirl-repacks.site/game.jpg">'), 'https://cdn.fitgirl-repacks.site/game.jpg');
  assert.equal(parseFitGirlArtwork('<img src="https://i6.imageban.ru/game.jpg">'), 'https://i6.imageban.ru/game.jpg');
  assert.equal(parseFitGirlArtwork('<img src="https://s01.riotpixels.net/game.jpg">'), 'https://s01.riotpixels.net/game.jpg');
  assert.equal(parseFitGirlArtwork('<img src="http://i6.imageban.ru/game.jpg">'), '');
  assert.equal(parseFitGirlArtwork('<img src="https://torrent-stats.info/game.jpg">'), '');
  assert.equal(parseFitGirlArtwork('<img src="https://attacker.example/game.jpg">'), '');
});

test('fitGirlPlainText strips markup and decodes entities', () => {
  assert.equal(fitGirlPlainText('<p>A &amp; B</p><p>Game&nbsp;details</p>'), 'A & B Game details');
});

const helperContext = { path, crypto: require('node:crypto') };
vm.createContext(helperContext);
vm.runInContext(source.slice(source.indexOf('function safeDownloadName('), source.indexOf('async function recordTorboxFileSaved(')), helperContext);
test('safeDownloadRelativePath preserves nested subdirectories and strips dangerous characters', () => {
  assert.equal(helperContext.safeDownloadRelativePath('data/audio/voice.bin', 'fallback'), path.join('data', 'audio', 'voice.bin'));
  assert.equal(helperContext.safeDownloadRelativePath('../../../etc/passwd', 'fallback'), 'fallback');
  assert.equal(helperContext.safeDownloadRelativePath('setup:v1*?.exe', 'fallback'), 'setup_v1__.exe');
});

test('generateGameFolderName sanitizes titles into clean folder names', () => {
  assert.equal(generateGameFolderName('Elden Ring: Shadow of the Erdtree'), 'Elden Ring - Shadow of the Erdtree');
  assert.equal(generateGameFolderName('Cyberpunk 2077 / Phantom Liberty'), 'Cyberpunk 2077 - Phantom Liberty');
  assert.equal(generateGameFolderName('Half-Life 2: Episode One & Two...'), 'Half-Life 2 - Episode One & Two');
  assert.equal(generateGameFolderName('What/If? *Star Wars* <Special>'), 'What - If Star Wars Special');
  assert.equal(generateGameFolderName('Assassin&#8217;s Creed: Mirage &amp; Valhalla'), 'Assassin’s Creed - Mirage & Valhalla');
  assert.equal(generateGameFolderName(':::...'), 'Game');
  assert.equal(generateGameFolderName('', 'CustomFallback'), 'CustomFallback');
  assert.equal(generateGameFolderName(null), 'Game');
  assert.equal(generateGameFolderName('A'.repeat(200)).length, 120);
});


