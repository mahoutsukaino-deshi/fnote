import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { parseHeadings, type Attachment, type Note, type TagMatch } from './core';

interface MarkAppearance { mark: string; color?: string }
interface OutlineRow { id: string; parent: string; label: string; noteId: string; offset: number; appearance?: MarkAppearance; collapsedAppearance?: MarkAppearance; outlineMark?: MarkAppearance }

export type DropPosition = 'before' | 'after' | 'inside';
export type NoteEdit = { mode: 'create' | 'rename'; id?: string; parent?: string; name: string };

export class NotesView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private current: Note[] = [];
  private selectedId?: string;
  private activeId?: string;
  private outline: OutlineRow[] = [];
  private subscriptions: vscode.Disposable[] = [];
  constructor(
    public readonly data: vscode.TreeDataProvider<Note>,
    private readonly extensionUri: vscode.Uri,
    private readonly onDrop: (id: string, target: string | undefined, position: DropPosition) => Promise<void>,
    private readonly tagMode = false,
    private readonly collapsedLabel?: (note: Note) => string,
    private readonly appearance?: (note: Note, collapsed: boolean) => { mark: string; color?: string },
    private readonly headingAppearance?: (tags: readonly TagMatch[]) => MarkAppearance | undefined,
    private readonly outlineMark?: () => MarkAppearance,
    private readonly attachmentAppearance?: (attachment: Attachment) => { mark: string; color?: string },
    private readonly onEdit?: (edit: NoteEdit) => Promise<void>
  ) {}
  private pendingEdit?: Omit<NoteEdit, 'name'>;
  private webviewReady = false;
  get selection(): Note[] { return this.current.filter(note => note.id === this.selectedId); }
  get selectedAttachmentId(): string | undefined {
    return this.current.flatMap(note => note.attachments ?? []).find(attachment => attachment.id === this.selectedId)?.id;
  }
  private async updateArchiveContext(note?: Note): Promise<void> {
    if (!this.tagMode) await vscode.commands.executeCommand('setContext', 'fnote.noteArchived', Boolean(note?.archived));
  }
  async collapseAll(): Promise<void> {
    await this.view?.webview.postMessage({ type: 'collapseAll' });
  }
  async expandAll(): Promise<void> {
    await this.view?.webview.postMessage({ type: 'expandAll' });
  }
  async reveal(note: Note): Promise<void> {
    this.selectedId = note.id;
    await this.updateArchiveContext(note);
    this.activeId = note.id;
    await this.view?.webview.postMessage({ type: 'select', id: note.id, active: true });
  }
  async startCreate(parent = ''): Promise<boolean> {
    return this.startEdit({ mode: 'create', parent });
  }
  async startRename(id: string): Promise<boolean> {
    return this.startEdit({ mode: 'rename', id });
  }
  private async startEdit(edit: Omit<NoteEdit, 'name'>): Promise<boolean> {
    if (!this.view) return false;
    this.pendingEdit = edit;
    if (!this.webviewReady) return true;
    this.pendingEdit = undefined;
    await this.view.webview.postMessage({ type: 'edit', ...edit });
    return true;
  }
  async update(notes: Note[]): Promise<void> {
    this.current = notes;
    await this.updateArchiveContext(this.current.find(note => note.id === this.selectedId));
    const attachments = notes.flatMap(note => note.attachments ?? []);
    this.outline = this.tagMode ? [] : notes.flatMap(note => {
      const rows: OutlineRow[] = [];
      const headings = parseHeadings(note.text);
      const stack: { level: number; id: string }[] = [];
      for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        if (heading.level === 1) { stack.length = 0; continue; }
        while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
        const id = `\0heading:${note.id}:${heading.start}`;
        const nextHeading = headings[index + 1];
        const ownTags = note.tags.filter(tag => tag.start >= heading.start && tag.start < (nextHeading?.start ?? note.text.length));
        const subtreeEnd = headings.slice(index + 1).find(next => next.level <= heading.level)?.start ?? note.text.length;
        const descendantTags = note.tags.filter(tag => tag.start >= (nextHeading?.start ?? subtreeEnd) && tag.start < subtreeEnd);
        const ownAppearance = this.headingAppearance?.(ownTags);
        const descendantAppearance = this.headingAppearance?.(descendantTags);
        rows.push({ id, parent: stack.at(-1)?.id ?? note.id, label: heading.title, noteId: note.id, offset: heading.start,
          appearance: ownAppearance, collapsedAppearance: descendantAppearance ?? ownAppearance, outlineMark: this.outlineMark?.() });
        stack.push({ level: heading.level, id });
      }
      return rows;
    });
    const attachmentRows = this.tagMode ? [] : attachments.map(attachment => ({
      id: attachment.id,
      parent: attachment.parent,
      label: attachment.name,
      attachment: true,
      directory: attachment.directory,
      appearance: this.attachmentAppearance?.(attachment),
    }));
    if (!this.view) return;
    const rows = await Promise.all(notes.map(async note => {
      const item = await this.data.getTreeItem(note);
      return { id: note.id, parent: note.parent, label: typeof item.label === 'string' ? item.label : item.label?.label ?? note.name, description: item.description, archived: note.archived, collapsedLabel: this.collapsedLabel?.(note), appearance: this.appearance?.(note, false), collapsedAppearance: this.appearance?.(note, true) };
    }));
    await this.view.webview.postMessage({ type: 'notes', rows: [...this.outline, ...rows, ...attachmentRows], selected: this.selectedId, active: this.activeId });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'notes.js'));
    const iconCss = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css'));
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${iconCss}"><style nonce="${nonce}">
body{--fnote-fallback-foreground:#cccccc;--fnote-foreground:var(--vscode-editor-foreground,var(--fnote-fallback-foreground));margin:0;color:var(--fnote-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}body.vscode-light,body.vscode-high-contrast-light{--fnote-fallback-foreground:#333333}body.vscode-dark,body.vscode-high-contrast{--fnote-fallback-foreground:#cccccc}#tree{color:var(--fnote-foreground);min-height:100vh;padding:2px 0 36px;box-sizing:border-box;outline:none}.row{color:var(--fnote-foreground);height:22px;display:flex;align-items:center;box-sizing:border-box;position:relative;white-space:nowrap;cursor:default}.row:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-list-hoverForeground,var(--fnote-foreground))}.row[data-outline="true"]:not(.selected){color:var(--vscode-descriptionForeground,var(--fnote-foreground))}.row.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground,var(--fnote-foreground))}#tree:focus-within .row.active.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground,var(--fnote-foreground))}.row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.row .note-icon{flex:none;margin-right:5px}.row .label{color:inherit;overflow:hidden;text-overflow:ellipsis}.toggle{flex:none;width:20px;padding:0;background:none;border:0;color:inherit;font:inherit;height:22px;cursor:pointer}.before::before,.after::after{content:'';position:absolute;height:2px;left:0;right:0;background:var(--vscode-list-dropBetweenBackground,var(--vscode-focusBorder));z-index:2}.before::before{top:0}.after::after{bottom:0}.inside{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;background:var(--vscode-list-dropBackground)}#root-drop{height:24px;margin:0 8px;color:var(--vscode-descriptionForeground);font-size:11px}#root-drop.over{border-top:2px solid var(--vscode-focusBorder)}#hint{padding:8px;color:var(--vscode-descriptionForeground)}.inline-input{flex:1;min-width:0;height:22px;box-sizing:border-box;padding:1px 4px;border:1px solid var(--vscode-focusBorder);border-radius:0;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit;outline:none}
</style></head><body data-tags="${this.tagMode}"><div id="tree" role="tree" aria-label="${this.tagMode ? 'Tags' : 'Notes'}" tabindex="0"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.subscriptions.push(webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      try {
        if (message.type === 'expansionState' && 'allCollapsed' in message && typeof message.allCollapsed === 'boolean'
          && 'hasBranches' in message && typeof message.hasBranches === 'boolean') {
          const prefix = this.tagMode ? 'fnote.tags' : 'fnote.notes';
          await vscode.commands.executeCommand('setContext', `${prefix}AllCollapsed`, message.allCollapsed);
          await vscode.commands.executeCommand('setContext', `${prefix}HasBranches`, message.hasBranches);
          return;
        }
        if (message.type === 'ready') {
          this.webviewReady = true;
          await this.update(this.current);
          if (this.pendingEdit) {
            const edit = this.pendingEdit;
            this.pendingEdit = undefined;
            await this.view?.webview.postMessage({ type: 'edit', ...edit });
          }
          return;
        }
        if (message.type === 'edit') {
          const mode = 'mode' in message && typeof message.mode === 'string' ? message.mode : undefined;
          const name = 'name' in message && typeof message.name === 'string' ? message.name : undefined;
          const id = 'id' in message && typeof message.id === 'string' ? message.id : undefined;
          const parent = 'parent' in message && typeof message.parent === 'string' ? message.parent : undefined;
          if (!this.onEdit || (mode !== 'create' && mode !== 'rename') || name === undefined
            || (mode === 'rename' && id === undefined) || ('parent' in message && parent === undefined)) return;
          const edit: NoteEdit = mode === 'rename'
            ? { mode: 'rename', id, name }
            : { mode: 'create', parent: parent ?? '', name };
          try {
            await this.onEdit(edit);
            await this.view?.webview.postMessage({ type: 'editResult', ok: true });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`fnote: ${detail}`);
            await this.view?.webview.postMessage({ type: 'editResult', ok: false, error: detail });
          }
          return;
        }
        if (!this.tagMode && message.type === 'command' && 'command' in message && message.command === 'add'
          && (!('id' in message) || message.id === undefined)) {
          await vscode.commands.executeCommand('fnote.add');
          return;
        }
        if ('id' in message && typeof message.id === 'string') {
          if (!this.tagMode && this.current.some(note => note.id === message.id) && message.type === 'attachmentDropError') {
            throw new Error('Could not read dropped attachments: ' + ('error' in message ? String(message.error) : 'Unknown error'));
          }
          if (!this.tagMode && this.current.some(note => note.id === message.id) && message.type === 'attachmentDrop') {
            if ('files' in message) await vscode.commands.executeCommand('fnote.dropAttachmentFiles', message.id, message.files);
            else if ('uris' in message && Array.isArray(message.uris) && message.uris.every(uri => typeof uri === 'string')) {
              await vscode.commands.executeCommand('fnote.dropAttachments', message.id, message.uris);
            }
            return;
          }
          const attachment = this.current.flatMap(note => note.attachments ?? []).find(item => item.id === message.id);
          if (attachment && message.type !== 'drop') {
            this.selectedId = attachment.id;
            await this.updateArchiveContext();
            if (message.type === 'openAttachment') this.activeId = attachment.id;
            if (message.type === 'openAttachment') {
              await vscode.commands.executeCommand('fnote.openAttachment', attachment.id);
              await this.view?.webview.postMessage({ type: 'select', id: attachment.id, active: true, focus: true });
            }
            if (message.type === 'command' && 'command' in message && message.command === 'rename') await this.startRename(attachment.id);
            if (message.type === 'command' && 'command' in message && message.command === 'deleteAttachment') await vscode.commands.executeCommand('fnote.deleteAttachment', attachment.id);
            if (message.type === 'command' && 'command' in message && message.command === 'add') await vscode.commands.executeCommand('fnote.add');
            return;
          }
          const heading = this.outline.find(row => row.id === message.id);
          if (heading) {
            this.selectedId = heading.noteId;
            await this.updateArchiveContext(this.current.find(note => note.id === heading.noteId));
            if (message.type === 'open') this.activeId = heading.noteId;
            if (message.type === 'open') await vscode.commands.executeCommand('fnote.open', heading.noteId, heading.offset, true);
            return;
          }
        }
        if (!('id' in message) || typeof message.id !== 'string') return;
        const messageNote = this.current.find(note => note.id === message.id);
        const messageAttachment = this.current.flatMap(note => note.attachments ?? []).find(item => item.id === message.id);
        if (!messageNote && !messageAttachment) return;
        this.selectedId = message.id;
        await this.updateArchiveContext(messageNote);
        if (message.type === 'open') {
          this.activeId = message.id;
          if (this.tagMode) await vscode.commands.executeCommand('fnote.filter', message.id, true);
          else await vscode.commands.executeCommand('fnote.open', message.id, undefined, true);
        }
        if (!this.tagMode && message.type === 'command' && 'command' in message && typeof message.command === 'string' && ['addChild', 'addAttachment', 'rename', 'archive', 'move', 'up', 'down', 'delete'].includes(message.command)) {
          await vscode.commands.executeCommand(`fnote.${message.command}`, this.selection[0]);
        }
        if (message.type === 'drop' && 'position' in message && ['before', 'after', 'inside'].includes(String(message.position))) {
          const target = 'target' in message && typeof message.target === 'string' ? message.target : undefined;
          if (target !== undefined && !this.current.some(note => note.id === target || (note.attachments ?? []).some(item => item.id === target))) return;
          await this.onDrop(message.id, target, message.position as DropPosition);
        }
      } catch (error) { void vscode.window.showErrorMessage(`fnote: ${error instanceof Error ? error.message : String(error)}`); }
    }));
  }
  dispose(): void { this.subscriptions.forEach(item => item.dispose()); }
}
