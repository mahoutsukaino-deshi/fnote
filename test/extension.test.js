'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('拡張機能: 保存・再読込・子ノート移動・循環防止・検索・削除', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'fnote-test-'));
  const contexts = new Map();
  const commands = new Map(), views = new Map(), errors = [], inputs = [], picks = [];
  const disposable = () => ({ dispose() {} });
  const uri = p => ({ fsPath: p, toString: () => `file://${p}` });
  const fileError = e => { if (e.code === 'ENOENT') e.code = 'FileNotFound'; throw e; };
  let html = '', panelCount = 0, panelDisposeCount = 0, receiveMessage, shown;
  const documents = [];
  const editorStyles = [];
  const closeCalls = [];
  let closeResult = true;
  const settings = new Map([['defaultTagMark', '🏷️']]);
  const api = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    FileType: { File: 1, Directory: 2 }, TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ViewColumn: { Active: -1 },
    TabInputText: class { constructor(uri) { this.uri = uri; } },
    TabInputWebview: class { constructor(viewType) { this.viewType = viewType; } },
    Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
    TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
    EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    RelativePattern: class {}, DataTransferItem: class { constructor(value) { this.value = value; } },
    WorkspaceEdit: class { ops = []; replace(u, range, value) { this.ops.push(async () => { const text = await fs.readFile(u.fsPath, 'utf8'); await fs.writeFile(u.fsPath, text.slice(0, range.start.offset) + value + text.slice(range.end.offset)); }); } renameFile(a, b) { this.ops.push(() => fs.rename(a.fsPath, b.fsPath)); } deleteFile(a) { this.ops.push(() => fs.rm(a.fsPath, { recursive: true })); } },
    commands: { executeCommand: (name, ...args) => name === 'setContext' ? contexts.set(...args) : commands.get(name)(...args), registerCommand(name, fn) { commands.set(name, fn); return disposable(); } },
    workspace: {
      workspaceFolders: [{ uri: uri(temp) }], textDocuments: documents,
      getConfiguration: () => ({ inspect: key => ({ globalValue: settings.get(key) }), get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback }),
      fs: {
        readDirectory: async u => (await fs.readdir(u.fsPath, { withFileTypes: true }).catch(fileError)).map(e => [e.name, e.isDirectory() ? 2 : 1]),
        readFile: u => fs.readFile(u.fsPath).catch(fileError), writeFile: (u, data) => fs.writeFile(u.fsPath, data),
        createDirectory: u => fs.mkdir(u.fsPath, { recursive: true }), stat: u => fs.stat(u.fsPath).catch(fileError)
      },
      applyEdit: async edit => { for (const op of edit.ops) await op(); return true; },
      openTextDocument: async u => { const text = documents.find(doc => doc.uri.toString() === u.toString())?.getText() ?? await fs.readFile(u.fsPath, 'utf8'); return { uri: u, getText: () => text, positionAt: offset => ({ offset }) }; },
      createFileSystemWatcher: () => ({ ...disposable(), onDidCreate: disposable, onDidDelete: disposable, onDidChange: disposable }),
      onDidChangeTextDocument: disposable, onDidCloseTextDocument: disposable, onDidChangeConfiguration: disposable
    },
    window: {
      tabGroups: { all: [], close: async (tabs, preserveFocus) => { closeCalls.push({ tabs, preserveFocus }); return closeResult; } },
      registerWebviewViewProvider: (id, provider) => { views.set(id, { treeDataProvider: provider.data, webviewProvider: provider }); return disposable(); },
      createTextEditorDecorationType: options => ({ ...disposable(), options }),
      visibleTextEditors: [], createTreeView: (id, options) => { const view = { ...disposable(), ...options, selection: [], reveal: async () => {} }; views.set(id, view); return view; },
      showInputBox: async () => inputs.shift(), showQuickPick: async () => picks.shift(), showWarningMessage: async () => '削除',
      showErrorMessage: message => errors.push(message), showTextDocument: async (doc, options) => { shown = { doc, options }; },
      onDidChangeVisibleTextEditors: disposable, onDidChangeActiveTextEditor: disposable,
      createWebviewPanel: () => { panelCount++; let onDispose; return { dispose() { panelDisposeCount++; onDispose?.(); }, reveal() {}, onDidDispose: handler => { onDispose = handler; return disposable(); }, webview: { asWebviewUri: value => value.toString(), cspSource: "https://webview.test", set html(value) { html = value; }, onDidReceiveMessage: handler => { receiveMessage = handler; return disposable(); } } }; }
    }
  };
  const original = Module._load;
  Module._load = function(name, ...rest) { return name === 'vscode' ? api : name === 'node:os' ? { ...os, homedir: () => temp } : original.call(this, name, ...rest); };
  const savedState = new Map();
  const context = { extensionUri: uri(path.resolve(__dirname, '..')), subscriptions: [], globalState: { get: (key, fallback) => savedState.get(key) ?? fallback, update: async (key, value) => { savedState.set(key, value); } }, globalStorageUri: uri(temp) };
  try {
    const { activate } = require('../dist/extension');
    await activate(context);
    const run = (name, ...args) => commands.get(`fnote.${name}`)(...args);
    const provider = views.get('fnote.notes').treeDataProvider;
    inputs.push('音楽'); await run('add');
    const parent = provider.getChildren()[0];
    assert.equal(provider.getTreeItem(parent).label, '$(note) 音楽');
    settings.set('untaggedNoteMark', '📝');
    assert.equal(provider.getTreeItem(parent).label, '📝 音楽');
    settings.set('untaggedNoteMark', '');
    assert.equal(provider.getTreeItem(parent).label, '音楽');
    settings.delete('untaggedNoteMark');

    inputs.push('曲'); await run('addChild', parent);
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), '@TODO @2026/09/01');
    await run('refresh');
    let child = provider.getChildren(parent)[0];
    assert.equal(provider.getTreeItem(child).label, '🏷️ 曲');
    const noteTab = { input: new api.TabInputText(uri(path.join(temp, '.fnote/音楽/index.md'))) };
    const childTab = { input: new api.TabInputText(uri(path.join(temp, '.fnote/音楽/曲/index.md'))), isDirty: true };
    const duplicateTab = { input: new api.TabInputText(noteTab.input.uri) };
    const unrelatedTab = { input: new api.TabInputText(uri(path.join(temp, 'index.md'))) };
    const resultTab = { input: new api.TabInputWebview('fnote.results') };
    const unrelatedWebviewTab = { input: new api.TabInputWebview('other.results') };
    api.window.tabGroups.all = [{ tabs: [noteTab, unrelatedTab, unrelatedWebviewTab] }, { tabs: [childTab, duplicateTab, resultTab] }];
    await run('closeAllNotes');
    assert.deepEqual(closeCalls[0], { tabs: [noteTab, childTab, duplicateTab], preserveFocus: true });
    closeResult = false;
    await run('closeAllNotes');
    assert.equal(closeCalls.length, 2, 'キャンセル時に強制終了や再試行をしない');
    closeResult = true;
    api.window.tabGroups.all = [{ tabs: [unrelatedTab, resultTab] }];
    await run('closeAllNotes');
    assert.equal(closeCalls.length, 2);
    api.window.tabGroups.all = [{ tabs: [unrelatedTab, unrelatedWebviewTab] }];
    await run('closeAllNotes');
    assert.equal(closeCalls.length, 2, '対象がなければ何もしない');
    api.window.tabGroups.all = [];
    settings.set('tagStyles', { TODO: { mark: '🔴' } });
    assert.equal(provider.getTreeItem(child).label, '🔴 曲');
    settings.set('tagStyles', { '2026/09': { mark: '📅' }, TODO: { mark: '🔴' } });
    assert.equal(provider.getTreeItem(child).label, '🔴 曲');
    settings.set('tagStyles', { TODO: { mark: '🔴' }, '2026/09': { mark: '📅' } });
    assert.equal(provider.getTreeItem(child).label, '🔴 曲');
    settings.delete('tagStyles');
    const tagSidebar = views.get('fnote.tags').webviewProvider;
    let tagMessage, tagRows = [], tagHtml;
    tagSidebar.resolveWebviewView({ webview: {
      asWebviewUri: value => value,
      set html(value) { tagHtml = value; },
      postMessage: async message => { if (message.type === 'notes') tagRows = message.rows; },
      onDidReceiveMessage: handler => { tagMessage = handler; return disposable(); }
    } });
    await tagMessage({ type: 'ready' });
    await tagMessage({ type: 'expansionState', allCollapsed: true, hasBranches: true });
    assert.equal(contexts.get('fnote.tagsAllCollapsed'), true);
    assert.match(tagHtml, /data-tags="true"/);
    settings.set('tagStyles', [{ tag: 'date', mark: '$(calendar)', markColor: '#ABCDEF' }]);
    await run('refresh');
    for (const id of ['2026', '2026/09', '2026/09/01']) {
      const row = tagRows.find(row => row.id === id);
      assert.ok(row.label.startsWith('$(calendar) '));
      assert.deepEqual(row.appearance, { mark: '$(calendar)', color: '#ABCDEF' });
    }
    settings.delete('tagStyles');
    await run('refresh');
    assert.equal(tagRows.find(row => row.id === 'TODO').label, '🏷️ TODO');
    for (const mark of [undefined, '', '   ']) {
      settings.set('tagStyles', [{ tag: 'TODO', mark }]);
      await run('refresh');
      assert.equal(tagRows.find(row => row.id === 'TODO').label, '🏷️ TODO');
      assert.equal(provider.getTreeItem(child).label, '🏷️ 曲');
      await run('filter', 'TODO');
      assert.match(html, /🏷️ 曲<\/button>/);
    }
    settings.delete('tagStyles');
    await tagMessage({ type: 'drop', id: 'TODO', target: '2026', position: 'before' });
    assert.deepEqual(tagRows.filter(row => !row.parent).map(row => row.id), ['TODO', '2026']);
    assert.deepEqual(savedState.get(`tagOrder:file://${path.join(temp, '.fnote')}`), ['TODO', '2026']);
    await tagMessage({ type: 'drop', id: 'TODO', target: '2026', position: 'after' });
    assert.deepEqual(tagRows.filter(row => !row.parent).map(row => row.id), ['2026', 'TODO']);
    await tagMessage({ type: 'drop', id: 'TODO', target: '2026/09', position: 'before' });
    assert.deepEqual(tagRows.filter(row => !row.parent).map(row => row.id), ['2026', 'TODO']);
    await tagMessage({ type: 'drop', id: '2026', position: 'inside' });
    await run('refresh');
    assert.deepEqual(tagRows.filter(row => !row.parent).map(row => row.id), ['TODO', '2026']);

    assert.equal((await fs.readFile(path.join(temp, '.fnote/音楽/index.md'), 'utf8')), '# 音楽\n\n');
    await run('filter', '2026'); assert.equal(panelCount, 1); assert.match(html, /音楽/); assert.match(html, /曲/); assert.match(html, /1 件/);
    settings.set('tagHierarchy', { 状態: ['TODO', 'WAIT'] });
    await run('refresh');
    assert.equal(tagRows.find(row => row.id === 'TODO').parent, '状態');
    assert.equal(tagRows.find(row => row.id === '状態').description, '1');
    await run('filter', '状態');
    assert.match(html, /1 件のノート/);
    assert.match(html, /@TODO/);
    settings.delete('tagHierarchy');
    await run('refresh');
    assert.equal(tagRows.find(row => row.id === 'TODO').parent, '');
    // Exercise actual sidebar messages, including file moves and insertion order.
    let sidebarMessage, noteRows = [];
    const sidebar = views.get('fnote.notes').webviewProvider;
    sidebar.resolveWebviewView({ webview: {
      asWebviewUri: value => value,
      postMessage: async message => { if (message.type === 'notes') noteRows = message.rows; },
      onDidReceiveMessage: handler => { sidebarMessage = handler; return disposable(); }
    } });
    await sidebarMessage({ type: 'expansionState', allCollapsed: false, hasBranches: true });
    assert.equal(contexts.get('fnote.notesAllCollapsed'), false);
    assert.equal(contexts.get('fnote.tagsAllCollapsed'), true);
    const outlineText = '# 音楽\r\n## 節 🎵\r\n#### 小節 `code` ###\r\n```md\r\n## 非表示\r\n```\r\n## 節 🎵\r\n# 別タイトル\r\n###### 末尾';
    await fs.writeFile(path.join(temp, '.fnote/音楽/index.md'), outlineText);
    await run('refresh');
    const outline = noteRows.filter(row => row.noteId === '音楽');
    assert.deepEqual(outline.map(row => row.label), ['節 🎵', '小節 `code`', '節 🎵', '末尾']);
    assert.deepEqual(outline.map(row => row.parent), ['音楽', outline[0].id, '音楽', '音楽']);
    assert.notEqual(outline[0].id, outline[2].id);
    await sidebarMessage({ type: 'open', id: outline[1].id });
    assert.equal(shown.options.selection.start.offset, outlineText.indexOf('#### 小節'));
    await sidebarMessage({ type: 'command', id: outline[0].id, command: 'delete' });
    assert.ok(provider.getChildren().some(note => note.id === '音楽'));
    // Updating the document removes stale outline rows; tags have no outline.
    assert.ok(tagRows.every(row => row.noteId === undefined));
    await sidebarMessage({ type: 'open', id: '音楽' });
    assert.equal(shown.options.preserveFocus, true);
    inputs.push('音楽');
    await sidebarMessage({ type: 'command', id: '音楽', command: 'rename' });
    assert.equal(await fs.readFile(path.join(temp, '.fnote/音楽/index.md'), 'utf8'), outlineText);
    const dirty = { uri: uri(path.join(temp, '.fnote/音楽/index.md')), getText: () => '# 編集中のタイトル\n## 子の見出し' };
    documents.push(dirty);
    await run('refresh');
    assert.match(noteRows.find(row => row.id === '音楽').label, /編集中のタイトル$/);
    assert.equal(noteRows.find(row => row.noteId === '音楽').label, '子の見出し');
    documents.pop();
    await fs.writeFile(path.join(temp, '.fnote/音楽/index.md'), '# 変更後\r\n## 子はそのまま\r\n本文');
    await run('refresh');
    assert.match(noteRows.find(row => row.id === '音楽').label, /変更後$/);
    inputs.push('音楽');
    await sidebarMessage({ type: 'command', id: '音楽', command: 'rename' });
    assert.equal(await fs.readFile(path.join(temp, '.fnote/音楽/index.md'), 'utf8'), '# 音楽\r\n## 子はそのまま\r\n本文');
    settings.set('tagStyles', [{ tag: 'TODO', mark: '🔴' }, { tag: 'DONE', mark: '🟢' }]);
    await fs.writeFile(path.join(temp, '.fnote/音楽/index.md'), '# 音楽\n@DONE');
    await run('refresh');
    assert.ok(noteRows.every(row => !row.noteId));
    assert.equal(noteRows.find(row => row.id === '音楽').label, '🟢 音楽');
    assert.equal(noteRows.find(row => row.id === '音楽').collapsedLabel, '🔴 音楽');
    settings.set('tagStyles', [{ tag: 'DONE', mark: '🟢' }, { tag: 'TODO', mark: '🔴' }]);
    await run('refresh');
    assert.equal(noteRows.find(row => row.id === '音楽').collapsedLabel, '🟢 音楽');
    settings.set('tagStyles', [{ tag: 'TODO', mark: '$(check)', markColor: '#12AB34' }]);
    settings.delete('defaultTagMark');
    await run('refresh');
    assert.equal(tagRows.find(row => row.id === 'TODO').appearance.mark, '$(check)');
    assert.equal(tagRows.find(row => row.id === 'TODO').appearance.color, '#12AB34');
    assert.equal(noteRows.find(row => row.id === '音楽').collapsedAppearance.mark, '$(check)');
    assert.equal(noteRows.find(row => row.id === '音楽').collapsedAppearance.color, '#12AB34');
    assert.equal(noteRows.find(row => row.id === '音楽').appearance.mark, '$(circle-filled-compact)');
    assert.match(noteRows.find(row => row.id === '音楽').appearance.color, /^hsl\(/);
    await run('filter', 'TODO');
    assert.match(html, /class="codicon codicon-check note-icon-\d+"/);
    assert.match(html, /\.note-icon-\d+\{color:#12AB34\}/);
    assert.match(html, /font-src https:\/\/webview.test/);
    assert.match(html, /media\/codicons\/codicon.css/);
    settings.set('tagHierarchy', { 状態: ['TODO'] });
    settings.set('tagStyles', [{ tag: '状態', mark: '$(flag)', markColor: '#AB1234' }, { tag: 'TODO', color: '#FFFFFF' }]);
    await run('refresh');
    assert.equal(tagRows.find(row => row.id === 'TODO').label, '$(flag) TODO');
    assert.equal(tagRows.find(row => row.id === 'TODO').appearance.color, '#AB1234');
    assert.equal(noteRows.find(row => row.id === '音楽').collapsedAppearance.mark, '$(flag)');
    assert.match(html, /class="codicon codicon-flag note-icon-\d+"/);
    settings.delete('tagHierarchy');
    settings.set('defaultTagMark', '🏷️');

    settings.delete('tagStyles');
    await fs.writeFile(path.join(temp, '.fnote/音楽/index.md'), '# 音楽\n\n');
    inputs.push('A'); await run('add'); inputs.push('B'); await run('add');
    await sidebarMessage({ type: 'drop', id: 'B', target: 'A', position: 'before' });
    const rootIds = provider.getChildren().map(n => n.id);
    assert.ok(rootIds.indexOf('B') < rootIds.indexOf('A'));
    await sidebarMessage({ type: 'drop', id: 'A', target: '音楽', position: 'inside' });
    await sidebarMessage({ type: 'drop', id: 'B', target: '音楽/A', position: 'before' });
    const childIds = provider.getChildren(parent).map(n => n.id);
    assert.ok(childIds.indexOf('音楽/B') < childIds.indexOf('音楽/A'));
    assert.equal(await fs.readFile(path.join(temp, '.fnote/音楽/B/index.md'), 'utf8'), '# B\n\n');
    await sidebarMessage({ type: 'drop', id: '音楽', target: '音楽/B', position: 'before' });
    assert.match(errors.pop(), /子ノート/);
    await sidebarMessage({ type: 'drop', id: '音楽/B', position: 'inside' });
    assert.equal(provider.getChildren().at(-1).id, 'B');
    await run('delete', provider.getChildren().find(n => n.id === 'B'));
    await run('delete', provider.getChildren(parent).find(n => n.id === '音楽/A'));
    // The note name and its initial H1 share one title row (reported WAIT case).
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), '# 曲\n@WAIT 待つ\n## 内訳\n@WAIT 続き @2026/09/13 @10m');
    await run('refresh'); await run('filter', 'WAIT');
    assert.equal((html.match(/曲<\/button>/g) || []).length, 1);
    assert.match(html, /class="content"><span class="tag-color-\d+">@WAIT<\/span> 待つ/);
    assert.match(html, /内訳<\/button>/);
    await run('filter', '2026/09/13');
    assert.equal((html.match(/曲<\/button>/g) || []).length, 1);
    assert.match(html, /曲<\/button><span class="work-time">\(10m\)<\/span>/);
    assert.match(html, /内訳<\/button><span class="work-time">\(10m\)<\/span>/);

    // Reproduce headings within one Markdown file, not separate note folders.
    const body = '# タイトル1\n## タイトル1-1\n### タイトル1-1-1\n@TODO あれ\n## 対象外\n本文';
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), body);
    await run('refresh');
    await run('filter', 'TODO');
    assert.match(html, /タイトル1<\/button><ul><li><button[^>]*>タイトル1-1<\/button><ul><li><button[^>]*class="match">タイトル1-1-1<\/button>/);
    assert.doesNotMatch(html, /対象外/);
    assert.match(html, /class="content"><span class="tag-color-\d+">@TODO<\/span> あれ<\/button>/);
    await receiveMessage({ id: child.id, offset: body.indexOf('@TODO') });
    assert.equal(shown.options.selection.start.offset, body.indexOf('@TODO'));

    const offset = body.indexOf('###');
    await receiveMessage({ id: child.id, offset });
    assert.equal(shown.doc.uri.fsPath, path.join(temp, '.fnote/音楽/曲/index.md'));
    assert.equal(shown.options.selection.start.offset, offset);
    const lastShown = shown;
    await receiveMessage({ id: child.id, offset: -1 });
    assert.equal(shown, lastShown);
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), '@TODO <script>alert("x")</script>');
    await run('refresh');
    assert.match(html, /class="content"><span class="tag-color-\d+">@TODO<\/span> &lt;script&gt;alert/);
    assert.doesNotMatch(html, /<script>alert/);
    inputs.push('ALERT'); await run('search');
    assert.match(html, /検索: ALERT/);
    assert.match(html, /data-id="音楽" class="ancestor"/);
    assert.match(html, /class="content"><span class="tag-color-\d+">@TODO<\/span> &lt;script&gt;alert/);
    await receiveMessage({ id: child.id, offset: 0 });
    assert.equal(shown.options.selection.start.offset, 0);
    const beforeCancel = html;
    await run('search'); assert.equal(html, beforeCancel);
    inputs.push('   '); await run('search'); assert.equal(html, beforeCancel);
    inputs.push('一致しない単語'); await run('search');
    assert.match(html, /0 件のノート/);
    assert.match(html, /対象のノートはありません/);
    inputs.push('曲'); await run('search');
    assert.match(html, /1 件のノート/);
    await run('filter', 'TODO');
    assert.match(html, /<h1><span class="tag-color-\d+">@TODO<\/span><\/h1>/);

    // A tagged heading is shown once, while its time still contributes to ancestors.
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), '# 作業\n## 詳細 @2026/09/13 @10m\n本文 @2026/09/13 @20m');
    await run('refresh'); await run('filter', '2026/09/13');
    assert.equal((html.match(/詳細/g) || []).length, 1);
    assert.doesNotMatch(html, /class="content">##/);
    assert.match(html, /class="content">本文/);
    assert.match(html, /作業<\/button><span class="work-time">\(30m\)<\/span>/);
    assert.match(html, /@10m<\/span><\/button><span class="work-time">\(30m\)<\/span>/);
    await run('filter', 'TODO');

    settings.set('tagStyles', [{ tag: 'TODO', color: '#FF4444' }, { tag: '2026', color: '#80CBC4' }]);
    settings.set('tagColor', '#00BFFF');
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), '# @TODO 見出し\n- @TODO 本文 @2026/09/12 @OTHER\n```\n@TODO コード\n```');
    await run('refresh');
    assert.match(html, /\.tag-color-\d+\{color:#FF4444\}/);
    assert.match(html, /\.tag-color-\d+\{color:#80CBC4\}/);
    assert.match(html, /\.tag-color-\d+\{color:#00BFFF\}/);
    assert.match(html, /<span class="tag-color-\d+">@TODO<\/span> 見出し/);
    inputs.push('@TODO'); await run('search');
    assert.match(html, /class="content">@TODO コード<\/button>/);
    assert.match(html, /class="content">- <span class="tag-color-\d+">@TODO<\/span> 本文/);

    settings.set('tagStyles', [{ tag: 'TODO', color: '#FFFFFF', backgroundColor: '#402020' }, { tag: '2026', color: '#FFFFFF', backgroundColor: '' }]);
    settings.set('tagBackgroundColor', '#123456');
    const editorText = '@TODO @2026/09/12 @OTHER';
    api.window.visibleTextEditors = [{
      document: { uri: uri(path.join(temp, '.fnote/音楽/曲/index.md')), getText: () => editorText, positionAt: offset => ({ offset }) },
      setDecorations: (decoration, ranges) => editorStyles.push({ ...decoration.options, ranges })
    }];
    await run('refresh');
    assert.match(html, /color:#FFFFFF;background-color:#402020/);
    assert.match(html, /color:#FFFFFF\}/);
    assert.match(html, /background-color:#123456/);
    assert.ok(editorStyles.some(style => style.color === '#FFFFFF' && style.backgroundColor === '#402020'));
    assert.ok(editorStyles.some(style => style.color === '#FFFFFF' && style.backgroundColor === undefined));
    assert.ok(editorStyles.some(style => style.backgroundColor === '#123456'));
    api.window.visibleTextEditors = [];
    settings.delete('tagBackgroundColor');
    settings.delete('tagStyles'); settings.delete('tagColor');
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), '# 作業\n## 詳細\n@2026/09/13 @10:30-12:00 @10m\n@2026/09/13 @1h @TODO\n@2026/09/14 @8h');
    await run('refresh'); await run('filter', '2026/09/13');
    assert.match(html, /詳細<\/button><span class="work-time">\(2h40m\)<\/span>/);
    for (const title of ['作業', '音楽']) {
      assert.ok(html.includes(`${title}</button><span class="work-time">(2h40m)</span>`));
    }
    assert.equal((html.match(/class="work-time"/g) || []).length, 4);
    await fs.writeFile(path.join(temp, '.fnote/音楽/index.md'), '@2026/09/13 @20m');
    await fs.appendFile(path.join(temp, '.fnote/音楽/曲/index.md'), '\n## 別作業\n@2026/09/13 @20m');
    await run('refresh');
    assert.match(html, /作業<\/button><span class="work-time">\(3h\)<\/span>/);
    assert.match(html, /data-id="音楽\/曲" class="match">[^<]*作業<\/button>/);
    assert.match(html, /音楽<\/button><span class="work-time">\(3h20m\)<\/span>/);
    assert.match(html, /<h1>.*@2026\/09\/13<\/span><span class="work-time">\(3h20m\)<\/span><\/h1>/);
    inputs.push('別ノート'); await run('add');
    await fs.writeFile(path.join(temp, '.fnote/別ノート/index.md'), '@2026/09/13 @40m');
    await run('refresh');
    assert.match(html, /<h1>.*<span class="work-time">\(4h\)<\/span><\/h1>/);
    await run('filter', '2026/09/14');
    assert.match(html, /<h1>.*<span class="work-time">\(8h\)<\/span><\/h1>/);
    await run('filter', '2026/09/15');
    assert.doesNotMatch(html, /class="work-time"/);
    await run('delete', provider.getChildren().find(note => note.id === '別ノート'));

    await fs.writeFile(path.join(temp, '.fnote/音楽/index.md'), '');
    await run('filter', 'TODO'); assert.doesNotMatch(html, /class="work-time"/);
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), '@2026/09/13 @10m @TODO');
    await run('refresh'); await run('filter', '2026/09/13');
    assert.match(html, /曲<\/button><span class="work-time">\(10m\)<\/span>/);
    // A tag on a grandchild must keep every ancestor and the matching leaf.
    inputs.push('詳細'); await run('addChild', child);
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/詳細/index.md'), '@深いタグ');
    await run('refresh');
    await run('filter', '深いタグ');
    assert.match(html, /data-id="音楽" class="ancestor"/);
    assert.match(html, /data-id="音楽\/曲" class="ancestor"/);
    assert.match(html, /data-id="音楽\/曲\/詳細" class="match"/);
    assert.match(html, /1 件/);
    const grandchild = provider.getChildren(child)[0];
    await run('delete', grandchild);
    picks.push({ id: child.id }); await run('move', parent); assert.match(errors.pop(), /子ノート/);
    picks.push({ id: '' }); await run('move', child); assert.equal(provider.getChildren().length, 2);
    child = provider.getChildren().find(n => n.id === '曲');
    inputs.push('音楽'); await run('rename', child); assert.match(errors.pop(), /同名/);
    inputs.push('新しい曲'); await run('rename', child);
    const renamed = provider.getChildren().find(n => n.name === '新しい曲');
    assert.match(await fs.readFile(path.join(temp, '.fnote/新しい曲/index.md'), 'utf8'), /@TODO/);
    await run('delete', renamed); assert.equal(provider.getChildren().length, 1);
    assert.equal(errors.length, 0);
    // Closing all notes also disposes tag/search results and allows reopening them.
    const panelsBeforeClose = panelCount;
    api.window.tabGroups.all = [{ tabs: [noteTab, unrelatedTab, unrelatedWebviewTab] }];
    closeResult = false;
    await run('closeAllNotes');
    assert.equal(panelDisposeCount, 0, '本文を閉じる操作のキャンセル時は結果画面も維持する');
    closeResult = true;
    await run('closeAllNotes');
    assert.equal(panelDisposeCount, 1, 'タグ一覧から開いた画面も閉じる');
    await run('filter', 'TODO');
    assert.equal(panelCount, panelsBeforeClose + 1, '閉じた後は結果画面を作り直す');
    inputs.push('音楽'); await run('search');
    assert.match(html, /検索: 音楽/);
    api.window.tabGroups.all = [{ tabs: [unrelatedTab, unrelatedWebviewTab] }];
    const closesBeforeResultsOnly = closeCalls.length;
    await run('closeAllNotes');
    assert.equal(panelDisposeCount, 2, '本文タブがなくても検索結果画面を閉じる');
    assert.equal(closeCalls.length, closesBeforeResultsOnly, '無関係なタブは閉じない');
    await run('closeAllNotes');
    assert.equal(panelDisposeCount, 2, '繰り返しても破棄済みの画面には触れない');
    // Opening another workspace still reads the same global notes.
    for (const subscription of context.subscriptions) subscription.dispose();
    context.subscriptions.length = 0;
    api.workspace.workspaceFolders = [{ uri: uri(path.join(temp, 'another-workspace')) }];
    await activate(context);
    assert.deepEqual(views.get('fnote.notes').treeDataProvider.getChildren().map(n => n.name), ['音楽']);
    for (const subscription of context.subscriptions) subscription.dispose();
    context.subscriptions.length = 0;
    // A user-specified absolute directory is independent of the workspace, too.
    const custom = path.join(temp, 'custom-notes');
    settings.set('storagePath', custom);
    await activate(context);
    assert.equal(views.get('fnote.notes').treeDataProvider.getChildren().length, 0);
    inputs.push('共通ノート'); await run('add');
    assert.equal(await fs.readFile(path.join(custom, '共通ノート/index.md'), 'utf8'), '# 共通ノート\n\n');
    for (const subscription of context.subscriptions) subscription.dispose();
    context.subscriptions.length = 0;
    api.workspace.workspaceFolders = undefined;
    await activate(context);
    assert.deepEqual(views.get('fnote.notes').treeDataProvider.getChildren().map(n => n.name), ['共通ノート']);
    assert.equal(errors.length, 0);
  } finally {
    Module._load = original;
    for (const subscription of context.subscriptions) subscription.dispose();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
