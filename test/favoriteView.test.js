'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('../test-support/notesWebview');

const rows = [
  { id: 'parent', parent: '', label: '親', shortcut: true },
  { id: 'heading', parent: 'parent', label: '見出し', noteId: 'note',
    appearance: { mark: '$(book)', color: '#123456' },
    collapsedAppearance: { mark: '$(bug)', color: '#abcdef' },
    outlineMark: { mark: '$(symbol-number)', color: '#654321' } },
  { id: 'subheading', parent: 'heading', label: '小見出し', noteId: 'note' },
  { id: 'child', parent: 'parent', label: '子', shortcut: false },
  { id: 'other', parent: '', label: '別のお気に入り', shortcut: true },
];

test('お気に入りの見出しは同じアイコンと色を使い、折りたたむと配下のタグを反映する', () => {
  const view = setup(false, '', true);
  view.message({ type: 'notes', rows });
  const heading = () => view.tree.children.find(row => row.dataset.id === 'heading');
  assert.equal(heading().children[1].className, 'note-icon codicon codicon-book');
  assert.equal(heading().children[1].style.color, '#123456');
  assert.equal(heading().children[2].className, 'note-icon codicon codicon-symbol-number heading-mark');
  assert.equal(heading().children[2].style.color, '#654321');
  heading().children[0].onclick({ stopPropagation() {} });
  assert.equal(heading().children[1].className, 'note-icon codicon codicon-bug');
  assert.equal(heading().children[1].style.color, '#abcdef');
  assert.ok(!view.tree.children.some(row => row.dataset.id === 'subheading'));
  assert.ok(view.states.at(-1).collapsed.includes('heading'));
  heading().children[0].onclick({ stopPropagation() {} });
  assert.ok(view.tree.children.some(row => row.dataset.id === 'subheading'));
  heading().onclick();
  assert.equal(view.sent.at(-1).type, 'open');
  assert.equal(view.sent.at(-1).id, 'heading');
});

test('お気に入りの並べ替えは登録したルートだけを対象とし、再描画でもドラッグを維持する', () => {
  const view = setup(false, '', true);
  view.message({ type: 'notes', rows });
  const [parent, heading, , child, other] = view.tree.querySelectorAll('.row');
  assert.equal(parent.draggable, true);
  assert.equal(heading.draggable, false);
  assert.equal(child.draggable, false);
  assert.equal(JSON.parse(parent.dataset.vscodeContext).webviewSection, 'favorite');
  assert.equal(JSON.parse(child.dataset.vscodeContext).webviewSection, 'favoriteChild');
  const data = new Map();
  const dataTransfer = { setData: (type, value) => data.set(type, value), types: ['application/vnd.fnote.favorite'] };
  parent.onmousedown({ button: 0 });
  parent.ondragstart({ dataTransfer });
  assert.equal(JSON.parse(data.get('application/vnd.fnote.favorite')).id, 'parent');
  assert.equal(data.has('application/vnd.fnote.note'), false);
  assert.equal(data.has('text/plain'), false);
  view.message({ type: 'notes', rows });
  assert.ok(view.tree.contains(parent));
  const event = target => ({ target, dataTransfer, preventDefault() {}, stopPropagation() {} });
  view.tree.handlers.drop(event(child));
  assert.ok(!view.sent.some(message => message.type === 'drop'));
  // Begin another drag after dropping on an ineligible child.
  const source = view.tree.querySelectorAll('.row')[0];
  source.onmousedown({ button: 0 });
  source.ondragstart({ dataTransfer });
  const target = view.tree.querySelectorAll('.row').find(row => row.dataset.id === other.dataset.id);
  view.tree.handlers.drop(event(target));
  assert.deepEqual(JSON.parse(JSON.stringify(view.sent.find(message => message.type === 'drop'))),
    { type: 'drop', id: 'parent', target: 'other', position: 'before' });
  const last = view.tree.querySelectorAll('.row').find(row => row.dataset.id === 'other');
  last.onmousedown({ button: 0 });
  last.ondragstart({ dataTransfer });
  view.tree.handlers.drop(event(view.tree));
  assert.equal(view.sent.at(-1).type, 'drop');
  assert.equal(view.sent.at(-1).id, 'other');
  assert.equal(view.sent.at(-1).target, undefined);
});

