'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(tagMode = false, platform = '') {
  const sent = [], states = [], listeners = new Map(), documentListeners = new Map();
  let document;
  class Element {
    children = []; dataset = {}; style = {}; handlers = {}; classes = new Set();
    classList = { toggle: (key, active) => active ? this.classes.add(key) : this.classes.delete(key),
      add: (...keys) => keys.forEach(key => this.classes.add(key)), remove: (...keys) => keys.forEach(key => this.classes.delete(key)) };
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    replaceChildren() {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      this.children = [];
    }
    setAttribute() {}
    focus() { document.activeElement = this; }
    select() {}
    scrollIntoView() {}
    closest(selector) { return selector === '.row' && this.className === 'row' ? this : this.parent?.closest(selector); }
    querySelectorAll() { return this.children.filter(child => child.className === 'row'); }
    querySelector() { return this.children.find(child => child.classes.has('selected')); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
  }
  const tree = new Element(), menu = new Element(), body = new Element();
  body.dataset.tags = String(tagMode);
  document = { body, activeElement: body, getElementById: id => id === 'tree' ? tree : menu,
    createElement: () => new Element(), addEventListener: (type, fn) => documentListeners.set(type, fn) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/notes.js'), 'utf8'), {
    document, window: { scrollY: 0, scrollTo() {}, addEventListener: (type, fn) => listeners.set(type, fn) },
    navigator: { platform },
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: state => states.push(state), postMessage: msg => sent.push(msg) })
  });
  return { document, body, tree, sent, states, documentListeners, message: data => listeners.get('message')({ data }) };
}

test('after the host delivers a Shift-drag, webview events do not reactivate its drop overlay', async () => {
  const { tree, body, sent, message, documentListeners } = setup();
  message({ type: 'notes', rows: [{ id: 'note', parent: '', label: 'Note' }] });
  let hostDragMessages = 0;
  async function dispatch(type, target) {
    // This models events inside the iframe, not the host's Shift gate.
    const event = { target, shiftKey: true, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      dataTransfer: { types: ['Files'], items: [{ kind: 'file' }], getData: () => '',
        files: [{ name: 'test.txt', arrayBuffer: async () => new ArrayBuffer(0) }] } };
    if (tree.contains(target)) await tree.handlers[type]?.(event);
    if (!event.stopped) await documentListeners.get(type)?.(event);
    // Model VS Code's bubbling window listeners: dragover forwards even when
    // defaultPrevented, whereas dragenter checks it before enabling the overlay.
    if (!event.stopped && (type === 'dragover' || (type === 'dragenter' && !event.defaultPrevented))) hostDragMessages++;
    assert.ok(event.defaultPrevented && event.stopped, type);
    return event;
  }
  for (const target of [body, tree, tree.children[0], tree.children[0].children[1]]) {
    await dispatch('dragenter', target);
    const event = await dispatch('dragover', target);
    assert.equal(event.dataTransfer.dropEffect, target.closest('.row') ? 'copy' : 'none');
  }
  await dispatch('drop', body);
  assert.ok(!sent.some(item => item.type === 'attachmentDrop'), 'empty space has no implicit destination');
  await dispatch('drop', tree.children[0]);
  assert.equal(sent.find(item => item.type === 'attachmentDrop').id, 'note');
  assert.equal(hostDragMessages, 0);
});

test('external drop guards leave tag views and internal note drags unchanged', () => {
  for (const tagMode of [false, true]) {
    const { tree, message, documentListeners } = setup(tagMode);
    message({ type: 'notes', rows: [{ id: 'note', parent: '', label: 'Note' }] });
    if (!tagMode) tree.children[0].ondragstart({ dataTransfer: { setData() {} } });
    for (const type of ['dragenter', 'dragover', 'drop']) {
      documentListeners.get(type)({ target: tree.children[0], dataTransfer: { types: ['Files'] },
        preventDefault() { assert.fail('must not intercept'); }, stopPropagation() { assert.fail('must not intercept'); } });
    }
  }
});

