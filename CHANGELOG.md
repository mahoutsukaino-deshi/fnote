# Release notes

[日本語](CHANGELOG.ja.md)

## v0.1.12 (Unreleased)

- Display child notes and headings in favorite as a tree with the same icons, colors, and collapsed tag priorities as the note list. Click headings to jump to their positions in the note; attachments are excluded.
- Add **Collapse All / Expand All** buttons to favorite, switching between them according to the expansion state just like the note list.
- Save the note list and favorite expansion states separately in `.status` at the storage root and restore them on the next launch, including headings and Collapse All / Expand All changes.

## v0.1.11

- Resize the extension icon to 1024×1024 pixels to fix Marketplace publishing errors.
- Shorten the note and tag view names to `List` and `Tags`.
- Rename a note's folder when its first-line `#` heading changes and is saved. Preserve child notes and attachments, and update supported relative links, favorites, and display order. Report conflicting or invalid names without renaming the folder.
- Show each note's storage folder name instead of `index.md` in editor tabs while keeping the standard Markdown file editor. Require VS Code 1.88 or later.
- Add a **favorite** area for shortcuts to frequently used notes, displayed as a flat list with note tag icons.
- Add **Add to favorite** in the note list context menu and **Remove from favorite** in the favorite context menu. Removing a shortcut preserves the original note.
- Support reordering within favorite by drag and drop or **Move Up / Move Down**. Store favorite note IDs and display order in `.status` at the storage root, distinguish identically named notes in different hierarchies, and follow notes renamed or moved within the extension.
- Fix icon selection for parent notes and collapsed Markdown headings by comparing their own and descendant tags together according to the configured priority.
- Include tags with an omitted or blank `mark` in `fnote.tagStyles` priority comparisons, using `fnote.defaultTagMark` when no parent icon can be inherited.
- Inherit tag icon shapes and colors independently, giving a child tag's `markColor` or `color` precedence over ancestor colors.
- Improve selection and display updates when dragging unselected rows or receiving list updates during a note-list drag.

## v0.1.10

- Prevent Markdown link syntax from briefly appearing while typing by reusing link decorations instead of disposing and recreating them.
- Support Ctrl+Click navigation for Markdown links to headings in the current or another note, such as `[](#title)`.
- Show the note's tag icon on Markdown heading rows in the note list, with a configurable heading mark and color.
- Add optional Time mode for date-tag results with `fnote.dateTagSort`.
- Add a Sort button to cycle date-tag result modes without changing settings.
- Group date-tag results by date across notes in Time mode, allowing a note to appear in multiple date groups.
- Enable the same date-ordered Time mode for regular tag results, placing undated lines in a final **No date** group.

## v0.1.9

- Keep focus in the tag list after selecting a tag so the Up and Down arrow keys can move between tags like they do in the note list.

## v0.1.8

- Add inline name editing when creating or renaming notes and attachments.
- Update supported relative Markdown and wiki links when notes, attachments, and directories are moved or renamed.
- Add archive and unarchive support for notes, including optional descendant updates; archived notes are excluded from tag results, counts, and work-time totals.
- Improve note list navigation, keyboard shortcuts, context menus, and drag-and-drop support for attachments.
- Store the ordering of direct child notes in `.status` files so copied or synchronized storage preserves note ordering.

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
