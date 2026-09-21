"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatWorkMinutes,
  timeTagMinutes,
  minutesForDate,
  isTimeTag,
  planNoteDrop,
  searchNotes,
  parseTags,
  noteMark,
  matchingLines,
  matchingHeadings,
  tagTree,
  filterTree,
  styleFor,
  within,
  validateName,
  escapeHtml,
} = require("../dist/core");
const tags = (text) => parseTags(text).map((t) => t.tag);
test("日本語・日付・TODO・句読点・メール・エスケープ", () => {
  assert.deepEqual(
    tags("🔴 @TODO @バラード。 @2026/09/01\na@b.com \\@hidden @@no @a-b_c"),
    ["TODO", "バラード", "2026/09/01", "a-b_c"],
  );
  const text = "🎵 @音楽";
  const match = parseTags(text)[0];
  assert.equal(text.slice(match.start, match.end), "@音楽");
});
test("Markdownと仕様の引用符コードを除外する", () => {
  assert.deepEqual(
    tags(
      "@yes `@no` ``@no ` @no`` '@no'\n```js\n@no\n```\n~~~\n@no\n~~~\n'''\n@no\n'''\n    @no\n\t@no\n@last",
    ),
    ["yes", "last"],
  );
  assert.deepEqual(tags("`code\n@hidden` @shown"), ["shown"]);
  assert.deepEqual(tags("``@hidden ` @hidden`` @shown"), ["shown"]);
  assert.deepEqual(tags("```\n@hidden"), []);
});
test("タグ階層の重複排除と親タグ検索で祖先ノートを維持", () => {
  const notes = [
    { id: "音楽", tags: [] },
    { id: "音楽/曲", tags: parseTags("@2026/09/01 @2026/09/01") },
    { id: "別", tags: parseTags("@20260") },
  ];
  const tree = tagTree(notes);
  assert.equal(tree.get("2026").children.get("09").children.size, 1);
  assert.deepEqual(
    filterTree(notes, "2026").map((n) => n.id),
    ["音楽", "音楽/曲"],
  );
});
test("タグ設定の継承と完全一致優先", () => {
  const styles = {
    2026: { mark: "$(calendar)" },
    "2026/09": { color: "#fff" },
  };
  assert.deepEqual(styleFor("2026/09/01", styles), { color: "#fff" });
  assert.deepEqual(styleFor("2026/10", styles), { mark: "$(calendar)" });
  assert.deepEqual(styleFor("toString", styles), {});
});
test("安全な名前・移動境界・HTMLエスケープ", () => {
  for (const name of ["", "..", "../a", "a/b", "a\\b", "CON", "a.", " a"])
    assert.ok(validateName(name), name);
  assert.equal(validateName("安静"), undefined);
  assert.equal(within("a/b", "a"), true);
  assert.equal(within("ab", "a"), false);
  assert.equal(escapeHtml('<script>"&'), "&lt;script&gt;&quot;&amp;");
});

test("タグ検索で本文の見出しを3階層表示する（報告例）", () => {
  const text = "# タイトル1\n## タイトル1-1\n### タイトル1-1-1\n@TODO あれ\n";
  const tree = matchingHeadings(text, "TODO");
  assert.equal(tree.length, 1);
  assert.equal(tree[0].title, "タイトル1");
  assert.equal(tree[0].matched, false);
  assert.equal(tree[0].children[0].title, "タイトル1-1");
  const leaf = tree[0].children[0].children[0];
  assert.equal(leaf.title, "タイトル1-1-1");
  assert.equal(leaf.matched, true);
  assert.equal(text.slice(leaf.start).split("\n")[0], "### タイトル1-1-1");
});
test("検索見出しはコードと無関係な節を除外し、複数の一致を保持", () => {
  const text =
    "# 親\n### 同名\n@2026/09/01\n## 対象外\n@OTHER\n## 同名\n```md\n# コードの見出し\n@2026/09/02\n```\n@2026/10/01";
  const tree = matchingHeadings(text, "2026");
  assert.deepEqual(
    tree[0].children.map((n) => n.title),
    ["同名", "同名"],
  );
  assert.notEqual(tree[0].children[0].start, tree[0].children[1].start);
  assert.equal(tree[0].children[1].matched, true);
  assert.equal(tree[0].children[1].children.length, 0);
  assert.equal(matchingHeadings(text, "20260").length, 0);
});
test("見出し以前のタグは無関係な見出しを表示しない", () => {
  assert.deepEqual(matchingHeadings("@TODO\n# 対象外\n本文", "TODO"), []);
  assert.deepEqual(matchingHeadings("@TODO 本文のみ", "TODO"), []);
});
test("CRLF・絵文字・閉じるハッシュ・見出し上のタグ", () => {
  const text = "🎵\r\n# 親\r\n###### 子 @TODO ###\r\n本文";
  const child = matchingHeadings(text, "TODO")[0].children[0];
  assert.equal(child.title, "子 @TODO");
  assert.equal(child.matched, true);
  assert.equal(child.start, text.indexOf("######"));
});

