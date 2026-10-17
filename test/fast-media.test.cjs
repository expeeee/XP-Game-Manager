const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { copyGameFiles } = require('../src/fast-media.cjs');

test('copyGameFiles stages nested files, executable modes, and symlinks with progress', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xpgm-fast-media-'));
  const source = path.join(temporaryRoot, 'source');
  const staged = path.join(temporaryRoot, 'staged');
  const payload = Buffer.from('game assets');
  try {
    await fs.mkdir(path.join(source, 'bin'), { recursive: true });
    await fs.mkdir(path.join(source, 'data'));
    await fs.writeFile(path.join(source, 'bin', 'game.exe'), '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(path.join(source, 'data', 'assets.bin'), payload);
    await fs.symlink('../data/assets.bin', path.join(source, 'asset-link'));
    const progress = [];
    await copyGameFiles(source, staged, new AbortController().signal, (event) => progress.push(event));

    assert.equal(await fs.readFile(path.join(staged, 'data', 'assets.bin'), 'utf8'), payload.toString());
    assert.equal((await fs.stat(path.join(staged, 'bin', 'game.exe'))).mode & 0o111, 0o111);
    assert.equal(await fs.readlink(path.join(staged, 'asset-link')), '../data/assets.bin');
    assert.equal(progress[0].state, 'scanning');
    assert.equal(progress.at(-1).state, 'complete');
    assert.equal(progress.at(-1).copiedBytes, payload.length + Buffer.byteLength('#!/bin/sh\n'));
    assert.equal(progress.at(-1).totalBytes, progress.at(-1).copiedBytes);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('copyGameFiles stops when its AbortSignal is already cancelled', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xpgm-fast-media-cancel-'));
  const source = path.join(temporaryRoot, 'source');
  const staged = path.join(temporaryRoot, 'staged');
  const controller = new AbortController();
  try {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'game.dat'), 'data');
    controller.abort();
    await assert.rejects(copyGameFiles(source, staged, controller.signal, () => {}), /Fast-media copy cancelled/);
    await assert.rejects(fs.access(staged));
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('copyGameFiles interrupts an active file transfer on cancellation', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xpgm-fast-media-active-cancel-'));
  const source = path.join(temporaryRoot, 'source');
  const staged = path.join(temporaryRoot, 'staged');
  const controller = new AbortController();
  try {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'large-game.dat'), Buffer.alloc(8 * 1024 * 1024, 7));
    await assert.rejects(
      copyGameFiles(source, staged, controller.signal, (event) => {
        if (event.state === 'copying' && event.copiedBytes > 0) controller.abort();
      }),
      /abort/i
    );
    assert.equal(controller.signal.aborted, true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
