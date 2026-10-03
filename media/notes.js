(() => {
  const api = acquireVsCodeApi();
  const tree = document.getElementById('tree');
  const tagMode = document.body.dataset.tags === 'true';
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const saved = api.getState() || {};
  let rows = [], selected = saved.selected, active = saved.active, collapsed = new Set(saved.collapsed || []);
  const dateBranches = new Set(saved.dateBranches || []);
  let dragging, drop, pending, editing, editInput;
  const within = (id, parent) => {
    for (let key = id; key; key = rows.find(row => row.id === key)?.parent) if (key === parent) return true;
    return false;
  };
  const persist = () => api.setState({ selected, active, collapsed: [...collapsed], dateBranches: [...dateBranches] });
  const send = (type, id, rest = {}) => api.postMessage({ type, id, ...rest });
  function select(id, focus = false) {
    selected = id; persist();
    for (const row of tree.querySelectorAll('.row')) {
      const active = row.dataset.id === id;
      row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active)); row.tabIndex = active ? 0 : -1;
      if (active && focus) row.focus();
    }
  }
  function setActive(id) {
    active = id; persist();
    for (const row of tree.querySelectorAll('.row')) row.classList.toggle('active', row.dataset.id === id);
  }
  function beginEdit(request) {
    editing = { ...request, busy: false };
    if (editing.mode === 'create' && editing.parent) collapsed.delete(editing.parent);
    if (editing.mode === 'rename') {
      let parent = rows.find(row => row.id === editing.id)?.parent;
      while (parent) { collapsed.delete(parent); parent = rows.find(row => row.id === parent)?.parent; }
    }
    persist(); render();
    editInput?.focus(); editInput?.select();
  }
  function finishEdit(commit) {
    if (!editing || editing.busy) return;
    if (!commit) { editing = undefined; render(); return; }
    const name = editInput?.value ?? '';
    if (!name) { editing = undefined; render(); return; }
    editing.busy = true;
    editInput.disabled = true;
    api.postMessage({ type: 'edit', mode: editing.mode, id: editing.id, parent: editing.parent, name });
  }
  function addInlineEditor(row, value) {
    const input = document.createElement('input');
    input.className = 'inline-input'; input.type = 'text'; input.value = value;
    input.setAttribute('aria-label', editing.mode === 'create' ? 'New note name' : 'Note name');
    let composing = false;
    input.oncompositionstart = () => { composing = true; };
    input.oncompositionend = () => { composing = false; };
    input.onclick = e => e.stopPropagation(); input.onmousedown = e => e.stopPropagation();
    input.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter' && !composing && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finishEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    };
    input.onblur = () => finishEdit(true);
    row.append(input); editInput = input;
  }
  function addCreateRow(parent, depth) {
    const row = document.createElement('div'); row.className = 'row editing';
    row.dataset.id = '\0editing'; row.dataset.outline = 'false'; row.dataset.attachment = 'false';
    row.style.paddingLeft = `${depth * 16 + 4}px`; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1));
    const toggle = document.createElement('button'); toggle.className = 'toggle'; toggle.tabIndex = -1; toggle.textContent = '';
    row.append(toggle); addInlineEditor(row, ''); tree.append(row);
  }
  function render() {
    const scroll = window.scrollY;
    const hadFocus = tree.contains(document.activeElement);
    tree.replaceChildren(); editInput = undefined;
    let hasExpandedBranch = false;
    function branch(parent, depth) {
      for (const note of rows.filter(row => row.parent === parent)) {
        const hasChildren = rows.some(row => row.parent === note.id);
        const row = document.createElement('div'); row.className = 'row'; row.classList.toggle('active', note.id === active); row.dataset.id = note.id;
        row.dataset.outline = String(Boolean(note.noteId));
        row.dataset.attachment = String(Boolean(note.attachment));
        row.draggable = !note.noteId; row.style.paddingLeft = `${depth * 16 + 4}px`;
        row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.title = note.noteId ? note.label : note.id;
        if (hasChildren && !collapsed.has(note.id)) hasExpandedBranch = true;
        if (hasChildren) row.setAttribute('aria-expanded', String(!collapsed.has(note.id)));
        const toggle = document.createElement('button'); toggle.className = 'toggle'; toggle.tabIndex = -1;
        toggle.textContent = hasChildren ? (collapsed.has(note.id) ? '▸' : '▾') : '';
        toggle.setAttribute('aria-label', collapsed.has(note.id) ? 'Expand' : 'Collapse');
        toggle.onclick = e => { e.stopPropagation(); if (hasChildren) { collapsed.has(note.id) ? collapsed.delete(note.id) : collapsed.add(note.id); persist(); render(); select(note.id, true); send('select', note.id); } };
        const label = document.createElement('span'); label.className = 'label'; label.textContent = collapsed.has(note.id) ? (note.collapsedLabel ?? note.label) : note.label;
        row.append(toggle);
        const appearance = collapsed.has(note.id) ? note.collapsedAppearance : note.appearance;
        const icon = /^\$\(([a-z0-9-]+)\)$/.exec(appearance?.mark || '');
        if (icon && label.textContent.startsWith(appearance.mark + ' ')) label.textContent = label.textContent.slice(appearance.mark.length + 1);
        const renaming = editing?.mode === 'rename' && editing.id === note.id;
        if (!renaming) {
          if (icon) {
            const mark = document.createElement('span');
            mark.className = `note-icon codicon codicon-${icon[1]}`;
            mark.setAttribute('aria-hidden', 'true');
            if (appearance.color) mark.style.color = appearance.color;
            row.append(mark);
          }
          row.append(label);
          if (note.description) { const count = document.createElement('span'); count.textContent = note.description; count.style.cssText = 'margin-left:8px;opacity:.7'; row.append(count); }
        } else {
          row.classList.add('editing'); addInlineEditor(row, label.textContent);
        }
        tree.append(row);
        row.onclick = () => { setActive(note.id); select(note.id, true); send(note.attachment ? 'openAttachment' : 'open', note.id); };
        row.dataset.vscodeContext = JSON.stringify({
          webviewSection: note.noteId ? 'outline' : note.attachment ? 'attachment' : 'note',
          preventDefaultContextMenuItems: true,
        });
        row.oncontextmenu = () => {
          if (tagMode || note.noteId) return;
          select(note.id, true);
          send('select', note.id);
        };
        row.ondragstart = e => { if (note.noteId) { e.preventDefault(); return; } dragging = note.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', note.id); select(note.id); };
        if (!collapsed.has(note.id)) branch(note.id, depth + 1);
      }
      if (editing?.mode === 'create' && editing.parent === parent) addCreateRow(parent, depth);
    }
    branch('', 0);
    if (!rows.length) {
      const hint = document.createElement('div'); hint.id = 'hint'; hint.textContent = tagMode ? 'Add tags to your notes to see them here.' : 'Click + to add a note.'; tree.append(hint);
    }
    const rootDrop = document.createElement('div'); rootDrop.id = 'root-drop'; rootDrop.textContent = dragging ? (tagMode ? 'Move to the end of this level' : 'Move to the end of the top level') : ''; tree.append(rootDrop);
    select(selected, hadFocus); window.scrollTo(0, scroll);
    send('expansionState', undefined, { allCollapsed: !hasExpandedBranch, hasBranches: rows.some(row => row.parent && rows.some(parent => parent.id === row.parent)) });
  }
  function clearDrop() {
    tree.querySelectorAll('.before,.after,.inside,.over').forEach(row => row.classList.remove('before', 'after', 'inside', 'over'));
    drop = undefined;
  }
  function locate(e) {
    clearDrop();
    if (!dragging) return;
    const row = e.target.closest('.row');
    const source = rows.find(item => item.id === dragging);
    if (!row) {
      if (source?.attachment) return;
      drop = { target: undefined, position: 'inside' };
      const rootDrop = document.getElementById('root-drop'); rootDrop.classList.add('over'); rootDrop.textContent = (tagMode ? 'Move to the end of this level' : 'Move to the end of the top level');
      return;
    }
    const target = row.dataset.id;
    const targetRow = rows.find(item => item.id === target);
    if (!targetRow || targetRow.noteId || (!source?.attachment && targetRow.attachment)) return;
    if (within(target, dragging)) return;
    if (tagMode && rows.find(item => item.id === target)?.parent !== rows.find(item => item.id === dragging)?.parent) return;
    const bounds = row.getBoundingClientRect();
    const ratio = (e.clientY - bounds.top) / bounds.height;
    const position = tagMode ? (ratio < 0.5 ? 'before' : 'after') : ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
    if (source?.attachment && position === 'inside' && targetRow.attachment && !targetRow.directory) return;
    drop = { target, position };
    let indicator = row;
    if (position === 'after') {
      while (indicator.nextElementSibling?.classList.contains('row') && within(indicator.nextElementSibling.dataset.id, target)) indicator = indicator.nextElementSibling;
    }
    indicator.classList.add(position);
  }
  function attachmentTarget(event) {
    if (tagMode) return;
    const row = event.target.closest('.row');
    if (!row || row.dataset.outline === 'true') return;
    let id = row.dataset.id;
    while (id) {
      const current = rows.find(item => item.id === id);
      if (!current) return;
      if (!current.attachment) return current.id;
      id = current.parent;
    }
  }
  function hasExternalFiles(event) {
    return [...(event.dataTransfer?.types || [])].some(type => ['files', 'text/uri-list', 'text/plain'].includes(String(type).toLowerCase()));
  }
  // These handlers only run AFTER the host allows events into the webview.
  // Shift is still required to re-enable the iframe in WebviewWindowDragMonitor.
  // VS Code also listens on the webview window. Letting dragenter reach it enables
  // an overlay that intercepts the subsequent drop and opens the file instead.
  // Cover the whole document, including empty space crossed before a note row.
  for (const type of ['dragenter', 'dragover', 'drop']) {
    document.addEventListener(type, event => {
      if (tagMode || dragging || !hasExternalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = attachmentTarget(event) ? 'copy' : 'none';
    });
  }
  function externalUris(event) {
    const listed = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '';
    const uris = listed.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#') && (value.startsWith('file://') || value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)));
    if (uris.length) return [...new Set(uris)];
    return [];
  }
  async function droppedFiles(dataTransfer) {
    // File.path is not exposed in a sandboxed webview. Read the File itself.
    const items = [...(dataTransfer.items || [])];
    const entries = items.map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    const files = [...(dataTransfer.files || [])];
    const result = [];
    async function readFile(file, name) {
      result.push({ name, data: Array.from(new Uint8Array(await file.arrayBuffer())) });
    }
    async function readEntry(entry, prefix = '') {
      const name = prefix + entry.name;
      if (entry.isFile) await readFile(await new Promise((resolve, reject) => entry.file(resolve, reject)), name);
      else if (entry.isDirectory) {
        result.push({ name, directory: true });
        const reader = entry.createReader();
        for (;;) {
          const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!children.length) break;
          for (const child of children) await readEntry(child, name + '/');
        }
      }
    }
    if (entries.length) for (const entry of entries) await readEntry(entry);
    else for (const file of files) await readFile(file, file.name);
    return result;
  }
  tree.addEventListener('dragover', e => {
    if (!dragging) {
      if (!hasExternalFiles(e)) return;
      const target = attachmentTarget(e);
      if (!target) return;
      e.preventDefault(); clearDrop(); e.target.closest('.row').classList.add('inside'); drop = { target, position: 'attachment' }; e.dataTransfer.dropEffect = 'copy';
      return;
    }
    e.preventDefault(); locate(e); e.dataTransfer.dropEffect = drop ? 'move' : 'none';
    if (e.clientY < 32) window.scrollBy(0, -12);
    if (e.clientY > window.innerHeight - 32) window.scrollBy(0, 12);
  });
  tree.addEventListener('dragleave', e => { if (!tree.contains(e.relatedTarget)) clearDrop(); });
  tree.addEventListener('drop', async e => {
    if (!dragging) {
      const target = attachmentTarget(e);
      if (!target || !hasExternalFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      const uris = externalUris(e);
      try {
        // Capture file handles before the browser clears the drag data store.
        const files = await droppedFiles(e.dataTransfer);
        if (files.length) send('attachmentDrop', target, { files });
        else if (uris.length) send('attachmentDrop', target, { uris });
        else send('attachmentDropError', target, { error: 'No readable files were found in the drop.' });
      } catch (error) {
        send('attachmentDropError', target, { error: String(error) });
      } finally { finishDrag(); }
      return;
    }
    e.preventDefault(); locate(e);
    if (dragging && drop) send('drop', dragging, drop);
    finishDrag();
  });
  function finishDrag() { dragging = undefined; clearDrop(); document.getElementById('root-drop').textContent = ''; if (pending) { rows = pending; pending = undefined; render(); } }
  document.addEventListener('dragend', finishDrag);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') clearDrop(); });
  tree.addEventListener('keydown', e => {
    const visible = [...tree.querySelectorAll('.row')];
    const current = rows.find(row => row.id === selected); const index = visible.findIndex(row => row.dataset.id === selected);
    let next;
    if (e.key === 'ArrowDown') next = visible[Math.min(index + 1, visible.length - 1)];
    if (e.key === 'ArrowUp') next = visible[Math.max(index - 1, 0)];
    if (e.key === 'Home') next = visible[0]; if (e.key === 'End') next = visible.at(-1);
    if (next) { e.preventDefault(); select(next.dataset.id, true); send('select', next.dataset.id); }
    const newNoteKey = !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n'
      && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
    if (!tagMode && newNoteKey) {
      e.preventDefault(); e.stopPropagation();
      if (current && !current.noteId && !current.attachment) send('command', current.id, { command: 'addChild' });
      else if (current?.attachment) send('command', current.id, { command: 'add' });
      else api.postMessage({ type: 'command', command: 'add' });
      return;
    }
    if (!current) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(current.id); send(current.attachment ? 'openAttachment' : 'open', current.id); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (!collapsed.has(current.id) && rows.some(row => row.parent === current.id)) { collapsed.add(current.id); persist(); render(); select(current.id, true); } else if (current.parent) { select(current.parent, true); send('select', current.parent); } }
    if (e.key === 'ArrowRight') { e.preventDefault(); collapsed.delete(current.id); persist(); render(); select(current.id, true); }
    if (!tagMode && !current.noteId && e.key === 'F2') { e.preventDefault(); e.stopPropagation(); send('command', current.id, { command: 'rename' }); }
    const deleteKey = isMac
      ? e.metaKey && !e.ctrlKey && e.key === 'Backspace'
      : !e.metaKey && !e.ctrlKey && e.key === 'Delete';
    if (!tagMode && !current.noteId && deleteKey) { e.preventDefault(); e.stopPropagation(); send('command', current.id, { command: current.attachment ? 'deleteAttachment' : 'delete' }); }
    if (!tagMode && !current.noteId && e.key === 'F10' && e.shiftKey) {
      e.preventDefault();
      const rect = visible[index].getBoundingClientRect();
      visible[index].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left, clientY: rect.bottom }));
    }
  });
  window.addEventListener('message', e => {
    const message = e.data;
    if (message.type === 'edit') {
      beginEdit(message);
      return;
    }
    if (message.type === 'editResult' && editing) {
      if (message.ok) { editing = undefined; render(); }
      else if (!editing.busy) return;
      else { editing.busy = false; editInput.disabled = false; editInput.focus(); editInput.select(); }
      return;
    }
    if (message.type === 'notes' && tagMode) {
      for (const row of message.rows) {
        if (!/^\d{4}(?:\/\d{2})?$/.test(row.id) || !message.rows.some(child => child.parent === row.id)) continue;
        if (!dateBranches.has(row.id)) { collapsed.add(row.id); dateBranches.add(row.id); }
      }
      persist();
    }
    if (message.type === 'notes') { if (dragging) { pending = message.rows; return; } rows = message.rows; selected = message.selected ?? selected; active = message.active ?? active; render(); }
    if (message.type === 'expandAll') {
      collapsed.clear(); persist(); render();
    }
    if (message.type === 'collapseAll') {
      collapsed = new Set((pending || rows).map(row => row.parent).filter(Boolean));
      while (selected && rows.find(row => row.id === selected)?.parent) selected = rows.find(row => row.id === selected).parent;
      persist(); render();
    }
    if (message.type === 'select') {
      let id = message.id;
      while ((id = rows.find(row => row.id === id)?.parent)) collapsed.delete(id);
      selected = message.id; if (message.active) active = message.id; persist(); render();
      if (message.focus) select(message.id, true);
      tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    }
  });
  send('ready');
})();
