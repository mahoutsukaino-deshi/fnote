import * as vscode from 'vscode';
import type { Note } from './core';
import { linkMark, linkIconUri } from './linkMark';

const favoriteMime = 'application/vnd.fnote.favorite';

/** Drag and drop only reorders shortcuts already in this list. */
export class FavoriteView implements vscode.TreeDataProvider<Note>, vscode.TreeDragAndDropController<Note>, vscode.Disposable {
  private readonly events = new vscode.EventEmitter<Note | undefined>();
  readonly onDidChangeTreeData = this.events.event;
  readonly dropMimeTypes = [favoriteMime];
  readonly dragMimeTypes = [favoriteMime];
  private readonly view: vscode.TreeView<Note>;
  private current: Note[] = [];
  private presentation = '';
  constructor(
    private readonly onReorder: (id: string, target: string | undefined) => Promise<void>,
    private readonly appearance: (note: Note) => { mark: string; color?: string },
  ) {
    this.view = vscode.window.createTreeView('fnote.favorite', { treeDataProvider: this, dragAndDropController: this });
  }
  get selection(): readonly Note[] { return this.view.selection; }
  update(notes: Note[]): void {
    const presentation = JSON.stringify(notes.map(note => [note.id, note.name, this.appearance(note)]));
    this.current = notes;
    if (presentation === this.presentation) return;
    this.presentation = presentation;
    this.events.fire(undefined);
  }
  getChildren(parent?: Note): Note[] { return parent ? [] : this.current; }
  getTreeItem(note: Note): vscode.TreeItem {
    const appearance = this.appearance(note);
    const mark = linkMark(appearance.mark);
    const item = new vscode.TreeItem(`${mark.text ? `${mark.text} ` : ''}${note.name}`, vscode.TreeItemCollapsibleState.None);
    item.id = note.id;
    item.contextValue = 'favorite';
    item.tooltip = note.id;
    item.command = { command: 'fnote.open', title: 'Open', arguments: [note.id, undefined, true] };
    if (mark.icon) item.iconPath = {
      light: vscode.Uri.parse(linkIconUri(mark.icon, appearance.color ?? '#333333')),
      dark: vscode.Uri.parse(linkIconUri(mark.icon, appearance.color ?? '#cccccc')),
    };
    return item;
  }
  handleDrag(sources: readonly Note[], transfer: vscode.DataTransfer): void {
    const note = sources[0];
    if (note && this.current.some(item => item.id === note.id)) {
      transfer.set(favoriteMime, new vscode.DataTransferItem(JSON.stringify({ id: note.id })));
    }
  }
  async handleDrop(target: Note | undefined, transfer: vscode.DataTransfer): Promise<void> {
    if (target && !this.current.some(note => note.id === target.id)) return;
    try {
      const item = transfer.get(favoriteMime);
      if (!item) return;
      let value: unknown;
      try { value = JSON.parse(await item.asString()); } catch { return; }
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return;
      if (this.current.some(note => note.id === value.id)) await this.onReorder(value.id, target?.id);
    } catch (error) { void vscode.window.showErrorMessage(`fnote: ${error instanceof Error ? error.message : String(error)}`); }
  }
  dispose(): void { this.view.dispose(); this.events.dispose(); }
}
