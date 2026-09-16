import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { parseHeadings, type Note } from './core';

interface OutlineRow { id: string; parent: string; label: string; noteId: string; offset: number }

export type DropPosition = 'before' | 'after' | 'inside';

export class NotesView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private current: Note[] = [];
  private selectedId?: string;
  private outline: OutlineRow[] = [];
  private subscriptions: vscode.Disposable[] = [];
  constructor(
    public readonly data: vscode.TreeDataProvider<Note>,
    private readonly extensionUri: vscode.Uri,
    private readonly onDrop: (id: string, target: string | undefined, position: DropPosition) => Promise<void>,
    private readonly tagMode = false,
    private readonly collapsedLabel?: (note: Note) => string
  ) {}
  get selection(): Note[] { return this.current.filter(note => note.id === this.selectedId); }
  async collapseAll(): Promise<void> {
    await this.view?.webview.postMessage({ type: 'collapseAll' });
  }
  async expandAll(): Promise<void> {
    await this.view?.webview.postMessage({ type: 'expandAll' });
  }
  async reveal(note: Note): Promise<void> {
    this.selectedId = note.id;
    await this.view?.webview.postMessage({ type: 'select', id: note.id });
  }
  async update(notes: Note[]): Promise<void> {
    this.current = notes;
    this.outline = this.tagMode ? [] : notes.flatMap(note => {
      const rows: OutlineRow[] = [];
      const stack: { level: number; id: string }[] = [];
      for (const heading of parseHeadings(note.text)) {
        if (heading.level === 1) { stack.length = 0; continue; }
        while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
        const id = `\0heading:${note.id}:${heading.start}`;
        rows.push({ id, parent: stack.at(-1)?.id ?? note.id, label: heading.title, noteId: note.id, offset: heading.start });
        stack.push({ level: heading.level, id });
      }
      return rows;
    });
    if (!this.view) return;
    const rows = await Promise.all(notes.map(async note => {
      const item = await this.data.getTreeItem(note);
      return { id: note.id, parent: note.parent, label: typeof item.label === 'string' ? item.label : item.label?.label ?? note.name, description: item.description, collapsedLabel: this.collapsedLabel?.(note) };
    }));
    await this.view.webview.postMessage({ type: 'notes', rows: [...this.outline, ...rows], selected: this.selectedId });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'notes.js'));
    webview.html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
body{--fnote-fallback-foreground:#cccccc;--fnote-foreground:var(--vscode-editor-foreground,var(--fnote-fallback-foreground));margin:0;color:var(--fnote-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}body.vscode-light,body.vscode-high-contrast-light{--fnote-fallback-foreground:#333333}body.vscode-dark,body.vscode-high-contrast{--fnote-fallback-foreground:#cccccc}#tree{color:var(--fnote-foreground);min-height:100vh;padding:2px 0 36px;box-sizing:border-box;outline:none}.row{color:var(--fnote-foreground);height:22px;display:flex;align-items:center;box-sizing:border-box;position:relative;white-space:nowrap;cursor:default}.row:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-list-hoverForeground,var(--fnote-foreground))}.row.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground,var(--fnote-foreground))}.row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.row .label{color:inherit;overflow:hidden;text-overflow:ellipsis}.toggle{flex:none;width:20px;padding:0;background:none;border:0;color:inherit;font:inherit;height:22px;cursor:pointer}.before::before,.after::after{content:'';position:absolute;height:2px;left:0;right:0;background:var(--vscode-list-dropBetweenBackground,var(--vscode-focusBorder));z-index:2}.before::before{top:0}.after::after{bottom:0}.inside{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;background:var(--vscode-list-dropBackground)}#root-drop{height:24px;margin:0 8px;color:var(--vscode-descriptionForeground);font-size:11px}#root-drop.over{border-top:2px solid var(--vscode-focusBorder)}#hint{padding:8px;color:var(--vscode-descriptionForeground)}#menu{position:fixed;z-index:10;background:var(--vscode-menu-background);color:var(--vscode-menu-foreground,var(--fnote-foreground));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border));box-shadow:0 2px 8px #0004;padding:4px;max-height:90vh;overflow:auto}#menu button{display:block;width:100%;border:0;text-align:left;padding:4px 12px;font:inherit;background:none;color:inherit}#menu button:hover,#menu button:focus{background:var(--vscode-menu-selectionBackground);color:var(--vscode-menu-selectionForeground,var(--fnote-foreground))}
</style></head><body data-tags="${this.tagMode}"><div id="tree" role="tree" aria-label="${this.tagMode ? 'タグ一覧' : 'ノート一覧'}" tabindex="0"></div><div id="menu" role="menu" hidden></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
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
        if (message.type === 'ready') { await this.update(this.current); return; }
        if ('id' in message && typeof message.id === 'string') {
          const heading = this.outline.find(row => row.id === message.id);
          if (heading) {
            this.selectedId = heading.noteId;
            if (message.type === 'open') await vscode.commands.executeCommand('fnote.open', heading.noteId, heading.offset, true);
            return;
          }
        }
        if (!('id' in message) || typeof message.id !== 'string' || !this.current.some(note => note.id === message.id)) return;
        this.selectedId = message.id;
        if (message.type === 'open') {
          if (this.tagMode) await vscode.commands.executeCommand('fnote.filter', message.id);
          else await vscode.commands.executeCommand('fnote.open', message.id, undefined, true);
        }
        if (!this.tagMode && message.type === 'command' && 'command' in message && typeof message.command === 'string' && ['addChild', 'rename', 'move', 'up', 'down', 'delete'].includes(message.command)) {
          await vscode.commands.executeCommand(`fnote.${message.command}`, this.selection[0]);
        }
        if (message.type === 'drop' && 'position' in message && ['before', 'after', 'inside'].includes(String(message.position))) {
          const target = 'target' in message && typeof message.target === 'string' ? message.target : undefined;
          if (target !== undefined && !this.current.some(note => note.id === target)) return;
          await this.onDrop(message.id, target, message.position as DropPosition);
        }
      } catch (error) { void vscode.window.showErrorMessage(`fnote: ${error instanceof Error ? error.message : String(error)}`); }
    }));
  }
  dispose(): void { this.subscriptions.forEach(item => item.dispose()); }
}