test('添付ファイルもノート一覧からドラッグできる', () => {
  const { tree, message } = setup();
  message({ type: 'notes', rows: [
    { id: 'note', parent: '', label: 'Note' },
    { id: 'note/file.txt', parent: 'note', label: 'file.txt', attachment: true, directory: false },
  ] });
  const row = tree.children.find(item => item.dataset.id === 'note/file.txt');
  assert.equal(row.draggable, true);
  let dragged;
  row.ondragstart({ dataTransfer: { effectAllowed: '', setData(type, value) { dragged = { type, value }; } } });
  assert.deepEqual(dragged, { type: 'text/plain', value: 'note/file.txt' });
});

test('ノート名の入力中はIME確定キーと矢印キーで編集を確定しない', () => {
  const { tree, sent, message } = setup();
  message({ type: 'notes', rows: [{ id: 'note', parent: '', label: 'Note' }] });
  message({ type: 'edit', mode: 'create', parent: '' });
  const input = tree.children.find(row => row.dataset.id === '\0editing').children[1];
  input.value = '新しいノート';
  let stopped = 0;
  input.onkeydown({ key: 'ArrowDown', stopPropagation() { stopped++; } });
  input.onkeydown({ key: 'Enter', isComposing: true, keyCode: 229, preventDefault() {}, stopPropagation() { stopped++; } });
  assert.equal(stopped, 2);
  assert.equal(sent.some(item => item.type === 'edit'), false);
  input.onkeydown({ key: 'Enter', isComposing: false, keyCode: 13, preventDefault() {}, stopPropagation() { stopped++; } });
  assert.equal(sent.at(-1).type, 'edit');
  assert.equal(sent.at(-1).name, '新しいノート');
});

test('リネーム入力では標準のコピー操作を有効にする', () => {
  const { tree, message } = setup();
  message({ type: 'notes', rows: [{ id: 'note', parent: '', label: 'Note' }] });
  message({ type: 'edit', mode: 'rename', id: 'note' });
  const input = tree.children.find(row => row.dataset.id === 'note').children[1];
  assert.deepEqual(JSON.parse(input.dataset.vscodeContext), { preventDefaultContextMenuItems: false });
});

test('開いている項目はWebviewの永続状態に保存しない', () => {
  const { tree, states, message } = setup();
  message({ type: 'notes', rows: [{ id: 'note', parent: '', label: 'Note' }] });
  tree.children[0].onclick();
  assert.ok(states.length > 0);
  assert.ok(states.every(state => !Object.hasOwn(state, 'active')));
});

