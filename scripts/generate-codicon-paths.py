"""Regenerate editor icon outlines from bundled Codicons (requires fontTools)."""
import json
import re
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

root = Path(__file__).resolve().parent.parent
folder = root / 'media/codicons'
font = TTFont(folder / 'codicon.ttf')
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
paths = {}
for name, code in re.findall(r'\.codicon-([\w-]+):before \{ content: "\\([a-f0-9]+)" \}', (folder / 'codicon.css').read_text()):
    pen = SVGPathPen(glyphs)
    glyphs[cmap[int(code, 16)]].draw(pen)
    paths[name] = pen.getCommands()
(folder / 'paths.json').write_text(json.dumps({
    'size': font['head'].unitsPerEm, 'ascent': font['hhea'].ascent, 'paths': paths
}, ensure_ascii=False, indent=2) + '\n')
print(f'Generated {len(paths)} Codicon outlines')
