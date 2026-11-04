(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const content = document.getElementById('results-content');
  const widget = document.getElementById('results-find');
  const input = document.getElementById('results-find-input');
  const count = document.getElementById('results-find-count');
  const previous = document.getElementById('results-find-previous');
  const next = document.getElementById('results-find-next');
  const close = document.getElementById('results-find-close');
  const saved = api.getState()?.find;
  let query = '', matches = [], index = -1, composing = false, returnFocus;
  input.value = typeof saved?.query === 'string' ? saved.query : '';
  widget.hidden = saved?.open !== true;

  function save() {
    api.setState({ find: { query: input.value, open: !widget.hidden, index } });
  }

  function paint(scroll = true) {
    CSS.highlights.delete('fnote-find');
    CSS.highlights.delete('fnote-find-current');
    if (!widget.hidden && matches.length) {
      const all = new Highlight();
      for (const match of matches) all.add(match);
      CSS.highlights.set('fnote-find', all);
      const current = new Highlight(matches[index]);
      current.priority = 1;
      CSS.highlights.set('fnote-find-current', current);
      if (scroll) {
        const rect = matches[index].getBoundingClientRect();
        if (rect.top < widget.getBoundingClientRect().bottom + 8 || rect.bottom > window.innerHeight - 8) {
          matches[index].startContainer.parentElement.scrollIntoView({ block: 'center' });
        }
      }
    }
    count.textContent = !query ? '0 / 0' : matches.length ? `${index + 1} / ${matches.length}` : 'No results';
    previous.disabled = next.disabled = !matches.length;
    input.setAttribute('aria-invalid', String(!!query && !matches.length));
    save();
  }

  function search(keepIndex = false, scroll = true) {
    query = input.value;
    const oldIndex = index;
    matches = [];
    // Search across inline tag/link spans, but never across separate result rows.
    const blocks = [];
    let block = { text: '', parts: [] };
    const flush = () => {
      if (block.text) blocks.push(block);
      block = { text: '', parts: [] };
    };
    function visit(node) {
      if (node.nodeType === 3) {
        if (node.data) {
          block.parts.push({ node, start: block.text.length, end: block.text.length + node.data.length });
          block.text += node.data;
        }
        return;
      }
      if (node.nodeType !== 1 || node.hidden || node.getAttribute('aria-hidden') === 'true'
        || /^(SCRIPT|STYLE)$/.test(node.tagName)) return;
      const boundary = /^(H[1-6]|P|DIV|UL|OL|LI|SECTION|MAIN|BR)$/.test(node.tagName);
      if (boundary) flush();
      for (const child of node.childNodes) visit(child);
      if (boundary) flush();
    }
    if (query) {
      visit(content);
      flush();
      const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      for (const item of blocks) {
        for (const match of item.text.matchAll(expression)) {
          const start = item.parts.find(part => part.end > match.index);
          const endOffset = match.index + match[0].length;
          const end = item.parts.find(part => part.end >= endOffset);
          const range = document.createRange();
          range.setStart(start.node, match.index - start.start);
          range.setEnd(end.node, endOffset - end.start);
          matches.push(range);
        }
      }
    }
    index = matches.length ? keepIndex ? Math.max(0, Math.min(oldIndex, matches.length - 1)) : 0 : -1;
    paint(scroll);
  }

  // Both Enter and the arrow buttons use this one navigation path.
  function move(delta) {
    if (composing) return;
    if (input.value !== query) search();
    if (matches.length) {
      index = (index + delta + matches.length) % matches.length;
      paint();
    }
    input.focus();
  }

  function show() {
    if (!widget.contains(document.activeElement)) returnFocus = document.activeElement;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && content.contains(selection.anchorNode)) {
      input.value = selection.toString();
    }
    const unchanged = input.value === query;
    widget.hidden = false;
    input.focus();
    input.select();
    search(unchanged);
  }

  function hide() {
    widget.hidden = true;
    paint(false);
    (returnFocus?.isConnected ? returnFocus : content).focus();
  }

  input.addEventListener('input', () => { if (!composing) search(); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; search(); });
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  close.addEventListener('click', hide);
  document.addEventListener('keydown', event => {
    const inComposition = composing || event.isComposing || event.keyCode === 229;
    if (!inComposition && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      show();
    } else if (!widget.hidden && event.key === 'Escape' && !inComposition) {
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.target === input && event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Keep IME confirmation in the input and prevent host keybindings from navigating another editor.
      event.stopPropagation();
      if (!inComposition) {
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
      }
    }
  });
  document.addEventListener('click', event => {
    const sort = event.target.closest('button[data-action="toggle-date-sort"]');
    if (sort) { api.postMessage({ type: 'toggleDateTagSort' }); return; }
    const button = event.target.closest('button[data-id]');
    if (button) api.postMessage({ id: button.dataset.id,
      ...(button.dataset.offset !== undefined ? { offset: Number(button.dataset.offset) } : {}) });
  });
  window.addEventListener('message', event => { if (event.data?.type === 'showFind') show(); });
  index = Number.isSafeInteger(saved?.index) ? saved.index : -1;
  search(true, false);
  if (!widget.hidden) input.focus();
})();
