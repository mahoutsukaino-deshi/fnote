'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { favoriteHeadings, headingFavoriteUpdates } = require('../dist/favorites');

const note = text => ({ id: 'note', parent: '', name: 'Note', text, tags: [] });

test('同名見出しの改名と既存名への改名でも登録先を取り違えない', () => {
  for (const [oldTitles, newTitles] of [
    [['同名', '同名'], ['変更後', '同名']],
    [['同名', '同名'], ['同名', '変更後']],
    [['A', 'B'], ['B', 'B']],
    [['A', 'B'], ['A', 'A']],
  ]) {
    const before = note('# Note\r\n' + oldTitles.map(title => `## ${title}\r\n本文\r\n`).join(''));
    const after = note('# Note\r\n' + newTitles.map(title => `## ${title}\r\n本文\r\n`).join(''));
    const updates = headingFavoriteUpdates(before, after);
    const original = favoriteHeadings(before), renamed = favoriteHeadings(after);
    assert.equal(updates.get(original[1].favoriteId), renamed[1].favoriteId);
    assert.equal(updates.get(original[2].favoriteId), renamed[2].favoriteId);
  }
});

test('見出しの挿入や削除で別の見出しへ登録を付け替えない', () => {
  const before = note('# Note\n## 対象\n本文\n## 後続\n');
  const inserted = note('# Note\n## 新規\n## 対象\n本文\n## 後続\n');
  const removed = note('# Note\n本文\n## 後続\n');
  const original = favoriteHeadings(before);
  assert.equal(headingFavoriteUpdates(before, inserted).get(original[1].favoriteId), original[1].favoriteId);
  const deleted = headingFavoriteUpdates(before, removed);
  assert.equal(deleted.get(original[1].favoriteId), undefined);
  assert.equal(deleted.get(original[2].favoriteId), original[2].favoriteId);
});

test('本文編集や見出し追加と同時の改名は変更のない見出しを基準に追従する', () => {
  const before = note('# Note\n## A\n本文\n## 基準\n### 続き\n末尾\n');
  const after = note('# Note\n追記\n## 新しいA 🎵\n本文\n## 基準\n## 追加\n### 続き\n末尾\n');
  const updates = headingFavoriteUpdates(before, after);
  const original = favoriteHeadings(before), current = favoriteHeadings(after);
  assert.equal(updates.get(original[1].favoriteId), current[1].favoriteId);
  assert.equal(updates.get(original[2].favoriteId), current[2].favoriteId);
  assert.equal(updates.get(original[3].favoriteId), current[4].favoriteId);
});

test('見出しのレベルとタイトルを同時に変更しても登録を維持する', () => {
  const before = note('# Note\n## 旧タイトル\n本文\n');
  const after = note('# Note\n###### 新タイトル\n本文\n');
  const id = favoriteHeadings(before)[1].favoriteId;
  assert.equal(headingFavoriteUpdates(before, after).get(id), favoriteHeadings(after)[1].favoriteId);
});