test('お気に入りの削除キーはルートの登録のみ解除し、ノート編集キーや外部ドロップを受け付けない', async () => {
  for (const platform of ['', 'MacIntel']) {
    const view = setup(false, platform, true);
    const key = (key, extra = {}) => view.tree.handlers.keydown({ key, preventDefault() {}, stopPropagation() {}, ...extra });
    const deleting = () => platform ? key('Backspace', { metaKey: true }) : key('Delete');
    view.message({ type: 'notes', rows, selected: 'parent' });
    deleting();
    assert.equal(view.sent.at(-1).command, 'removeFavorite');
    const count = view.sent.length;
    key('F2');
    key('n', platform ? { metaKey: true } : { ctrlKey: true });
    assert.equal(view.sent.length, count);
    view.message({ type: 'notes', rows, selected: 'child' });
    deleting();
    assert.ok(!view.sent.some(message => message.command === 'delete'));
    assert.equal(view.sent.filter(message => message.command === 'removeFavorite').length, 1);
    for (const types of [['Files'], ['application/vnd.fnote.note'], ['application/vnd.fnote.favorite']]) {
      await view.tree.handlers.drop({ target: view.tree.children[0], dataTransfer: { types }, preventDefault() {}, stopPropagation() {} });
    }
    assert.ok(!view.sent.some(message => ['drop', 'attachmentDrop', 'attachmentDropError'].includes(message.type)));
  }
});

test('直接登録した見出しは右クリック・ドラッグ・削除キーで操作できる', () => {
  const view = setup(false, '', true);
  const headingRows = [{ ...rows[1], parent: '', shortcut: true }, rows[2], rows[4]];
  view.message({ type: 'notes', rows: headingRows });
  const [heading, child, other] = view.tree.querySelectorAll('.row');
  assert.equal(heading.draggable, true);
  assert.equal(child.draggable, false);
  assert.equal(JSON.parse(heading.dataset.vscodeContext).webviewSection, 'favorite');
  heading.oncontextmenu();
  assert.equal(view.sent.at(-1).type, 'select');
  assert.equal(view.sent.at(-1).id, 'heading');
  const data = new Map();
  const dataTransfer = { types: ['application/vnd.fnote.favorite'], setData: (type, value) => data.set(type, value) };
  heading.onmousedown({ button: 0 });
  heading.ondragstart({ dataTransfer });
  assert.equal(JSON.parse(data.get('application/vnd.fnote.favorite')).id, 'heading');
  view.message({ type: 'notes', rows: headingRows });
  assert.ok(view.tree.contains(heading), '見出しのドラッグ中はDOMを維持する');
  view.tree.handlers.drop({ target: other, dataTransfer, preventDefault() {}, stopPropagation() {} });
  assert.equal(view.sent.find(message => message.type === 'drop').id, 'heading');
  view.tree.handlers.keydown({ key: 'Delete', preventDefault() {}, stopPropagation() {} });
  assert.equal(view.sent.at(-1).command, 'removeFavorite');
  assert.equal(view.sent.at(-1).id, 'heading');
});

test('ノート一覧の見出しを右クリックすると登録対象の見出しを選択する', () => {
  const view = setup();
  view.message({ type: 'notes', rows: [
    { id: 'note', parent: '', label: 'ノート' }, { ...rows[1], parent: 'note' },
  ] });
  const heading = view.tree.querySelectorAll('.row')[1];
  assert.equal(JSON.parse(heading.dataset.vscodeContext).webviewSection, 'outline');
  heading.oncontextmenu();
  assert.equal(view.sent.at(-1).type, 'select');
  assert.equal(view.sent.at(-1).id, 'heading');
});
