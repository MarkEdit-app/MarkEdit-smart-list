# MarkEdit-smart-list

Smarter list indentation and automatic numbering for [MarkEdit](https://github.com/MarkEdit-app/MarkEdit).

## Installation

Install this extension from the [MarkEdit Extension Registry](https://markedit-app.github.io/extensions/#markedit-smart-list).

## Features

- Indent and outdent lists with Tab, Shift-Tab, Command-[, Command-], or the native indentation commands.
- Keep child items and continuation lines attached.
- Start new ordered sublists at `1`, continue existing lists, and preserve deliberate numbering restarts.
- Fix numbering after deleting whole lines or leading indentation.
- Undo each edit and its numbering changes together.

## Settings

In [settings.json](https://github.com/MarkEdit-app/MarkEdit/wiki/Customization#advanced-settings), defaults are:

```json
{
  "extension.markeditSmartList": {
    "indentWidth": "auto",
    "renumberOnDelete": true,
    "tabBehavior": "marker"
  }
}
```

- `indentWidth`: `"auto"` aligns with the parent's text; `3` or `4` sets a preferred minimum. Wider markers may require more spaces. Existing child-list alignment takes precedence.
- `renumberOnDelete`: repair numbering after deletion. Indent/outdent commands still adjust numbers when disabled.
- `tabBehavior`: `"marker"` handles Tab near the marker; `"item"` handles it anywhere on the item's opening line.

Relaunch MarkEdit after changing settings.

## Development

- `yarn test`: run tests (Node.js 22.18+).
- `yarn test:browser`: run browser checks at `/test/`.
- `yarn typecheck`: check types.
- `yarn build:check`: build without deploying.
- `yarn build`: build and deploy to your local MarkEdit installation.
