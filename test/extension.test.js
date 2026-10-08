"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

test("拡張機能: 保存・再読込・子ノート移動・循環防止・検索・削除", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "fnote-test-"));
  const contexts = new Map();
  const commands = new Map(),
    views = new Map(),
    errors = [],
    inputs = [],
    picks = [];
  const disposable = () => ({ dispose() {} });
  const uri = (p, fragment) => ({
    fsPath: p,
    fragment,
    toString: () => `file://${p}${fragment ? `#${fragment}` : ''}`,
    with: change => uri(p, change.fragment),
  });
  const fileError = (e) => {
    if (e.code === "ENOENT") e.code = "FileNotFound";
    throw e;
  };
  let html = "",
    panelCount = 0,
    panelDisposeCount = 0,
    panelReveals = [],
    receiveMessage,
    configurationChanged,
    selectionChanged,
    shown,
    linkProvider,
    dropProvider;
  const documents = [];
  const editorStyles = [];
  const closeCalls = [];
  const openedAttachments = [];
  const attachmentSources = [];
  let closeResult = true;
  const settings = new Map([["defaultTagMark", "🏷️"]]);
  const api = {
    languages: {
      registerDocumentLinkProvider(selector, provider) {
        linkProvider = provider;
        return disposable();
      },
      registerDocumentDropEditProvider(selector, provider) {
        dropProvider = provider;
        return disposable();
      },
    },
    DocumentLink: class {
      constructor(range, target) { Object.assign(this, { range, target }); }
    },
    DocumentDropEdit: class {
      constructor(insertText) { this.insertText = insertText; }
    },
    ThemeColor: class { constructor(id) { this.id = id; } },
    Uri: {
      parse: value => ({ toString: () => value }),
      file: uri,
      joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
    },
    FileType: { File: 1, Directory: 2 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1 },
    TabInputText: class {
      constructor(uri) {
        this.uri = uri;
      }
    },
    TabInputWebview: class {
      constructor(viewType) {
        this.viewType = viewType;
      }
    },
    Range: class {
      intersection(other) {
        return this.start.offset <= other.end.offset && this.end.offset >= other.start.offset ? this : undefined;
      }
      constructor(start, end) {
        Object.assign(this, { start, end });
      }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        Object.assign(this, { label, collapsibleState });
      }
    },
    EventEmitter: class {
      event = () => disposable();
      fire() {}
      dispose() {}
    },
    RelativePattern: class {},
    DataTransferItem: class {
      constructor(value) {
        this.value = value;
      }
    },
    WorkspaceEdit: class {
      ops = [];
      replace(u, range, value) {
        this.ops.push(async () => {
          const text = await fs.readFile(u.fsPath, "utf8");
          await fs.writeFile(
            u.fsPath,
            text.slice(0, range.start.offset) +
              value +
              text.slice(range.end.offset),
          );
        });
      }
      createFile(u, options = {}) {
        this.ops.push(async () => {
          await fs.mkdir(path.dirname(u.fsPath), { recursive: true });
          const data = options.contents?.data ? await options.contents.data() : options.contents ?? [];
          await fs.writeFile(u.fsPath, Buffer.from(data), { flag: options.overwrite ? 'w' : 'wx' });
        });
      }
      renameFile(a, b) {
        this.ops.push(() => fs.rename(a.fsPath, b.fsPath));
      }
      deleteFile(a) {
        this.ops.push(() => fs.rm(a.fsPath, { recursive: true }));
      }
    },
    commands: {
      executeCommand: (name, ...args) =>
        name === "setContext"
          ? contexts.set(...args)
          : name === "vscode.open" || name === "revealFileInOS"
            ? openedAttachments.push({ name, uri: args[0] })
          : commands.get(name)(...args),
      registerCommand(name, fn) {
        commands.set(name, fn);
        return disposable();
      },
    },
    workspace: {
      workspaceFolders: [{ uri: uri(temp) }],
      textDocuments: documents,
      getConfiguration: () => ({
        inspect: (key) => ({ globalValue: settings.get(key) }),
        get: (key, fallback) =>
          settings.has(key) ? settings.get(key) : fallback,
      }),
      fs: {
        readDirectory: async (u) =>
          (
            await fs.readdir(u.fsPath, { withFileTypes: true }).catch(fileError)
          ).map((e) => [e.name, e.isDirectory() ? 2 : 1]),
        readFile: (u) => fs.readFile(u.fsPath).catch(fileError),
        writeFile: (u, data) => fs.writeFile(u.fsPath, data),
        createDirectory: (u) => fs.mkdir(u.fsPath, { recursive: true }),
        stat: async (u) => {
          const stat = await fs.stat(u.fsPath).catch(fileError);
          return { type: stat.isDirectory() ? 2 : 1 };
        },
        copy: async (source, target, options = {}) => {
          await fs.cp(source.fsPath, target.fsPath, { recursive: true, force: Boolean(options.overwrite) });
        },
      },
      applyEdit: async (edit) => {
        for (const op of edit.ops) await op();
        return true;
      },
      openTextDocument: async (u) => {
        const text =
          documents
            .find((doc) => doc.uri.toString() === u.toString())
            ?.getText() ?? (await fs.readFile(u.fsPath, "utf8"));
        return {
          uri: u,
          getText: () => text,
          positionAt: (offset) => ({ offset }),
        };
      },
      createFileSystemWatcher: () => ({
        ...disposable(),
        onDidCreate: disposable,
        onDidDelete: disposable,
        onDidChange: disposable,
      }),
      onDidChangeTextDocument: disposable,
      onDidCloseTextDocument: disposable,
      onDidChangeConfiguration: (listener) => {
        configurationChanged = listener;
        return disposable();
      },
    },
    window: {
      tabGroups: {
        all: [],
        close: async (tabs, preserveFocus) => {
          closeCalls.push({ tabs, preserveFocus });
          return closeResult;
        },
      },
      registerWebviewViewProvider: (id, provider) => {
        views.set(id, {
          treeDataProvider: provider.data,
          webviewProvider: provider,
        });
        return disposable();
      },
      createTextEditorDecorationType: (options) => ({
        ...disposable(),
        options,
      }),
      visibleTextEditors: [],
      createTreeView: (id, options) => {
        const view = {
          ...disposable(),
          ...options,
          selection: [],
          reveal: async () => {},
        };
        views.set(id, view);
        return view;
      },
      showInputBox: async () => inputs.shift(),
      showQuickPick: async () => picks.shift(),
      showOpenDialog: async () => attachmentSources.shift(),
      showWarningMessage: async (message) => message.startsWith("Archive or unarchive") ? "Apply" : "Delete",
      showErrorMessage: (message) => errors.push(message),
      showTextDocument: async (doc, options) => {
        shown = { doc, options };
      },
      onDidChangeVisibleTextEditors: disposable,
      onDidChangeTextEditorSelection: listener => { selectionChanged = listener; return disposable(); },
      onDidChangeActiveTextEditor: disposable,
      createWebviewPanel: () => {
        panelCount++;
        let onDispose;
        return {
          dispose() {
            panelDisposeCount++;
            onDispose?.();
          },
          reveal(...args) { panelReveals.push(args); },
          onDidDispose: (handler) => {
            onDispose = handler;
            return disposable();
          },
          webview: {
            asWebviewUri: (value) => value.toString(),
            cspSource: "https://webview.test",
            set html(value) {
              html = value;
            },
            onDidReceiveMessage: (handler) => {
              receiveMessage = handler;
              return disposable();
            },
          },
        };
      },
    },
  };
  const original = Module._load;
  Module._load = function (name, ...rest) {
    return name === "vscode"
      ? api
      : name === "node:os"
        ? { ...os, homedir: () => temp }
        : original.call(this, name, ...rest);
  };
  const savedState = new Map();
  const context = {
    extensionUri: uri(path.resolve(__dirname, "..")),
    subscriptions: [],
    globalState: {
      get: (key, fallback) => savedState.get(key) ?? fallback,
      update: async (key, value) => {
        savedState.set(key, value);
      },
    },
    globalStorageUri: uri(temp),
  };
  try {
    const { activate } = require("../dist/extension");
    await activate(context);
    const linkText = "[[../旅行/]]\n[](../旅行/)\n[旅行](../%E6%97%85%E8%A1%8C/)";
    const linkDocument = {
      uri: uri(path.join(temp, ".fnote/日記/index.md")),
      getText: () => linkText,
      positionAt: offset => ({ offset }),
    };
    const links = await linkProvider.provideDocumentLinks(linkDocument);
    assert.equal(links.length, 3);
    assert.deepEqual(links.map(link => linkText.slice(link.range.start.offset, link.range.end.offset)), ["../旅行/", "../旅行/", "旅行"]);
    for (const link of links) {
      assert.equal(link.target.fsPath, path.join(temp, ".fnote/旅行/index.md"));

    }
    assert.deepEqual(await linkProvider.provideDocumentLinks({ ...linkDocument, uri: uri(path.join(temp, "other/index.md")) }), []);
    await fs.mkdir(path.join(temp, ".fnote/旅行"), { recursive: true });
    await fs.writeFile(path.join(temp, ".fnote/旅行/index.md"), "# 旅行");
    await fs.writeFile(path.join(temp, ".fnote/plain"), "ordinary file");
    await fs.writeFile(path.join(temp, ".fnote/旅行/a(new).png"), "image");
    const noteLinkFixtures = [
      {
        name: 'ディレクトリ（末尾スラッシュあり）',
        text: '[](../旅行/)\n[旅行予定](../旅行/)\n[[../旅行/]]',
        ranges: ['../旅行/', '旅行予定', '../旅行/'],
      },
      {
        name: 'ディレクトリ（末尾スラッシュなし）',
        text: '[](../旅行)\n[旅行予定](../旅行)\n[[../旅行]]',
        ranges: ['../旅行', '旅行予定', '../旅行'],
      },
      {
        name: 'ディレクトリとファイル名',
        text: '[](../旅行/index.md)\n[旅行予定](../旅行/index.md)\n[[../旅行/index.md]]',
        ranges: ['../旅行/index.md', '旅行予定', '../旅行/index.md'],
      },
    ];
    for (const fixture of noteLinkFixtures) {
      const links = await linkProvider.provideDocumentLinks({ ...linkDocument, getText: () => fixture.text });
      assert.equal(links.length, 3, fixture.name);
      assert.deepEqual(links.map(link => fixture.text.slice(link.range.start.offset, link.range.end.offset)), fixture.ranges, fixture.name);
      for (const link of links) assert.equal(link.target.fsPath, path.join(temp, '.fnote/旅行/index.md'), fixture.name);
    }
    const parenthesized = "[graph](a(new).png)";
    const parenthesizedLinks = await linkProvider.provideDocumentLinks({
      ...linkDocument,
      uri: uri(path.join(temp, ".fnote/旅行/index.md")),
      getText: () => parenthesized,
    });
    assert.equal(parenthesizedLinks.length, 1);
    assert.equal(parenthesized.slice(parenthesizedLinks[0].range.start.offset, parenthesizedLinks[0].range.end.offset), "graph");
    assert.equal(parenthesizedLinks[0].target.fsPath, path.join(temp, ".fnote/旅行/a(new).png"));
    const slashless = await linkProvider.provideDocumentLinks({
      ...linkDocument,
      getText: () => "[[../旅行]]\n[](../旅行)\n[](../%E6%97%85%E8%A1%8C)\n[](../旅行/index.md)\n[[../plain]]\n[](../missing)\n[](../%invalid)",
    });
    assert.equal(slashless.length, 5);
    for (const link of slashless.slice(0, 4)) {
      assert.equal(link.target.fsPath, path.join(temp, ".fnote/旅行/index.md"));
    }
    assert.equal(slashless[4].target.fsPath, path.join(temp, '.fnote/plain'));
    const namedFileText = '[旅行予定](../旅行/index.md)\n[旅行予定](../%E6%97%85%E8%A1%8C/index.md)\n[[../旅行/index.md]]\n[不存在](../旅行/missing.md)';
    const namedFiles = await linkProvider.provideDocumentLinks({ ...linkDocument, getText: () => namedFileText });
    assert.equal(namedFiles.length, 3);
    for (const link of namedFiles) assert.equal(link.target.fsPath, path.join(temp, '.fnote/旅行/index.md'));
    assert.deepEqual(namedFiles.map(link => namedFileText.slice(link.range.start.offset, link.range.end.offset)), ['旅行予定', '旅行予定', '../旅行/index.md']);
    const externalText = '[mybest](https://my-best.com/3185?utm_source=google&utm_medium=cpc&gclid=example)\n[](https://example.com/)';
    const externalLinks = await linkProvider.provideDocumentLinks({ ...linkDocument, getText: () => externalText });
    assert.equal(externalLinks.length, 2);
    assert.deepEqual(externalLinks.map(link => externalText.slice(link.range.start.offset, link.range.end.offset)), ['mybest', 'https://example.com/']);
    assert.equal(externalLinks[0].target.toString(), 'https://my-best.com/3185?utm_source=google&utm_medium=cpc&gclid=example');
    assert.equal(externalLinks[1].target.toString(), 'https://example.com/');
    const fragmentText = '[](#title)\n# Title';
    const fragmentLinks = await linkProvider.provideDocumentLinks({ ...linkDocument, getText: () => fragmentText });
    assert.equal(fragmentLinks.length, 1);
    assert.equal(fragmentLinks[0].target.fsPath, linkDocument.uri.fsPath);
    assert.equal(fragmentLinks[0].target.fragment, 'L2');
    await fs.rm(path.join(temp, ".fnote/旅行"), { recursive: true });
    await fs.unlink(path.join(temp, ".fnote/plain"));
    const run = (name, ...args) => commands.get(`fnote.${name}`)(...args);
    const provider = views.get("fnote.notes").treeDataProvider;
    inputs.push("音楽");
    await run("add");
    const parent = provider.getChildren()[0];
    assert.equal(provider.getTreeItem(parent).label, "$(note) 音楽");
    settings.set("untaggedNoteMark", "📝");
    assert.equal(provider.getTreeItem(parent).label, "📝 音楽");
    settings.set("untaggedNoteMark", "");
    assert.equal(provider.getTreeItem(parent).label, "音楽");
    settings.delete("untaggedNoteMark");

    inputs.push("曲");
    await run("addChild", parent);
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/曲/index.md"),
      "@TODO @2026/09/01",
    );
    await run("refresh");
    let child = provider.getChildren(parent)[0];
    assert.equal(provider.getTreeItem(child).label, "🏷️ 曲");
    const noteTab = {
      input: new api.TabInputText(uri(path.join(temp, ".fnote/音楽/index.md"))),
    };
    const childTab = {
      input: new api.TabInputText(
        uri(path.join(temp, ".fnote/音楽/曲/index.md")),
      ),
      isDirty: true,
    };
    const duplicateTab = { input: new api.TabInputText(noteTab.input.uri) };
    const unrelatedTab = {
      input: new api.TabInputText(uri(path.join(temp, "index.md"))),
    };
    const resultTab = { input: new api.TabInputWebview("fnote.results") };
    const unrelatedWebviewTab = {
      input: new api.TabInputWebview("other.results"),
    };
    api.window.tabGroups.all = [
      { tabs: [noteTab, unrelatedTab, unrelatedWebviewTab] },
      { tabs: [childTab, duplicateTab, resultTab] },
    ];
    await run("closeAllNotes");
    assert.deepEqual(closeCalls[0], {
      tabs: [noteTab, childTab, duplicateTab],
      preserveFocus: true,
    });
    closeResult = false;
    await run("closeAllNotes");
    assert.equal(
      closeCalls.length,
      2,
      "キャンセル時に強制終了や再試行をしない",
    );
    closeResult = true;
    api.window.tabGroups.all = [{ tabs: [unrelatedTab, resultTab] }];
    await run("closeAllNotes");
    assert.equal(closeCalls.length, 2);
    api.window.tabGroups.all = [{ tabs: [unrelatedTab, unrelatedWebviewTab] }];
    await run("closeAllNotes");
    assert.equal(closeCalls.length, 2, "対象がなければ何もしない");
    api.window.tabGroups.all = [];
    settings.set("tagStyles", { TODO: { mark: "🔴" } });
    assert.equal(provider.getTreeItem(child).label, "🔴 曲");
    settings.set("tagStyles", {
      "2026/09": { mark: "$(calendar)" },
      TODO: { mark: "🔴" },
    });
    assert.equal(provider.getTreeItem(child).label, "🔴 曲");
    settings.set("tagStyles", {
      TODO: { mark: "🔴" },
      "2026/09": { mark: "$(calendar)" },
    });
    assert.equal(provider.getTreeItem(child).label, "🔴 曲");
    settings.delete("tagStyles");
    const tagSidebar = views.get("fnote.tags").webviewProvider;
    let tagMessage,
      tagRows = [],
      tagHtml;
    tagSidebar.resolveWebviewView({
      webview: {
        asWebviewUri: (value) => value,
        set html(value) {
          tagHtml = value;
        },
        postMessage: async (message) => {
          if (message.type === "notes") tagRows = message.rows;
        },
        onDidReceiveMessage: (handler) => {
          tagMessage = handler;
          return disposable();
        },
      },
    });
    await tagMessage({ type: "ready" });
    await tagMessage({
      type: "expansionState",
      allCollapsed: true,
      hasBranches: true,
    });
    assert.equal(contexts.get("fnote.tagsAllCollapsed"), true);
    assert.match(tagHtml, /data-tags="true"/);
    assert.doesNotMatch(tagHtml, /id="attachment-hint"/);
    settings.set("tagStyles", [
      { tag: "date", mark: "$(calendar)", markColor: "#ABCDEF" },
    ]);
    await run("refresh");
    for (const id of ["2026", "2026/09", "2026/09/01"]) {
      const row = tagRows.find((row) => row.id === id);
      assert.ok(row.label.startsWith("$(calendar) "));
      assert.deepEqual(row.appearance, {
        mark: "$(calendar)",
        color: "#ABCDEF",
      });
    }
    settings.delete("tagStyles");
    await run("refresh");
    assert.equal(tagRows.find((row) => row.id === "TODO").label, "🏷️ TODO");
    for (const mark of [undefined, "", "   "]) {
      settings.set("tagStyles", [{ tag: "TODO", mark }]);
      await run("refresh");
      assert.equal(tagRows.find((row) => row.id === "TODO").label, "🏷️ TODO");
      assert.equal(provider.getTreeItem(child).label, "🏷️ 曲");
      await run("filter", "TODO");
      assert.match(html, /🏷️ 曲<\/button>/);
    }
    settings.delete("tagStyles");
    await tagMessage({
      type: "drop",
      id: "TODO",
      target: "2026",
      position: "before",
    });
    assert.deepEqual(
      tagRows.filter((row) => !row.parent).map((row) => row.id),
      ["TODO", "2026"],
    );
    assert.deepEqual(
      savedState.get(`tagOrder:file://${path.join(temp, ".fnote")}`),
      ["TODO", "2026"],
    );
    await tagMessage({
      type: "drop",
      id: "TODO",
      target: "2026",
      position: "after",
    });
    assert.deepEqual(
      tagRows.filter((row) => !row.parent).map((row) => row.id),
      ["2026", "TODO"],
    );
    await tagMessage({
      type: "drop",
      id: "TODO",
      target: "2026/09",
      position: "before",
    });
    assert.deepEqual(
      tagRows.filter((row) => !row.parent).map((row) => row.id),
      ["2026", "TODO"],
    );
    await tagMessage({ type: "drop", id: "2026", position: "inside" });
    await run("refresh");
    assert.deepEqual(
      tagRows.filter((row) => !row.parent).map((row) => row.id),
      ["TODO", "2026"],
    );

    assert.equal(
      await fs.readFile(path.join(temp, ".fnote/音楽/index.md"), "utf8"),
      "# 音楽\n\n",
    );
    await run("filter", "2026");
    assert.equal(panelCount, 1);
    assert.match(html, /音楽/);
    assert.match(html, /曲/);
    assert.match(html, /<p>1 note<\/p>/);
    await tagMessage({ type: "open", id: "TODO" });
    assert.deepEqual(panelReveals.at(-1), [undefined, true], "タグ選択後もタグ一覧にフォーカスを残す");
    settings.set("tagHierarchy", { 状態: ["TODO", "WAIT"] });
    await run("refresh");
    assert.equal(tagRows.find((row) => row.id === "TODO").parent, "状態");
    assert.equal(tagRows.find((row) => row.id === "状態").description, "1");
    await run("filter", "状態");
    assert.match(html, /<p>1 note<\/p>/);
    assert.match(html, /@TODO/);
    settings.delete("tagHierarchy");
    await run("refresh");
    assert.equal(tagRows.find((row) => row.id === "TODO").parent, "");
    // Exercise actual sidebar messages, including file moves and insertion order.
    let sidebarMessage,
      sidebarHtml,
      noteRows = [];
    const sidebar = views.get("fnote.notes").webviewProvider;
    sidebar.resolveWebviewView({
      webview: {
        asWebviewUri: (value) => value,
        set html(value) { sidebarHtml = value; },
        postMessage: async (message) => {
          if (message.type === "notes") noteRows = message.rows;
          if (message.type === "edit") {
            const name = inputs.shift();
            if (name !== undefined) await sidebarMessage({ ...message, name });
          }
        },
        onDidReceiveMessage: (handler) => {
          sidebarMessage = handler;
          return disposable();
        },
      },
    });
    assert.doesNotMatch(sidebarHtml, /attachment-hint|Attach files: hold Shift and drop onto a note\./);
    await sidebarMessage({ type: "ready" });
    await sidebarMessage({
      type: "expansionState",
      allCollapsed: false,
      hasBranches: true,
    });
    assert.equal(contexts.get("fnote.notesAllCollapsed"), false);
    assert.equal(contexts.get("fnote.tagsAllCollapsed"), true);
    await fs.mkdir(path.join(temp, ".fnote/別作業"), { recursive: true });
    await fs.writeFile(path.join(temp, ".fnote/別作業/index.md"), "# 別作業\n\n@TODO\n");
    await run("refresh");
    assert.equal(tagRows.find((row) => row.id === "TODO").description, "2");
    await run("archive", child);
    assert.equal(tagRows.find((row) => row.id === "TODO").description, "1");
    await run("archive", child);
    assert.equal(tagRows.find((row) => row.id === "TODO").description, "2");
    await fs.rm(path.join(temp, ".fnote/別作業"), { recursive: true });
    await run("refresh");
    await run("archive", parent);
    assert.equal(contexts.get("fnote.noteArchived"), true);
    assert.equal(noteRows.find((row) => row.id === "音楽").archived, true);
    assert.deepEqual(noteRows.find((row) => row.id === "音楽").appearance, { mark: "$(archive)", color: "#808080" });
    assert.deepEqual(noteRows.find((row) => row.id === "音楽/曲").appearance, { mark: "$(archive)", color: "#808080" });
    assert.equal(JSON.parse(await fs.readFile(path.join(temp, ".fnote/音楽/.status"), "utf8")).archived, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(temp, ".fnote/音楽/曲/.status"), "utf8")).archived, true);
    assert.equal(tagRows.some((row) => row.id === "TODO"), false);
    settings.set("archiveMark", "$(box)");
    settings.set("archiveColor", "#123456");
    await run("refresh");
    assert.deepEqual(noteRows.find((row) => row.id === "音楽").appearance, { mark: "$(box)", color: "#123456" });
    await run("archive", child);
    assert.equal(noteRows.find((row) => row.id === "音楽/曲").archived, false);
    assert.deepEqual(noteRows.find((row) => row.id === "音楽").appearance, { mark: "$(box)", color: "#123456" });
    assert.notDeepEqual(noteRows.find((row) => row.id === "音楽/曲").appearance, { mark: "$(box)", color: "#123456" });
    assert.equal(JSON.parse(await fs.readFile(path.join(temp, ".fnote/音楽/.status"), "utf8")).archived, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(temp, ".fnote/音楽/曲/.status"), "utf8")).archived, false);
    assert.ok(tagRows.some((row) => row.id === "TODO"));
    assert.equal(tagRows.find((row) => row.id === "TODO").description, "1");
    await run("archive", child);
    assert.deepEqual(noteRows.find((row) => row.id === "音楽/曲").appearance, { mark: "$(box)", color: "#123456" });
    assert.equal(tagRows.some((row) => row.id === "TODO"), false);
    settings.delete("archiveMark");
    settings.delete("archiveColor");
    settings.set("tagStyles", [
      { tag: "HIGH", mark: "$(flag)", markColor: "#123456" },
      { tag: "LOW", mark: "$(check)", markColor: "#654321" },
    ]);
    await sidebarMessage({ type: "select", id: "音楽" });
    await run("archive", parent);
    assert.equal(contexts.get("fnote.noteArchived"), false);
    assert.ok(tagRows.some((row) => row.id === "TODO"));
    await run("archive", child);
    assert.equal(contexts.get("fnote.noteArchived"), false);
    assert.equal(tagRows.some((row) => row.id === "TODO"), false);
    await run("archive", child);
    assert.equal(tagRows.some((row) => row.id === "TODO"), true);
    const outlineText =
      "# 音楽\r\n## 節 🎵 @LOW\r\n#### 小節 `code` ### @HIGH\r\n```md\r\n## 非表示\r\n```\r\n## 節 🎵\r\n# 別タイトル\r\n###### 末尾 @LOW";
    await fs.writeFile(path.join(temp, ".fnote/音楽/資料.txt"), "attachment");
    await fs.mkdir(path.join(temp, ".fnote/音楽/assets"), { recursive: true });
    await fs.writeFile(path.join(temp, ".fnote/音楽/assets/preview.png"), "image");
    await fs.writeFile(path.join(temp, ".fnote/音楽/index.md"), outlineText);
    await run("refresh");
    const attachmentRows = noteRows.filter((row) => row.attachment);
    assert.deepEqual(attachmentRows.map((row) => row.id).sort(), ["音楽/assets", "音楽/assets/preview.png", "音楽/資料.txt"]);
    assert.deepEqual(attachmentRows.find((row) => row.id === "音楽/資料.txt").appearance, { mark: "$(attach)", color: undefined });
    await fs.writeFile(path.join(temp, ".fnote/音楽/move-test.txt"), "move me");
    await run("refresh");
    await fs.writeFile(path.join(temp, ".fnote/音楽/index.md"), `${outlineText}\n[](move-test.txt)`);
    await sidebarMessage({ type: "drop", id: "音楽/move-test.txt", target: "音楽/assets", position: "inside" });
    assert.equal(await fs.readFile(path.join(temp, ".fnote/音楽/assets/move-test.txt"), "utf8"), "move me");
    assert.equal(await fs.stat(path.join(temp, ".fnote/音楽/move-test.txt")).catch(() => undefined), undefined);
    assert.match(await fs.readFile(path.join(temp, ".fnote/音楽/index.md"), "utf8"), /\[\]\(assets\/move-test\.txt\)/);
    await fs.writeFile(path.join(temp, ".fnote/音楽/index.md"), outlineText);
    await sidebarMessage({ type: "openAttachment", id: "音楽/move-test.txt" });
    assert.equal(openedAttachments.at(-1), undefined);
    await sidebarMessage({ type: "openAttachment", id: "音楽/assets/move-test.txt" });
    assert.equal(openedAttachments.at(-1).name, "vscode.open");
    assert.equal(openedAttachments.at(-1).uri.fsPath, path.join(temp, ".fnote/音楽/assets/move-test.txt"));
    await sidebarMessage({ type: "command", id: "音楽/assets/preview.png", command: "deleteAttachment" });
    assert.equal(await fs.stat(path.join(temp, ".fnote/音楽/assets/preview.png")).catch(() => undefined), undefined);
    await fs.writeFile(path.join(temp, "external.txt"), "external");
    attachmentSources.push([uri(path.join(temp, "external.txt"))]);
    await run("addAttachment", parent);
    assert.equal(await fs.readFile(path.join(temp, ".fnote/音楽/external.txt"), "utf8"), "external");
    const dropEdit = await dropProvider.provideDocumentDropEdits(
      { uri: uri(path.join(temp, ".fnote/音楽/index.md")) },
      {},
      new Map([[
        "files",
        { asFile: () => ({ name: "dropped.txt", data: async () => Buffer.from("dropped") }) },
      ]]),
      {},
    );
    assert.equal(dropEdit.insertText, "[](dropped.txt)");
    await api.workspace.applyEdit(dropEdit.additionalEdit);
    assert.equal(await fs.readFile(path.join(temp, ".fnote/音楽/dropped.txt"), "utf8"), "dropped");
    // The browser sends bytes, not File.path, for OS drops into a webview.
    await sidebarMessage({ type: 'attachmentDrop', id: '音楽', files: [
      { name: 'browser/data.bin', data: [0, 255, 128, 1] },
      { name: 'browser', directory: true },
      { name: 'browser/empty', directory: true },
    ] });
    assert.deepEqual(await fs.readFile(path.join(temp, '.fnote/音楽/browser/data.bin')), Buffer.from([0, 255, 128, 1]));
    assert.ok((await fs.stat(path.join(temp, '.fnote/音楽/browser/empty'))).isDirectory());
    assert.ok(noteRows.some(row => row.id === '音楽/browser/data.bin' && row.attachment));
    await sidebarMessage({ type: 'attachmentDrop', id: '音楽', files: [{ name: '../escape.txt', data: [1] }] });
    assert.match(errors.pop(), /Invalid dropped attachment/);
    await sidebarMessage({ type: 'attachmentDrop', id: '音楽', files: [{ name: 'index.md', data: [1] }] });
    assert.match(errors.pop(), /Invalid dropped attachment/);
    await sidebarMessage({ type: 'attachmentDrop', id: '音楽', files: [{ name: 'browser/data.bin', data: [1] }] });
    assert.match(errors.pop(), /already exists/);
    assert.deepEqual(await fs.readFile(path.join(temp, '.fnote/音楽/browser/data.bin')), Buffer.from([0, 255, 128, 1]));
    // A file URI must not cause a copy while VS Code is still gathering drop choices.
    const deferred = await dropProvider.provideDocumentDropEdits(
      { uri: uri(path.join(temp, '.fnote/音楽/index.md')) }, {}, new Map([['image/png', {
        asFile: () => ({ name: '旅行(3.png', uri: uri(path.join(temp, 'external.txt')), data: async () => Buffer.from([0, 255, 42]) }),
      }]]), { isCancellationRequested: false });
    assert.equal(await fs.stat(path.join(temp, '.fnote/音楽/旅行(3.png')).catch(() => undefined), undefined);
    assert.equal(deferred.insertText, '[](%E6%97%85%E8%A1%8C%283.png)');
    await api.workspace.applyEdit(deferred.additionalEdit);
    assert.deepEqual(await fs.readFile(path.join(temp, '.fnote/音楽/旅行(3.png')), Buffer.from([0, 255, 42]));
    const cancelled = await dropProvider.provideDocumentDropEdits(
      { uri: uri(path.join(temp, '.fnote/音楽/index.md')) }, {}, new Map([['files', {
        asFile: () => ({ name: 'cancelled.txt', data: async () => { throw new Error('must not read'); } }),
      }]]), { isCancellationRequested: true });
    assert.equal(cancelled, undefined);
    const outline = noteRows.filter((row) => row.noteId === "音楽");
    assert.deepEqual(outline[0].appearance, { mark: "$(check)", color: "#654321" });
    assert.deepEqual(outline[0].collapsedAppearance, { mark: "$(flag)", color: "#123456" });
    assert.deepEqual(outline[1].appearance, { mark: "$(flag)", color: "#123456" });
    assert.equal(outline[2].appearance, undefined);
    assert.deepEqual(outline[3].appearance, { mark: "$(check)", color: "#654321" });
    assert.deepEqual(outline[0].outlineMark, { mark: "#", color: "#808080" });
    assert.deepEqual(
      outline.map((row) => row.label),
      ["節 🎵 @LOW", "小節 `code` ### @HIGH", "節 🎵", "末尾 @LOW"],
    );
    assert.deepEqual(
      outline.map((row) => row.parent),
      ["音楽", outline[0].id, "音楽", "音楽"],
    );
    assert.notEqual(outline[0].id, outline[2].id);
    await sidebarMessage({ type: "open", id: outline[1].id });
    assert.equal(
      shown.options.selection.start.offset,
      outlineText.indexOf("#### 小節"),
    );
    settings.set("headingMark", "$(symbol-number)");
    settings.set("headingMarkColor", "#123456");
    await run("refresh");
    assert.deepEqual(noteRows.find((row) => row.noteId === "音楽").outlineMark, { mark: "$(symbol-number)", color: "#123456" });
    await sidebarMessage({
      type: "command",
      id: outline[0].id,
      command: "delete",
    });
    assert.ok(provider.getChildren().some((note) => note.id === "音楽"));
    // Updating the document removes stale outline rows; tags have no outline.
    assert.ok(tagRows.every((row) => row.noteId === undefined));
    await sidebarMessage({ type: "open", id: "音楽" });
    assert.equal(shown.options.preserveFocus, true);
    inputs.push("音楽");
    await sidebarMessage({ type: "command", id: "音楽", command: "rename" });
    assert.equal(
      await fs.readFile(path.join(temp, ".fnote/音楽/index.md"), "utf8"),
      outlineText,
    );
    const dirty = {
      uri: uri(path.join(temp, ".fnote/音楽/index.md")),
      getText: () => "# 編集中のタイトル\n## 子の見出し",
    };
    documents.push(dirty);
    await run("refresh");
    assert.match(
      noteRows.find((row) => row.id === "音楽").label,
      /編集中のタイトル$/,
    );
    assert.equal(
      noteRows.find((row) => row.noteId === "音楽").label,
      "子の見出し",
    );
    documents.pop();
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/index.md"),
      "# 変更後\r\n## 子はそのまま\r\n本文",
    );
    await run("refresh");
    assert.match(noteRows.find((row) => row.id === "音楽").label, /変更後$/);
    inputs.push("音楽");
    await sidebarMessage({ type: "command", id: "音楽", command: "rename" });
    assert.equal(
      await fs.readFile(path.join(temp, ".fnote/音楽/index.md"), "utf8"),
      "# 音楽\r\n## 子はそのまま\r\n本文",
    );
    settings.set("tagStyles", [
      { tag: "TODO", mark: "🔴" },
      { tag: "DONE", mark: "🟢" },
    ]);
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/index.md"),
      "# 音楽\n@DONE",
    );
    await run("refresh");
    assert.ok(noteRows.every((row) => !row.noteId));
    assert.equal(noteRows.find((row) => row.id === "音楽").label, "🟢 音楽");
    assert.equal(
      noteRows.find((row) => row.id === "音楽").collapsedLabel,
      "🔴 音楽",
    );
    settings.set("tagStyles", [
      { tag: "DONE", mark: "🟢" },
      { tag: "TODO", mark: "🔴" },
    ]);
    await run("refresh");
    assert.equal(
      noteRows.find((row) => row.id === "音楽").collapsedLabel,
      "🟢 音楽",
    );
    settings.set("tagStyles", [
      { tag: "TODO", mark: "$(check)", markColor: "#12AB34" },
    ]);
    settings.delete("defaultTagMark");
    await run("refresh");
    assert.equal(
      tagRows.find((row) => row.id === "TODO").appearance.mark,
      "$(check)",
    );
    assert.equal(
      tagRows.find((row) => row.id === "TODO").appearance.color,
      "#12AB34",
    );
    assert.equal(
      noteRows.find((row) => row.id === "音楽").collapsedAppearance.mark,
      "$(check)",
    );
    assert.equal(
      noteRows.find((row) => row.id === "音楽").collapsedAppearance.color,
      "#12AB34",
    );
    assert.equal(
      noteRows.find((row) => row.id === "音楽").appearance.mark,
      "$(circle-filled-compact)",
    );
    assert.match(
      noteRows.find((row) => row.id === "音楽").appearance.color,
      /^hsl\(/,
    );
    await run("filter", "TODO");
    assert.match(html, /class="codicon codicon-check note-icon-\d+"/);
    assert.match(html, /\.note-icon-\d+\{color:#12AB34\}/);
    assert.match(html, /font-src https:\/\/webview.test/);
    assert.match(html, /media\/codicons\/codicon.css/);
    settings.set("tagHierarchy", { 状態: ["TODO"] });
    settings.set("tagStyles", [
      { tag: "状態", mark: "$(flag)", markColor: "#AB1234" },
      { tag: "TODO", color: "#FFFFFF" },
    ]);
    await run("refresh");
    assert.equal(
      tagRows.find((row) => row.id === "TODO").label,
      "$(flag) TODO",
    );
    assert.equal(
      tagRows.find((row) => row.id === "TODO").appearance.color,
      "#AB1234",
    );
    assert.equal(
      noteRows.find((row) => row.id === "音楽").collapsedAppearance.mark,
      "$(flag)",
    );
    assert.match(html, /class="codicon codicon-flag note-icon-\d+"/);
    settings.delete("tagHierarchy");
    settings.set("defaultTagMark", "🏷️");

    settings.delete("tagStyles");
    await fs.writeFile(path.join(temp, ".fnote/音楽/index.md"), "# 音楽\n\n");
    inputs.push("A");
    await run("add");
    inputs.push("B");
    await run("add");
    await sidebarMessage({
      type: "drop",
      id: "B",
      target: "A",
      position: "before",
    });
    const rootIds = provider.getChildren().map((n) => n.id);
    assert.ok(rootIds.indexOf("B") < rootIds.indexOf("A"));
    await sidebarMessage({
      type: "drop",
      id: "A",
      target: "音楽",
      position: "inside",
    });
    await sidebarMessage({
      type: "drop",
      id: "B",
      target: "音楽/A",
      position: "before",
    });
    const childIds = provider.getChildren(parent).map((n) => n.id);
    assert.ok(childIds.indexOf("音楽/B") < childIds.indexOf("音楽/A"));
    assert.equal(
      await fs.readFile(path.join(temp, ".fnote/音楽/B/index.md"), "utf8"),
      "# B\n\n",
    );
    await sidebarMessage({
      type: "drop",
      id: "音楽",
      target: "音楽/B",
      position: "before",
    });
    assert.match(errors.pop(), /descendants/);
    await sidebarMessage({ type: "drop", id: "音楽/B", position: "inside" });
    assert.equal(provider.getChildren().at(-1).id, "B");
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(temp, ".fnote/.status"), "utf8")).order,
      ["音楽", "B"],
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(temp, ".fnote/音楽/.status"), "utf8")).order,
      ["曲", "A"],
    );
    await run(
      "delete",
      provider.getChildren().find((n) => n.id === "B"),
    );
    await run(
      "delete",
      provider.getChildren(parent).find((n) => n.id === "音楽/A"),
    );
    // The note name and its initial H1 share one title row (reported WAIT case).
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/曲/index.md"),
      "# 曲\n@WAIT 待つ\n## 内訳\n@WAIT 続き @2026/09/13 @10m",
    );
    await run("refresh");
    await run("filter", "WAIT");
    assert.equal((html.match(/曲<\/button>/g) || []).length, 1);
    assert.match(
      html,
      /class="content"><span class="tag-color-\d+">@WAIT<\/span> 待つ/,
    );
    assert.match(html, /内訳<\/button>/);
    await run("filter", "2026/09/13");
    assert.equal((html.match(/曲<\/button>/g) || []).length, 1);
    assert.match(html, /曲<\/button><span class="work-time">\(10m\)<\/span>/);
    assert.match(html, /内訳<\/button><span class="work-time">\(10m\)<\/span>/);

    // Reproduce headings within one Markdown file, not separate note folders.
    const body =
      "# タイトル1\n## タイトル1-1\n### タイトル1-1-1\n@TODO あれ\n## 対象外\n本文";
    await fs.writeFile(path.join(temp, ".fnote/音楽/曲/index.md"), body);
    await run("refresh");
    await run("filter", "TODO");
    assert.match(
      html,
      /タイトル1<\/button><ul><li><button[^>]*>タイトル1-1<\/button><ul><li><button[^>]*class="match">タイトル1-1-1<\/button>/,
    );
    assert.doesNotMatch(html, /対象外/);
    assert.match(
      html,
      /class="content"><span class="tag-color-\d+">@TODO<\/span> あれ<\/button>/,
    );
    await receiveMessage({ id: child.id, offset: body.indexOf("@TODO") });
    assert.equal(shown.options.selection.start.offset, body.indexOf("@TODO"));

    const offset = body.indexOf("###");
    await receiveMessage({ id: child.id, offset });
    assert.equal(
      shown.doc.uri.fsPath,
      path.join(temp, ".fnote/音楽/曲/index.md"),
    );
    assert.equal(shown.options.selection.start.offset, offset);
    const lastShown = shown;
    await receiveMessage({ id: child.id, offset: -1 });
    assert.equal(shown, lastShown);
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/曲/index.md"),
      '@TODO <script>alert("x")</script>',
    );
    await run("refresh");
    assert.match(
      html,
      /class="content"><span class="tag-color-\d+">@TODO<\/span> &lt;script&gt;alert/,
    );
    assert.doesNotMatch(html, /<script>alert/);
    inputs.push("ALERT");
    await run("search");
    assert.match(html, /Search: ALERT/);
    assert.match(html, /data-id="音楽" class="ancestor"/);
    assert.match(
      html,
      /class="content"><span class="tag-color-\d+">@TODO<\/span> &lt;script&gt;alert/,
    );
    await receiveMessage({ id: child.id, offset: 0 });
    assert.equal(shown.options.selection.start.offset, 0);
    settings.set("tokenColorCustomizations", {
      textMateRules: [{
        scope: "markup.underline.link.markdown, punctuation.definition.metadata.markdown",
        settings: { foreground: "#85C1E9" },
      }],
    });
    await fs.writeFile(path.join(temp, ".fnote/音楽/曲/index.md"), "@TODO https://example.com/@user");
    await run("refresh");
    await run("filter", "TODO");
    assert.match(html, /\.url\{color:#85C1E9\}/);
    assert.match(html, /<span class="url"><i class="codicon codicon-link-external" aria-hidden="true"><\/i> https:\/\/example.com\/@user<\/span>/);
    settings.delete("tokenColorCustomizations");
    configurationChanged({ affectsConfiguration: (key) => key === "editor.tokenColorCustomizations" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.match(html, /\.url\{color:var\(--vscode-textLink-foreground\)\}/);
    await fs.writeFile(path.join(temp, ".fnote/音楽/曲/index.md"), '@TODO [](http://www.yahoo.co.jp) <http://www.yahoo.co.jp> [[TRIP]] [名前](https://example.com)');
    await run("refresh");
    assert.equal((html.match(/class="codicon codicon-link-external"/g) ?? []).length, 4);
    assert.match(html, /<\/i> TRIP<\/span>/);
    assert.doesNotMatch(html, /\[\[TRIP\]\]|\[名前\]/);
    assert.match(html, /<\/i> 名前<\/span>/);
    const beforeCancel = html;
    await run("search");
    assert.equal(html, beforeCancel);
    inputs.push("   ");
    await run("search");
    assert.equal(html, beforeCancel);
    inputs.push("一致しない単語");
    await run("search");
    assert.match(html, /<p>0 notes<\/p>/);
    assert.match(html, /No matching notes/);
    inputs.push("曲");
    await run("search");
    assert.match(html, /<p>1 note<\/p>/);
    await run("filter", "TODO");
    assert.match(html, /<h1><span class="tag-color-\d+">@TODO<\/span><\/h1>/);

    // A tagged heading is shown once, while its time still contributes to ancestors.
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/曲/index.md"),
      "# 作業\n## 詳細 @2026/09/13 @10m\n本文 @2026/09/13 @20m",
    );
    await run("refresh");
    await run("filter", "2026/09/13");
    assert.equal((html.match(/詳細/g) || []).length, 1);
    assert.doesNotMatch(html, /class="content">##/);
    assert.match(html, /class="content">本文/);
    assert.match(html, /作業<\/button><span class="work-time">\(30m\)<\/span>/);
    assert.match(
      html,
      /@10m<\/span><\/button><span class="work-time">\(30m\)<\/span>/,
    );
    await run("filter", "TODO");

    settings.set("tagStyles", [
      { tag: "TODO", color: "#FF4444" },
      { tag: "2026", color: "#80CBC4" },
    ]);
    settings.set("tagColor", "#00BFFF");
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/曲/index.md"),
      "# @TODO 見出し\n- @TODO 本文 @2026/09/12 @OTHER\n```\n@TODO コード\n```",
    );
    await run("refresh");
    assert.match(html, /\.tag-color-\d+\{color:#FF4444\}/);
    assert.match(html, /\.tag-color-\d+\{color:#80CBC4\}/);
    assert.match(html, /\.tag-color-\d+\{color:#00BFFF\}/);
    assert.match(html, /<span class="tag-color-\d+">@TODO<\/span> 見出し/);
    inputs.push("@TODO");
    await run("search");
    assert.match(html, /class="content">@TODO コード<\/button>/);
    assert.match(
      html,
      /class="content">- <span class="tag-color-\d+">@TODO<\/span> 本文/,
    );

    settings.set("tagStyles", [
      { tag: "TODO", color: "#FFFFFF", backgroundColor: "#402020" },
      { tag: "2026", color: "#FFFFFF", backgroundColor: "" },
    ]);
    settings.set("tagBackgroundColor", "#123456");
    const editorText = "@TODO @2026/09/12 @OTHER [](https://example.com) <https://example.org> [[TRIP]] [旅行予定](旅行)";
    api.window.visibleTextEditors = [
      {
        document: {
          uri: uri(path.join(temp, ".fnote/音楽/曲/index.md")),
          getText: () => editorText,
          positionAt: (offset) => ({ offset }),
        },
        selections: [],
        setDecorations: (decoration, ranges) =>
          editorStyles.push({ ...decoration.options, ranges }),
      },
    ];
    await run("refresh");
    assert.match(html, /color:#FFFFFF;background-color:#402020/);
    assert.match(html, /color:#FFFFFF\}/);
    assert.match(html, /background-color:#123456/);
    assert.ok(
      editorStyles.some(
        (style) =>
          style.color === "#FFFFFF" && style.backgroundColor === "#402020",
      ),
    );
    assert.ok(
      editorStyles.some(
        (style) =>
          style.color === "#FFFFFF" && style.backgroundColor === undefined,
      ),
    );
    assert.ok(
      editorStyles.some((style) => style.backgroundColor === "#123456"),
    );
    const iconStyle = editorStyles.find(style => style.before?.textDecoration?.includes("mask:"));
    assert.equal(iconStyle.ranges.length, 4);
    assert.deepEqual(iconStyle.ranges.map(range => editorText.slice(range.start.offset, range.end.offset)), ["https://example.com", "https://example.org", "TRIP", "旅行予定"]);
    editorStyles.length = 0;
    api.window.visibleTextEditors[0].selections = [{ start: { offset: editorText.indexOf("TRIP") }, end: { offset: editorText.indexOf("TRIP") } }];
    selectionChanged();
    assert.equal(editorStyles.find(style => style.before?.textDecoration?.includes("mask:")).ranges.length, 3);
    await fs.writeFile(path.join(temp, '.fnote/音楽/曲/index.md'), '@TODO [](https://example.com)');
    for (const mark of ['$(globe)', '🔗', '', '$(unknown-fnote-icon)', '<b>']) {
      settings.set('linkMark', mark);
      editorStyles.length = 0;
      configurationChanged({ affectsConfiguration: key => key === 'fnote' });
      await new Promise(resolve => setTimeout(resolve, 250));
      const attachment = editorStyles.find(style => style.before)?.before;
      if (mark === '') {
        assert.equal(attachment, undefined);
        assert.doesNotMatch(html, /codicon-link-external/);
      } else if (mark.startsWith('$(')) {
        assert.match(attachment.textDecoration, /mask:url\("data:image\/svg\+xml;base64,/);
        assert.match(attachment.textDecoration, /vertical-align:-0.35em/);
        assert.equal(attachment.color.id, 'textLink.foreground');
        assert.match(html, new RegExp(`codicon-${mark === '$(globe)' ? 'globe' : 'link-external'}`));
      } else {
        assert.equal(attachment.contentText, mark);
        assert.ok(html.includes(mark === '<b>' ? '&lt;b&gt;' : mark));
      }
    }
    settings.set('linkMark', '$(link-external)');
    settings.set('tokenColorCustomizations', { textMateRules: [{ scope: 'markup.underline.link.markdown', settings: { foreground: '#dc9977' } }] });
    editorStyles.length = 0;
    await run('refresh');
    const coloredLink = editorStyles.find(style => style.before?.textDecoration?.includes('mask:'));
    assert.equal(coloredLink.color, '#dc9977');
    assert.equal(coloredLink.before.color, coloredLink.color);
    assert.match(coloredLink.before.textDecoration, /background-color:currentColor/);
    assert.match(html, /\.url\{color:#dc9977\}/);
    settings.delete('tokenColorCustomizations');
    settings.delete('linkMark');
    api.window.visibleTextEditors = [];
    settings.delete("tagBackgroundColor");
    settings.delete("tagStyles");
    settings.delete("tagColor");
    const incompleteTag = 'Incomplete time tags';
    const logPath = path.join(temp, '.fnote/音楽/曲/index.md');
    await fs.writeFile(logPath, '# Work\n## Active\n@2026/09/26 @10:00- Editing\n@10:00 Another task\n## Finished\n@10:00-11:00 Done');
    for (const mark of ['$(clock)', '⏳']) {
      settings.set('tagStyles', [{ tag: incompleteTag, mark, color: '#FFAA00', markColor: '#ABCDEF' }]);
      await run('refresh');
      const row = tagRows.find(row => row.id === incompleteTag);
      assert.ok(row.label.includes(incompleteTag));
      assert.equal(row.description, '1');
      assert.deepEqual(row.appearance, { mark, color: '#ABCDEF' });
      assert.ok(!tagRows.some(row => row.id === '10'));
      await tagMessage({ type: 'open', id: incompleteTag });
      assert.match(html, /<h1><span class="tag-color-\d+">Incomplete time tags<\/span><\/h1>/);
      assert.match(html, /1 note/);
      assert.match(html, /@10:00-<\/span> Editing/);
      assert.match(html, /@10:00<\/span> Another task/);
      assert.match(html, /color:#FFAA00/);
      assert.doesNotMatch(html, /Finished<\/button>/);
      await receiveMessage({ id: '音楽/曲', offset: '# Work\n## Active\n'.length });
      assert.equal(shown.doc.uri.fsPath, logPath);
      assert.equal(shown.options.selection.start.offset, '# Work\n## Active\n'.length);
    }
    // Unsaved editor contents take priority over the unfinished log on disk.
    const completedDocument = { uri: uri(logPath), getText: () => '@2026/09/26 @10:00-11:00' };
    documents.push(completedDocument);
    await run('refresh');
    assert.ok(!tagRows.some(row => row.id === incompleteTag));
    assert.match(html, /No matching notes/);
    documents.splice(documents.indexOf(completedDocument), 1);
    settings.delete('tagStyles');
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/曲/index.md"),
      "# 作業\n## 詳細\n@2026/09/13 @10:30-12:00 @10m\n@2026/09/13 @1h @TODO\n@2026/09/14 @8h",
    );
    await run("refresh");
    await run("filter", "2026/09/13");
    assert.match(
      html,
      /詳細<\/button><span class="work-time">\(2h40m\)<\/span>/,
    );
    for (const title of ["作業", "音楽"]) {
      assert.ok(
        html.includes(
          `${title}</button><span class="work-time">(2h40m)</span>`,
        ),
      );
    }
    assert.equal((html.match(/class="work-time"/g) || []).length, 4);
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/index.md"),
      "@2026/09/13 @20m",
    );
    await fs.appendFile(
      path.join(temp, ".fnote/音楽/曲/index.md"),
      "\n## 別作業\n@2026/09/13 @20m",
    );
    await run("refresh");
    assert.match(html, /作業<\/button><span class="work-time">\(3h\)<\/span>/);
    assert.match(html, /data-id="音楽\/曲" class="match">[^<]*作業<\/button>/);
    assert.match(
      html,
      /音楽<\/button><span class="work-time">\(3h20m\)<\/span>/,
    );
    assert.match(
      html,
      /<h1>.*@2026\/09\/13<\/span><span class="work-time">\(3h20m\)<\/span><\/h1>/,
    );
    inputs.push("別ノート");
    await run("add");
    await fs.writeFile(
      path.join(temp, ".fnote/別ノート/index.md"),
      "@2026/09/13 @40m",
    );
    await run("refresh");
    assert.match(html, /<h1>.*<span class="work-time">\(4h\)<\/span><\/h1>/);
    await fs.mkdir(path.join(temp, ".fnote/早い"), { recursive: true });
    await fs.mkdir(path.join(temp, ".fnote/遅い"), { recursive: true });
    await fs.writeFile(path.join(temp, ".fnote/早い/index.md"), "# 早い\n@2026/02/13 @08:30-09:00\n@2026/09/02 @08:30-09:00\n@2026/09/13 @08:30-09:00");
    await fs.writeFile(path.join(temp, ".fnote/遅い/index.md"), "# 遅い\n@2026/11/13 @18:00-19:00\n@2026/09/25 @18:00-19:00\n@2026/09/13 @18:00-19:00");
    await run("refresh");
    settings.set("dateTagSort", "time");
    await run("filter", "2026/09/13");
    assert.ok(html.indexOf('data-id="早い"') < html.indexOf('data-id="遅い"'));
    assert.ok(html.indexOf('data-id="音楽"') < html.indexOf('data-id="遅い"'));
    settings.set("dateTagSort", "date");
    await run("filter", "2026");
    assert.ok(html.indexOf('data-id="早い"') < html.indexOf('data-id="遅い"'));
    assert.deepEqual([...html.matchAll(/<h2>(2026\/\d{2}\/\d{2})<\/h2>/g)].map(match => match[1]), ["2026/02/13", "2026/09/02", "2026/09/13", "2026/09/14", "2026/09/25", "2026/11/13"]);
    assert.equal((html.match(/data-id="早い" class="match"/g) || []).length, 3);
    assert.equal((html.match(/data-id="遅い" class="match"/g) || []).length, 3);
    await fs.writeFile(path.join(temp, ".fnote/早い/index.md"), "# 早い\n## 子見出し\n### 詳細\n@2030/10/08 @13:00-14:00\n@2030/10/08 @11:00-12:00");
    await fs.writeFile(path.join(temp, ".fnote/遅い/index.md"), "# 遅い\n- @TODO @2030/10/08 @12:00-13:00");
    await run("refresh");
    await run("filter", "2030/10/08");
    const timelineRows = [...html.matchAll(/<li class="timeline-row">(.*?)<\/li>/g)].map(match => match[1]);
    assert.equal(timelineRows.length, 3);
    const entryText = /class="content">(.*?)<\/button>/.exec(timelineRows[1])[1].replace(/<[^>]*>/g, '');
    assert.equal(entryText, '@2030/10/08 @12:00-13:00 @TODO');
    for (const [index, time] of ["11:00-12:00", "12:00-13:00", "13:00-14:00"].entries()) {
      assert.ok(timelineRows[index].includes(time));
    }
    assert.match(timelineRows[0], /早い<\/button><span class="work-time">\(2h\)<\/span> \/ .*子見出し<\/button><span class="work-time">\(2h\)<\/span> \/ .*詳細<\/button><span class="work-time">\(2h\)<\/span>/);
    assert.ok(timelineRows[0].includes(`data-offset="${"# 早い\n## 子見出し\n### 詳細\n@2030/10/08 @13:00-14:00\n".length}" class="content"`));
    await fs.writeFile(path.join(temp, ".fnote/早い/index.md"), "# 早い\n@2026/09/02 @08:30-09:00");
    await fs.writeFile(path.join(temp, ".fnote/遅い/index.md"), "# 遅い\n@2026/09/25 @18:00-19:00");
    await run("refresh");
    await run("filter", "2026/09");
    assert.ok(html.indexOf('data-id="早い"') < html.indexOf('data-id="遅い"'));
    assert.match(html, /data-sort-mode="time">Sort: Time<\/button>/);
    await receiveMessage({ type: "toggleDateTagSort" });
    assert.match(html, /data-sort-mode="note">Sort: Notes<\/button>/);
    await receiveMessage({ type: "toggleDateTagSort" });
    assert.match(html, /data-sort-mode="time">Sort: Time<\/button>/);
    settings.delete("dateTagSort");
    configurationChanged({ affectsConfiguration: key => key === "fnote.dateTagSort" });
    await fs.rm(path.join(temp, ".fnote/早い"), { recursive: true });
    await fs.rm(path.join(temp, ".fnote/遅い"), { recursive: true });
    await run("refresh");
    await run("filter", "2026/09/14");
    assert.match(html, /<h1>.*<span class="work-time">\(8h\)<\/span><\/h1>/);
    await run("filter", "2026/09/15");
    assert.doesNotMatch(html, /class="work-time"/);
    await run(
      "delete",
      provider.getChildren().find((note) => note.id === "別ノート"),
    );

    await fs.writeFile(path.join(temp, ".fnote/音楽/index.md"), "");
    await run("filter", "TODO");
    assert.doesNotMatch(html, /class="work-time"/);
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/曲/index.md"),
      "@2026/09/13 @10m @TODO\n[音楽](../)\n[資料](../資料.txt)",
    );
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/index.md"),
      "# 音楽\n[曲](曲/)\n",
    );
    await run("refresh");
    await run("filter", "2026/09/13");
    assert.match(html, /曲<\/button><span class="work-time">\(10m\)<\/span>/);
    // A tag on a grandchild must keep every ancestor and the matching leaf.
    inputs.push("詳細");
    await run("addChild", child);
    await fs.writeFile(
      path.join(temp, ".fnote/音楽/曲/詳細/index.md"),
      "@深いタグ",
    );
    await run("refresh");
    await run("filter", "深いタグ");
    assert.match(html, /data-id="音楽" class="ancestor"/);
    assert.match(html, /data-id="音楽\/曲" class="ancestor"/);
    assert.match(html, /data-id="音楽\/曲\/詳細" class="match"/);
    assert.match(html, /<p>1 note<\/p>/);
    const grandchild = provider.getChildren(child)[0];
    await run("delete", grandchild);
    picks.push({ id: child.id });
    await run("move", parent);
    assert.match(errors.pop(), /descendants/);
    picks.push({ id: "" });
    await run("move", child);
    assert.equal(provider.getChildren().length, 2);
    assert.match(
      await fs.readFile(path.join(temp, ".fnote/音楽/index.md"), "utf8"),
      /\[曲\]\(\.\.\/曲\/\)/,
    );
    assert.match(
      await fs.readFile(path.join(temp, ".fnote/曲/index.md"), "utf8"),
      /\[音楽\]\(\.\.\/音楽\/\)/,
    );
    assert.match(
      await fs.readFile(path.join(temp, ".fnote/曲/index.md"), "utf8"),
      /\[資料\]\(\.\.\/音楽\/資料\.txt\)/,
    );
    child = provider.getChildren().find((n) => n.id === "曲");
    inputs.push("音楽");
    await run("rename", child);
    assert.match(errors.pop(), /same name/);
    inputs.push("新しい曲");
    await run("rename", child);
    const renamed = provider.getChildren().find((n) => n.name === "新しい曲");
    assert.match(
      await fs.readFile(path.join(temp, ".fnote/新しい曲/index.md"), "utf8"),
      /@TODO/,
    );
    assert.match(
      await fs.readFile(path.join(temp, ".fnote/新しい曲/index.md"), "utf8"),
      /\[音楽\]\(\.\.\/音楽\/\)/,
    );
    await run("delete", renamed);
    assert.equal(provider.getChildren().length, 1);
    assert.equal(errors.length, 0);
    // Closing all notes also disposes tag/search results and allows reopening them.
    const panelsBeforeClose = panelCount;
    api.window.tabGroups.all = [
      { tabs: [noteTab, unrelatedTab, unrelatedWebviewTab] },
    ];
    closeResult = false;
    await run("closeAllNotes");
    assert.equal(
      panelDisposeCount,
      0,
      "本文を閉じる操作のキャンセル時は結果画面も維持する",
    );
    closeResult = true;
    await run("closeAllNotes");
    assert.equal(panelDisposeCount, 1, "タグ一覧から開いた画面も閉じる");
    await run("filter", "TODO");
    assert.equal(
      panelCount,
      panelsBeforeClose + 1,
      "閉じた後は結果画面を作り直す",
    );
    inputs.push("音楽");
    await run("search");
    assert.match(html, /Search: 音楽/);
    api.window.tabGroups.all = [{ tabs: [unrelatedTab, unrelatedWebviewTab] }];
    const closesBeforeResultsOnly = closeCalls.length;
    await run("closeAllNotes");
    assert.equal(
      panelDisposeCount,
      2,
      "本文タブがなくても検索結果画面を閉じる",
    );
    assert.equal(
      closeCalls.length,
      closesBeforeResultsOnly,
      "無関係なタブは閉じない",
    );
    await run("closeAllNotes");
    assert.equal(
      panelDisposeCount,
      2,
      "繰り返しても破棄済みの画面には触れない",
    );
    // Opening another workspace still reads the same global notes.
    for (const subscription of context.subscriptions) subscription.dispose();
    context.subscriptions.length = 0;
    api.workspace.workspaceFolders = [
      { uri: uri(path.join(temp, "another-workspace")) },
    ];
    await activate(context);
    assert.deepEqual(
      views
        .get("fnote.notes")
        .treeDataProvider.getChildren()
        .map((n) => n.name),
      ["音楽"],
    );
    for (const subscription of context.subscriptions) subscription.dispose();
    context.subscriptions.length = 0;
    const workspaceRoot = path.join(temp, "workspace-root");
    api.workspace.workspaceFolders = [{ uri: uri(workspaceRoot) }];
    settings.set("storagePath", "${workspace}/.fnote");
    await activate(context);
    assert.equal(
      views.get("fnote.notes").treeDataProvider.getChildren().length,
      0,
      "workspace storage starts empty",
    );
    inputs.push("ワークスペースノート");
    await run("add");
    assert.equal(
      await fs.readFile(path.join(workspaceRoot, ".fnote/ワークスペースノート/index.md"), "utf8"),
      "# ワークスペースノート\n\n",
    );
    for (const subscription of context.subscriptions) subscription.dispose();
    context.subscriptions.length = 0;
    // A user-specified absolute directory is independent of the workspace, too.
    const custom = path.join(temp, "custom-notes");
    settings.set("storagePath", custom);
    await activate(context);
    assert.equal(
      views.get("fnote.notes").treeDataProvider.getChildren().length,
      0,
    );
    inputs.push("共通ノート");
    await run("add");
    assert.equal(
      await fs.readFile(path.join(custom, "共通ノート/index.md"), "utf8"),
      "# 共通ノート\n\n",
    );
    for (const subscription of context.subscriptions) subscription.dispose();
    context.subscriptions.length = 0;
    api.workspace.workspaceFolders = undefined;
    await activate(context);
    assert.deepEqual(
      views
        .get("fnote.notes")
        .treeDataProvider.getChildren()
        .map((n) => n.name),
      ["共通ノート"],
    );
    assert.equal(errors.length, 0);
  } finally {
    Module._load = original;
    for (const subscription of context.subscriptions) subscription.dispose();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
