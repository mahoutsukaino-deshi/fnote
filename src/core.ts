export interface TagMatch { tag: string; start: number; end: number }
export interface TaggedNote { id: string; tags: TagMatch[] }

export interface DisplayLink { target: string; label: string; start: number; end: number; targetStart: number; targetEnd: number; displayStart: number; displayEnd: number }

// Preserve source offsets so editor decorations never change the stored Markdown.
export function parseDisplayLinks(text: string): DisplayLink[] {
  const result: DisplayLink[] = [];
  const masked = maskCode(text);
  const occupied: { start: number; end: number }[] = [];
  const escaped = new Uint8Array(masked.length);
  let slashRun = 0;
  for (let i = 0; i < masked.length; i++) {
    escaped[i] = slashRun % 2;
    slashRun = text[i] === '\\' ? slashRun + 1 : 0;
  }
  const add = (start: number, end: number, targetStart: number, target: string, label: string, displayStart: number) => {
    occupied.push({ start, end });
    result.push({ target, label, start, end, targetStart, targetEnd: targetStart + target.length, displayStart, displayEnd: displayStart + label.length });
  };
  // Scan explicitly so malformed links during editing cannot trigger regexp backtracking.
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '!' || escaped[i]) continue;
    if (masked.startsWith('[[', i)) {
      const close = masked.indexOf(']]', i + 2);
      if (close > i + 2 && !masked.slice(i + 2, close).includes('\n')) {
        const target = text.slice(i + 2, close);
        add(i, close + 2, i + 2, target, target, i + 2);
        i = close + 1;
      }
      continue;
    }
    if (masked[i] === '[') {
      const bracket = masked.indexOf('](', i + 1);
      if (bracket < 0 || masked.slice(i + 1, bracket).includes('\n')) continue;
      let cursor = bracket + 2;
      while (cursor < masked.length && /[ \t]/.test(masked[cursor])) cursor++;
      const targetStart = cursor + (masked[cursor] === '<' ? 1 : 0);
      let targetEnd = cursor;
      if (masked[cursor] === '<') {
        const close = masked.indexOf('>', cursor + 1);
        if (close < 0) continue;
        targetEnd = close;
        cursor = close + 1;
      } else {
        let depth = 0;
        while (cursor < masked.length && !/[ \t\r\n)]/.test(masked[cursor])) {
          if (masked[cursor] === '(') depth++;
          cursor++;
        }
        while (depth > 0 && masked[cursor] === ')') { depth--; cursor++; }
        targetEnd = cursor;
      }
      if (targetEnd <= targetStart) continue;
      while (cursor < masked.length && /[ \t]/.test(masked[cursor])) cursor++;
      if (masked[cursor] === '"') {
        const titleEnd = masked.indexOf('"', cursor + 1);
        if (titleEnd < 0) continue;
        cursor = titleEnd + 1;
        while (cursor < masked.length && /[ \t]/.test(masked[cursor])) cursor++;
      }
      if (masked[cursor] !== ')') continue;
      const target = text.slice(targetStart, targetEnd);
      const label = text.slice(i + 1, bracket);
      if (i > 0 && masked[i - 1] === '!') occupied.push({ start: i - 1, end: cursor + 1 });
      else add(i, cursor + 1, targetStart, target, label || target, label ? i + 1 : targetStart);
      i = cursor;
      continue;
    }
    if (masked[i] === '<') {
      const close = masked.indexOf('>', i + 1);
      if (close < 0) continue;
      const target = text.slice(i + 1, close);
      if (/^[a-z][a-z\d+.-]*:[^<>\s]+$/i.test(target)) add(i, close + 1, i + 1, target, target, i + 1);
      i = close;
    }
  }
  for (const url of parseUrls(text)) {
    if (occupied.some(span => url.start < span.end && url.end > span.start)) continue;
    result.push({ ...url, target: text.slice(url.start, url.end), label: text.slice(url.start, url.end), targetStart: url.start, targetEnd: url.end, displayStart: url.start, displayEnd: url.end });
  }
  return result.sort((a, b) => a.start - b.start);
}

