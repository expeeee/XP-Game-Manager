const BOOLEAN_OPTIONS = ['debugLogging', 'gameMode', 'mangoHud', 'useWineD3D', 'noEsync', 'noFsync', 'enableFsr', 'enableRdnaRayTracing', 'hideNvidiaGpu', 'enableNvapi', 'enableMesaGlThread', 'largeAddressAware', 'dxvkAsync'];
function performanceSettings(config) {
  const settings = Object.fromEntries(BOOLEAN_OPTIONS.map(key => [key, Boolean(config[key])]));
  settings.amdVulkanDriver = ['default', 'radv', 'amdvlk', 'pro'].includes(config.amdVulkanDriver) ? config.amdVulkanDriver : 'default';
  settings.fsrStrength = config.fsrStrength === undefined || config.fsrStrength === '' ? '' : String(config.fsrStrength);
  if (settings.fsrStrength && !/^[0-5]$/.test(settings.fsrStrength)) throw new Error('FSR strength must be from 0 to 5.');
  return settings;
}
function splitArguments(value) {
  if (!value || typeof value !== 'string') return { args: [], envInjected: {} };
  const tokens = []; let token = ''; let quote = ''; let started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\' && quote !== "'" && i + 1 < value.length && (value[i + 1] === quote || /[\s\\"']/.test(value[i + 1]))) { token += value[++i]; started = true; }
    else if (quote) { if (char === quote) quote = ''; else token += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) tokens.push(token); token = ''; started = false; }
    else { token += char; started = true; }
  }
  if (quote) throw new Error('Launch arguments contain an unmatched quote.');
  if (started) tokens.push(token);
  const args = []; const envInjected = {}; let leading = true;
  for (const item of tokens) {
    const match = leading && /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(item);
    if (match) envInjected[match[1]] = match[2];
    else { leading = false; args.push(item); }
  }
  return { args, envInjected };
}
function checksumAssetName(name) { return name.replace(/\.tar\.gz$/, '.sha512sum'); }
module.exports = { performanceSettings, splitArguments, checksumAssetName };