test("TODO本文を行単位で抽出し、同じ行を重複表示しない", () => {
  const text =
    "@TODO 冒頭\r\n# 見出し\r\n- @TODO あれ @TODO これ\r\n`@TODO 非表示`\r\n```\r\n@TODO コード\r\n```\r\n@TODO 最後";
  const lines = matchingLines(text, "TODO");
  assert.deepEqual(
    lines.map((line) => line.text),
    ["@TODO 冒頭", "- @TODO あれ @TODO これ", "@TODO 最後"],
  );
  for (const line of lines)
    assert.ok(text.slice(line.start).startsWith(line.text));
  const heading = matchingHeadings(text, "TODO")[0];
  assert.deepEqual(
    heading.lines.map((line) => line.text),
    ["- @TODO あれ @TODO これ", "@TODO 最後"],
  );
});
test("本文を正しい見出しに割り当て、親タグでも表示する", () => {
  const text = "# 親\n@2026/09/01 開始\n## 子\n@2026/09/02 続き";
  const [parent] = matchingHeadings(text, "2026");
  assert.deepEqual(
    parent.lines.map((line) => line.text),
    ["@2026/09/01 開始"],
  );
  assert.deepEqual(
    parent.children[0].lines.map((line) => line.text),
    ["@2026/09/02 続き"],
  );
});

test("ノートの印は本文順ではなく設定順で1つだけ選ぶ", () => {
  const tags = parseTags("@ロック @TODO @TODO");
  assert.equal(
    noteMark(tags, { TODO: { mark: "🔴" }, ロック: { mark: "🟡" } }, "🗒️"),
    "🔴",
  );
  assert.equal(
    noteMark(tags, { ロック: { mark: "🟡" }, TODO: { mark: "🔴" } }, "🗒️"),
    "🟡",
  );
  assert.equal(
    noteMark(tags, { TODO: { color: "#fff" }, ロック: { mark: "🟡" } }, "🗒️"),
    "🟡",
  );
  assert.equal(noteMark([], {}, "🗒️"), "🗒️");
  assert.equal(noteMark(tags, {}, "🗒️"), "🏷️");
});
test("階層タグは有効な最寄りの設定の順序で印を選ぶ", () => {
  const styles = {
    date: { mark: "$(calendar)" },
    TODO: { mark: "🔴" },
    "date/day": { mark: "◆" },
  };
  assert.equal(
    noteMark(parseTags("@date/month @TODO"), styles, ""),
    "$(calendar)",
  );
  assert.equal(noteMark(parseTags("@date/day @TODO"), styles, ""), "🔴");
});

test("設定がアクセスごとに別オブジェクトを返してもノートの印を表示する", () => {
  const values = { TODO: { mark: "🔴" }, FIX: { mark: "🐞" } };
  const settings = new Proxy(values, {
    get: (target, key) => ({ ...target[key] }),
  });
  assert.notEqual(settings.TODO, settings.TODO);
  assert.equal(noteMark(parseTags("@FIX @TODO"), settings, "🗒️"), "🔴");
  assert.equal(styleFor("FIX", settings).mark, "🐞");
});

test("配列の定義順は数字だけのタグがあっても維持する", () => {
  const styles = [
    { tag: "TODO", mark: "🔴" },
    { tag: "FIX", mark: "🐞" },
    { tag: "2026", mark: "$(calendar)" },
  ];
  const tags = parseTags("@2026/09/12 @FIX @TODO");
  assert.equal(noteMark(tags, styles, ""), "🔴");
  assert.equal(noteMark(tags, [...styles].reverse(), ""), "🐞");
  assert.equal(noteMark(parseTags("@FIX @2026"), styles, ""), "🐞");
  assert.equal(styleFor("2026/09", styles).mark, "$(calendar)");
  assert.equal(styleFor("TODO", styles).mark, "🔴");
});
test("重複定義は印と色の両方で先頭を優先する", () => {
  const styles = [
    { tag: "TODO", color: "#fff" },
    { tag: "TODO", mark: "🔴" },
    { tag: "FIX", mark: "🐞" },
  ];
  assert.equal(noteMark(parseTags("@TODO @FIX"), styles, ""), "🐞");
  assert.deepEqual(styleFor("TODO", styles), styles[0]);
});

