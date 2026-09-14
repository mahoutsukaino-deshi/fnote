import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { Note } from './core';

export type DropPosition = 'before' | 'after' | 'inside';

export class NotesView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private current: Note[] = [];
  private selectedId?: string;
  private subscriptions: vscode.Disposable[] = [];
  constructor(
    public readonly data: vscode.TreeDataProvider<Note>,
    private readonly extensionUri: vscode.Uri,
    private readonly onDrop: (id: string, target: string | undefined, position: DropPosition) => Promise<void>,
    private readonly tagMode = false
  ) {}
  get selection(): Note[] { return this.current.filter(note => note.id === this.selectedId); }
  async reveal(note: Note): Promise<void> {
    this.selectedId = note.id;
    await this.view?.webview.postMessage({ type: 'select', id: note.id });
  }
  async update(notes: Note[]): Promise<void> {
    this.current = notes;
    if (!this.view) return;
    const rows = await Promise.all(notes.map(async note => {
      const item = await this.data.getTreeItem(note);
      return { id: note.id, parent: note.parent, label: typeof item.label === 'string' ? item.label : item.label?.label ?? note.name, description: item.description };
    }));
    await this.view.webview.postMessage({ type: 'notes', rows, selected: this.selectedId });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'notes.js'));
    webview.html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
body{--fnote-fallback-foreground:#cccccc;--fnote-foreground:var(--vscode-editor-foreground,var(--fnote-fallback-foreground));margin:0;color:var(--fnote-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}body.vscode-light,body.vscode-high-contrast-light{--fnote-fallback-foreground:#333333}body.vscode-dark,body.vscode-high-contrast{--fnote-fallback-foreground:#cccccc}#tree{color:var(--fnote-foreground);min-height:100vh;padding:2px 0 36px;box-sizing:border-box;outline:none}.row{color:var(--fnote-foreground);height:24px;display:flex;align-items:center;box-sizing:border-box;position:relative;white-space:nowrap;cursor:default}.row:hover{background:var(--vscode-list-hoverBackground)}.row.selected{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground,var(--fnote-foreground))}.row:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.row.selected:focus{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground,var(--fnote-foreground))}.row .label{color:inherit;overflow:hidden;text-overflow:ellipsis}.toggle{flex:none;width:20px;padding:0;background:none;border:0;color:inherit;font:inherit;height:22px;cursor:pointer}.before::before,.after::after{content:'';position:absolute;height:2px;left:0;right:0;background:var(--vscode-list-dropBetweenBackground,var(--vscode-focusBorder));z-index:2}.before::before{top:0}.after::after{bottom:0}.inside{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;background:var(--vscode-list-dropBackground)}#root-drop{height:24px;margin:0 8px;color:var(--vscode-descriptionForeground);font-size:11px}#root-drop.over{border-top:2px solid var(--vscode-focusBorder)}#hint{padding:8px;color:var(--vscode-descriptionForeground)}#menu{position:fixed;z-index:10;background:var(--vscode-menu-background);color:var(--vscode-menu-foreground,var(--fnote-foreground));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border));box-shadow:0 2px 8px #0004;padding:4px;max-height:90vh;overflow:auto}#menu button{display:block;width:100%;border:0;text-align:left;padding:4px 12px;font:inherit;background:none;color:inherit}#menu button:hover,#menu button:focus{background:var(--vscode-menu-selectionBackground);color:var(--vscode-menu-selectionForeground,var(--fnote-foreground))}
</style></head><body data-tags="${this.tagMode}"><div id="tree" role="tree" aria-label="${this.tagMode ? 'タグ一覧' : 'ノート一覧'}" tabindex="0"></div><div id="menu" role="menu" hidden></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.subscriptions.push(webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      try {
        if (message.type === 'ready') { await this.update(this.current); return; }
        if (!('id' in message) || typeof message.id !== 'string' || !this.current.some(note => note.id === message.id)) return;
        this.selectedId = message.id;
        if (message.type === 'open') await vscode.commands.executeCommand(this.tagMode ? 'fnote.filter' : 'fnote.open', message.id);
        if (!this.tagMode && message.type === 'command' && 'command' in message && typeof message.command === 'string' && ['addChild', 'rename', 'move', 'up', 'down', 'delete'].includes(message.command)) {
          await vscode.commands.executeCommand(`fnote.${message.command}`, this.selection[0]);
        }
        if (message.type === 'drop' && 'position' in message && ['before', 'after', 'inside'].includes(String(message.position))) {
          const target = 'target' in message && typeof message.target === 'string' ? message.target : undefined;
          await this.onDrop(message.id, target, message.position as DropPosition);
        }
      } catch (error) { void vscode.window.showErrorMessage(`fnote: ${error instanceof Error ? error.message : String(error)}`); }
    }));
  }
  dispose(): void { this.subscriptions.forEach(item => item.dispose()); }
}
