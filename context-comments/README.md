---
summary: Save line-level comments on session context and insert them into your next prompt.
commands: [/context-comments]
category: productivity
keywords: [context, comments, prompt, shortcut, annotation]
status: beta
---

# context-comments

Add comments to specific lines from your current Pi session context, then insert those comments into the query box when you’re ready to send them.

## Features

- Pick one or more context lines in a full-screen modal mode (like built-in full-view tools), with list/input panes sized to your terminal height
- Filter context types in the picker (`t`), collapsing hidden sections into a single `[filtered N lines]` row per entry
- In picker mode, press `s` to submit all saved comments immediately (available after at least one comment is saved)
- Save comments per session branch
- View and clear saved comments
- Insert all saved comments into the editor with `/context-comments submit`
- Show and configure global shortcuts with `/context-comments shortcuts`

## Command

Use a single command with subcommands:

- `/context-comments` (or `/context-comments add`) — Open the picker and add a context comment
- `/context-comments list` — List saved context comments
- `/context-comments clear` — Clear saved context comments in this branch
- `/context-comments submit` — Insert saved comments into the query editor
- `/context-comments shortcuts` — Show current shortcut bindings and config path
- `/context-comments shortcuts set <addComment|submitComments> <shortcut>` — Set a global shortcut
- `/context-comments shortcuts reset <addComment|submitComments>` — Reset one shortcut to default
- `/context-comments shortcuts reset all` — Reset all shortcuts to defaults

## Global shortcuts

Default bindings:

- `addComment`: `ctrl+alt+c`
- `submitComments`: `ctrl+alt+s`

### Configure shortcuts

Shortcuts are read from:

`~/.pi/agent/extensions/context-comments/config.json`

Example:

```json
{
  "shortcuts": {
    "addComment": "ctrl+shift+c",
    "submitComments": "ctrl+shift+s"
  }
}
```

You can also configure shortcuts from Pi:

```text
/context-comments shortcuts set submitComments ctrl+shift+s
```

> Shortcut changes are loaded when the extension starts. Restart Pi after changing shortcut config.

## Picker controls

- `t` — Open context type filters
- In filter mode: `space` toggles hidden/visible, `a` shows all, `enter`/`esc` returns to picker

## Notes

- Comments are stored as custom session entries and restored from the current branch history.
- After comments are inserted into your prompt and submitted, the extension clears submitted comments automatically.
