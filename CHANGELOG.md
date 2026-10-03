# Release notes

[日本語](CHANGELOG.ja.md)

## Unreleased

- Add inline name editing when creating or renaming notes and attachments.
- Update supported relative Markdown and wiki links when notes, attachments, and directories are moved or renamed.
- Add archive and unarchive support for notes, including optional descendant updates; archived notes are excluded from tag results, counts, and work-time totals.
- Improve note list navigation, keyboard shortcuts, context menus, and drag-and-drop support for attachments.

## v0.1.7

- Allow `fnote.storagePath` to be set in workspace settings and support `${workspace}/` and `${workspaceFolder}/` path variables.
- Add a dedicated Fnote view container to the activity bar with its own icon, moving the notes and tags views out of Explorer.

## v0.1.6

- Add attachment support for Markdown notes. Files and folders can be copied into a note from the Markdown editor, the note list, or the note menu; attachments are shown in the note list and can be opened or deleted.
- Add `fnote.attachmentMark` and `fnote.attachmentColor` for customizing attachment icons in the editor and note list.
- Support relative links to filenames containing parentheses and encode attachment link paths safely.

## v0.1.5

- Group unfinished time tags such as `@10:00-` under **Incomplete time tags** instead of numeric tags. Select the entry to find unfinished work logs and customize its icon and colors with `fnote.tagStyles`.

## v0.1.4

- Fix editor freezes when parsing long or incomplete Markdown links while editing.

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
