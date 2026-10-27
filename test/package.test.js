'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listFiles, PackageManager } = require('@vscode/vsce');

test('VSIXに同梱するファイルだけで拡張機能を読み込める', async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = await fs.mkdtemp(path.join(os.tmpdir(), 'fnote-package-'));
  try {
    const files = await listFiles({ cwd: root, packageManager: PackageManager.None });
    for (const file of files) {
      const destination = path.join(packaged, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(root, file), destination);
    }
    // Start outside the checkout so local dist files cannot conceal omissions.
    // VS Code supplies this one external module when loading the real package.
    execFileSync(process.execPath, ['-e', `
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function (id, ...args) {
        return id === 'vscode' ? {} : load.call(this, id, ...args);
      };
      const assert = require('node:assert/strict');
      assert.equal(typeof require('./').activate, 'function');
    `], { cwd: packaged, stdio: 'pipe' });
    for (const asset of ['media/notes.js', 'media/fnote.svg', 'media/codicons/codicon.css', 'media/codicons/codicon.ttf']) {
      assert.ok((await fs.stat(path.join(packaged, asset))).size > 0, `${asset} must be packaged`);
    }
  } finally {
    await fs.rm(packaged, { recursive: true, force: true });
  }
});
