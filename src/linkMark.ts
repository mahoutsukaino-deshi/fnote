import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const outlines: { size: number; ascent: number; paths: Record<string, string> } =
  JSON.parse(readFileSync(join(__dirname, '..', 'media', 'codicons', 'paths.json'), 'utf8'));

export function linkMark(value: string): { icon?: string; text: string } {
  const match = value.match(/^\$\(([a-z0-9-]+)\)$/i);
  if (!match) return { text: value };
  return { icon: Object.hasOwn(outlines.paths, match[1]) ? match[1] : 'link-external', text: '' };
}

const images = new Map<string, string>();
export function linkIconUri(icon: string): string {
  const key = icon;
  let uri = images.get(key);
  if (!uri) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outlines.size} ${outlines.size}"><path fill="black" transform="translate(0 ${outlines.ascent}) scale(1 -1)" d="${outlines.paths[icon]}"/></svg>`;
    uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    images.set(key, uri);
  }
  return uri;
}