test("ノート検索は名前・本文を部分一致で探し、該当行の位置を保持する", () => {
  const note = {
    id: "親/メモ",
    parent: "親",
    name: "メモ",
    text: "🎵\r\nHello World\r\n```\nHELLO code\n```",
    tags: [],
  };
  assert.equal(searchNotes([note], "メモ")[0].note, note);
  const [hit] = searchNotes([note], " hello ");
  assert.deepEqual(
    hit.lines.map((line) => line.text),
    ["Hello World", "HELLO code"],
  );
  assert.equal(hit.lines[0].start, note.text.indexOf("Hello"));
  assert.equal(hit.lines[1].start, note.text.indexOf("HELLO"));
  assert.deepEqual(searchNotes([note], ""), []);
  assert.deepEqual(searchNotes([note], "no match"), []);
  assert.deepEqual(searchNotes([note], ".*"), []);
});

test("ドロップの前後挿入は兄弟の順序と子ノートを保持する", () => {
  const notes = ["A", "A/子", "B", "C"].map((id) => ({
    id,
    name: id.split("/").at(-1),
    parent: id.includes("/") ? "A" : "",
    text: "",
    tags: [],
  }));
  assert.deepEqual(planNoteDrop(notes, "C", "A", "before").order, [
    "C",
    "A",
    "A/子",
    "B",
  ]);
  assert.deepEqual(planNoteDrop(notes, "A", "B", "after").order, [
    "B",
    "A",
    "A/子",
    "C",
  ]);
  assert.equal(planNoteDrop(notes, "B", "A/子", "before").destination, "A/B");
  assert.equal(planNoteDrop(notes, "B", "A", "inside").destination, "A/B");
  assert.equal(
    planNoteDrop(notes, "A/子", undefined, "inside").destination,
    "子",
  );
  assert.throws(() => planNoteDrop(notes, "A", "A/子", "after"), /descendants/);
  assert.throws(() => planNoteDrop(notes, "A", "A", "before"), /itself/);
  assert.throws(
    () => planNoteDrop(notes, "A", "missing", "before"),
    /not found/,
  );
  const duplicate = [
    ...notes,
    { id: "B/子", name: "子", parent: "B", text: "", tags: [] },
  ];
  assert.throws(() => planNoteDrop(duplicate, "A/子", "B", "inside"), /same name/);
});

test("時刻範囲のタグ全体を認識し、同じ行の複数の時間帯に対応する", () => {
  const text = "@2026/09/13 @10:30-12:00 @14:00-14:45 @23:30-24:00";
  const parsed = parseTags(text);
  assert.deepEqual(
    parsed.map((t) => t.tag),
    ["2026/09/13", "10:30-12:00", "14:00-14:45", "23:30-24:00"],
  );
  for (const tag of parsed)
    assert.equal(text.slice(tag.start, tag.end), "@" + tag.tag);
  const tree = tagTree([{ id: "note", tags: parsed }]);
  assert.equal(tree.has("10:30-12:00"), false);
  assert.deepEqual([...tree.keys()], ["2026"]);
  assert.equal(
    tree.get("2026").children.get("09").children.get("13").tag,
    "2026/09/13",
  );
  assert.equal(
    tagTree([{ id: "time-only", tags: parseTags("@10:30-12:00") }]).size,
    0,
  );
  assert.equal(tree.has("10"), false);
  assert.equal(matchingLines(text, "10:30-12:00").length, 1);
  assert.deepEqual(parseTags("`@10:30-12:00`\n```\n@14:00-14:45\n```"), []);
});

