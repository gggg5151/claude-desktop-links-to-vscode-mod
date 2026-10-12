# How it works

[日本語](how-it-works.ja.md)

```
reply text ──▶ hooks/register.tsx ──click──▶ scripts/open-in-vscode.sh ──▶ VS Code
               (rewrites file links)          (picks the window)             ▲
                                                     │ Markdown only          │
                                                     └──▶ Claude Open Bridge ─┘
                                                          (unix socket)
```

## The three parts

### `hooks/register.tsx`

It hooks the drawing of an assistant message on the desktop surface. Every Markdown link whose target is an existing regular file becomes a `file://…#L<line>C<column>` link that reports its click. Inline code and code fences are skipped.

These spellings are recognised: `a.ts`, `a.ts:42`, `a.ts:42:7`, `a.ts:42-50`, `a.ts#L42`, `a.ts#L42C7-L50`.

### `scripts/open-in-vscode.sh`

It receives the path, line and column.

- **Remote-SSH host** (`~/.vscode-server` exists). It lists the listening `vscode-ipc-*.sock` sockets and finds each window's remote CLI next to its extension host. VS Code names a remote folder's storage `md5("vscode-remote://<authority><path>")`, so the script hashes the file's parent folders until one matches a window. It then runs `code -r -g path:line:column` through that window's socket. With one window, or no match, the newest window is used.
- **Local**. It runs `code -g path:line:column`, and VS Code picks the window.

### `vscode-extension/` (Claude Open Bridge)

It handles Markdown. The built-in preview accepts no line from outside, but a newly opened preview starts at the topmost visible line of the most recent text editor for the same file. So the extension:

1. opens the file as text in the preview's editor group,
2. scrolls the target line to the top,
3. closes the old preview,
4. opens a new preview, and
5. closes the text tab it opened (one you already had stays).

Each window listens on `~/.cache/claude-open-bridge/<pid>.sock` (directory `0700`, socket `0600`). The script posts `{path, line, column}` to the window whose workspace folder contains the file.

If the jump does not work right after installing the extension, run **Developer: Reload Window** in VS Code.

## What it can reach

`claude plugin validate` lists what the mod hooks and calls, without running anything:

```
❯ ./register.tsx hooks: session.start, command.run{command=open-in-vscode-install-extension}, ui.render{component=AssistantMessage}
❯ ./register.tsx calls: $.command.register, $.fs.stat, $.process.run, $.session.cwd, $.ui.resolve, $.ui.toast
```

It checks whether a linked path is a file (`$.fs.stat`), on a click runs `scripts/open-in-vscode.sh`, and on `/open-in-vscode-install-extension` runs `scripts/install-vscode-extension.sh` (`$.process.run`). It makes no network requests.

## Load from a clone

Instead of installing from the marketplace, you can point Claude Code at a clone:

```bash
git clone https://github.com/gggg5151/claude-desktop-links-to-vscode-mod.git ~/.claude/mods/links-to-vscode
```

Then add the folder to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/links-to-vscode"
  }
}
```

If the variable is already set, append the folder with `:`. In a terminal session, `claude --plugin-dir ~/.claude/mods/links-to-vscode` loads it for that session only. Do not install the plugin and load the clone at the same time: two plugins with one name, and only the first loads.

## Check the setup without opening anything

```bash
OPEN_IN_VSCODE_DRY_RUN=1 bash scripts/open-in-vscode.sh /absolute/path/to/file.ts 42 1
```

It prints the command it would run.

## Limits

Platform

- A WSL session in the desktop app loads no plugins, and the script is untested on native Windows.
- Remote-SSH is detected by `~/.vscode-server` on a Linux host. A server installed elsewhere, or under another name, is not detected.

Opening a file

- Any existing, readable file can be opened, `.env` included. It opens only in your own editor.
- When VS Code cannot be reached, the click shows a notice and does not fall back to the app's file pane.
- With several Remote-SSH windows, a folder whose path contains spaces, non-ASCII characters or `+` may not be matched; the newest window is used.
- Choosing the window relies on VS Code internals: its socket names, the extension host's log, how it names a folder's storage, and the text of `code --status`. When any of these does not match, the newest window is used without a notice.
- `OPEN_IN_VSCODE_DRY_RUN=1` still asks each window for `code --status`.

Markdown Preview

- The text tab is visible for a moment.
- If the switch fails halfway, the preview is gone and the text tab stays open.
- The jump relies on how the built-in preview picks its starting line.
- After a jump, a window holding an untitled multi-root workspace is not brought to the front.

Rewriting links

- Only inline code and three-backtick or tilde fences count as code. A link in an indented code block, or in a longer fence that contains another fence, can still be rewritten.
- Whether a path is an openable file is remembered for the session.
- A reply is left as it is when its rewritten text exceeds 10,000 characters, or when it links to more than 256 different file locations.

Installing the extension

- VS Code's remote CLI exits with `0` even when the install failed, so the script prints "installed" either way. Check the Extensions view.

## Uninstall

1. Installed from the marketplace: `claude plugin uninstall open-in-vscode@links-to-vscode`. Loaded from a clone: remove the folder from `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` and delete it.
2. Delete `~/.cache/claude-open-bridge`.
3. In VS Code, uninstall **Claude Open Bridge** from the Extensions view.
