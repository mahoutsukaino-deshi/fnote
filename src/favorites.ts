import { parseHeadings, type Note, within } from './core';

// Store a heading's name and occurrence rather than its changing text offset.
const headingPrefix = '\0favoriteHeading:';
type HeadingReference = [noteId: string, title: string, level: number, occurrence: number];
export interface HeadingFavorite { id: string; index: number }

function headingReference(id: string): HeadingReference | undefined {
  if (!id.startsWith(headingPrefix)) return;
  try {
    const value: unknown = JSON.parse(id.slice(headingPrefix.length));
    if (Array.isArray(value) && value.length === 4 && typeof value[0] === 'string'
      && typeof value[1] === 'string' && Number.isInteger(value[2]) && value[2] >= 1 && value[2] <= 6
      && Number.isSafeInteger(value[3]) && value[3] >= 0) return value as HeadingReference;
  } catch { /* Ignore invalid saved references. */ }
}

export function isHeadingFavorite(id: string): boolean {
  return headingReference(id) !== undefined;
}

export function mergeFavoriteIds(ids: readonly string[], headings: readonly HeadingFavorite[]): string[] {
  const merged = [...new Set(ids)];
  for (const heading of [...headings].sort((a, b) => a.index - b.index)) {
    if (!merged.includes(heading.id)) merged.splice(Math.min(heading.index, merged.length), 0, heading.id);
  }
  return merged;
}

export function favoriteHeadings(note: Note) {
  const occurrences = new Map<string, number>();
  return parseHeadings(note.text).map(heading => {
    const key = JSON.stringify([heading.title, heading.level]);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return { ...heading, favoriteId: headingPrefix + JSON.stringify([note.id, heading.title, heading.level, occurrence]) };
  });
}

export function headingFavoriteUpdates(before: Note, after: Note): Map<string, string | undefined> {
  const updates = new Map<string, string | undefined>();
  if (before.text === after.text) return updates;
  const previous = favoriteHeadings(before), current = favoriteHeadings(after);
  const oldLines = before.text.split('\n'), newLines = after.text.split('\n');
  let prefix = 0, suffix = 0;
  // Compare complete lines: the shared "## " prefix of an inserted heading
  // must not make it look like a rename of the following heading.
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  const lineOffset = (lines: string[], index: number) => lines.slice(0, index).reduce((offset, line) => offset + line.length + 1, 0);
  const start = lineOffset(oldLines, prefix);
  const oldEnd = lineOffset(oldLines, oldLines.length - suffix);
  const newEnd = lineOffset(newLines, newLines.length - suffix);
  const byOffset = new Map(current.map(heading => [heading.start, heading]));
  for (const heading of previous) {
    const offset = heading.start < start ? heading.start
      : heading.start >= oldEnd ? heading.start + newEnd - oldEnd : undefined;
    updates.set(heading.favoriteId, offset === undefined ? undefined : byOffset.get(offset)?.favoriteId);
  }
  const oldChanged = previous.filter(heading => heading.start >= start && heading.start < oldEnd);
  const newChanged = current.filter(heading => heading.start >= start && heading.start < newEnd);
  type Heading = typeof previous[number];
  const pair = (oldHeadings: Heading[], newHeadings: Heading[]): void => {
    // Equal-sized changed sections preserve heading order, including duplicate
    // names and edits to several titles or heading levels at once.
    if (oldHeadings.length === newHeadings.length) oldHeadings.forEach((heading, index) => {
      updates.set(heading.favoriteId, newHeadings[index].favoriteId);
    });
  };
  if (oldChanged.length === newChanged.length) pair(oldChanged, newChanged);
  else {
    // Unchanged, unique headings anchor sections when edits also insert or
    // delete headings. Only pair gaps whose heading counts still agree.
    const key = (heading: Heading) => JSON.stringify([heading.level, heading.title]);
    const positions = (headings: Heading[]) => {
      const result = new Map<string, number[]>();
      headings.forEach((heading, index) => {
        const indices = result.get(key(heading)) ?? [];
        indices.push(index); result.set(key(heading), indices);
      });
      return result;
    };
    const oldPositions = positions(oldChanged), newPositions = positions(newChanged);
    let oldStart = 0, newStart = 0;
    oldChanged.forEach((heading, index) => {
      const matches = newPositions.get(key(heading));
      if (oldPositions.get(key(heading))?.length !== 1 || matches?.length !== 1 || matches[0] < newStart) return;
      pair(oldChanged.slice(oldStart, index), newChanged.slice(newStart, matches[0]));
      updates.set(heading.favoriteId, newChanged[matches[0]].favoriteId);
      oldStart = index + 1; newStart = matches[0] + 1;
    });
    pair(oldChanged.slice(oldStart), newChanged.slice(newStart));
  }
  return updates;
}

export function favoriteNoteId(id: string): string {
  return headingReference(id)?.[0] ?? id;
}

export function resolveFavoriteHeading(id: string, notes: readonly Note[]) {
  const reference = headingReference(id);
  const note = reference && notes.find(note => note.id === reference[0]);
  return note ? favoriteHeadings(note).find(heading => heading.favoriteId === id) : undefined;
}

export function relocateFavorite(id: string, source: string, destination: string): string {
  const reference = headingReference(id);
  const noteId = reference?.[0] ?? id;
  if (!within(noteId, source)) return id;
  const moved = destination + noteId.slice(source.length);
  if (!reference) return moved;
  return headingPrefix + JSON.stringify([moved, ...reference.slice(1)]);
}