test("分・時間のタグを時刻タグとして扱い、一覧から除外する", () => {
  const text = "@2026/09/13 @10m @1h @90m @TODO";
  const parsed = parseTags(text);
  assert.deepEqual(
    parsed.map((tag) => tag.tag),
    ["2026/09/13", "10m", "1h", "90m", "TODO"],
  );
  for (const tag of parsed)
    assert.equal(text.slice(tag.start, tag.end), "@" + tag.tag);
  assert.deepEqual(
    [...tagTree([{ id: "note", tags: parsed }]).keys()],
    ["2026", "TODO"],
  );
  for (const tag of ["10m", "1h", "90m", "10:30-12:00"])
    assert.equal(isTimeTag(tag), true);
  for (const tag of ["10minutes", "1hour", "10m/task", "TODO", "2026/09/13"])
    assert.equal(isTimeTag(tag), false);
  assert.deepEqual(parseTags("`@10m`\n```\n@1h\n```"), []);
  assert.equal(matchingLines(text, "10m")[0].text, text);
});

test("日付・時刻タグはノートの印の候補にしない", () => {
  const styles = [
    { tag: "2026", mark: "$(calendar)" },
    { tag: "10:30-12:00", mark: "⏰" },
    { tag: "10m", mark: "⏱️" },
    { tag: "1h", mark: "⌛" },
    { tag: "TODO", mark: "🔴" },
  ];
  const special = "@2026/09/13 @10:30-12:00 @10m @1h";
  assert.equal(noteMark(parseTags(special), styles, "🗒️"), "🗒️");
  assert.equal(noteMark(parseTags(special), styles, "📝"), "📝");
  assert.equal(noteMark(parseTags(special), styles, ""), "");
  assert.equal(noteMark(parseTags(special + " @TODO"), styles, "🗒️"), "🔴");
  assert.equal(noteMark([], styles, "🗒️"), "🗒️");
  assert.equal(styleFor("2026/09/13", styles).mark, "$(calendar)");
});

test("日付タグの作業時間を最下位の見出しごとに合計する", () => {
  const text =
    "# 作業\n## A\n@2026/09/13 @10:30-12:00 @10m\n@2026/09/13 @1h\n@2026/09/14 @4h\n## B\n@2026/09/13 @15m";
  const [root] = matchingHeadings(text, "2026/09/13");
  assert.equal(minutesForDate(text, root.lines, "2026/09/13"), undefined);
  assert.equal(minutesForDate(text, root.children[0].lines, "2026/09/13"), 160);
  assert.equal(minutesForDate(text, root.children[1].lines, "2026/09/13"), 15);
  assert.equal(minutesForDate(text, root.children[0].lines, "TODO"), undefined);
});
test("日付と時刻は同じ行だけを集計し、コード・曖昧な日付・不正時刻を除外", () => {
  const text =
    "@2026/09/13 @10m `@2h`\n@1h\n@2026/09/13 @2026/09/14 @3h\n@2026/09/13 @25:00-26:00\n```\n@2026/09/13 @4h\n```";
  assert.equal(
    minutesForDate(text, matchingLines(text, "2026/09/13"), "2026/09/13"),
    10,
  );
  assert.equal(timeTagMinutes("23:30-24:00"), 30);
  assert.equal(timeTagMinutes("12:00-10:00"), undefined);
  assert.equal(timeTagMinutes("10:60-12:00"), undefined);
  assert.equal(timeTagMinutes("23:00-24:01"), undefined);
  assert.equal(timeTagMinutes("1h"), 60);
  assert.equal(timeTagMinutes("0m"), 0);
});

test("合計時間をh・m形式で表示する", () => {
  for (const [minutes, expected] of [
    [0, "0m"],
    [30, "30m"],
    [60, "1h"],
    [90, "1h30m"],
    [160, "2h40m"],
  ]) {
    assert.equal(formatWorkMinutes(minutes), expected);
  }
});

test("印が未設定・空白の通常タグは既定の印にフォールバックする", () => {
  for (const mark of [undefined, "", "   "]) {
    assert.equal(noteMark(parseTags("@TODO"), { TODO: { mark } }, "🗒️"), "🏷️");
    assert.equal(
      noteMark(parseTags("@TODO"), { TODO: { mark } }, "🗒️", "◆"),
      "◆",
    );
    assert.equal(
      noteMark(parseTags("@TODO"), { TODO: { mark } }, "🗒️", ""),
      "",
    );
  }
});

