# Release notes

[日本語](CHANGELOG.ja.md)

## v0.1.3

- Display links with icons in the note editor and tag/search results.
- Add `fnote.linkMark` to customize link icons. Use the default `$(link-external)`, another bundled Codicon such as `$(globe)`, emoji, or text. An empty string hides the icon.

## v0.1.2

- Update the version number to 0.1.2. No functional changes from v0.1.1.

## v0.1.1

- Support relative links between notes. `[[../Travel/]]` and `[](../Travel/)` open the destination's `index.md` relative to the current note.
- Apply Markdown link color customizations to URLs in tag/search results and refresh them when the theme or color settings change.

## v0.1.0

- Initial release.
- Organize Markdown notes in hierarchies, move and reorder them with drag and drop, and navigate heading outlines.
- Search by tag or keyword and jump to matching locations in source notes.
- Track work time by day, month, and year using date and duration tags.
- Customize tag icons and colors, and configure shared note storage across workspaces.
