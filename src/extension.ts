import * as vscode from 'vscode';
import { NotesView } from './notesView';
import type { DropPosition, NoteEdit } from './notesView';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { markdownLinkColor, noteAppearance, tagAppearance, parseHeadings, parseTags, formatWorkMinutes, minutesForDate, planNoteDrop, renderTagText, searchNotes, styleFor, tagTree, matchesTag, within, filterTree, matchingHeadings, matchingLines, validateName, escapeHtml as h } from './core';
import type { Attachment, Note, TagNode, TagHierarchy, TagStyles, HeadingMatch, ContentMatch } from './core';
import { parseNoteLinks, parseDisplayLinks, INCOMPLETE_TIME_TAG } from './core';
import { linkMark, linkIconUri } from './linkMark';

interface NoteStatus {
  archived?: boolean;
  order?: string[];
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'FileNotFound';
}

function markdownAttachmentLink(name: string): string {
  const target = name.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return `[](${target})`;
}

function droppedUri(value: string): vscode.Uri {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value) ? vscode.Uri.file(value) : vscode.Uri.parse(value);
}

function validAttachmentPath(name: string): boolean {
  return !!name && !/[\\\x00-\x1f:]/.test(name)
    && name.split('/').every(part => !!part && part !== '.' && part !== '..')
    && name.toLowerCase() !== 'index.md';
}

