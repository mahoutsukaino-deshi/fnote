(() => {
  const api = acquireVsCodeApi();
  const tree = document.getElementById('tree');
  const menu = document.getElementById('menu');
  const tagMode = document.body.dataset.tags === 'true';
  const saved = api.getState() || {};
  let rows = [], selected = saved.selected, collapsed = new Set(saved.collapsed || []);
  const dateBranches = new Set(saved.dateBranches || []);
  let dragging, drop, pending;
  const within = (id, parent) => id === parent || id.startsWith(parent + '/');
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
    tree.replaceChildren();
    function branch(parent, depth) {
      for (const note of rows.filter(row => row.parent === parent)) {
        const hasChildren = rows.some(row => row.parent === note.id);
        const row = document.createElement('div'); row.className = 'row'; row.dataset.id = note.id;
        row.draggable = true; row.style.paddingLeft = `${depth * 16 + 4}px`;
        row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.title = note.id;
        if (hasChildren) row.setAttribute('aria-expanded', String(!collapsed.has(note.id)));
        const toggle = document.createElement('button'); toggle.className = 'toggle'; toggle.tabIndex = -1;
        toggle.textContent = hasChildren ? (collapsed.has(note.id) ? '▸' : '▾') : '';
        toggle.setAttribute('aria-label', collapsed.has(note.id) ? '展開' : '折りたたむ');
        toggle.onclick = e => { e.stopPropagation(); if (hasChildren) { collapsed.has(note.id) ? collapsed.delete(note.id) : collapsed.add(note.id); persist(); render(); select(note.id, true); } };
        const label = document.createElement('span'); label.className = 'label'; label.textContent = collapsed.has(note.id) ? (note.collapsedLabel ?? note.label) : note.label;
        row.append(toggle, label);
        if (note.description) { const count = document.createElement('span'); count.textContent = note.description; count.style.cssText = 'margin-left:8px;opacity:.7'; row.append(count); }
        tree.append(row);
        row.onclick = () => { select(note.id, true); send('open', note.id); };
        row.oncontextmenu = e => { e.preventDefault(); if (tagMode) return; select(note.id, true); showMenu(e.clientX, e.clientY, note.id); };
        row.ondragstart = e => { dragging = note.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', note.id); menu.hidden = true; select(note.id); };
        if (!collapsed.has(note.id)) branch(note.id, depth + 1);
      }
    }
    branch('', 0);
    if (!rows.length) {
      const hint = document.createElement('div'); hint.id = 'hint'; hint.textContent = tagMode ? '本文にタグを入力すると表示されます。' : '＋からノートを追加できます。'; tree.append(hint);
    }
    const rootDrop = document.createElement('div'); rootDrop.id = 'root-drop'; rootDrop.textContent = dragging ? (tagMode ? '同じ階層の末尾へ移動' : '最上位の末尾へ移動') : ''; tree.append(rootDrop);
    select(selected); window.scrollTo(0, scroll);
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
      const rootDrop = document.getElementById('root-drop'); rootDrop.classList.add('over'); rootDrop.textContent = (tagMode ? '同じ階層の末尾へ移動' : '最上位の末尾へ移動');
      return;
    }
    const target = row.dataset.id;
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
    for (const [command, title] of [['addChild', '子ノートを追加'], ['rename', '名前を変更'], ['move', '移動'], ['up', '上へ並べ替え'], ['down', '下へ並べ替え'], ['delete', '削除']]) {
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
    if (!tagMode && e.key === 'F2') send('command', current.id, { command: 'rename' });
    if (!tagMode && e.key === 'Delete') send('command', current.id, { command: 'delete' });
    if (!tagMode && e.key === 'F10' && e.shiftKey) { e.preventDefault(); const rect = visible[index].getBoundingClientRect(); showMenu(rect.left, rect.bottom, current.id); }
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
    if (message.type === 'collapseAll') {
      collapsed = new Set((pending || rows).map(row => row.parent).filter(Boolean));
      while (selected && rows.find(row => row.id === selected)?.parent) selected = rows.find(row => row.id === selected).parent;
      persist(); render();
    }
    if (message.type === 'select') {
      let id = message.id;
      while (id.includes('/')) { id = id.slice(0, id.lastIndexOf('/')); collapsed.delete(id); }
      selected = message.id; persist(); render();
      tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    }
  });
  send('ready');
})();
