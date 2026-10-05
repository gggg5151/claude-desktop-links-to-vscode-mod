# claude-desktop-links-to-vscode-mod

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) for the desktop app.
**Click a file reference in a reply, and the file opens in VS Code at that line.**

<!-- TODO: demo GIF -->

In the desktop app's Code tab, a reply cites files as links such as `src/server.ts:42`. A click opens the app's own file pane, and an SSH session offers no "Open in" entry for your editor. With this mod, the click goes to the VS Code window you already have open.

- **Remote-SSH**: the file opens in the window whose folder contains it.
- **Local**: on macOS and Linux, through the `code` command.
- **Markdown Preview**: a previewed Markdown file scrolls to the line and stays a preview.
- Web links, images, folders and paths that do not exist behave as before.

[日本語](README.ja.md) · [How it works](docs/how-it-works.md)

## Install

You need the desktop app's Code tab with Claude Code v2.1.287 or later, VS Code 1.90 or later, and `bash`.
Run these on the machine where the session runs. For an SSH session, that is the remote host.

1. Get the files.

   ```bash
   git clone https://github.com/gggg5151/claude-desktop-links-to-vscode-mod.git ~/.claude/mods/links-to-vscode
   ```

2. Load the mod. Add this to `~/.claude/settings.json`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/links-to-vscode"
     }
   }
   ```

3. For the Markdown Preview jump, install the bundled VS Code extension while a VS Code window is open:

   ```bash
   bash ~/.claude/mods/links-to-vscode/scripts/install-vscode-extension.sh
   ```

4. Start a new session and click a file reference.

A mod runs with your permissions. `claude plugin validate ~/.claude/mods/links-to-vscode` lists what this one hooks and calls, without running it.

## Known limitations

- Windows is not supported as the machine the session runs on.
- Any readable file can be opened, `.env` included. Mind it while sharing your screen.
- When VS Code cannot be reached, the click shows a notice and the app's file pane does not open.
- With several Remote-SSH windows, a folder whose path has spaces, non-ASCII characters or `+` may not be matched. The newest window is used.
- The Markdown Preview jump shows a text tab for a moment.
- Choosing the window relies on VS Code internals, so a VS Code update can break it.

The full list is in [How it works](docs/how-it-works.md#limits).

## License

[MIT](LICENSE)
