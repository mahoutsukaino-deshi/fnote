'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('../test-support/resultsWebview');

const rows = e => [e('button', 'alpha alpha'), e('button', e('span', 'ALPHA'))];

test('画面内検索: Enterと下矢印は同じ一致順で移動し、末尾から先頭へ戻る', () => {
  const view = setup(rows);
  assert.equal(view.widget.hidden, true);
  const shortcut = view.key('f', { ctrlKey: true });
  assert.ok(shortcut.defaultPrevented && shortcut.stopped);
  assert.equal(view.document.activeElement, view.input);
  view.type('alpha');
  assert.equal(view.count.textContent, '1 / 3');
  assert.equal(view.current().startOffset, 0);
  const enter = view.key('Enter');
  assert.ok(enter.defaultPrevented && enter.stopped, 'Enterをホスト側の別の検索コマンドへ伝えない');
  assert.equal(view.count.textContent, '2 / 3');
  assert.equal(view.current().startOffset, 6);
  view.click(view.next);
  assert.equal(view.count.textContent, '3 / 3');
  assert.equal(view.document.activeElement, view.input, '矢印クリック後も入力欄からEnterで移動を続けられる');
  assert.equal(view.current().startContainer.data, 'ALPHA');
  view.key('Enter');
  assert.equal(view.count.textContent, '1 / 3');
  view.click(view.previous);
  assert.equal(view.count.textContent, '3 / 3');
  view.key('Enter', { shiftKey: true });
  assert.equal(view.count.textContent, '2 / 3');
  for (let i = 0; i < 20; i++) view.key('Enter');
  assert.equal(view.count.textContent, '1 / 3', '繰り返しEnterを押しても同じ移動処理を続ける');
});

test('画面内検索: タグ・リンクのspanをまたぎ、記号・絵文字・日本語を文字列として探す', () => {
  const view = setup(e => [e('button', '前 A+', e('span', 'B [x]'), ' 😀 テスト'), e('button', 'テスト')]);
  view.message({ type: 'showFind' });
  view.type('A+B [x]');
  assert.equal(view.count.textContent, '1 / 1');
  assert.equal(view.current().startContainer.data, '前 A+');
  assert.equal(view.current().startOffset, 2);
  assert.equal(view.current().endContainer.data, 'B [x]');
  assert.equal(view.current().endOffset, 5);
  view.type('😀');
  assert.equal(view.current().endOffset - view.current().startOffset, 2);
  view.type('テスト');
  assert.equal(view.count.textContent, '1 / 2');
  view.key('Enter');
  assert.equal(view.current().startContainer.data, 'テスト');
});

test('画面内検索: 別の行や非表示のアイコンは一致に含めない', () => {
  const view = setup(e => {
    const icon = e('span', 'hidden');
    icon.setAttribute('aria-hidden', 'true');
    return [e('li', e('button', 'left'), e('ul', e('li', e('button', 'right')))), e('p', icon, 'visible')];
  });
  view.key('f', { metaKey: true });
  for (const word of ['leftright', 'left right', 'hidden']) {
    view.type(word);
    assert.equal(view.count.textContent, 'No results');
    assert.equal(view.next.disabled, true);
    assert.equal(view.previous.disabled, true);
    view.key('Enter');
    assert.equal(view.highlights.size, 0);
  }
  view.type('');
  assert.equal(view.count.textContent, '0 / 0');
  assert.equal(view.input.getAttribute('aria-invalid'), 'false');
});

test('画面内検索: IMEの確定Enterでは移動せず、確定後のEnterで移動する', () => {
  const view = setup(e => [e('p', 'test test テスト テスト')]);
  view.key('f', { ctrlKey: true });
  view.type('test');
  view.compose('compositionstart');
  view.type('テスト');
  const confirmation = view.key('Enter', { isComposing: true });
  assert.equal(confirmation.defaultPrevented, false);
  assert.equal(confirmation.stopped, true);
  assert.equal(view.count.textContent, '1 / 2');
  view.compose('compositionend');
  assert.equal(view.count.textContent, '1 / 2');
  assert.equal(view.key('Enter', { keyCode: 229 }).defaultPrevented, false);
  assert.equal(view.count.textContent, '1 / 2');
  view.key('Enter');
  assert.equal(view.count.textContent, '2 / 2');
  view.key('Enter', { shiftKey: true });
  assert.equal(view.count.textContent, '1 / 2');
});

test('画面内検索: 再読込で検索語と位置を復元し、閉じるとハイライトを消す', () => {
  const view = setup(rows, { find: { query: 'alpha', open: true, index: 2 } });
  assert.equal(view.count.textContent, '3 / 3');
  assert.equal(view.document.activeElement, view.input);
  view.key('Enter');
  assert.equal(view.count.textContent, '1 / 3');
  view.key('Escape');
  assert.equal(view.widget.hidden, true);
  assert.equal(view.highlights.size, 0);
  assert.equal(view.document.activeElement, view.content);
  assert.equal(view.states.at(-1).find.open, false);
  view.message({ type: 'showFind' });
  assert.equal(view.input.value, 'alpha');
  assert.equal(view.count.textContent, '1 / 3');
  view.click(view.close);
  assert.equal(view.widget.hidden, true);
  const fewer = setup(e => [e('p', 'alpha')], { find: { query: 'alpha', open: true, index: 20 } });
  assert.equal(fewer.count.textContent, '1 / 1', '本文更新で一致数が減っても位置を有効範囲に収める');
});

test('結果画面: 検索欄の追加後も並べ替えと本文への移動を維持する', () => {
  const view = setup(e => {
    const sort = e('button', 'Sort'); sort.dataset.action = 'toggle-date-sort';
    const note = e('button', 'note'); note.dataset = { id: 'note', offset: '12' };
    return [sort, note];
  });
  view.click(view.content.childNodes[0]);
  assert.equal(view.sent.at(-1).type, 'toggleDateTagSort');
  view.click(view.content.childNodes[1]);
  assert.equal(view.sent.at(-1).id, 'note');
  assert.equal(view.sent.at(-1).offset, 12);
});
