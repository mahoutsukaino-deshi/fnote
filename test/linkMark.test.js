const test = require('node:test');
const assert = require('node:assert/strict');
const { linkMark, linkIconUri } = require('../dist/linkMark');

test('link marks support bundled Codicons, text, emoji, empty values and unknown icons', () => {
  assert.equal(linkMark('$(globe)').icon, 'globe');
  assert.equal(linkMark('$(unknown-fnote-icon)').icon, 'link-external');
  for (const text of ['🔗', '🌍', '', '<script>']) assert.deepEqual(linkMark(text), { text });
  const svg = Buffer.from(linkIconUri('globe').split(',')[1], 'base64').toString();
  assert.match(svg, /fill="black"/);
  assert.doesNotMatch(svg, /undefined/);
  assert.notEqual(linkIconUri('globe'), linkIconUri('link-external'));
});