function isAttachmentLink(note: Note, target: string): boolean {
  if (!target || target.startsWith('/') || /[?#]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return false; }
  const relative = path.posix.normalize(decoded);
  if (relative === '.' || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return false;
  return (note.attachments ?? []).some(item => item.id === `${note.id}/${relative}`);
}

function resolveStoragePath(setting: string, workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined): string | undefined {
  const workspacePath = workspaceFolders?.[0]?.uri.fsPath;
  if (/\$\{workspace(?:Folder)?\}/.test(setting) && !workspacePath) return undefined;
  const expanded = setting.replace(/\$\{workspace(?:Folder)?\}/g, workspacePath ?? '');
  if (expanded === '~') return os.homedir();
  if (expanded.startsWith('~/')) return path.join(os.homedir(), expanded.slice(2));
  return expanded;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = () => vscode.workspace.getConfiguration('fnote');
  const setting = config().get<string>('storagePath', '~/.fnote');
  const storagePath = resolveStoragePath(setting, vscode.workspace.workspaceFolders);
  if (storagePath === undefined) {
    void vscode.window.showErrorMessage('fnote.storagePath uses ${workspace}, but no workspace folder is open.');
    return;
  }
  if (storagePath && !path.isAbsolute(storagePath)) {
    void vscode.window.showErrorMessage('Set fnote.storagePath to an absolute path, a path starting with ~/, or ${workspace}/... . Leave it empty to use the extension storage location.');
    return;
  }
  const root = storagePath ? vscode.Uri.file(storagePath) : vscode.Uri.joinPath(context.globalStorageUri, 'notes');
  const uri = (id: string) => vscode.Uri.joinPath(root, ...id.split('/').filter(Boolean));
  const file = (id: string) => vscode.Uri.joinPath(uri(id), 'index.md');
  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider({ language: 'markdown', scheme: 'file' }, {
    async provideDocumentLinks(document) {
      const relative = path.relative(root.fsPath, document.uri.fsPath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
      const links = await Promise.all(parseNoteLinks(document.getText(), true).map(async link => {
        const external = /^[a-z][a-z\d+.-]*:/i.test(link.target);
        let target = link.target;
        if (!external) {
          try { target = decodeURIComponent(link.target); } catch { return []; }
        }
        const range = new vscode.Range(document.positionAt(link.start), document.positionAt(link.end));
        if (external) {
          return [new vscode.DocumentLink(range, vscode.Uri.parse(target))];
        }
        const resolved = vscode.Uri.joinPath(document.uri, '..', target);
        let destination = vscode.Uri.joinPath(resolved, 'index.md');
        if (!target.endsWith('/')) {
          try {
            const stat = await vscode.workspace.fs.stat(resolved);
            if (stat.type & vscode.FileType.File) destination = resolved;
            else if (!(stat.type & vscode.FileType.Directory)) return [];
          } catch { return []; }
        }
        return [new vscode.DocumentLink(range, destination)];
      }));
      return links.flat();
    }
  }));
  context.subscriptions.push(vscode.languages.registerDocumentDropEditProvider({ language: 'markdown', scheme: 'file', pattern: new vscode.RelativePattern(root, '**/index.md') }, {
    async provideDocumentDropEdits(document, position, dataTransfer, token) {
      const relative = path.relative(root.fsPath, document.uri.fsPath);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.basename(relative) !== 'index.md' || path.dirname(relative) === '.') return;
      const noteId = path.dirname(relative).split(path.sep).join('/');
      const files: { name: string; contents: Uint8Array | vscode.DataTransferFile }[] = [];
      for (const [, item] of dataTransfer) {
        const dropped = item.asFile();
        if (dropped && !files.some(file => file.name === dropped.name)) files.push({ name: dropped.name, contents: dropped });
      }
      const uriList = dataTransfer.get('text/uri-list') ?? dataTransfer.get('text/plain');
      if (uriList) {
        for (const value of (await uriList.asString()).split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'))) {
          if (!/^(?:file:\/\/|[a-zA-Z]:[\\/]|\/)/.test(value)) continue;
          const source = droppedUri(value);
          let stat;
          try { stat = await vscode.workspace.fs.stat(source); } catch { continue; }
          if (!(stat.type & vscode.FileType.File)) continue;
          const name = path.basename(source.fsPath || source.path);
          if (name && !files.some(file => file.name === name)) files.push({ name, contents: await vscode.workspace.fs.readFile(source) });
        }
      }
      if (!files.length) return;
      const edit = new vscode.WorkspaceEdit();
      const links: string[] = [];
      for (const dropped of files) {
        if (token?.isCancellationRequested) return;
        if (!validAttachmentPath(dropped.name) || dropped.name.includes('/')) throw new Error('Invalid attachment name: ' + dropped.name);
        const destination = vscode.Uri.joinPath(uri(noteId), dropped.name);
        // Resolve bytes while the drag data is valid, and create only if this edit is applied.
        const contents = 'data' in dropped.contents ? await dropped.contents.data() : dropped.contents;
        edit.createFile(destination, { contents, overwrite: false });
        links.push(markdownAttachmentLink(dropped.name));
      }
      if (token?.isCancellationRequested) return;
      const result = new vscode.DocumentDropEdit(links.join('\n'));
      // New VS Code versions expose these fields; older versions ignore them.
      Object.assign(result, { title: 'Copy attachments into fnote', kind: { value: 'fnote.attachment' } });
      result.additionalEdit = edit;
      return result;
    }
  }));
  let notes: Note[] = [];
  let panel: vscode.WebviewPanel | undefined;
  let activeTag: string | undefined;
  let activeQuery: string | undefined;
  let decorations: vscode.TextEditorDecorationType[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const legacyOrderKey = `order:${root.toString()}`;
  let legacyOrder = context.globalState.get<string[]>(legacyOrderKey, []).filter(id => typeof id === 'string');
  let order: string[] = [];
  let tagOrder = context.globalState.get<string[]>(`tagOrder:${root.toString()}`, []);
  const events = new vscode.EventEmitter<void>();
  const tagEvents = new vscode.EventEmitter<void>();
  const guard = <Args extends unknown[], Result>(fn: (...args: Args) => Result) => async (...args: Args): Promise<Awaited<Result> | undefined> => {
    try { return await fn(...args); }
    catch (error) { void vscode.window.showErrorMessage(`fnote: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const statusFile = (id: string) => vscode.Uri.joinPath(uri(id), '.status');
  const readStatus = async (id: string): Promise<NoteStatus> => {
    try {
      const value = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(statusFile(id))).toString('utf8')) as Record<string, unknown>;
      return {
        ...(typeof value.archived === 'boolean' ? { archived: value.archived } : {}),
        ...(Array.isArray(value.order) ? { order: value.order.filter((item): item is string => typeof item === 'string') } : {}),
      };
    } catch {
      return {};
    }
  };
  const writeStatus = async (id: string, patch: NoteStatus): Promise<void> => {
    const current = await readStatus(id);
    await vscode.workspace.fs.writeFile(statusFile(id), Buffer.from(`${JSON.stringify({ ...current, ...patch })}\n`));
  };
  const writeArchiveStatus = async (id: string, archived: boolean): Promise<void> => {
    await writeStatus(id, { archived });
  };
  const readArchiveStatus = async (id: string): Promise<boolean | undefined> => {
    return (await readStatus(id)).archived;
  };
  const writeNoteOrder = async (ids: readonly string[]): Promise<void> => {
    const grouped = new Map<string, string[]>();
    for (const id of ids) {
      const parent = path.posix.dirname(id) === '.' ? '' : path.posix.dirname(id);
      const names = grouped.get(parent) ?? [];
      names.push(path.posix.basename(id));
      grouped.set(parent, names);
    }
    await Promise.all([...grouped].map(([parent, names]) => writeStatus(parent, { order: names })));
  };
  const appearance = (n: Note) => n.archived
    ? { mark: config().get<string>('archiveMark', '$(archive)'), color: config().get<string>('archiveColor', '#808080') || undefined }
    : noteAppearance(n.tags, config().get<TagStyles>('tagStyles', {}), config().get<string>('untaggedNoteMark', '$(note)'), config().get<string>('defaultTagMark', '$(circle-filled-compact)'), config().get<TagHierarchy>('tagHierarchy', {}));
  const marks = (n: Note) => appearance(n).mark;
  const children = (parent?: Note) => notes.filter(n => n.parent === (parent?.id || ''));
  const provider: vscode.TreeDataProvider<Note> = {
    onDidChangeTreeData: events.event,
    getChildren: children,
    getParent: n => notes.find(p => p.id === n.parent),
    getTreeItem: n => {
      const item = new vscode.TreeItem(`${marks(n)}${marks(n) ? ' ' : ''}${n.name}`, children(n).length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.id = n.id; item.contextValue = n.archived ? 'archivedNote' : 'note'; item.tooltip = n.id;
      item.command = { command: 'fnote.open', title: 'Open', arguments: [n.id] };
      return item;
    }
  };
  let dropQueue = Promise.resolve();
  const tree = new NotesView(provider, context.extensionUri, (id, target, position) => {
    const operation = dropQueue.catch(() => {}).then(() => dropItem(id, target, position));
    dropQueue = operation;
    return operation;
  }, false, note => {
    const mark = marks({ ...note, tags: notes.filter(child => within(child.id, note.id)).flatMap(child => child.tags) });
    return `${mark ? `${mark} ` : ''}${note.name}`;
  }, (note, collapsed) => appearance(collapsed ? { ...note, tags: notes.filter(child => within(child.id, note.id)).flatMap(child => child.tags) } : note), () => {
    const mark = linkMark(config().get<string>('attachmentMark', '$(attach)'));
    return { mark: mark.icon ? `$(${mark.icon})` : mark.text, color: config().get<string>('attachmentColor', '') || undefined };
  }, applyNoteEdit);
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
    getChildren: n => sortedTags((n?.children || tagTree(notes.filter(note => !note.archived), hierarchy())).values()),
    getTreeItem: n => {
      const mark = tagAppearance(n.tag, config().get<TagStyles>('tagStyles', {}), config().get<string>('defaultTagMark', '$(circle-filled-compact)'), hierarchy()).mark;
      const item = new vscode.TreeItem(`${mark ? `${mark} ` : ''}${n.label}`, n.children.size ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = n.tag; item.tooltip = n.tag === INCOMPLETE_TIME_TAG ? n.tag : `@${n.tag}`;
      item.description = String(notes.filter(note => !note.archived && matchesTag(note, n.tag, hierarchy())).length);
      item.command = { command: 'fnote.filter', title: 'Find by Tag', arguments: [n.tag] };
      return item;
    }
  };
  const tags = new NotesView({
    getChildren: () => [],
    getTreeItem: note => {
      const item = new vscode.TreeItem(note.name);
      item.description = String(notes.filter(n => !n.archived && matchesTag(n, note.id, hierarchy())).length);
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
  }, true, undefined, note => tagAppearance(note.id, config().get<TagStyles>('tagStyles', {}), config().get<string>('defaultTagMark', '$(circle-filled-compact)'), hierarchy()));
  async function tagRows(): Promise<Note[]> {
    const rows: Note[] = [];
    async function visit(nodes: Iterable<TagNode>, parent: string): Promise<void> {
      for (const node of sortedTags(nodes)) {
        const item = await tagProvider.getTreeItem(node);
        rows.push({ id: node.tag, parent, name: String(item.label), text: '', tags: [] });
        await visit(node.children.values(), node.tag);
      }
    }
    await visit(tagTree(notes.filter(note => !note.archived), hierarchy()).values(), '');
    return rows;
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('fnote.tags', tags));
  async function scan() {
    const found: Note[] = [];
    const readEntries = async (id: string): Promise<[string, vscode.FileType][]> => {
      try { return await vscode.workspace.fs.readDirectory(uri(id)); }
      catch (error) { if (isMissing(error)) return []; throw error; }
    };
    const hasIndex = (entries: readonly [string, vscode.FileType][]) => entries.some(([name, type]) => name === 'index.md' && type === vscode.FileType.File);
    async function collectAttachments(id: string, parent: string, entries: readonly [string, vscode.FileType][], output: Attachment[]): Promise<void> {
      output.push({ id, parent, name: path.posix.basename(id), directory: true });
      for (const [name, type] of entries) {
        const child = `${id}/${name}`;
        if (type === vscode.FileType.Directory) await collectAttachments(child, id, await readEntries(child), output);
        else output.push({ id: child, parent: id, name, directory: false });
      }
    }
    async function walkNote(id: string, parent: string, entries: readonly [string, vscode.FileType][], ancestorArchived = false): Promise<void> {
      const explicitArchive = await readArchiveStatus(id);
      const inheritedArchive = ancestorArchived || explicitArchive === true;
      const archived = inheritedArchive && explicitArchive !== false;
      const attachments: Attachment[] = [];
      const childNotes: { id: string; entries: readonly [string, vscode.FileType][] }[] = [];
      for (const [name, type] of entries) {
        if (name === '.status' || (name === 'index.md' && type === vscode.FileType.File)) continue;
        const child = `${id}/${name}`;
        if (type === vscode.FileType.Directory) {
          const childEntries = await readEntries(child);
          if (hasIndex(childEntries)) childNotes.push({ id: child, entries: childEntries });
          else await collectAttachments(child, id, childEntries, attachments);
        } else attachments.push({ id: child, parent: id, name, directory: false });
      }
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === file(id).toString());
      const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(file(id))).toString('utf8');
      found.push({ id, parent, name: parseHeadings(text).find(heading => heading.level === 1)?.title ?? path.posix.basename(id), text, tags: parseTags(text), archived, attachments });
      for (const child of childNotes) await walkNote(child.id, id, child.entries, inheritedArchive);
    }
    const rootEntries = await readEntries('');
    for (const [name, type] of rootEntries) if (type === vscode.FileType.Directory && !name.startsWith('.')) {
      const id = name;
      const entries = await readEntries(id);
      if (hasIndex(entries)) await walkNote(id, '', entries);
    }
    if (disposed) return;
    const statuses = new Map<string, NoteStatus>();
    await Promise.all(['', ...found.map(note => note.id)].map(async id => statuses.set(id, await readStatus(id))));
    const legacyByParent = new Map<string, string[]>();
    for (const id of legacyOrder) {
      const parent = path.posix.dirname(id) === '.' ? '' : path.posix.dirname(id);
      const names = legacyByParent.get(parent) ?? [];
      names.push(path.posix.basename(id));
      legacyByParent.set(parent, names);
    }
    const byParent = new Map<string, Note[]>();
    for (const note of found) {
      const siblings = byParent.get(note.parent) ?? [];
      siblings.push(note);
      byParent.set(note.parent, siblings);
    }
    const ordered: Note[] = [];
    const visit = (parent: string): void => {
      const preferred = statuses.get(parent)?.order ?? legacyByParent.get(parent) ?? [];
      const rank = new Map(preferred.map((name, index) => [name, index]));
      const siblings = [...(byParent.get(parent) ?? [])].sort((a, b) => {
        const ai = rank.get(path.posix.basename(a.id)), bi = rank.get(path.posix.basename(b.id));
        return (ai === undefined ? Infinity : ai) - (bi === undefined ? Infinity : bi)
          || a.id.localeCompare(b.id, 'ja', { numeric: true });
      });
      for (const note of siblings) { ordered.push(note); visit(note.id); }
    };
    visit('');
    notes = ordered;
    order = ordered.map(note => note.id);
    if (legacyOrder.length) {
      await writeNoteOrder(order);
      legacyOrder = [];
      await context.globalState.update(legacyOrderKey, undefined);
    }
    events.fire(); tagEvents.fire(); await tree.update(notes); await tags.update(await tagRows()); decorate(); renderResults();
  }
  let refreshQueue = Promise.resolve();
  function refresh() { refreshQueue = refreshQueue.catch(() => {}).then(scan); return refreshQueue; }
  function schedule() { clearTimeout(timer); timer = setTimeout(guard(refresh), 180); }
  function decorate() {
    for (const decoration of decorations) decoration.dispose();
    decorations = [];
    const styles = config().get<TagStyles>('tagStyles', {});
    const linkColor = markdownLinkColor(
      vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations'),
      vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '')
    ) ?? new vscode.ThemeColor('textLink.foreground');
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
      for (const { color, backgroundColor, ranges } of groups.values()) {
        const decoration = vscode.window.createTextEditorDecorationType({ color, backgroundColor: backgroundColor || undefined });
        decorations.push(decoration); editor.setDecorations(decoration, ranges);
      }
      const hidden: vscode.Range[] = [];
      const note = notes.find(item => file(item.id).toString() === editor.document.uri.toString());
      const linkGroups = new Map<string, { mark: ReturnType<typeof linkMark>; color: string | vscode.ThemeColor; ranges: vscode.Range[] }>();
      for (const link of parseDisplayLinks(editor.document.getText())) {
        const range = new vscode.Range(editor.document.positionAt(link.start), editor.document.positionAt(link.end));
        if (editor.selections.some(selection => range.intersection(selection))) continue;
        const attachmentLink = note ? isAttachmentLink(note, link.target) : false;
        const mark = linkMark(config().get<string>(attachmentLink ? 'attachmentMark' : 'linkMark', attachmentLink ? '$(attach)' : '$(link-external)'));
        const color = attachmentLink ? (config().get<string>('attachmentColor', '') || linkColor) : linkColor;
        const group = attachmentLink ? 'attachment' : 'link';
        if (!linkGroups.has(group)) linkGroups.set(group, { mark, color, ranges: [] });
        linkGroups.get(group)!.ranges.push(new vscode.Range(editor.document.positionAt(link.displayStart), editor.document.positionAt(link.displayEnd)));
        if (link.start < link.displayStart) hidden.push(new vscode.Range(range.start, editor.document.positionAt(link.displayStart)));
        if (link.displayEnd < link.end) hidden.push(new vscode.Range(editor.document.positionAt(link.displayEnd), range.end));
      }
      for (const { mark, color, ranges } of linkGroups.values()) {
        const before: vscode.ThemableDecorationAttachmentRenderOptions | undefined = mark.icon
          ? {
            contentText: '\u00a0', color, width: '1em', height: '1em', margin: '0 0.25em 0 0',
            textDecoration: `none; display:inline-block; vertical-align:-0.35em; background-color:currentColor; mask:url("${linkIconUri(mark.icon)}") center / contain no-repeat`
          }
          : mark.text ? { contentText: mark.text, color, margin: '0 0.25em 0 0' } : undefined;
        const decoration = vscode.window.createTextEditorDecorationType({
          color, before
        });
        decorations.push(decoration); editor.setDecorations(decoration, ranges);
      }
      if (hidden.length) {
        const decoration = vscode.window.createTextEditorDecorationType({ textDecoration: 'none; display: none' });
        decorations.push(decoration); editor.setDecorations(decoration, hidden);
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
  const selected = (n?: Note) => notes.find(note => note.id === n?.id) || tree.selection[0];
  async function add(parent = '') {
    if (await tree.startCreate(parent)) return;
    const name = await vscode.window.showInputBox({ prompt: 'Note name', validateInput: validateName });
    if (name) await applyNoteEdit({ mode: 'create', parent, name });
  }
  async function createNote(parent: string, name: string): Promise<void> {
    const id = parent ? `${parent}/${name}` : name;
    await ensureAbsent(id);
    await vscode.workspace.fs.createDirectory(uri(id));
    await vscode.workspace.fs.writeFile(file(id), Buffer.from(`# ${name}\n\n`));
    await refresh(); await writeNoteOrder(order); await open(id);
  }
  async function applyNoteEdit(edit: NoteEdit): Promise<void> {
    const validation = validateName(edit.name);
    if (validation) throw new Error(validation);
    if (edit.mode === 'create') {
      const parent = edit.parent ?? '';
      if (parent && !notes.some(note => note.id === parent)) throw new Error('The parent note no longer exists.');
      await createNote(parent, edit.name);
      return;
    }
    const note = notes.find(item => item.id === edit.id);
    if (!note) {
      const item = attachment(edit.id ?? '');
      if (!item) return;
      await relocate(item.id, `${item.parent}/${edit.name}`);
      return;
    }
    const destination = note.parent ? `${note.parent}/${edit.name}` : edit.name;
    await relocate(note.id, destination, edit.name);
    const renamed = notes.find(item => item.id === destination);
    if (renamed) await tree.reveal(renamed);
  }
  async function ensureAbsent(id: string) {
    try { await vscode.workspace.fs.stat(uri(id)); } catch (error) { if (isMissing(error)) return; throw error; }
    throw new Error('A note with the same name already exists.');
  }
  const attachment = (id: string) => notes.flatMap(note => note.attachments ?? []).find(item => item.id === id);
  async function copyAttachments(noteId: string, sources: vscode.Uri[]): Promise<void> {
    if (!notes.some(note => note.id === noteId)) return;
    for (const source of sources) {
      const name = path.basename(source.fsPath || source.path);
      if (!name || name === '.' || name === path.sep) continue;
      await vscode.workspace.fs.copy(source, vscode.Uri.joinPath(uri(noteId), name), { overwrite: false });
    }
    await refresh();
  }
  async function receiveAttachmentFiles(noteId: string, value: unknown): Promise<void> {
    if (!notes.some(note => note.id === noteId)) return;
    if (!Array.isArray(value) || !value.length) throw new Error('No attachment files received.');
    const entries: { name: string; directory: boolean; data: Uint8Array }[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (!entry || typeof entry.name !== 'string' || !validAttachmentPath(entry.name) || seen.has(entry.name)
        || (entry.directory !== true && (!Array.isArray(entry.data) || !entry.data.every((byte: unknown) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)))) {
        throw new Error('Invalid dropped attachment.');
      }
      seen.add(entry.name);
      entries.push({ name: entry.name, directory: entry.directory === true, data: Uint8Array.from(entry.data ?? []) });
    }
    for (const name of new Set(entries.map(entry => entry.name.split('/')[0]))) {
      try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri(noteId), name)); }
      catch (error) { if (isMissing(error)) continue; throw error; }
      throw new Error(`Attachment "${name}" already exists.`);
    }
    const edit = new vscode.WorkspaceEdit();
    for (const entry of entries) {
      if (!entry.directory) edit.createFile(vscode.Uri.joinPath(uri(noteId), entry.name), { contents: entry.data, overwrite: false });
    }
    try {
      if (entries.some(entry => !entry.directory) && !await vscode.workspace.applyEdit(edit)) throw new Error('Could not create attachments.');
      for (const entry of entries) if (entry.directory) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri(noteId), entry.name));
    } finally { await refresh(); }
  }
  async function addAttachment(note?: Note): Promise<void> {
    if (!note) return;
    const sources = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, openLabel: 'Add Attachment' });
    if (sources?.length) await copyAttachments(note.id, sources);
  }
  async function openAttachment(id: string): Promise<void> {
    const item = attachment(id);
    if (!item) return;
    const target = uri(id);
    if (item.directory) await vscode.commands.executeCommand('revealFileInOS', target);
    else await vscode.commands.executeCommand('vscode.open', target);
  }
  async function deleteAttachment(id?: string): Promise<void> {
    if (!id) return;
    const item = attachment(id);
    if (!item) return;
    if (await vscode.window.showWarningMessage(`Delete attachment "${item.name}"?`, { modal: true }, 'Delete') !== 'Delete') return;
    const edit = new vscode.WorkspaceEdit(); edit.deleteFile(uri(id), { recursive: item.directory });
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not delete the attachment.');
    await refresh();
  }
  async function updateNoteLinks(edit: vscode.WorkspaceEdit, id: string, destination: string): Promise<void> {
    const movedPaths = [
      ...notes.filter(note => within(note.id, id)).map(note => note.id),
      ...notes.flatMap(note => note.attachments ?? []).filter(item => within(item.id, id)).map(item => item.id),
    ];
    const movedIds = new Map(movedPaths.map(source => [source, destination + source.slice(id.length)]));
    const attachmentIds = new Set(notes.flatMap(note => (note.attachments ?? []).map(attachment => attachment.id)));
    for (const source of notes) {
      const document = await vscode.workspace.openTextDocument(file(source.id));
      const text = document.getText();
      const newSource = movedIds.get(source.id) ?? source.id;
      const sourceMoved = movedIds.has(source.id);
      for (const link of parseDisplayLinks(text).reverse()) {
        const sourceText = text.slice(link.start, link.end);
        if (!sourceText.startsWith('[') || link.target.startsWith('/') || /[?#]/.test(link.target) || /^[a-z][a-z\d+.-]*:/i.test(link.target)) continue;
        let decoded: string;
        try { decoded = decodeURIComponent(link.target); } catch { continue; }
        const resolved = path.posix.normalize(path.posix.join(source.id, decoded));
        const explicitIndex = decoded === 'index.md' || decoded.endsWith('/index.md');
        const targetId = resolved.endsWith('/index.md')
          ? resolved.slice(0, -'/index.md'.length)
          : resolved.replace(/\/+$/, '');
        const oldTarget = notes.find(note => note.id === targetId);
        if (!oldTarget && !attachmentIds.has(targetId)) continue;
        const oldTargetPath = oldTarget
          ? explicitIndex ? `${oldTarget.id}/index.md` : oldTarget.id
          : targetId;
        const targetMoved = within(oldTargetPath, id);
        if (sourceMoved === targetMoved) continue;
        const newTarget = targetMoved ? destination + oldTargetPath.slice(id.length) : oldTargetPath;
        const trailingSlash = decoded.endsWith('/');
        let replacement = path.posix.relative(newSource, newTarget) || (explicitIndex ? 'index.md' : '.');
        if (trailingSlash && !replacement.endsWith('/')) replacement += '/';
        if (link.target.startsWith('./') && !replacement.startsWith('.')) replacement = `./${replacement}`;
        if (/%[\da-f]{2}/i.test(link.target)) replacement = replacement.split('/').map(part => encodeURIComponent(part)).join('/');
        if (replacement !== link.target) edit.replace(document.uri, new vscode.Range(document.positionAt(link.targetStart), document.positionAt(link.targetEnd)), replacement);
      }
    }
  }
  async function relocate(id: string, destination: string, title?: string) {
    if (id === destination && title === undefined) return;
    if (id !== destination) await ensureAbsent(destination);
    const edit = new vscode.WorkspaceEdit();
    if (id !== destination) await updateNoteLinks(edit, id, destination);
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
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not move the note.');
    order = order.map(entry => within(entry, id) ? destination + entry.slice(id.length) : entry);
    await writeNoteOrder(order);
    await refresh();
  }
  async function move(id: string, parent: string) {
    if (!notes.some(n => n.id === id) || (parent && !notes.some(n => n.id === parent))) return;
    if (parent && within(parent, id)) throw new Error('Cannot move a note under itself or its descendants.');
    await relocate(id, parent ? `${parent}/${path.posix.basename(id)}` : path.posix.basename(id));
  }
  async function dropNote(id: string, target: string | undefined, position: DropPosition): Promise<void> {
    const plan = planNoteDrop(notes, id, target, position);
    await relocate(id, plan.destination);
    order = plan.order;
    await writeNoteOrder(order);
    await refresh();
    const moved = notes.find(note => note.id === plan.destination);
    if (moved) await tree.reveal(moved);
  }
  async function dropAttachment(id: string, target: string | undefined, position: DropPosition): Promise<void> {
    const source = attachment(id);
    if (!source) throw new Error('Source attachment not found.');
    const targetNote = target ? notes.find(note => note.id === target) : undefined;
    const targetAttachment = target ? attachment(target) : undefined;
    if (target !== undefined && !targetNote && !targetAttachment) throw new Error('Destination not found.');
    if (target && within(target, id)) throw new Error('Cannot move an attachment into itself or its descendants.');
    if (position === 'inside' && targetAttachment && !targetAttachment.directory) throw new Error('A file cannot contain an attachment.');
    const parent = target
      ? position === 'inside' ? target : targetNote?.parent ?? targetAttachment?.parent
      : undefined;
    if (!parent) throw new Error('Attachments must be moved into a note or attachment folder.');
    const destination = `${parent}/${source.name}`;
    if (destination === id) return;
    if (notes.some(note => note.id === destination) || attachment(destination)) throw new Error('An item with the same name already exists.');
    await relocate(id, destination);
    await refresh();
  }
  async function dropItem(id: string, target: string | undefined, position: DropPosition): Promise<void> {
    if (attachment(id)) await dropAttachment(id, target, position);
    else await dropNote(id, target, position);
  }
  function renderResults() {
    if (!panel || (!activeTag && !activeQuery)) return;
    const tag = activeTag ?? '';
    const hits = activeQuery ? searchNotes(notes, activeQuery) : [];
    const hitMap = new Map(hits.map(hit => [hit.note.id, hit]));
    const tagNotes = notes.filter(note => !note.archived);
    const subset = activeQuery
      ? notes.filter(note => hits.some(hit => within(hit.note.id, note.id)))
      : filterTree(tagNotes, tag, hierarchy());
    const isMatch = (note: Note) => activeQuery ? hitMap.has(note.id) : matchesTag(note, tag, hierarchy());
    const title = activeQuery ? `Search: ${activeQuery}` : tag === INCOMPLETE_TIME_TAG ? tag : `@${tag}`;
    const count = activeQuery ? hits.length : tagNotes.filter(isMatch).length;
    const tagClasses = new Map<string, string>();
    const styles = config().get<TagStyles>('tagStyles', {});
    // Only color-value characters are allowed inside the nonce-protected stylesheet.
    const safeColor = (value: string, fallback: string): string => /^[#a-zA-Z0-9(),.%\s+-]+$/.test(value) ? value : fallback;
    const linkColor = markdownLinkColor(
      vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations'),
      vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '')
    );
    const attachmentColor = safeColor(config().get<string>('attachmentColor', ''), '');
    const linkCss = `.url{color:${linkColor ?? 'var(--vscode-textLink-foreground)'}}${attachmentColor ? `.attachment-url{color:${attachmentColor}}` : ''}button .url .codicon{color:inherit;font-size:1em;vertical-align:-0.15em;position:static}`;
    const linkMarkHtmlFor = (note: Note, link: ReturnType<typeof parseDisplayLinks>[number]): { html: string; attachment: boolean } => {
      const attachment = isAttachmentLink(note, link.target);
      const mark = linkMark(config().get<string>(attachment ? 'attachmentMark' : 'linkMark', attachment ? '$(attach)' : '$(link-external)'));
      return { attachment, html: mark.icon ? `<i class="codicon codicon-${mark.icon}" aria-hidden="true"></i> ` : mark.text ? `${h(mark.text)} ` : '' };
    };
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
      const urls = parseDisplayLinks(note.text);
      const tokens = [...note.tags.filter(tag => !urls.some(url => tag.start < url.end && tag.end > url.start)),
        ...urls.map(url => ({ ...url, tag: ':url' }))].sort((a, b) => a.start - b.start);
      const ranges = tokens.filter(tag => tag.start >= offset && tag.end <= offset + text.length)
        .map(tag => ({ ...tag, start: tag.start - offset, end: tag.end - offset }));
      let html = '', cursor = 0;
      for (const token of ranges) {
        html += h(text.slice(cursor, token.start));
        if (token.tag === ':url') {
          const link = urls.find(link => link.start === token.start + offset)!;
          const mark = linkMarkHtmlFor(note, link);
          html += `<span class="url${mark.attachment ? ' attachment-url' : ''}">${mark.html}${h(link.label)}</span>`;
        } else html += `<span class="${classFor(token.tag)}">${h(text.slice(token.start, token.end))}</span>`;
        cursor = token.end;
      }
      return html + h(text.slice(cursor));
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
    const iconColors: string[] = [];
    const markHtml = (note: Note): string => {
      const { mark, color } = appearance(note);
      const icon = /^\$\(([a-z0-9-]+)\)$/.exec(mark);
      if (!icon) return h(mark);
      const index = iconColors.push(safeColor(color || 'inherit', 'inherit')) - 1;
      return `<span aria-hidden="true" class="codicon codicon-${icon[1]} note-icon-${index}"></span>`;
    };
    const branch = (parent: string): string => `<ul>${subset.filter(n => n.parent === parent).map(n => `<li><button data-id="${h(n.id)}" class="${isMatch(n) ? 'match' : 'ancestor'}">${markHtml(n)} ${noteTitle(n)}</button>${timeLabel(noteMinutes(n.id))}${noteContent(n)}${branch(n.id)}</li>`).join('')}</ul>`;
    const body = subset.length ? branch('') : '<p>No matching notes.</p>';
    const titleHtml = activeQuery ? h(title) : tag === INCOMPLETE_TIME_TAG
      ? `<span class="${classFor(tag)}">${h(title)}</span>`
      : renderTagText(title, parseTags(title), classFor);
    const tagCss = [...tagClasses].map(([declaration, name]) => `.${name}{${declaration}}`).join('');
    const nonce = crypto.randomBytes(16).toString('hex');
    const iconCss = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'codicons', 'codicon.css'));
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${iconCss}"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);padding:12px;line-height:1.35}h1{font-size:1.3em;margin:0 0 6px}p{margin:0 0 8px}ul{list-style:none;margin:0;padding-left:18px;border-left:1px solid var(--vscode-tree-indentGuidesStroke)}li{margin:0}ul:empty{display:none}button{font:inherit;text-align:left;color:inherit;background:transparent;border:0;padding:1px 4px;cursor:pointer;max-width:100%;overflow-wrap:anywhere}button:hover,button:focus{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder)}button .codicon{vertical-align:middle;position:relative;top:-1px}.work-time{font-size:0.85em;margin-left:4px;color:var(--vscode-descriptionForeground);white-space:nowrap}.content{white-space:pre-wrap}${linkCss}${tagCss}${iconColors.map((color, i) => `.note-icon-${i}{color:${color}}`).join('')}</style></head><body><h1>${titleHtml}${timeLabel(sumMinutes([...ownMinutes.values()]))}</h1><p>${count} ${count === 1 ? 'note' : 'notes'}</p>${body}<script nonce="${nonce}">const api=acquireVsCodeApi();document.addEventListener('click',e=>{const b=e.target.closest('button[data-id]');if(b)api.postMessage({id:b.dataset.id,...(b.dataset.offset!==undefined?{offset:Number(b.dataset.offset)}:{})});});</script></body></html>`;
  }
  function filter(tag: string) {
    activeTag = tag;
    activeQuery = undefined;
    showResults(tag === INCOMPLETE_TIME_TAG ? tag : `@${tag}`);
  }
  async function search() {
    const query = await vscode.window.showInputBox({
      prompt: 'Search note names and content (case-insensitive partial match)',
      placeHolder: 'Search keyword', value: activeQuery ?? ''
    });
    if (!query?.trim()) return;
    await refresh();
    activeQuery = query.trim();
    activeTag = undefined;
    showResults(`Search: ${activeQuery}`);
  }
  function showResults(title: string) {
    if (!panel) {
      panel = vscode.window.createWebviewPanel('fnote.results', `fnote: ${title}`, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
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
  command('closeAllNotes', async () => {
    const noteUris = new Set(notes.map(note => file(note.id).toString()));
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputText && noteUris.has(tab.input.uri.toString()));
    if (tabs.length && !await vscode.window.tabGroups.close(tabs, true)) return;
    panel?.dispose();
  });
  command('expandNotes', () => tree.expandAll());
  command('expandTags', () => tags.expandAll());
  command('collapseNotes', () => tree.collapseAll());
  command('collapseTags', () => tags.collapseAll());
  command('search', search); command('open', open); command('filter', filter); command('refresh', refresh);
  command('add', () => add()); command('addChild', (n?: Note) => { n = selected(n); return add(n?.id ?? ''); });
  command('addAttachment', (n?: Note) => addAttachment(selected(n)));
  command('dropAttachments', async (noteId: string, values: string[]) => {
    if (typeof noteId !== 'string' || !Array.isArray(values)) return;
    await copyAttachments(noteId, values.filter(value => typeof value === 'string').map(droppedUri));
  });
  command('dropAttachmentFiles', receiveAttachmentFiles);
  command('openAttachment', openAttachment);
  command('deleteAttachment', (id?: string) => deleteAttachment(typeof id === 'string' ? id : tree.selectedAttachmentId));
  command('rename', async (n?: Note) => {
    if (!n) {
      const attachmentId = tree.selectedAttachmentId;
      if (attachmentId && await tree.startRename(attachmentId)) return;
    }
    n = selected(n); if (!n) return;
    if (await tree.startRename(n.id)) return;
    const name = await vscode.window.showInputBox({ value: n.name, prompt: 'New note name', validateInput: validateName });
    if (name) await applyNoteEdit({ mode: 'rename', id: n.id, name });
  });
  command('move', async (n?: Note) => {
    n = selected(n); if (!n) return;
    const target = await vscode.window.showQuickPick([{ label: 'Top Level', id: '' }, ...notes.filter(p => !within(p.id, n.id)).map(p => ({ label: p.id, id: p.id }))], { placeHolder: 'Select the destination parent note' });
    if (target) await move(n.id, target.id);
  });
  const toggleArchive = async (n: Note | undefined): Promise<void> => {
    n = selected(n); if (!n) return;
    const descendants = notes.filter(note => note.id !== n!.id && within(note.id, n!.id));
    if (descendants.length && await vscode.window.showWarningMessage(
      `Archive or unarchive "${n.name}" and its child notes (${descendants.length + 1} notes in total)?`,
      { modal: true },
      'Apply',
    ) !== 'Apply') return;
    const archived = !n.archived;
    await Promise.all([n, ...descendants].map(note => writeArchiveStatus(note.id, archived)));
    await refresh();
  };
  command('archive', toggleArchive);
  command('archiveChecked', toggleArchive);
  for (const [name, delta] of [['up', -1], ['down', 1]] as const) command(name, async (n?: Note) => {
    n = selected(n); if (!n) return;
    const siblings = notes.filter(p => p.parent === n.parent);
    const index = siblings.findIndex(p => p.id === n.id), other = siblings[index + delta];
    if (!other) return;
    const ids = notes.map(p => p.id), a = ids.indexOf(n.id), b = ids.indexOf(other.id);
    [ids[a], ids[b]] = [ids[b], ids[a]]; order = ids;
    await writeNoteOrder(order); await refresh();
  });
  command('delete', async (n?: Note) => {
    n = selected(n); if (!n) return;
    const count = notes.filter(p => within(p.id, n.id)).length;
    if (await vscode.window.showWarningMessage(`Delete "${n.name}" and its child notes (${count} ${count === 1 ? 'note' : 'notes'} in total)?`, { modal: true }, 'Delete') !== 'Delete') return;
    const edit = new vscode.WorkspaceEdit(); edit.deleteFile(uri(n.id), { recursive: true });
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not delete the note.');
    await refresh(); await writeNoteOrder(order);
  });
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  context.subscriptions.push(events, tagEvents, tree, tags, watcher,
    watcher.onDidCreate(schedule), watcher.onDidDelete(schedule), watcher.onDidChange(schedule),
    vscode.workspace.onDidChangeTextDocument(e => { if (notes.some(n => file(n.id).toString() === e.document.uri.toString())) schedule(); }),
    vscode.workspace.onDidCloseTextDocument(schedule),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('fnote') || e.affectsConfiguration('editor.tokenColorCustomizations') || e.affectsConfiguration('workbench.colorTheme')) schedule(); }),
    vscode.window.onDidChangeVisibleTextEditors(decorate),
    vscode.window.onDidChangeTextEditorSelection(decorate),
    vscode.window.onDidChangeActiveTextEditor(guard(async (editor: vscode.TextEditor | undefined) => {
      const n = notes.find(n => file(n.id).toString() === editor?.document.uri.toString());
      if (n) await tree.reveal(n);
    })),
    { dispose() { disposed = true; clearTimeout(timer); decorations.forEach(d => d.dispose()); panel?.dispose(); } });
  await refresh();
}
