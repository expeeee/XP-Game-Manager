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

function decodeHtmlEntities(value) {
  if (typeof value !== 'string' || !value) return '';
  return value
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '\u2019')
    .replace(/&#8211;|&ndash;/g, '\u2013')
    .replace(/&#8212;|&mdash;/g, '\u2014')
    .replace(/&#8216;|&lsquo;/g, '\u2018')
    .replace(/&#8220;|&ldquo;/g, '\u201c')
    .replace(/&#8221;|&rdquo;/g, '\u201d')
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'");
}

// Extract the primary magnet info-hash, a human download name, and the
// advertised size from a FitGirl repack post's HTML content.
function parseFitGirlRepack(content) {
  const text = typeof content === 'string' ? content : '';
  const magnet = text.match(/urn:btih:([A-Fa-f0-9]{40})/i);
  if (!magnet) return null;
  const infoHash = magnet[1].toUpperCase();
  const segment = text.slice(magnet.index);
  const dnMatch = segment.match(/dn=([^&\s"']+)/);
  let downloadName = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : '';
  const sizeLabel = (() => {
    for (const candidate of [downloadName, segment, text]) {
      const sizeMatch = (candidate || '').match(/([0-9]+(?:\.[0-9]+)?)\s*(GB|MB|TB)\b/i);
      if (sizeMatch) return `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
    }
    return '';
  })();
  if (!downloadName) {
    const titleMatch = text.match(/title="([^"]+)"/i);
    if (titleMatch) downloadName = decodeHtmlEntities(titleMatch[1]);
  }
  return { infoHash, downloadName, sizeLabel, magnet: `magnet:?xt=urn:btih:${infoHash}` };
}

function parseFitGirlArtwork(content) {
  const text = typeof content === 'string' ? content : '';
  const approvedHosts = [
    'fitgirl-repacks.site',
    'imageban.ru',
    'riotpixels.net',
    'fastly.steamstatic.com',
    'akamai.steamstatic.com',
    'cloudflare.steamstatic.com',
    'fastpic.ru'
  ];
  for (const imageTag of text.matchAll(/<img\b[^>]*>/gi)) {
    const source = imageTag[0].match(/\b(?:src|data-src)="([^"]+)"/i)?.[1] || '';
    if (!source) continue;
    try {
      const url = new URL(decodeHtmlEntities(source));
      if (url.protocol === 'https:' && approvedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        return url.href;
      }
    } catch {}
  }
  return '';
}

function fitGirlPlainText(value) {
  return decodeHtmlEntities(typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ') : '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Scrape the ordered {slug,title} list from a FitGirl "top repacks" page,
// scoped to the main content so sidebar widgets are ignored.
function parseFitGirlTopList(html) {
  const text = typeof html === 'string' ? html : '';
  const start = text.indexOf('entry-content');
  const stop = text.indexOf('<aside', start >= 0 ? start : 0);
  const scope = start >= 0 ? text.slice(start, stop > start ? stop : undefined) : text;
  const games = [];
  const seen = new Set();
  for (const match of scope.matchAll(/<a\b[^>]*href="https:\/\/fitgirl-repacks\.site\/([a-z0-9-]+)\/"[^>]*title="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    games.push({
      slug: match[1],
      title: decodeHtmlEntities(match[2]),
      imageUrl: parseFitGirlArtwork(match[3])
    });
  }
  return games;
}

function generateGameFolderName(title, fallback = 'Game') {
  if (typeof title !== 'string' || !title.trim()) return String(fallback || 'Game').trim() || 'Game';
  const clean = decodeHtmlEntities(title)
    .replace(/[:/\\|]+/g, ' - ')
    .replace(/[<>?"*\x00-\x1f]/g, '')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-. ]+|[-. ]+$/g, '');
  return clean ? clean.slice(0, 120) : (String(fallback || 'Game').trim() || 'Game');
}

module.exports = { performanceSettings, splitArguments, checksumAssetName, decodeHtmlEntities, parseFitGirlRepack, parseFitGirlArtwork, fitGirlPlainText, parseFitGirlTopList, generateGameFolderName };