test('ノート一覧のショートカットを選択対象に応じて送信する', () => {
  const { tree, sent, message } = setup();
  message({ type: 'notes', rows: [
    { id: 'note', parent: '', label: 'Note' },
    { id: 'note/file.txt', parent: 'note', label: 'file.txt', attachment: true, directory: false },
  ] });
  const event = (key, modifiers = {}) => tree.handlers.keydown({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers, preventDefault() {}, stopPropagation() {} });
  tree.children.find(row => row.dataset.id === 'note').onclick();
  event('n', { ctrlKey: true });
  assert.equal(sent.at(-1).command, 'addChild');
  tree.children.find(row => row.dataset.id === 'note/file.txt').onclick();
  event('F2');
  assert.equal(sent.at(-1).command, 'rename');
  event('Delete');
  assert.equal(sent.at(-1).command, 'deleteAttachment');
  event('Backspace', { metaKey: true });
  assert.equal(sent.at(-1).command, 'deleteAttachment');
  const root = setup(false, 'MacIntel');
  root.message({ type: 'notes', rows: [{ id: 'note', parent: '', label: 'Note' }] });
  root.tree.handlers.keydown({ key: 'n', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
  assert.equal(root.sent.some(item => item.command === 'add'), false);
  root.tree.handlers.keydown({ key: 'n', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} });
  assert.equal(root.sent.at(-1).command, 'add');
});

test('表示中のノートと上下キーの選択を別々に保持する', () => {
  const { tree, message } = setup();
  message({ type: 'notes', rows: [
    { id: 'open', parent: '', label: 'Open' },
    { id: 'next', parent: '', label: 'Next' },
  ], selected: 'open', active: 'open' });
  const open = tree.children.find(row => row.dataset.id === 'open');
  const next = tree.children.find(row => row.dataset.id === 'next');
  assert.ok(open.classes.has('active'));
  assert.ok(open.classes.has('selected'));
  tree.handlers.keydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  assert.ok(open.classes.has('active'));
  assert.ok(!open.classes.has('selected'));
  assert.ok(!next.classes.has('active'));
  assert.ok(next.classes.has('selected'));
});

test('添付ファイルを開いた後も一覧にフォーカスを戻せる', () => {
  const { document, tree, message } = setup();
  message({ type: 'notes', rows: [
    { id: 'note', parent: '', label: 'Note' },
    { id: 'note/file.txt', parent: 'note', label: 'file.txt', attachment: true, directory: false },
  ], selected: 'note/file.txt', active: 'note/file.txt' });
  message({ type: 'select', id: 'note/file.txt', active: true, focus: true });
  assert.equal(document.activeElement.dataset.id, 'note/file.txt');
  assert.ok(tree.children.some(row => row.dataset.id === 'note/file.txt'));
});

test('一覧の再描画後もフォーカスを維持し、F2は選択中の親ノートだけを対象にする', () => {
  const { document, body, tree, sent, message } = setup();
  const rows = [{ id: 'parent', parent: '', label: '親' }, { id: 'child', parent: 'parent', label: '子' }];
  message({ type: 'notes', rows });
  tree.children.find(row => row.dataset.id === 'child').onclick();
  tree.children.find(row => row.dataset.id === 'parent').onclick();
  message({ type: 'select', id: 'parent' });
  message({ type: 'notes', rows, selected: 'parent' });
  assert.equal(document.activeElement.dataset.id, 'parent');
  let prevented = false, stopped = false;
  tree.handlers.keydown({ key: 'F2', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(sent.at(-1).type, 'command');
  assert.equal(sent.at(-1).command, 'rename');
  assert.equal(sent.at(-1).id, 'parent');
  assert.ok(prevented && stopped);
  document.activeElement = body;
  message({ type: 'notes', rows, selected: 'parent' });
  assert.equal(document.activeElement, body, '本文での編集中に一覧へフォーカスを奪わない');
});

test('OS files without a path or URI are sent as bytes, including empty files', async () => {
  const { tree, sent, message } = setup();
  message({ type: 'notes', rows: [{ id: 'note', parent: '', label: 'Note' }] });
  let prevented = false;
  const event = { target: tree.children[0], preventDefault() { prevented = true; }, stopPropagation() {},
    dataTransfer: { types: ['Files'], getData: () => '', files: [
      { name: '旅行(3.png', arrayBuffer: async () => Uint8Array.from([0, 255, 128, 1]).buffer },
      { name: 'empty.txt', arrayBuffer: async () => new ArrayBuffer(0) },
    ] } };
  tree.handlers.dragover(event);
  assert.ok(prevented);
  assert.equal(event.dataTransfer.dropEffect, 'copy');
  await tree.handlers.drop(event);
  const drop = sent.find(item => item.type === 'attachmentDrop');
  assert.equal(drop.id, 'note');
  assert.equal(JSON.stringify(drop.files), JSON.stringify([
    { name: '旅行(3.png', data: [0, 255, 128, 1] }, { name: 'empty.txt', data: [] },
  ]));
});

test('folder drops read all directory batches and retain relative paths', async () => {
  const { tree, sent, message } = setup();
  message({ type: 'notes', rows: [{ id: 'note', parent: '', label: 'Note' }] });
  const file = name => ({ name, isFile: true, file: resolve => resolve({ arrayBuffer: async () => new ArrayBuffer(0) }) });
  const batches = [[file('one.txt')], [file('two.txt')], []];
  await tree.handlers.drop({ target: tree.children[0], preventDefault() {}, stopPropagation() {},
    dataTransfer: { types: ['Files'], getData: () => '', files: [], items: [{ webkitGetAsEntry: () => ({
      name: 'assets', isDirectory: true, createReader: () => ({ readEntries: resolve => resolve(batches.shift()) }),
    }) }] } });
  assert.equal(JSON.stringify(sent.find(item => item.type === 'attachmentDrop').files.map(file => file.name)),
    JSON.stringify(['assets', 'assets/one.txt', 'assets/two.txt']));
});

test('tag view never accepts attachment drops', async () => {
  const { tree, sent, message } = setup(true);
  message({ type: 'notes', rows: [{ id: 'tag', parent: '', label: 'Tag' }] });
  await tree.handlers.drop({ target: tree.children[0], dataTransfer: { types: ['Files'] } });
  assert.ok(!sent.some(item => item.type === 'attachmentDrop'));
});

for (const tagMode of [false, true]) test(`${tagMode ? 'タグ' : 'ノート'}一覧: 全閉時のみ展開ボタンへ切り替える`, () => {
  const { tree, sent, message } = setup(tagMode);
  const state = () => sent.filter(item => item.type === 'expansionState').at(-1);
  const rows = [
    { id: 'parent', parent: '', label: '親' },
    { id: 'child', parent: 'parent', label: '子' },
    { id: 'leaf', parent: 'child', label: '末端' },
    { id: 'other', parent: '', label: '別' },
    { id: 'otherChild', parent: 'other', label: '別の子' }
  ];
  const toggle = id => tree.children.find(row => row.dataset.id === id).children[0].onclick({ stopPropagation() {} });
  message({ type: 'notes', rows });
  assert.equal(state().allCollapsed, false);
  assert.equal(state().hasBranches, true);
  toggle('parent');
  assert.equal(state().allCollapsed, false, '一部が開いていれば折りたたむボタン');
  toggle('other');
  assert.equal(state().allCollapsed, true, '非表示の子の状態にかかわらず、全ルートが閉じれば展開ボタン');
  message({ type: 'expandAll' });
  assert.equal(state().allCollapsed, false);
  assert.equal(tree.querySelectorAll('.row').length, 5);
  message({ type: 'collapseAll' });
  assert.equal(state().allCollapsed, true);
  assert.equal(tree.querySelectorAll('.row').length, 2);
  message({ type: 'select', id: 'leaf' });
  assert.equal(state().allCollapsed, false, '選択位置の自動展開にも追従');
  message({ type: 'notes', rows: [] });
  assert.equal(state().hasBranches, false);
  message({ type: 'notes', rows: [{ id: 'single', parent: '', label: '末端のみ' }] });
  assert.equal(state().hasBranches, false);
});


test('Codiconを文字列として表示せず色付きのアイコン要素にし、絵文字は保持する', () => {
  const { tree, message } = setup();
  message({ type: 'notes', rows: [
    { id: 'icon', parent: '', label: '$(book) 資料', appearance: { mark: '$(book)', color: '#123456' } },
    { id: 'emoji', parent: '', label: '✅ 完了', appearance: { mark: '✅' } }
  ] });
  const icon = tree.children[0];
  assert.equal(icon.children[1].className, 'note-icon codicon codicon-book');
  assert.equal(icon.children[1].style.color, '#123456');
  assert.equal(icon.children[2].textContent, '資料');
  assert.equal(tree.children[1].children[1].textContent, '✅ 完了');
});

test('Markdown見出しにノートのタグアイコンと設定した見出しマークを表示する', () => {
  const { tree, message } = setup();
  message({ type: 'notes', rows: [
    { id: 'note', parent: '', label: 'ノート' },
    {
      id: 'heading', parent: 'note', label: '見出し', noteId: 'note',
      appearance: { mark: '$(book)', color: '#123456' },
      outlineMark: { mark: '#', color: '#654321' },
    },
  ] });
  const row = tree.children.find(item => item.dataset.id === 'heading');
  assert.equal(row.children[1].className, 'note-icon codicon codicon-book');
  assert.equal(row.children[1].style.color, '#123456');
  assert.equal(row.children[2].className, 'note-icon heading-mark');
  assert.equal(row.children[2].textContent, '#');
  assert.equal(row.children[2].style.color, '#654321');
  assert.equal(row.children[3].textContent, '見出し');
});
