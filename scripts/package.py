"""Build a dependency-free VSIX with the standard VSIX manifest."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

root = Path(__file__).resolve().parent.parent
package = json.loads((root / 'package.json').read_text())
name, version, publisher = (package[k] for k in ('name', 'version', 'publisher'))
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
<Metadata><Identity Language="en-US" Id="{publisher}.{name}" Version="{version}" Publisher="{publisher}"/><DisplayName>fnote</DisplayName><Description xml:space="preserve">{escape(package['description'])}</Description><Tags>markdown,notes</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{package['engines']['vscode']}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>'''
content_types = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="css" ContentType="text/css"/><Default Extension="ttf" ContentType="font/ttf"/><Default Extension="png" ContentType="image/png"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'''
output = root / f'{name}-{version}.vsix'
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', manifest)
    archive.writestr('[Content_Types].xml', content_types)
    for relative in ['package.json', 'README.md', '画面イメージ.png', 'dist/core.js', 'dist/extension.js', 'dist/notesView.js', 'media/notes.js', *[str(file.relative_to(root)) for file in sorted((root / 'media/codicons').iterdir()) if file.is_file()]]:
        archive.write(root / relative, f'extension/{relative}')
print(output)
