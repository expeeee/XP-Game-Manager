import { readdir, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";

export type GameRecord = {
  id: string; title: string; source: "Steam" | "Folder"; installPath: string;
  available: boolean; platform: "Linux" | "Windows" | "Unknown"; protonCompatibility: number; appId?: string; artUrl?: string;
};

const DEFAULT_FOLDER_LIBRARIES = ["/Beta/WindowsGames"];
const GAME_SETTINGS_FILE = path.join(os.homedir(), ".config", "linux-game-manager", "game-launchers.json");
async function isDirectory(candidate: string) { try { return (await stat(candidate)).isDirectory(); } catch { return false; } }
function acfValue(content: string, key: string) { return content.match(new RegExp(`"${key}"\\s+"([^"]*)"`))?.[1]; }
async function protonCompatibility(gameId: string) {
  try {
    const settings = JSON.parse(await readFile(GAME_SETTINGS_FILE, "utf8"));
    const rating = settings?.[gameId]?.protonCompatibility;
    return Number.isInteger(rating) && rating >= 0 && rating <= 5 ? rating : 0;
  } catch { return 0; }
}

async function steamLibraries() {
  const homes = [...new Set([process.env.GAME_LIBRARY_HOME, "/home/xpchen", os.homedir()].filter(Boolean) as string[])];
  const libraries = new Set<string>();
  for (const home of homes) for (const root of [path.join(home, ".steam", "steam"), path.join(home, ".local", "share", "Steam")]) {
    if (!(await isDirectory(root))) continue;
    libraries.add(root);
    try { const vdf = await readFile(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8"); for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(match[1].replace(/\\\\/g, "/")); } catch {}
  }
  return [...libraries];
}

async function scanSteam(): Promise<GameRecord[]> {
  const games: GameRecord[] = [];
  for (const library of await steamLibraries()) {
    const steamapps = path.join(library, "steamapps"); let files: string[] = [];
    try { files = await readdir(steamapps); } catch { continue; }
    for (const file of files.filter((name) => /^appmanifest_\d+\.acf$/.test(name))) try {
      const manifest = await readFile(path.join(steamapps, file), "utf8");
      const appId = acfValue(manifest, "appid"), title = acfValue(manifest, "name"), installDir = acfValue(manifest, "installdir");
      if (!appId || !title || !installDir) continue;
      const installPath = path.join(steamapps, "common", installDir);
      const id = `steam:${appId}`;
      games.push({ id, title, source: "Steam", installPath, available: await isDirectory(installPath), platform: "Linux", protonCompatibility: await protonCompatibility(id), appId, artUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg` });
    } catch {}
  }
  return games;
}

async function scanFolder(root: string): Promise<GameRecord[]> {
  try { return Promise.all((await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(async (entry) => { const installPath = path.join(root, entry.name); const id = `folder:${installPath}`; return { id, title: entry.name, source: "Folder" as const, installPath, available: true, platform: "Windows" as const, protonCompatibility: await protonCompatibility(id) }; })); }
  catch { return []; }
}

export async function scanGameLibrary() {
  const configuredFolders = (process.env.GAME_LIBRARY_FOLDERS || "").split(":").filter(Boolean);
  const folderLibraries = [...new Set([...DEFAULT_FOLDER_LIBRARIES, ...configuredFolders])].filter(existsSync);
  const [steam, ...folderSets] = await Promise.all([scanSteam(), ...folderLibraries.map(scanFolder)]);
  const games = [...steam, ...folderSets.flat()].sort((left, right) => left.title.localeCompare(right.title));
  return { games, scannedAt: new Date().toISOString(), sources: { steam: steam.length, folders: folderSets.flat().length, folderLibraries } };
}