test("URL範囲はMarkdownの括弧・句読点・コードを除外する", () => {
  const { parseUrls } = require("../dist/core");
  const text =
    "https://example.com/a?q=1&b=2。 [説明](http://example.com/path) https://example.com/a_(b). `https://hidden.test`\n```\nhttps://hidden.test\n```";
  assert.deepEqual(
    parseUrls(text).map((url) => text.slice(url.start, url.end)),
    [
      "https://example.com/a?q=1&b=2",
      "http://example.com/path",
      "https://example.com/a_(b)",
    ],
  );
});

test("file・mailto・独自スキームのURIを検出する", () => {
  const { parseUrls } = require("../dist/core");
  const uris = [
    "file://~/notes/a.md",
    "file:///Users/test/a.md",
    "file:relative.md",
    "mailto:user@example.com",
    "ftp://example.com/a",
    "vscode://file/Users/test/a.ts:10",
    "urn:isbn:1234",
    "my-app+test://host/path",
  ];
  const text = uris.join(" ") + " 10:30 C:/notes/a.md `file:///hidden`";
  assert.deepEqual(
    parseUrls(text).map((uri) => text.slice(uri.start, uri.end)),
    uris,
  );
});

test("年・月で配下の日付の時間を合計する", () => {
  const text =
    "@2026/09/13 @24h\n@2026/09/14 @2h @30m\n@2026/10/01 @1h\n@2025/09/13 @8h\n@2026/09 @5h\n@2026/09/13 @2026/09/14 @10h";
  assert.equal(
    minutesForDate(text, matchingLines(text, "2026/09"), "2026/09"),
    1590,
  );
  assert.equal(minutesForDate(text, matchingLines(text, "2026"), "2026"), 1650);
  assert.equal(
    minutesForDate(text, matchingLines(text, "2026/09/13"), "2026/09/13"),
    1440,
  );
  assert.equal(
    minutesForDate(text, matchingLines(text, "2026/08"), "2026/08"),
    undefined,
  );
});
test("24時間以上も時間と分で表示する", () => {
  for (const [minutes, label] of [
    [1439, "23h59m"],
    [1440, "24h"],
    [1441, "24h1m"],
    [1590, "26h30m"],
    [2880, "48h"],
  ]) {
    assert.equal(formatWorkMinutes(minutes), label);
  }
});

test("深いリストのタグを認識し、リスト内のコードは除外する（#14）", () => {
  const text =
    "- @A\n  - @B\n    - @C\n      1. @D\n         続き @E\n\n             @code\n         ```\n         - @fenced\n         ```\n      - @F\n\n通常\n    @outsideCode";
  assert.deepEqual(tags(text), ["A", "B", "C", "D", "E", "F"]);
  for (const tag of parseTags(text))
    assert.equal(text.slice(tag.start, tag.end), "@" + tag.tag);
  assert.deepEqual(tags("- @A\n\t- @B\n\t\t- @C"), ["A", "B", "C"]);
  assert.deepEqual(tags("    - @code\n- 親\n      - @code"), []);
  const dated = "- 親\n  - 子\n    - @2026/09/16 @30m";
  assert.equal(
    minutesForDate(dated, matchingLines(dated, "2026/09/16"), "2026/09/16"),
    30,
  );
});

test("設定したタグ階層を表示し、親タグから子孫の本文を検索する（#11）", () => {
  const hierarchy = { car: ["toyota"], toyota: ["land-cruiser", "rav4"] };
  const text = "# 車\n@land-cruiser 仕様\n@rav4 比較\n@other 対象外";
  const notes = [
    { id: "親", tags: [] },
    { id: "親/子", tags: parseTags(text) },
  ];
  const tree = tagTree(notes, hierarchy);
  assert.deepEqual(
    [...tree.get("car").children.get("toyota").children.keys()],
    ["land-cruiser", "rav4"],
  );
  assert.equal(tree.has("land-cruiser"), false);
  assert.deepEqual(
    filterTree(notes, "toyota", hierarchy).map((note) => note.id),
    ["親", "親/子"],
  );
  assert.equal(
    matchingLines(text, "car", parseTags(text), hierarchy).length,
    2,
  );
  assert.equal(
    matchingHeadings(text, "toyota", parseTags(text), hierarchy)[0].lines
      .length,
    2,
  );
  assert.equal(
    matchingLines(text, "rav4", parseTags(text), hierarchy).length,
    1,
  );
  assert.equal(tagTree([], hierarchy).size, 0);
});
test("タグ階層の循環・複数親・同名の末尾を持つタグを安全に扱う", () => {
  const notes = [{ id: "n", tags: parseTags("@a @b @x/item @y/item") }];
  const tree = tagTree(notes, {
    a: ["b"],
    b: ["a"],
    other: ["b"],
    group: ["x/item", "y/item"],
  });
  assert.equal(tree.get("a").children.get("b").tag, "b");
  assert.equal(tree.has("other"), false);
  assert.deepEqual(
    [...tree.get("group").children.values()].map((node) => node.tag),
    ["x/item", "y/item"],
  );
});

