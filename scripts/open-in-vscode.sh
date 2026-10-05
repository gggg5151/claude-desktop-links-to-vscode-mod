#!/usr/bin/env bash
# open-in-vscode.sh <absolute path> [line] [column]
#
# Opens the file in VS Code at the line.
# - A Markdown file whose window runs the Claude Open Bridge extension
#   (vscode-extension/): the extension opens it in that window, in the editor
#   the user has for it (a Markdown Preview scrolled to the line, which the CLI
#   cannot do); the CLI then only brings the window to the front by naming its
#   open folder, which VS Code answers by focusing that window.
# - Otherwise, on a VS Code Remote-SSH host: through the CLI socket of the
#   window whose workspace folder holds the file (the newest window when none
#   does).
# - Otherwise (a local session on macOS or Linux): through the local `code`
#   CLI, which picks the window holding the file itself.
# Written for bash 3.2 (macOS) as well. OPEN_IN_VSCODE_DRY_RUN=1 prints the
# commands instead of running them.
set -u

file=${1:?usage: open-in-vscode.sh <path> [line] [column]}
line=${2:-1}
col=${3:-1}
goto="$file:$line:$col"

# A folder or a .code-workspace file would open as a workspace in a new window
# (also with -g), and a device or a pipe would hang the editor.
case $file in
  *.code-workspace | *.CODE-WORKSPACE)
    echo "a workspace file is not opened as a file: $file" >&2
    exit 2
    ;;
esac
if [ ! -f "$file" ]; then
  echo "not a regular file: $file" >&2
  exit 2
fi
bridge_dir="$HOME/.cache/claude-open-bridge"
is_remote_host=""
[ -d "$HOME/.vscode-server" ] && [ -d /proc ] && is_remote_host=1

# Runs the command and exits with its status.
run() {
  if [ -n "${OPEN_IN_VSCODE_DRY_RUN:-}" ]; then
    printf 'VSCODE_IPC_HOOK_CLI=%s %s\n' "${VSCODE_IPC_HOOK_CLI:-}" "$*"
    exit 0
  fi
  exec "$@"
}

# --- Remote-SSH windows -------------------------------------------------------

# "<socket> <extension host pid>" per listening Remote-SSH window socket.
live_sockets() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -xlpn 2>/dev/null |
    sed -nE 's|.*[[:space:]](/[^[:space:]]*vscode-ipc-[^[:space:]]*\.sock)[[:space:]].*pid=([0-9]+).*|\1 \2|p'
}

# The remote CLI next to the extension host's node binary.
remote_cli_of() {
  local node
  node=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  local cli
  cli="$(dirname "$node")/bin/remote-cli/code"
  [ -x "$cli" ] && printf '%s\n' "$cli"
}

# The workspaceStorage id the extension host locked at startup.
workspace_id_of() {
  local fd target
  for fd in /proc/"$1"/fd/*; do
    target=$(readlink "$fd" 2>/dev/null) || continue
    case $target in
      */remoteexthost.log)
        grep -oE 'workspaceStorage/[0-9a-f]{32}' "$target" | tail -1 | cut -d/ -f2
        return
        ;;
    esac
  done
}

# The window's remote authority ("ssh-remote%2Bmyhost"), cached per socket.
authority_of() {
  local sock=$1 cli=$2
  local cache="${XDG_RUNTIME_DIR:-/tmp}/open-in-vscode.$(basename "$sock").authority"
  if [ ! -s "$cache" ]; then
    VSCODE_IPC_HOOK_CLI=$sock timeout 10 "$cli" --status 2>/dev/null |
      sed -nE 's/^Remote:[[:space:]]+SSH: (.+)$/ssh-remote%2B\1/p' | head -1 >"$cache"
  fi
  cat "$cache"
}

md5_of() {
  if command -v md5sum >/dev/null 2>&1; then
    printf '%s' "$1" | md5sum | cut -d' ' -f1
  else
    md5 -qs "$1"
  fi
}

