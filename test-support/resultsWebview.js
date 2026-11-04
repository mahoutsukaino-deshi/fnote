'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(rows, savedState = {}) {
  const ids = new Map(), documentHandlers = new Map(), windowHandlers = new Map();
  const sent = [], states = [], highlights = new Map();
  let document;
  class Element {
    nodeType = 1; childNodes = []; attributes = {}; handlers = new Map(); dataset = {};
    hidden = false; disabled = false; value = ''; textContent = ''; isConnected = true;
    constructor(tagName) { this.tagName = tagName.toUpperCase(); }
    append(...nodes) {
      for (const node of nodes) {
        node.parentElement = this;
        this.childNodes.push(node);
      }
    }
    contains(node) { return node === this || this.childNodes.some(child => child === node || child.contains?.(node)); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    getBoundingClientRect() { return { top: 0, bottom: 45 }; }
    scrollIntoView() { this.scrolled = true; }
    closest(selector) {
      if (selector === 'button[data-action="toggle-date-sort"]' && this.dataset.action === 'toggle-date-sort') return this;
      if (selector === 'button[data-id]' && this.dataset.id !== undefined) return this;
      return this.parentElement?.closest(selector);
    }
  }
  function element(tag, ...children) {
    const result = new Element(tag);
    result.append(...children.map(child => typeof child === 'string' ? { nodeType: 3, data: child } : child));
    return result;
  }
  const body = element('body'), content = element('main');
  const widget = element('div'), input = element('input'), count = element('span');
  const previous = element('button'), next = element('button'), close = element('button');
  widget.append(input, count, previous, next, close);
  body.append(widget, content);
  for (const [id, item] of Object.entries({ 'results-content': content, 'results-find': widget,
    'results-find-input': input, 'results-find-count': count, 'results-find-previous': previous,
    'results-find-next': next, 'results-find-close': close })) ids.set(id, item);
  content.append(...rows(element));
  document = { body, activeElement: content, getElementById: id => ids.get(id),
    addEventListener: (name, handler) => documentHandlers.set(name, handler),
    createRange: () => ({
      setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
      setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
      getBoundingClientRect() { return { top: 150, bottom: 170 }; },
    }) };
  const window = { innerHeight: 800, getSelection: () => null,
    addEventListener: (name, handler) => windowHandlers.set(name, handler) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/results.js'), 'utf8'), {
    document, window, CSS: { highlights }, Highlight: class extends Set { constructor(...ranges) { super(ranges); } },
    acquireVsCodeApi: () => ({ getState: () => savedState, setState: state => { savedState = state; states.push(state); },
      postMessage: message => sent.push(message) }),
  });
  function key(key, extra = {}) {
    const event = { key, target: document.activeElement, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    documentHandlers.get('keydown')(event);
    return event;
  }
  function click(target) {
    const event = { target };
    target.handlers.get('click')?.(event);
    documentHandlers.get('click')(event);
  }
  return { document, window, content, widget, input, count, previous, next, close, states, sent, highlights, key, click,
    type: value => { input.value = value; input.handlers.get('input')(); },
    compose: type => input.handlers.get(type)(),
    message: data => windowHandlers.get('message')({ data }),
    current: () => highlights.get('fnote-find-current')?.values().next().value,
  };
}

module.exports = { setup };