test("タイトルの印から除外したタグは優先順位と既定タグ印の判定に参加しない", () => {
  for (const styles of [
    [
      { tag: "参考", mark: "📚", excludeFromNoteMark: true },
      { tag: "TODO", mark: "🔴" },
    ],
    { 参考: { mark: "📚", excludeFromNoteMark: true }, TODO: { mark: "🔴" } },
  ]) {
    assert.equal(noteMark(parseTags("@参考 @TODO"), styles, "🗒️"), "🔴");
    assert.equal(noteMark(parseTags("@参考"), styles, "🗒️"), "🗒️");
    assert.equal(noteMark(parseTags("@参考 @2026/09/17 @10m"), styles, ""), "");
    assert.equal(
      noteMark(parseTags("@参考 @未設定"), styles, "🗒️", "🏷️"),
      "🏷️",
    );
    assert.equal(styleFor("参考", styles).mark, "📚");
  }
});
test("印の除外は最寄りの定義と重複定義の先頭に従う", () => {
  const styles = [
    { tag: "参考", mark: "📚", excludeFromNoteMark: true },
    { tag: "参考", mark: "誤った候補", excludeFromNoteMark: false },
    { tag: "参考/重要", mark: "⭐", excludeFromNoteMark: false },
    { tag: "参考/通常", mark: "◆" },
    { tag: "TODO", mark: "🔴" },
  ];
  assert.equal(noteMark(parseTags("@参考/資料 @TODO"), styles, ""), "🔴");
  assert.equal(noteMark(parseTags("@参考 @参考/資料"), styles, "🗒️"), "🗒️");
  assert.equal(noteMark(parseTags("@参考/重要 @TODO"), styles, ""), "⭐");
  assert.equal(noteMark(parseTags("@参考/通常 @TODO"), styles, ""), "🔴");
});

test("除外属性は設定したタグ階層を継承し、子の色・印だけの定義では解除しない", () => {
  const hierarchy = { 分類: ["参考"], 参考: ["資料", "例外", "未定義"] };
  const styles = [
    { tag: "分類", excludeFromNoteMark: true },
    { tag: "参考", color: "#fff" },
    { tag: "資料", mark: "📚" },
    { tag: "例外", mark: "⭐", excludeFromNoteMark: false },
    { tag: "TODO", mark: "🔴" },
  ];
  for (const definitions of [
    styles,
    Object.fromEntries(styles.map(({ tag, ...style }) => [tag, style])),
  ]) {
    const mark = (text) =>
      noteMark(parseTags(text), definitions, "🗒️", "🏷️", hierarchy);
    assert.equal(mark("@資料 @TODO"), "🔴");
    assert.equal(mark("@資料/詳細 @参考 @未定義"), "🗒️");
    assert.equal(mark("@例外 @TODO"), "⭐");
    assert.equal(mark("@未設定"), "🏷️");
    assert.equal(styleFor("資料", definitions).mark, "📚");
  }
});

