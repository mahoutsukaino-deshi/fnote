import * as vscode from 'vscode';
import { NotesView } from './notesView';
import type { DropPosition } from './notesView';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { parseHeadings, parseUrls, parseTags, formatWorkMinutes, minutesForDate, planNoteDrop, renderTagText, searchNotes, styleFor, noteMark, tagTree, matchesTag, within, filterTree, matchingHeadings, matchingLines, validateName, escapeHtml as h } from './core';
import type { Note, TagNode, TagHierarchy, TagStyles, HeadingMatch, ContentMatch } from './core';

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'FileNotFound';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = () => vscode.workspace.getConfiguration('fnote');
  const setting = config().inspect<string>('storagePath')?.globalValue ?? '~/.fnote';
  const storagePath = setting === '~' ? os.homedir() : setting.startsWith('~/') ? path.join(os.homedir(), setting.slice(2)) : setting;
  if (storagePath && !path.isAbsolute(storagePath)) {
    void vscode.window.showErrorMessage('fnote.storagePath はユーザー設定で絶対パス（または ~/ から始まるパス）を指定してください。空文字の場合は共通の個人保存領域を使用します。');
    return;
  }
  const root = storagePath ? vscode.Uri.file(storagePath) : vscode.Uri.joinPath(context.globalStorageUri, 'notes');
  const uri = (id: string) => vscode.Uri.joinPath(root, ...id.split('/').filter(Boolean));
  const file = (id: string) => vscode.Uri.joinPath(uri(id), 'index.md');
  let notes: Note[] = [];
  let panel: vscode.WebviewPanel | undefined;
  let activeTag: string | undefined;
  let activeQuery: string | undefined;
  let decorations: vscode.TextEditorDecorationType[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let order = context.globalState.get<string[]>(`order:${root.toString()}`, []);
  let tagOrder = context.globalState.get<string[]>(`tagOrder:${root.toString()}`, []);
  const events = new vscode.EventEmitter<void>();
  const tagEvents = new vscode.EventEmitter<void>();
  const guard = <Args extends unknown[], Result>(fn: (...args: Args) => Result) => async (...args: Args): Promise<Awaited<Result> | undefined> => {
    try { return await fn(...args); }
    catch (error) { void vscode.window.showErrorMessage(`fnote: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const marks = (n: Note) => noteMark(n.tags, config().get<TagStyles>('tagStyles', {}), config().get<string>('untaggedNoteMark', '🗒️'), config().get<string>('defaultTagMark', '🏷️'), config().get<TagHierarchy>('tagHierarchy', {}));
  const children = (parent?: Note) => notes.filter(n => n.parent === (parent?.id || ''));
  const provider: vscode.TreeDataProvider<Note> = {
    onDidChangeTreeData: events.event,
    getChildren: children,
    getParent: n => notes.find(p => p.id === n.parent),
    getTreeItem: n => {
      const item = new vscode.TreeItem(`${marks(n)}${marks(n) ? ' ' : ''}${n.name}`, children(n).length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.id = n.id; item.contextValue = 'note'; item.tooltip = n.id;
      item.command = { command: 'fnote.open', title: '開く', arguments: [n.id] };
      return item;
    }
  };
  let dropQueue = Promise.resolve();
  const tree = new NotesView(provider, context.extensionUri, (id, target, position) => {
    const operation = dropQueue.catch(() => {}).then(() => dropNote(id, target, position));
    dropQueue = operation;
    return operation;
  }, false, note => {
    const mark = marks({ ...note, tags: notes.filter(child => within(child.id, note.id)).flatMap(child => child.tags) });
    return `${mark ? `${mark} ` : ''}${note.name}`;
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('fnote.notes', tree));
  const hierarchy = () => config().get<TagHierarchy>('tagHierarchy', {});
  const sortedTags = (nodes: Iterable<TagNode>) => [...nodes].sort((a, b) => {
    const ai = tagOrder.indexOf(a.tag), bi = tagOrder.indexOf(b.tag);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi)
      || a.label.localeCompare(b.label, 'ja', { numeric: true });
  });
  let tagDropQueue = Promise.resolve();
  const tagProvider: vscode.TreeDataProvider<TagNode> = {
    onDidChangeTreeData: tagEvents.event,
    getChildren: n => sortedTags((n?.children || tagTree(notes, hierarchy())).values()),
    getTreeItem: n => {
      const mark = styleFor(n.tag, config().get<TagStyles>('tagStyles', {})).mark?.trim() || config().get<string>('defaultTagMark', '🏷️');
      const item = new vscode.TreeItem(`${mark ? `${mark} ` : ''}${n.label}`, n.children.size ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = n.tag; item.tooltip = `@${n.tag}`;
      item.description = String(notes.filter(note => matchesTag(note, n.tag, hierarchy())).length);
      item.command = { command: 'fnote.filter', title: 'タグで検索', arguments: [n.tag] };
      return item;
    }
  };
  const tags = new NotesView({
    getChildren: () => [],
    getTreeItem: note => {
      const item = new vscode.TreeItem(note.name);
      item.description = String(notes.filter(n => matchesTag(n, note.id, hierarchy())).length);
      return item;
    }
  }, context.extensionUri, async (id, target, position) => {
    const operation = tagDropQueue.catch(() => {}).then(async () => {
      const rows = await tagRows();
      const tagParent = (key: string) => rows.find(row => row.id === key)?.parent;
      const parent = tagParent(id);
      if (target === id || (target !== undefined && tagParent(target) !== parent)) return;
      if (target !== undefined && position === 'inside') return;
      const siblings = rows.filter(row => row.parent === parent).map(row => row.id);
      if (!siblings.includes(id) || (target !== undefined && !siblings.includes(target))) return;
      const remaining = siblings.filter(key => key !== id);
      remaining.splice(target === undefined ? remaining.length : remaining.indexOf(target) + (position === 'after' ? 1 : 0), 0, id);
      const next = [...tagOrder.filter(key => tagParent(key) !== parent), ...remaining];
      await context.globalState.update(`tagOrder:${root.toString()}`, next);
      tagOrder = next;
      await tags.update(await tagRows());
    });
    tagDropQueue = operation;
    await operation;
  }, true);
  async function tagRows(): Promise<Note[]> {
    const rows: Note[] = [];
    async function visit(nodes: Iterable<TagNode>, parent: string): Promise<void> {
      for (const node of sortedTags(nodes)) {
        const item = await tagProvider.getTreeItem(node);
        rows.push({ id: node.tag, parent, name: String(item.label), text: '', tags: [] });
        await visit(node.children.values(), node.tag);
      }
    }
    await visit(tagTree(notes, hierarchy()).values(), '');
    return rows;
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('fnote.tags', tags));
  async function scan() {
    const found: Note[] = [];
    async function walk(id: string, parent: string): Promise<void> {
      let entries;
      try { entries = await vscode.workspace.fs.readDirectory(uri(id)); }
      catch (error) { if (isMissing(error)) return; throw error; }
      if (id) {
        let text = '';
        if (entries.some(([name, type]) => name === 'index.md' && type === vscode.FileType.File)) {
          const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === file(id).toString());
          text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(file(id))).toString('utf8');
        }
        found.push({ id, parent, name: parseHeadings(text).find(heading => heading.level === 1)?.title ?? path.posix.basename(id), text, tags: parseTags(text) });
      }
      for (const [name, type] of entries) if (type === vscode.FileType.Directory && !name.startsWith('.')) await walk(id ? `${id}/${name}` : name, id);
    }
    await walk('', '');
    if (disposed) return;
    notes = found.sort((a, b) => {
      const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.id.localeCompare(b.id, 'ja', { numeric: true });
    });
    events.fire(); tagEvents.fire(); await tree.update(notes); await tags.update(await tagRows()); decorate(); renderResults();
  }
  let refreshQueue = Promise.resolve();
  function refresh() { refreshQueue = refreshQueue.catch(() => {}).then(scan); return refreshQueue; }
  function schedule() { clearTimeout(timer); timer = setTimeout(guard(refresh), 180); }
  function decorate() {
    for (const decoration of decorations) decoration.dispose();
    decorations = [];
    const styles = config().get<TagStyles>('tagStyles', {});
    for (const editor of vscode.window.visibleTextEditors) {
      if (!notes.some(n => file(n.id).toString() === editor.document.uri.toString())) continue;
      const groups = new Map<string, { color: string; backgroundColor: string; ranges: vscode.Range[] }>();
      for (const tag of parseTags(editor.document.getText())) {
        const style = styleFor(tag.tag, styles);
        const color = style.color || config().get<string>('tagColor', '#00BFFF');
        const backgroundColor = style.backgroundColor ?? config().get<string>('tagBackgroundColor', '');
        const key = JSON.stringify([color, backgroundColor]);
        if (!groups.has(key)) groups.set(key, { color, backgroundColor, ranges: [] });
        groups.get(key)!.ranges.push(new vscode.Range(editor.document.positionAt(tag.start), editor.document.positionAt(tag.end)));
      }
      const urlRanges = parseUrls(editor.document.getText()).map(url =>
        new vscode.Range(editor.document.positionAt(url.start), editor.document.positionAt(url.end)));
      if (urlRanges.length) {
        const decoration = vscode.window.createTextEditorDecorationType({ color: '#3794FF' });
        decorations.push(decoration); editor.setDecorations(decoration, urlRanges);
      }
      for (const { color, backgroundColor, ranges } of groups.values()) {
        const decoration = vscode.window.createTextEditorDecorationType({ color, backgroundColor: backgroundColor || undefined });
        decorations.push(decoration); editor.setDecorations(decoration, ranges);
      }
    }
  }
  async function open(id: string, offset?: number, preserveFocus = false) {
    if (!notes.some(n => n.id === id)) return;
    try { await vscode.workspace.fs.stat(file(id)); }
    catch (error) { if (!isMissing(error)) throw error; await vscode.workspace.fs.writeFile(file(id), Buffer.from('')); }
    const doc = await vscode.workspace.openTextDocument(file(id));
    const position = offset === undefined ? undefined : doc.positionAt(offset);
    await vscode.window.showTextDocument(doc, {
      preview: false, preserveFocus,
      ...(position ? { selection: new vscode.Range(position, position) } : {})
    });
    const note = notes.find(n => n.id === id);
    if (note) await tree.reveal(note);
  }
  const selected = (n?: Note) => n || tree.selection[0];
  async function add(parent = '') {
    const name = await vscode.window.showInputBox({ prompt: 'ノート名', validateInput: validateName });
    if (!name) return;
    const id = parent ? `${parent}/${name}` : name;
    await ensureAbsent(id);
    await vscode.workspace.fs.createDirectory(uri(id));
    await vscode.workspace.fs.writeFile(file(id), Buffer.from(`# ${name}\n\n`));
    await refresh(); await open(id);
  }
  async function ensureAbsent(id: string) {
    try { await vscode.workspace.fs.stat(uri(id)); } catch (error) { if (isMissing(error)) return; throw error; }
    throw new Error('同名のノートが存在します。');
  }
  async function relocate(id: string, destination: string, title?: string) {
    if (id === destination && title === undefined) return;
    if (id !== destination) await ensureAbsent(destination);
    const edit = new vscode.WorkspaceEdit();
    if (title !== undefined) {
      const doc = await vscode.workspace.openTextDocument(file(id));
      const text = doc.getText();
      const heading = parseHeadings(text).find(item => item.level === 1);
      const start = heading?.start ?? 0;
      const newline = text.indexOf('\n', start);
      const end = heading ? (newline < 0 ? text.length : newline) : 0;
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
        heading ? `# ${title}${text[end - 1] === '\r' ? '\r' : ''}` : `# ${title}${eol}${eol}`);
    }
    if (id !== destination) edit.renameFile(uri(id), uri(destination), { overwrite: false });
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('移動できませんでした。');
    order = order.map(entry => within(entry, id) ? destination + entry.slice(id.length) : entry);
    await context.globalState.update(`order:${root.toString()}`, order);
    await refresh();
  }
  async function move(id: string, parent: string) {
    if (!notes.some(n => n.id === id) || (parent && !notes.some(n => n.id === parent))) return;
    if (parent && within(parent, id)) throw new Error('自分自身や子ノートの下には移動できません。');
    await relocate(id, parent ? `${parent}/${path.posix.basename(id)}` : path.posix.basename(id));
  }
  async function dropNote(id: string, target: string | undefined, position: DropPosition): Promise<void> {
    const plan = planNoteDrop(notes, id, target, position);
    await relocate(id, plan.destination);
    order = plan.order;
    await context.globalState.update(`order:${root.toString()}`, order);
    await refresh();
    const moved = notes.find(note => note.id === plan.destination);
    if (moved) await tree.reveal(moved);
  }
  function renderResults() {
    if (!panel || (!activeTag && !activeQuery)) return;
    const tag = activeTag ?? '';
    const hits = activeQuery ? searchNotes(notes, activeQuery) : [];
    const hitMap = new Map(hits.map(hit => [hit.note.id, hit]));
    const subset = activeQuery
      ? notes.filter(note => hits.some(hit => within(hit.note.id, note.id)))
      : filterTree(notes, tag, hierarchy());
    const isMatch = (note: Note) => activeQuery ? hitMap.has(note.id) : matchesTag(note, tag, hierarchy());
    const title = activeQuery ? `検索: ${activeQuery}` : `@${tag}`;
    const count = activeQuery ? hits.length : notes.filter(isMatch).length;
    const tagClasses = new Map<string, string>();
    const styles = config().get<TagStyles>('tagStyles', {});
    // Only color-value characters are allowed inside the nonce-protected stylesheet.
    const safeColor = (value: string, fallback: string): string => /^[#a-zA-Z0-9(),.%\s+-]+$/.test(value) ? value : fallback;
    const classFor = (tag: string): string => {
      const style = styleFor(tag, styles);
      const color = safeColor(style.color || config().get<string>('tagColor', '#00BFFF'), '#00BFFF');
      const background = safeColor(style.backgroundColor ?? config().get<string>('tagBackgroundColor', ''), '');
      const declaration = `color:${color}${background ? `;background-color:${background}` : ''}`;
      if (!tagClasses.has(declaration)) tagClasses.set(declaration, `tag-color-${tagClasses.size}`);
      return tagClasses.get(declaration)!;
    };
    const fragment = (id: string, start: number, text: string): string => {
      const note = notes.find(note => note.id === id);
      if (!note) return h(text);
      // Use full-document tag ranges so snippets inside code remain uncolored.
      const endOfLine = note.text.indexOf('\n', start);
      const originalLine = note.text.slice(start, endOfLine < 0 ? note.text.length : endOfLine);
      const relative = originalLine.indexOf(text);
      if (relative < 0) return h(text);
      const offset = start + relative;
      const urls = parseUrls(note.text);
      const tokens = [...note.tags.filter(tag => !urls.some(url => tag.start < url.end && tag.end > url.start)),
        ...urls.map(url => ({ ...url, tag: ':url' }))].sort((a, b) => a.start - b.start);
      const ranges = tokens.filter(tag => tag.start >= offset && tag.end <= offset + text.length)
        .map(tag => ({ ...tag, start: tag.start - offset, end: tag.end - offset }));
      return renderTagText(text, ranges, tag => tag === ':url' ? 'url' : classFor(tag));
    };
    const contentBranch = (id: string, lines: ContentMatch[]): string => lines.length ? `<ul>${lines.map(line => `<li><button data-id="${h(id)}" data-offset="${line.start}" class="content">${fragment(id, line.start, line.text)}</button></li>`).join('')}</ul>` : '';
    const timeLabel = (minutes: number | undefined): string =>
      minutes === undefined ? '' : `<span class="work-time">(${formatWorkMinutes(minutes)})</span>`;
    const sumMinutes = (values: (number | undefined)[]): number | undefined =>
      values.reduce<number | undefined>((total, value) => value === undefined ? total : (total ?? 0) + value, undefined);
    const headingLines = (heading: HeadingMatch): ContentMatch[] =>
      [...heading.lines, ...heading.children.flatMap(headingLines)];
    const headingMinutes = (id: string, heading: HeadingMatch): number | undefined => {
      const note = notes.find(note => note.id === id);
      return activeQuery || !note ? undefined : minutesForDate(note.text, headingLines(heading), tag, note.tags);
    };
    const ownMinutes = new Map(subset.map(note => [note.id, activeQuery ? undefined
      : minutesForDate(note.text, matchingLines(note.text, tag, note.tags, hierarchy()), tag, note.tags)]));
    const noteMinutes = (id: string): number | undefined =>
      sumMinutes(subset.filter(note => within(note.id, id)).map(note => ownMinutes.get(note.id)));
    const headingBranch = (id: string, headings: HeadingMatch[]): string => headings.length ? `<ul>${headings.map(heading => `<li><button data-id="${h(id)}" data-offset="${heading.start}" class="${heading.matched ? 'match' : 'ancestor'}">${fragment(id, heading.start, heading.title)}</button>${timeLabel(headingMinutes(id, heading))}${contentBranch(id, heading.lines.filter(line => line.start !== heading.start))}${headingBranch(id, heading.children)}</li>`).join('')}</ul>` : '';
    const noteContent = (note: Note): string => {
      if (activeQuery) return contentBranch(note.id, hitMap.get(note.id)?.lines ?? []);
      const headings = matchingHeadings(note.text, tag, note.tags, hierarchy());
      const assigned = new Set<number>();
      const collect = (nodes: HeadingMatch[]): void => {
        for (const node of nodes) { node.lines.forEach(line => assigned.add(line.start)); collect(node.children); }
      };
      collect(headings);
      const preamble = matchingLines(note.text, tag, note.tags, hierarchy()).filter(line => !assigned.has(line.start));
      // The initial H1 often repeats the note name created by add(). Render its
      // contents directly under the note instead of adding another title row.
      const first = headings[0];
      const initialTitle = first && first.title === note.name
        && note.text.slice(0, first.start).trim() === ''
        && /^ {0,3}#[\t ]/.test(note.text.slice(first.start));
      if (initialTitle) {
        return contentBranch(note.id, preamble)
          + contentBranch(note.id, first.lines.filter(line => line.start !== first.start))
          + headingBranch(note.id, first.children)
          + headingBranch(note.id, headings.slice(1));
      }
      return contentBranch(note.id, preamble) + headingBranch(note.id, headings);
    };
    const noteTitle = (note: Note): string => {
      const title = parseHeadings(note.text).find(heading => heading.level === 1);
      return title ? fragment(note.id, title.start, note.name) : h(note.name);
    };
    const branch = (parent: string): string => `<ul>${subset.filter(n => n.parent === parent).map(n => `<li><button data-id="${h(n.id)}" class="${isMatch(n) ? 'match' : 'ancestor'}">${h(marks(n))} ${noteTitle(n)}</button>${timeLabel(noteMinutes(n.id))}${noteContent(n)}${branch(n.id)}</li>`).join('')}</ul>`;
    const body = subset.length ? branch('') : '<p>対象のノートはありません。</p>';
    const titleHtml = activeQuery ? h(title) : renderTagText(title, parseTags(title), classFor);
    const tagCss = [...tagClasses].map(([declaration, name]) => `.${name}{${declaration}}`).join('');
    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);padding:12px;line-height:1.35}h1{font-size:1.3em;margin:0 0 6px}p{margin:0 0 8px}ul{list-style:none;margin:0;padding-left:18px;border-left:1px solid var(--vscode-tree-indentGuidesStroke)}li{margin:0}ul:empty{display:none}button{font:inherit;text-align:left;color:inherit;background:transparent;border:0;padding:1px 4px;cursor:pointer;max-width:100%;overflow-wrap:anywhere}button:hover,button:focus{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder)}.work-time{font-size:0.85em;margin-left:4px;color:var(--vscode-descriptionForeground);white-space:nowrap}.content{white-space:pre-wrap}.url{color:#3794FF}${tagCss}</style></head><body><h1>${titleHtml}${timeLabel(sumMinutes([...ownMinutes.values()]))}</h1><p>${count} 件のノート</p>${body}<script nonce="${nonce}">const api=acquireVsCodeApi();document.addEventListener('click',e=>{const b=e.target.closest('button[data-id]');if(b)api.postMessage({id:b.dataset.id,...(b.dataset.offset!==undefined?{offset:Number(b.dataset.offset)}:{})});});</script></body></html>`;
  }
  function filter(tag: string) {
    activeTag = tag;
    activeQuery = undefined;
    showResults(`@${tag}`);
  }
  async function search() {
    const query = await vscode.window.showInputBox({
      prompt: 'ノート名・本文を検索（大文字と小文字を区別しない部分一致）',
      placeHolder: '検索キーワード', value: activeQuery ?? ''
    });
    if (!query?.trim()) return;
    await refresh();
    activeQuery = query.trim();
    activeTag = undefined;
    showResults(`検索: ${activeQuery}`);
  }
  function showResults(title: string) {
    if (!panel) {
      panel = vscode.window.createWebviewPanel('fnote.results', `fnote: ${title}`, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
      panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
      panel.webview.onDidReceiveMessage(guard((message: unknown) => {
        if (typeof message !== 'object' || message === null || !('id' in message) || typeof message.id !== 'string') return;
        const offset = 'offset' in message ? message.offset : undefined;
        if (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)) return;
        return open(message.id, offset);
      }), null, context.subscriptions);
    }
    panel.title = `fnote: ${title}`; renderResults(); panel.reveal();
  }
  const command = <Args extends unknown[], Result>(name: string, fn: (...args: Args) => Result) => context.subscriptions.push(vscode.commands.registerCommand(`fnote.${name}`, guard(fn)));
  command('expandNotes', () => tree.expandAll());
  command('expandTags', () => tags.expandAll());
  command('collapseNotes', () => tree.collapseAll());
  command('collapseTags', () => tags.collapseAll());
  command('search', search); command('open', open); command('filter', filter); command('refresh', refresh);
  command('add', () => add()); command('addChild', (n?: Note) => { n = selected(n); return n ? add(n.id) : add(); });
  command('rename', async (n?: Note) => {
    n = selected(n); if (!n) return;
    const name = await vscode.window.showInputBox({ value: n.name, prompt: '新しいノート名', validateInput: validateName });
    if (name) {
      const destination = n.parent ? `${n.parent}/${name}` : name;
      await relocate(n.id, destination, name);
      const renamed = notes.find(note => note.id === destination);
      if (renamed) await tree.reveal(renamed);
    }
  });
  command('move', async (n?: Note) => {
    n = selected(n); if (!n) return;
    const target = await vscode.window.showQuickPick([{ label: '最上位', id: '' }, ...notes.filter(p => !within(p.id, n.id)).map(p => ({ label: p.id, id: p.id }))], { placeHolder: '移動先の親ノート' });
    if (target) await move(n.id, target.id);
  });
  for (const [name, delta] of [['up', -1], ['down', 1]] as const) command(name, async (n?: Note) => {
    n = selected(n); if (!n) return;
    const siblings = notes.filter(p => p.parent === n.parent);
    const index = siblings.findIndex(p => p.id === n.id), other = siblings[index + delta];
    if (!other) return;
    const ids = notes.map(p => p.id), a = ids.indexOf(n.id), b = ids.indexOf(other.id);
    [ids[a], ids[b]] = [ids[b], ids[a]]; order = ids;
    await context.globalState.update(`order:${root.toString()}`, order); await refresh();
  });
  command('delete', async (n?: Note) => {
    n = selected(n); if (!n) return;
    const count = notes.filter(p => within(p.id, n.id)).length;
    if (await vscode.window.showWarningMessage(`「${n.name}」と子ノート（計${count}件）を削除しますか？`, { modal: true }, '削除') !== '削除') return;
    const edit = new vscode.WorkspaceEdit(); edit.deleteFile(uri(n.id), { recursive: true });
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('削除できませんでした。');
    await refresh();
  });
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  context.subscriptions.push(events, tagEvents, tree, tags, watcher,
    watcher.onDidCreate(schedule), watcher.onDidDelete(schedule), watcher.onDidChange(schedule),
    vscode.workspace.onDidChangeTextDocument(e => { if (notes.some(n => file(n.id).toString() === e.document.uri.toString())) schedule(); }),
    vscode.workspace.onDidCloseTextDocument(schedule),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('fnote')) schedule(); }),
    vscode.window.onDidChangeVisibleTextEditors(decorate),
    vscode.window.onDidChangeActiveTextEditor(guard(async (editor: vscode.TextEditor | undefined) => {
      const n = notes.find(n => file(n.id).toString() === editor?.document.uri.toString());
      if (n) await tree.reveal(n);
    })),
    { dispose() { disposed = true; clearTimeout(timer); decorations.forEach(d => d.dispose()); panel?.dispose(); } });
  await refresh();
}