// Find link candidates; the provider resolves relative files and note directories.
export function parseNoteLinks(text: string, includeExternal = false): { target: string; start: number; end: number }[] {
  const result: { target: string; start: number; end: number }[] = [];
  const pattern = /(?<!!)(\[\[([^\]\r\n]+)\]\]|\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^\s()]+)\s*\))/g;
  for (const match of maskCode(text).matchAll(pattern)) {
    const preceding = text.slice(0, match.index).match(/\\+$/)?.[0].length ?? 0;
    if (preceding % 2) continue;
    const raw = match[2] ?? match[3];
    const target = raw.startsWith('<') ? raw.slice(1, -1) : raw;
    const external = /^[a-z][a-z\d+.-]*:/i.test(target);
    if (!target || target.startsWith('/') || (external && !includeExternal) || (!external && /[?#]/.test(target))) continue;
    const destinationOffset = match[2] !== undefined ? 2 : match[0].indexOf('](') + 2;
    const start = match.index + match[0].indexOf(raw, destinationOffset);
    const name = match[3] !== undefined ? match[0].slice(1, match[0].indexOf('](')) : '';
    result.push({ target, start: name ? match.index + 1 : start, end: name ? match.index + 1 + name.length : start + raw.length });
  }
  return result;
}
export interface Note extends TaggedNote { parent: string; name: string; text: string }
export interface ContentMatch { text: string; start: number }
export interface NoteSearchMatch { note: Note; lines: ContentMatch[] }
export interface HeadingMatch { title: string; start: number; matched: boolean; lines: ContentMatch[]; children: HeadingMatch[] }
export interface TagStyle { excludeFromNoteMark?: boolean; mark?: string; markColor?: string; color?: string; backgroundColor?: string }
export interface TagStyleDefinition extends TagStyle { tag: string }
export type TagStyles = Record<string, TagStyle> | readonly TagStyleDefinition[];
export interface TagNode { label: string; tag: string; children: Map<string, TagNode> }

// Webviews do not inherit the editor's TextMate token colors.
export function markdownLinkColor(customizations: unknown, theme: string): string | undefined {
  if (!customizations || typeof customizations !== 'object') return undefined;
  const configuration = customizations as Record<string, unknown>;
  const themed = configuration[`[${theme}]`];
  let color: string | undefined;
  let specificity = -1;
  for (const section of [configuration, themed]) {
    if (!section || typeof section !== 'object') continue;
    const rules = (section as { textMateRules?: unknown }).textMateRules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      const foreground = rule?.settings?.foreground;
      if (typeof foreground !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(foreground)) continue;
      const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
      for (const scopesEntry of scopes) {
        if (typeof scopesEntry !== 'string') continue;
        for (const selector of scopesEntry.split(',')) {
          const scope = selector.trim();
          if (!scope || !('markup.underline.link.markdown' === scope || 'markup.underline.link.markdown'.startsWith(`${scope}.`))) continue;
          const score = scope.split('.').length;
          if (score >= specificity) { color = foreground; specificity = score; }
        }
      }
    }
  }
  return color;
}

export type TagHierarchy = Record<string, readonly string[]>;
const naturalTagParent = (tag: string) => tag.includes('/') ? tag.slice(0, tag.lastIndexOf('/')) : '';
function hierarchyParents(hierarchy: TagHierarchy): Map<string, string> {
  const parents = new Map<string, string>();
  const valid = (tag: unknown): tag is string => typeof tag === 'string'
    && /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(tag) && !isTimeTag(tag);
  for (const [parent, children] of Object.entries(hierarchy ?? {})) {
    if (!valid(parent) || !Array.isArray(children)) continue;
    for (const child of children) {
      if (!valid(child) || parents.has(child)) continue;
      const visited = new Set([child]);
      let ancestor = parent;
      while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        ancestor = parents.get(ancestor) ?? naturalTagParent(ancestor);
      }
      if (!ancestor) parents.set(child, parent);
    }
  }
  return parents;
}
function tagMatches(actual: string, selected: string, parents: Map<string, string>): boolean {
  for (let tag = actual; tag; tag = parents.get(tag) ?? naturalTagParent(tag)) {
    if (tag === selected) return true;
  }
  return false;
}

