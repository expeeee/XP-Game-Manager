const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

async function inventoryGameFiles(root, signal) {
  const entries = [];
  let totalBytes = 0;
  async function visit(directory, relativeDirectory = '') {
    if (signal.aborted) throw new Error('Fast-media copy cancelled.');
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = path.join(relativeDirectory, child.name);
      const sourcePath = path.join(directory, child.name);
      const stat = await fs.lstat(sourcePath);
      if (stat.isDirectory()) {
        entries.push({ type: 'directory', sourcePath, relativePath, mode: stat.mode & 0o777 });
        await visit(sourcePath, relativePath);
      } else if (stat.isSymbolicLink()) {
        entries.push({ type: 'symlink', sourcePath, relativePath });
      } else if (stat.isFile()) {
        entries.push({ type: 'file', sourcePath, relativePath, size: stat.size, mode: stat.mode & 0o777 });
        totalBytes += stat.size;
      } else {
        throw new Error(`Cannot stage unsupported game file: ${relativePath}`);
      }
    }
  }
  await visit(root);
  return { entries, totalBytes };
}

async function copyGameFiles(sourceRoot, targetRoot, signal, reportProgress) {
  reportProgress({ state: 'scanning', copiedBytes: 0, totalBytes: 0, relativePath: '' });
  const { entries, totalBytes } = await inventoryGameFiles(sourceRoot, signal);
  await fs.mkdir(targetRoot, { recursive: true });
  let copiedBytes = 0;
  reportProgress({ state: 'copying', copiedBytes, totalBytes, relativePath: '' });

  for (const entry of entries) {
    if (signal.aborted) throw new Error('Fast-media copy cancelled.');
    const targetPath = path.join(targetRoot, entry.relativePath);
    if (entry.type === 'directory') {
      await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
    } else if (entry.type === 'symlink') {
      await fs.symlink(await fs.readlink(entry.sourcePath), targetPath);
    } else {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      let lastFileReportAt = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          copiedBytes += chunk.length;
          const now = Date.now();
          if (now - lastFileReportAt >= 250 || copiedBytes === totalBytes) {
            lastFileReportAt = now;
            reportProgress({ state: 'copying', copiedBytes, totalBytes, relativePath: entry.relativePath });
          }
          callback(null, chunk);
        }
      });
      await pipeline(
        fsSync.createReadStream(entry.sourcePath),
        meter,
        fsSync.createWriteStream(targetPath, { mode: entry.mode }),
        { signal }
      );
      await fs.chmod(targetPath, entry.mode);
      reportProgress({ state: 'copying', copiedBytes, totalBytes, relativePath: entry.relativePath });
    }
  }

  for (const entry of entries) {
    if (entry.type === 'directory') {
      await fs.chmod(path.join(targetRoot, entry.relativePath), entry.mode);
    }
  }
  reportProgress({ state: 'complete', copiedBytes, totalBytes, relativePath: '' });
}

module.exports = { copyGameFiles };
