'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(tagMode = false) {
  const sent = [], listeners = new Map();
  let document;
  class Element {
    children = []; dataset = {}; style = {}; handlers = {}; classes = new Set();
    classList = { toggle: (key, active) => active ? this.classes.add(key) : this.classes.delete(key) };
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    replaceChildren() {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      this.children = [];
    }
    setAttribute() {}
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    querySelectorAll() { return this.children.filter(child => child.className === 'row'); }
    querySelector() { return this.children.find(child => child.classes.has('selected')); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
  }
  const tree = new Element(), menu = new Element(), body = new Element();
  body.dataset.tags = String(tagMode);
  document = { body, activeElement: body, getElementById: id => id === 'tree' ? tree : menu,
    createElement: () => new Element(), addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/notes.js'), 'utf8'), {
    document, window: { scrollY: 0, scrollTo() {}, addEventListener: (type, fn) => listeners.set(type, fn) },
    acquireVsCodeApi: () => ({ getState: () => ({}), setState() {}, postMessage: msg => sent.push(msg) })
  });
  return { document, body, tree, sent, message: data => listeners.get('message')({ data }) };
}

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