test("Codiconsの既定アイコンとタグ名から生成する1024色のHSLパレット", () => {
  const {
    automaticTagColor,
    tagAppearance,
    noteAppearance,
  } = require("../dist/core");
  const first = tagAppearance("未設定", {});
  assert.equal(first.mark, "$(circle-filled-compact)");
  assert.equal(first.color, automaticTagColor("未設定"));
  assert.equal(first.color, tagAppearance("未設定", {}).color);
  const colors = new Set(
    Array.from({ length: 20000 }, (_, i) => automaticTagColor(`tag${i}`)),
  );
  assert.equal(colors.size, 1024);
  for (const color of colors) {
    const [, hue, saturation, lightness] =
      /^hsl\(([\d.]+), (\d+)%, (\d+)%\)$/.exec(color);
    assert.ok(+hue >= 0 && +hue < 360);
    assert.ok(+saturation >= 55 && +saturation <= 79);
    assert.ok(+lightness >= 42 && +lightness <= 60);
  }
  const styles = [
    { tag: "TODO", mark: "$(check)", color: "#112233", markColor: "#445566" },
  ];
  assert.deepEqual(tagAppearance("TODO/子", styles), {
    mark: "$(check)",
    color: "#445566",
  });
  assert.equal(
    tagAppearance("色のみ", { 色のみ: { color: "#123456" } }).color,
    "#123456",
  );
  assert.equal(tagAppearance("絵文字", { 絵文字: { mark: "✅" } }).mark, "✅");
  assert.equal(tagAppearance("無印", {}, "").mark, "");
  assert.equal(noteAppearance(parseTags("@未設定"), {}, "🗒️").mark, first.mark);
  assert.equal(noteAppearance(parseTags("@TODO"), styles, "").color, "#445566");
  assert.equal(
    noteAppearance(
      parseTags("@参考 @TODO"),
      [{ tag: "参考", mark: "$(book)", excludeFromNoteMark: true }, ...styles],
      "",
    ).mark,
    "$(check)",
  );
});

test("階層タグは親のアイコンと色を継承し、子のアイコン指定だけを優先する", () => {
  const { tagAppearance, noteAppearance } = require("../dist/core");
  const hierarchy = { 車: ["toyota"], toyota: ["rav4"] };
  const styles = [
    { tag: "車", mark: "$(symbol-color)", markColor: "#123456" },
    { tag: "toyota", color: "#ffffff" },
  ];
  const parent = tagAppearance("車", styles, undefined, hierarchy);
  assert.deepEqual(
    tagAppearance("toyota", styles, undefined, hierarchy),
    parent,
  );
  assert.deepEqual(tagAppearance("rav4", styles, undefined, hierarchy), parent);
  assert.deepEqual(
    tagAppearance("rav4/詳細", styles, undefined, hierarchy),
    parent,
  );
  assert.deepEqual(
    noteAppearance(parseTags("@rav4"), styles, "", undefined, hierarchy),
    parent,
  );
  assert.deepEqual(tagAppearance("車/分類/子", styles), parent);
  const override = [
    ...styles,
    { tag: "rav4", mark: "🚗", markColor: "#abcdef" },
  ];
  assert.deepEqual(tagAppearance("rav4", override, undefined, hierarchy), {
    mark: "🚗",
    color: "#abcdef",
  });
  assert.equal(
    noteAppearance(parseTags("@rav4"), override, "", undefined, hierarchy).mark,
    "🚗",
  );
  assert.deepEqual(
    tagAppearance("rav4", {}, undefined, hierarchy),
    tagAppearance("車", {}, undefined, hierarchy),
  );
  assert.equal(
    noteAppearance(
      parseTags("@rav4"),
      [{ ...styles[0], excludeFromNoteMark: true }],
      "🗒️",
      undefined,
      hierarchy,
    ).mark,
    "🗒️",
  );
});

test("date設定で年に依存せず年・月・日の日付タグに共通アイコンを使う", () => {
  const { tagAppearance } = require("../dist/core");
  const date = { mark: "$(calendar)", markColor: "#123456", color: "#abcdef" };
  for (const styles of [{ date }, [{ tag: "date", ...date }]]) {
    for (const tag of ["2025", "2026/09", "2027/01/01", "2030"]) {
      assert.deepEqual(tagAppearance(tag, styles), {
        mark: "$(calendar)",
        color: "#123456",
      });
      assert.equal(styleFor(tag, styles).color, "#abcdef");
    }
    assert.equal(
      tagAppearance("TODO", styles).mark,
      "$(circle-filled-compact)",
    );
    assert.equal(
      tagAppearance("2026/topic", styles).mark,
      "$(circle-filled-compact)",
    );
    assert.equal(noteMark(parseTags("@2027/01/01"), styles, "🗒️"), "🗒️");
  }
  const styles = {
    date,
    2026: { mark: "$(calendar)" },
    "2026/09": { mark: "⭐" },
  };
  assert.equal(tagAppearance("2026/08/01", styles).mark, "$(calendar)");
  assert.equal(tagAppearance("2026/09/01", styles).mark, "⭐");
  assert.equal(tagAppearance("2027", styles).mark, "$(calendar)");
  assert.equal(
    tagAppearance("2026", { 2026: { mark: "$(calendar)" } }).mark,
    "$(calendar)",
  );
});
