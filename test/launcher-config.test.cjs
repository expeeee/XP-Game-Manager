const test = require('node:test');
const assert = require('node:assert/strict');
const {splitArguments, performanceSettings, checksumAssetName} = require('../src/launcher-config.cjs');
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
