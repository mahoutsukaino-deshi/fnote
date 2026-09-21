(() => {
  const api = acquireVsCodeApi();
  const tree = document.getElementById('tree');
  const menu = document.getElementById('menu');
  const tagMode = document.body.dataset.tags === 'true';
  const saved = api.getState() || {};
  let rows = [], selected = saved.selected, collapsed = new Set(saved.collapsed || []);
  const dateBranches = new Set(saved.dateBranches || []);
  let dragging, drop, pending;
  const within = (id, parent) => {
    for (let key = id; key; key = rows.find(row => row.id === key)?.parent) if (key === parent) return true;
    return false;
  };
  const persist = () => api.setState({ selected, collapsed: [...collapsed], dateBranches: [...dateBranches] });
  const send = (type, id, rest = {}) => api.postMessage({ type, id, ...rest });
  function select(id, focus = false) {
    selected = id; persist();
    for (const row of tree.querySelectorAll('.row')) {
      const active = row.dataset.id === id;
      row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active)); row.tabIndex = active ? 0 : -1;
      if (active && focus) row.focus();
    }
  }
  function render() {
    const scroll = window.scrollY;
    const hadFocus = tree.contains(document.activeElement);
    tree.replaceChildren();
    let hasExpandedBranch = false;
    function branch(parent, depth) {
      for (const note of rows.filter(row => row.parent === parent)) {
        const hasChildren = rows.some(row => row.parent === note.id);
        const row = document.createElement('div'); row.className = 'row'; row.dataset.id = note.id;
        row.dataset.outline = String(Boolean(note.noteId));
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
        if (icon) {
          const mark = document.createElement('span');
          mark.className = `note-icon codicon codicon-${icon[1]}`;
          mark.setAttribute('aria-hidden', 'true');
          if (appearance.color) mark.style.color = appearance.color;
          if (label.textContent.startsWith(appearance.mark + ' ')) label.textContent = label.textContent.slice(appearance.mark.length + 1);
          row.append(mark);
        }
        row.append(label);
        if (note.description) { const count = document.createElement('span'); count.textContent = note.description; count.style.cssText = 'margin-left:8px;opacity:.7'; row.append(count); }
        tree.append(row);
        row.onclick = () => { select(note.id, true); send('open', note.id); };
        row.oncontextmenu = e => { e.preventDefault(); if (tagMode || note.noteId) return; select(note.id, true); showMenu(e.clientX, e.clientY, note.id); };
        row.ondragstart = e => { if (note.noteId) { e.preventDefault(); return; } dragging = note.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', note.id); menu.hidden = true; select(note.id); };
        if (!collapsed.has(note.id)) branch(note.id, depth + 1);
      }
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
    if (!row) {
      drop = { target: undefined, position: 'inside' };
      const rootDrop = document.getElementById('root-drop'); rootDrop.classList.add('over'); rootDrop.textContent = (tagMode ? 'Move to the end of this level' : 'Move to the end of the top level');
      return;
    }
    const target = row.dataset.id;
    if (rows.find(item => item.id === target)?.noteId) return;
    if (within(target, dragging)) return;
    if (tagMode && rows.find(item => item.id === target)?.parent !== rows.find(item => item.id === dragging)?.parent) return;
    const bounds = row.getBoundingClientRect();
    const ratio = (e.clientY - bounds.top) / bounds.height;
    const position = tagMode ? (ratio < 0.5 ? 'before' : 'after') : ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
    drop = { target, position };
    let indicator = row;
    if (position === 'after') {
      while (indicator.nextElementSibling?.classList.contains('row') && within(indicator.nextElementSibling.dataset.id, target)) indicator = indicator.nextElementSibling;
    }
    indicator.classList.add(position);
  }
  tree.addEventListener('dragover', e => {
    if (!dragging) return;
    e.preventDefault(); locate(e); e.dataTransfer.dropEffect = drop ? 'move' : 'none';
    if (e.clientY < 32) window.scrollBy(0, -12);
    if (e.clientY > window.innerHeight - 32) window.scrollBy(0, 12);
  });
  tree.addEventListener('dragleave', e => { if (!tree.contains(e.relatedTarget)) clearDrop(); });
  tree.addEventListener('drop', e => {
    e.preventDefault(); locate(e);
    if (dragging && drop) send('drop', dragging, drop);
    finishDrag();
  });
  function finishDrag() { dragging = undefined; clearDrop(); document.getElementById('root-drop').textContent = ''; if (pending) { rows = pending; pending = undefined; render(); } }
  document.addEventListener('dragend', finishDrag);
  function showMenu(x, y, id) {
    menu.replaceChildren();
    for (const [command, title] of [['addChild', 'Add Child Note'], ['rename', 'Rename'], ['move', 'Move'], ['up', 'Move Up'], ['down', 'Move Down'], ['delete', 'Delete']]) {
      const button = document.createElement('button'); button.textContent = title; button.setAttribute('role', 'menuitem');
      button.onclick = () => { menu.hidden = true; send('command', id, { command }); }; menu.append(button);
    }
    menu.hidden = false; menu.style.left = `${Math.max(0, Math.min(x, innerWidth - menu.offsetWidth))}px`; menu.style.top = `${Math.max(0, Math.min(y, innerHeight - menu.offsetHeight))}px`;
    menu.firstChild.focus();
  }
  document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { menu.hidden = true; clearDrop(); } });
  tree.addEventListener('keydown', e => {
    const visible = [...tree.querySelectorAll('.row')];
    const current = rows.find(row => row.id === selected); const index = visible.findIndex(row => row.dataset.id === selected);
    let next;
    if (e.key === 'ArrowDown') next = visible[Math.min(index + 1, visible.length - 1)];
    if (e.key === 'ArrowUp') next = visible[Math.max(index - 1, 0)];
    if (e.key === 'Home') next = visible[0]; if (e.key === 'End') next = visible.at(-1);
    if (next) { e.preventDefault(); select(next.dataset.id, true); send('select', next.dataset.id); }
    if (!current) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); send('open', current.id); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (!collapsed.has(current.id) && rows.some(row => row.parent === current.id)) { collapsed.add(current.id); persist(); render(); select(current.id, true); } else if (current.parent) { select(current.parent, true); send('select', current.parent); } }
    if (e.key === 'ArrowRight') { e.preventDefault(); collapsed.delete(current.id); persist(); render(); select(current.id, true); }
    if (!tagMode && !current.noteId && e.key === 'F2') { e.preventDefault(); e.stopPropagation(); send('command', current.id, { command: 'rename' }); }
    if (!tagMode && !current.noteId && e.key === 'Delete') send('command', current.id, { command: 'delete' });
    if (!tagMode && !current.noteId && e.key === 'F10' && e.shiftKey) { e.preventDefault(); const rect = visible[index].getBoundingClientRect(); showMenu(rect.left, rect.bottom, current.id); }
  });
  window.addEventListener('message', e => {
    const message = e.data;
    if (message.type === 'notes' && tagMode) {
      for (const row of message.rows) {
        if (!/^\d{4}(?:\/\d{2})?$/.test(row.id) || !message.rows.some(child => child.parent === row.id)) continue;
        if (!dateBranches.has(row.id)) { collapsed.add(row.id); dateBranches.add(row.id); }
      }
      persist();
    }
    if (message.type === 'notes') { if (dragging) { pending = message.rows; return; } rows = message.rows; selected = message.selected ?? selected; render(); }
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
      selected = message.id; persist(); render();
      tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    }
  });
  send('ready');
})();
