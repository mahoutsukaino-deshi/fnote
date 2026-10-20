'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(tagMode = false, platform = '', favoriteMode = false) {
  const sent = [], states = [], timers = [], listeners = new Map(), documentListeners = new Map();
  let document;
  class Element {
    children = []; dataset = {}; style = {}; handlers = {}; classes = new Set();
    classList = { toggle: (key, active) => active ? this.classes.add(key) : this.classes.delete(key),
      add: (...keys) => keys.forEach(key => this.classes.add(key)), remove: (...keys) => keys.forEach(key => this.classes.delete(key)) };
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    replaceChildren() {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      this.children = [];
    }
    setAttribute() {}
    focus() { document.activeElement = this; }
    select() {}
    scrollIntoView() {}
    closest(selector) { return selector === '.row' && this.className === 'row' ? this : this.parent?.closest(selector); }
    querySelectorAll() { return this.children.filter(child => child.className === 'row'); }
    querySelector() { return this.children.find(child => child.classes.has('selected')); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
  }
  const tree = new Element(), menu = new Element(), body = new Element();
  body.append(tree);
  body.dataset.tags = String(tagMode);
  body.dataset.favorites = String(favoriteMode);
  document = { body, activeElement: body, getElementById: id => id === 'tree' ? tree : menu,
    createElement: () => new Element(), addEventListener: (type, fn) => documentListeners.set(type, fn) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/notes.js'), 'utf8'), {
    document, window: { scrollY: 0, innerHeight: 800, scrollTo() {}, scrollBy() {}, addEventListener: (type, fn) => listeners.set(type, fn) },
    navigator: { platform }, setTimeout: callback => timers.push(callback),
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: state => states.push(state), postMessage: msg => sent.push(msg) })
  });
  return { document, body, tree, sent, states, documentListeners, flushTimers: () => { for (const callback of timers.splice(0)) callback(); }, message: data => listeners.get('message')({ data }) };
}


module.exports = { setup };