// Mask code without changing UTF-16 offsets used by VS Code positions.
function maskCode(text: string): string {
  const chars = text.split('');
  const mask = (start: number, end: number) => { for (let i = start; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '; };
  let offset = 0;
  let fence: string | undefined;
  const listIndents: number[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    const whitespace = line.match(/^[ \t]*/)![0];
    let indent = 0;
    for (const char of whitespace) indent += char === '\t' ? 4 - indent % 4 : 1;
    const content = line.slice(whitespace.length);
    let marker = /^(?:[-+*]|\d{1,9}[.)])([ \t]+)(?=\S)/.exec(content);
    if (!fence && content.trim()) {
      while (listIndents.length && indent < listIndents[listIndents.length - 1]) listIndents.pop();
      if (indent - (listIndents.at(-1) ?? 0) >= 4) marker = null;
      if (marker) listIndents.push(indent + marker[0].length);
    }
    const base = listIndents.at(-1) ?? 0;
    const relativeIndent = marker && !fence ? 0 : Math.max(0, indent - base);
    const logicalLine = marker && !fence ? content.slice(marker[0].length) : content;
    const match = relativeIndent < 4 ? logicalLine.match(/^(`{3,}|~{3,}|'{3,})/) : null;
    if (fence) {
      mask(offset, offset + line.length);
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && logicalLine.slice(match[0].length).trim() === '') fence = undefined;
    } else if (match) {
      fence = match[1]; mask(offset, offset + line.length);
    } else if (relativeIndent >= 4) mask(offset, offset + line.length);
    offset += line.length;
  }
  const masked = chars.join('');
  const delimiters = /`+|'+/g;
  let opening;
  while ((opening = delimiters.exec(masked))) {
    const closing = new RegExp(opening[0][0] === '`' ? '`+' : "'+", 'g');
    closing.lastIndex = delimiters.lastIndex;
    let match;
    while ((match = closing.exec(masked))) {
      if (match[0] !== opening[0]) continue;
      if (opening[0][0] === "'" && masked.slice(opening.index, match.index).includes('\n')) break;
      mask(opening.index, closing.lastIndex);
      delimiters.lastIndex = closing.lastIndex;
      break;
    }
  }
  return chars.join('');
}

export function parseTags(text: string): TagMatch[] {
  const result = [];
  const pattern = /(?<![\p{L}\p{N}_@\\])@(\d{2}:\d{2}-\d{2}:\d{2}|[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;
  for (const match of maskCode(text).matchAll(pattern)) result.push({ tag: match[1], start: match.index, end: match.index + match[0].length });
  return result;
}

// Keep full-document offsets and the same code exclusions as tags.
export function parseUrls(text: string): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  for (const match of maskCode(text).matchAll(/(?<![\p{L}\p{N}_])[a-z][a-z0-9+.-]*:[^\s<>"'`、。！？「」『』]+/giu)) {
    let url = match[0].replace(/[.,;:!?]+$/, '');
    while (/[)\]}]$/.test(url)) {
      const close = url.at(-1)!;
      const open = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[close];
      if (url.split(close).length <= url.split(open).length) break;
      url = url.slice(0, -1);
    }
    // Windows drive paths are not URI schemes.
    if (/^[a-z]:[\\/]/i.test(url)) continue;
    if (/^[a-z][a-z0-9+.-]*:.+/i.test(url)) result.push({ start: match.index, end: match.index + url.length });
  }
  return result;
}

export function searchNotes(notes: readonly Note[], query: string): NoteSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const results: NoteSearchMatch[] = [];
  for (const note of notes) {
    const lines: ContentMatch[] = [];
    let start = 0;
    for (const line of note.text.split('\n')) {
      if (line.toLocaleLowerCase().includes(needle)) lines.push({ text: line.trim(), start });
      start += line.length + 1;
    }
    if (lines.length || note.name.toLocaleLowerCase().includes(needle)) results.push({ note, lines });
  }
  return results;
}

// A tag belongs to the nearest preceding heading. Keep that heading's ancestors,
// but omit unrelated sibling sections and code-block headings.
export function matchingLines(text: string, tag: string, tags = parseTags(text), hierarchy: TagHierarchy = {}): ContentMatch[] {
  const parents = hierarchyParents(hierarchy);
  const lines = new Map<number, ContentMatch>();
  for (const match of tags) {
    if (!tagMatches(match.tag, tag, parents)) continue;
    const start = text.lastIndexOf('\n', match.start - 1) + 1;
    const newline = text.indexOf('\n', match.end);
    lines.set(start, { start, text: text.slice(start, newline < 0 ? text.length : newline).trim() });
  }
  return [...lines.values()];
}

export function parseHeadings(text: string): { title: string; start: number; level: number }[] {
  const headings: { title: string; start: number; level: number }[] = [];
  const pattern = /^ {0,3}(#{1,6})(?:[\t ]+|(?=\r?$))(.*)$/gm;
  for (const match of maskCode(text).matchAll(pattern)) {
    const raw = text.slice(match.index, match.index + match[0].length);
    const title = raw.replace(/^ {0,3}#{1,6}[\t ]*/, '').replace(/[\t ]+#+[\t ]*\r?$/, '').trim();
    headings.push({ title: title || '(Untitled heading)', start: match.index, level: match[1].length });
  }
  return headings;
}

export function matchingHeadings(text: string, tag: string, tags = parseTags(text), hierarchy: TagHierarchy = {}): HeadingMatch[] {
  const headings = parseHeadings(text);
  const roots: HeadingMatch[] = [];
  const content = matchingLines(text, tag, tags, hierarchy);
  const stack: { level: number; node: HeadingMatch }[] = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const end = headings[index + 1]?.start ?? text.length;
    const lines = content.filter(line => line.start >= heading.start && line.start < end);
    const node: HeadingMatch = { title: heading.title, start: heading.start, matched: lines.length > 0, lines, children: [] };
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    (stack.at(-1)?.node.children ?? roots).push(node);
    stack.push({ level: heading.level, node });
  }
  const prune = (nodes: HeadingMatch[]): HeadingMatch[] => nodes.map(node => ({ ...node, children: prune(node.children) })).filter(node => node.matched || node.children.length > 0);
  return prune(roots);
}
function styleEntries(styles: TagStyles): [string, TagStyle][] {
  if (Array.isArray(styles)) return styles.map(style => [style.tag, style]);
  return Object.entries(styles);
}
const isDateTagLevel = (tag: string): boolean => /^\d{4}(?:\/\d{2}){0,2}$/.test(tag);
function styleKeyFor(tag: string, styles: Map<string, TagStyle>): string | undefined {
  const parts = tag.split('/');
  while (parts.length) { const key = parts.join('/'); if (styles.has(key)) return key; parts.pop(); }
  return isDateTagLevel(tag) && styles.has('date') ? 'date' : undefined;
}
export function styleFor(tag: string, styles: TagStyles): TagStyle {
  const definitions = new Map(styleEntries(styles).reverse());
  const key = styleKeyFor(tag, definitions);
  return key === undefined ? {} : definitions.get(key)!;
}

export function automaticTagColor(tag: string): string {
  let hash = 2166136261;
  for (const char of tag) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  const index = hash >>> 0 & 1023;
  // 64 hues × 4 saturation levels × 4 lightness levels; no black/white.
  return `hsl(${(index % 64) * 360 / 64}, ${55 + (index >>> 6 & 3) * 8}%, ${42 + (index >>> 8 & 3) * 6}%)`;
}
// Icon inheritance is independent of text-color definitions on child tags.
function markSource(tag: string, definitions: Map<string, TagStyle>, parents: Map<string, string>): string {
  let root = tag;
  for (let key = tag; key; key = parents.get(key) ?? naturalTagParent(key)) {
    root = key;
    if (definitions.get(key)?.mark?.trim()) return key;
  }
  return isDateTagLevel(tag) && definitions.has('date') ? 'date' : root;
}
export function tagAppearance(tag: string, styles: TagStyles, defaultMark = '$(circle-filled-compact)', hierarchy: TagHierarchy = {}): { mark: string; color: string } {
  const definitions = new Map(styleEntries(styles).reverse());
  const key = markSource(tag, definitions, hierarchyParents(hierarchy));
  const style = definitions.get(key) ?? {};
  return { mark: style.mark?.trim() || defaultMark, color: style.markColor || style.color || automaticTagColor(key) };
}
export function noteMark(tags: readonly TagMatch[], styles: TagStyles, untaggedMark: string, defaultTagMark = '🏷️', hierarchy: TagHierarchy = {}): string {
  return noteAppearance(tags, styles, untaggedMark, defaultTagMark, hierarchy).mark;
}

export function noteAppearance(tags: readonly TagMatch[], styles: TagStyles, untaggedMark: string, defaultTagMark = '$(circle-filled-compact)', hierarchy: TagHierarchy = {}): { mark: string; color?: string } {
  const regularTags = tags.filter(tag => !isDateTag(tag.tag) && !isTimeTag(tag.tag));
  const entries = styleEntries(styles);
  const definitions = new Map([...entries].reverse());
  const parents = hierarchyParents(hierarchy);
  const excluded = (tag: string): boolean => {
    for (let key = tag; key; key = parents.get(key) ?? naturalTagParent(key)) {
      const value = definitions.get(key)?.excludeFromNoteMark;
      if (typeof value === 'boolean') return value;
    }
    return false;
  };
  const eligible = regularTags.filter(tag => !excluded(tag.tag));
  if (eligible.length === 0) return { mark: untaggedMark };
  const applicable = new Set(eligible.map(tag => markSource(tag.tag, definitions, parents)));
  const visited = new Set<string>();
  for (const [key, style] of entries) {
    if (visited.has(key)) continue;
    visited.add(key);
    const mark = style.mark?.trim();
    if (mark && applicable.has(key)) return { mark, color: style.markColor || style.color || automaticTagColor(key) };
  }
  const tag = eligible[0].tag;
  return tagAppearance(tag, styles, defaultTagMark, hierarchy);
}
export const isTimeTag = (tag: string): boolean => /^(?:\d{2}:\d{2}-\d{2}:\d{2}|\d+[mh])$/.test(tag);
export const isDateTag = (tag: string): boolean => /^\d{4}\/\d{2}\/\d{2}$/.test(tag);

export function tagTree(notes: readonly TaggedNote[], hierarchy: TagHierarchy = {}): Map<string, TagNode> {
  const roots = new Map<string, TagNode>();
  const nodes = new Map<string, TagNode>();
  const parents = hierarchyParents(hierarchy);
  function ensure(tag: string): TagNode {
    const existing = nodes.get(tag);
    if (existing) return existing;
    const node: TagNode = { tag, label: tag.split('/').at(-1)!, children: new Map() };
    nodes.set(tag, node);
    const parent = parents.get(tag) ?? naturalTagParent(tag);
    const siblings = parent ? ensure(parent).children : roots;
    siblings.set(siblings.has(node.label) ? node.tag : node.label, node);
    return node;
  }
  for (const note of notes) for (const { tag } of note.tags) if (!isTimeTag(tag)) ensure(tag);
  return roots;
}
export const matchesTag = (note: TaggedNote, tag: string, hierarchy: TagHierarchy = {}) => {
  const parents = hierarchyParents(hierarchy);
  return note.tags.some(t => tagMatches(t.tag, tag, parents));
};
export const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);

export function planNoteDrop(notes: readonly Note[], id: string, targetId: string | undefined, position: 'before' | 'after' | 'inside'): { destination: string; order: string[] } {
  const source = notes.find(note => note.id === id);
  const target = notes.find(note => note.id === targetId);
  if (!source || (targetId !== undefined && !target)) throw new Error('Source or destination note not found.');
  if (target && within(target.id, id)) throw new Error('Cannot move a note to itself or its descendants.');
  const parent = target ? (position === 'inside' ? target.id : target.parent) : '';
  const destination = parent ? `${parent}/${source.name}` : source.name;
  if (destination !== id && notes.some(note => note.id === destination)) throw new Error('A note with the same name already exists.');
  const moving = notes.filter(note => within(note.id, id)).map(note => destination + note.id.slice(id.length));
  const remaining = notes.filter(note => !within(note.id, id)).map(note => note.id);
  const index = target && position !== 'inside' ? remaining.indexOf(target.id) + (position === 'after' ? 1 : 0) : remaining.length;
  remaining.splice(index, 0, ...moving);
  return { destination, order: remaining };
}
export function filterTree<T extends TaggedNote>(notes: readonly T[], tag: string, hierarchy: TagHierarchy = {}): T[] {
  const keep = new Set();
  for (const note of notes) if (matchesTag(note, tag, hierarchy)) {
    let id = note.id;
    while (id) { keep.add(id); id = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ''; }
  }
  return notes.filter(n => keep.has(n.id));
}
export function validateName(name: string): string | undefined {
  if (!name.trim() || name !== name.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^\./.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return 'Enter a non-empty name without leading or trailing whitespace, leading or trailing dots, reserved names, or invalid filename characters.';
  return undefined;
}
export const escapeHtml = (text: string) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

export function renderTagText(text: string, tags: readonly TagMatch[], classFor: (tag: string) => string): string {
  let html = '', cursor = 0;
  for (const tag of tags) {
    if (tag.start < cursor || tag.end > text.length) continue;
    html += escapeHtml(text.slice(cursor, tag.start));
    html += `<span class="${escapeHtml(classFor(tag.tag))}">${escapeHtml(text.slice(tag.start, tag.end))}</span>`;
    cursor = tag.end;
  }
  return html + escapeHtml(text.slice(cursor));
}

export function timeTagMinutes(tag: string): number | undefined {
  const duration = /^(\d+)([mh])$/.exec(tag);
  if (duration) {
    const minutes = Number(duration[1]) * (duration[2] === 'h' ? 60 : 1);
    return Number.isSafeInteger(minutes) ? minutes : undefined;
  }
  const range = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(tag);
  if (!range) return undefined;
  const [startHour, startMinute, endHour, endMinute] = range.slice(1).map(Number);
  if (startHour > 23 || startMinute > 59 || endHour > 24 || endMinute > 59 || (endHour === 24 && endMinute !== 0)) return undefined;
  const minutes = endHour * 60 + endMinute - startHour * 60 - startMinute;
  return minutes >= 0 ? minutes : undefined;
}

// Only times on a line with exactly one date belong to that day. Full-document
// tag ranges preserve code exclusions when processing search-result snippets.
export function minutesForDate(text: string, lines: readonly ContentMatch[], date: string, tags = parseTags(text)): number | undefined {
  if (!/^\d{4}(?:\/\d{2}){0,2}$/.test(date)) return undefined;
  let total: number | undefined;
  for (const start of new Set(lines.map(line => line.start))) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    const lineTags = tags.filter(tag => tag.start >= start && tag.start < end);
    const dates = lineTags.filter(tag => isDateTag(tag.tag));
    if (dates.length !== 1 || (dates[0].tag !== date && !dates[0].tag.startsWith(`${date}/`))) continue;
    for (const tag of lineTags) {
      const minutes = timeTagMinutes(tag.tag);
      if (minutes !== undefined) total = (total ?? 0) + minutes;
    }
  }
  return total;
}

export function formatWorkMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? `${remainder}m` : ''}` : `${remainder}m`;
}