# The length of the window's workspace folder when it is the file's folder or
# an ancestor: VS Code names a remote folder's storage
# md5("vscode-remote://<authority><path>").
held_folder_length() {
  local id=$1 authority=$2 dir
  dir=$(dirname "$file")
  while [ -n "$dir" ] && [ "$dir" != / ]; do
    if [ "$(md5_of "vscode-remote://$authority$dir")" = "$id" ]; then
      printf '%s\n' "${#dir}"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

open_remote() {
  local sockets count sock pid cli id authority held
  local newest="" newest_cli="" best="" best_cli="" best_len=0
  sockets=$(live_sockets)
  [ -n "$sockets" ] || return 2
  count=$(printf '%s\n' "$sockets" | wc -l | tr -d ' ')

  while read -r sock pid; do
    cli=$(remote_cli_of "$pid") || continue
    if [ -z "$newest" ] || [ "$sock" -nt "$newest" ]; then
      newest=$sock
      newest_cli=$cli
    fi
    [ "$count" -gt 1 ] || continue
    id=$(workspace_id_of "$pid")
    authority=$(authority_of "$sock" "$cli")
    [ -n "$id" ] && [ -n "$authority" ] || continue
    # The deepest folder wins when windows have nested folders open.
    held=$(held_folder_length "$id" "$authority") || continue
    if [ "$held" -gt "$best_len" ]; then
      best=$sock
      best_cli=$cli
      best_len=$held
    fi
  done <<EOF
$sockets
EOF

  [ -n "$best" ] && VSCODE_IPC_HOOK_CLI=$best run "$best_cli" -r -g "$goto"
  [ -n "$newest" ] || return 2
  VSCODE_IPC_HOOK_CLI=$newest run "$newest_cli" -g "$goto"
}

# --- Local VS Code ------------------------------------------------------------

local_cli() {
  local cli
  for cli in "$(command -v code 2>/dev/null)" \
    /usr/local/bin/code /opt/homebrew/bin/code /usr/bin/code /snap/bin/code \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
    [ -n "$cli" ] && [ -x "$cli" ] && printf '%s\n' "$cli" && return 0
  done
  return 1
}

open_local() {
  local cli
  cli=$(local_cli) && run "$cli" -g "$goto"
  if [ -n "$is_remote_host" ]; then
    echo "no VS Code Remote-SSH window is connected to this host" >&2
  else
    echo "the VS Code 'code' command was not found" >&2
  fi
  exit 2
}

# --- Claude Open Bridge (Markdown) --------------------------------------------

is_markdown() {
  case $(printf '%s' "$file" | tr '[:upper:]' '[:lower:]') in
    *.md | *.markdown | *.mkd | *.mkdn | *.mdwn | *.mdown | *.markdn | *.mdtxt | *.mdtext) return 0 ;;
  esac
  return 1
}

# The string, or each string of the array, that a bridge registry entry has
# for a key, one per line. An entry is one line of JSON.stringify output, so a
# quote or a backslash inside a string is escaped.
registry_strings() {
  awk -v key="\"$2\":" '
    {
      at = index($0, key)
      if (!at) next
      rest = substr($0, at + length(key))
      many = (substr(rest, 1, 1) == "[")
      inside = 0
      while (length(rest)) {
        c = substr(rest, 1, 1)
        rest = substr(rest, 2)
        if (!inside) {
          if (c == "\"") { inside = 1; value = "" }
          else if (c == "]" || c == "}") break
          continue
        }
        if (c == "\\") { value = value substr(rest, 1, 1); rest = substr(rest, 2); continue }
        if (c == "\"") { print value; inside = 0; if (!many) break; continue }
        value = value c
      }
    }' "$1"
}

# One workspace folder per line from a bridge registry entry.
bridge_folders() {
  registry_strings "$1" folders
}

# The registry entry of the window whose longest folder holds the file.
bridge_entry_holding_file() {
  local entry folder best="" best_len=0
  for entry in "$bridge_dir"/*.json; do
    [ -f "$entry" ] || continue
    while IFS= read -r folder; do
      [ -n "$folder" ] || continue
      case $file in
        "${folder%/}"/*)
          if [ "${#folder}" -gt "$best_len" ]; then
            best=$entry
            best_len=${#folder}
          fi
          ;;
      esac
    done <<EOF
$(bridge_folders "$entry")
EOF
  done
  [ -n "$best" ] && printf '%s\n' "$best"
}

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# What to name to `code` so that it brings the registry entry's window to the
# front: its .code-workspace file, or its folder when it has just one. VS Code
# focuses the window that already has a workspace or a lone folder it is asked
# to open; a folder of a multi-root window would open in a new window instead.
window_target() {
  local entry=$1 workspace
  workspace=$(registry_strings "$entry" workspaceFile)
  if [ -n "$workspace" ]; then
    printf '%s\n' "$workspace"
  elif [ "$(bridge_folders "$entry" | grep -c .)" = 1 ]; then
    bridge_folders "$entry"
  fi
}

# Brings the entry's window to the front, and changes nothing else. The bridge
# has opened the file already, so this never falls back to opening it; a window
# with nothing to name (an untitled multi-root workspace) stays where it is.
focus_window() {
  local entry=$1 pid=$2 target sock cli
  target=$(window_target "$entry")
  [ -n "$target" ] || exit 0
  if [ -n "$is_remote_host" ]; then
    sock=$(live_sockets | while read -r s p; do [ "$p" = "$pid" ] && printf '%s\n' "$s"; done)
    cli=$(remote_cli_of "$pid") || exit 0
    [ -n "$sock" ] || exit 0
    VSCODE_IPC_HOOK_CLI=$sock run "$cli" "$target"
  fi
  cli=$(local_cli) || exit 0
  run "$cli" "$target"
}

# Hands a Markdown file to its window's bridge; returns when there is none or it
# fails, so the CLI opens the file instead.
open_markdown_with_bridge() {
  is_markdown || return 0
  command -v curl >/dev/null 2>&1 || return 0
  # json_string escapes quotes and backslashes only; the CLI opens a path with
  # a control character in it.
  case $file in *[[:cntrl:]]*) return 0 ;; esac

  local entry pid body
  entry=$(bridge_entry_holding_file) || return 0
  pid=$(basename "$entry" .json)
  body=$(printf '{"path":%s,"line":%d,"column":%d}' "$(json_string "$file")" "$line" "$col")

  if [ -n "${OPEN_IN_VSCODE_DRY_RUN:-}" ]; then
    printf 'POST %s /reveal %s\n' "${entry%.json}.sock" "$body"
  else
    local answer
    answer=$(curl -s --max-time 10 --unix-socket "${entry%.json}.sock" \
      -H 'content-type: application/json' -d "$body" http://localhost/reveal)
    printf '%s' "$answer" | grep -q '"ok":true' || return 0
  fi
  focus_window "$entry" "$pid"
}

open_markdown_with_bridge
[ -n "$is_remote_host" ] && open_remote
open_local
