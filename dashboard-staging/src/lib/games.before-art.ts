import { readdir, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";

export type GameRecord = {
  id: string; title: string; source: "Steam" | "Folder"; installPath: string;
  available: boolean; platform: "Linux" | "Windows" | "Unknown"; appId?: string;
};

const DEFAULT_FOLDER_LIBRARIES = ["/Beta/WindowsGames"];
async function isDirectory(candidate: string) { try { return (await stat(candidate)).isDirectory(); } catch { return false; } }
function acfValue(content: string, key: string) { return content.match(new RegExp(`"${key}"\\s+"([^"]*)"`))?.[1]; }

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
      games.push({ id: `steam:${appId}`, title, source: "Steam", installPath, available: await isDirectory(installPath), platform: "Linux", appId });
    } catch {}
  }
  return games;
}

async function scanFolder(root: string): Promise<GameRecord[]> {
  try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => ({ id: `folder:${path.join(root, entry.name)}`, title: entry.name, source: "Folder" as const, installPath: path.join(root, entry.name), available: true, platform: "Windows" as const })); }
  catch { return []; }
}

export async function scanGameLibrary() {
  const configuredFolders = (process.env.GAME_LIBRARY_FOLDERS || "").split(":").filter(Boolean);
  const folderLibraries = [...new Set([...DEFAULT_FOLDER_LIBRARIES, ...configuredFolders])].filter(existsSync);
  const [steam, ...folderSets] = await Promise.all([scanSteam(), ...folderLibraries.map(scanFolder)]);
  const games = [...steam, ...folderSets.flat()].sort((left, right) => left.title.localeCompare(right.title));
  return { games, scannedAt: new Date().toISOString(), sources: { steam: steam.length, folders: folderSets.flat().length, folderLibraries } };
}
