#!/usr/bin/env bash
# install-vscode-extension.sh
#
# Packages ../vscode-extension (Claude Open Bridge) as a .vsix and installs it.
# - On a VS Code Remote-SSH host: through the remote CLI of a connected window
#   (the newest one), so it is installed on this host where the extension runs.
# - Elsewhere (a local session on macOS or Linux): through the local `code` CLI.
# Written for bash 3.2 (macOS) as well.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$here/../vscode-extension" && pwd)
manifest="$src/package.json"

# First `"key": "value"` string in package.json.
field() {
  sed -nE 's/^[[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$manifest" | head -1
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

name=$(field name)
publisher=$(field publisher)
version=$(field version)
display_name=$(field displayName)
description=$(field description)
engine=$(field vscode)
kind=$(sed -nE 's/.*"extensionKind"[[:space:]]*:[[:space:]]*\[([^]]*)\].*/\1/p' "$manifest" | tr -d ' "' | head -1)
if [ -z "$name" ] || [ -z "$publisher" ] || [ -z "$version" ] || [ -z "$engine" ]; then
  echo "could not read name/publisher/version/engines.vscode from $manifest" >&2
  exit 1
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/claude-open-bridge.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
stage="$tmp/stage"
mkdir -p "$stage/extension"
cp -R "$src/." "$stage/extension/"

cat >"$stage/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(xml_escape "$name")" Version="$(xml_escape "$version")" Publisher="$(xml_escape "$publisher")" />
    <DisplayName>$(xml_escape "$display_name")</DisplayName>
    <Description xml:space="preserve">$(xml_escape "$description")</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(xml_escape "$engine")" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="$(xml_escape "$kind")" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
EOF

cat >"$stage/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".css" ContentType="text/css" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
EOF

vsix="$tmp/$publisher.$name-$version.vsix"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$stage" "$vsix" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
names = ["[Content_Types].xml", "extension.vsixmanifest"]
for root, _, files in os.walk(os.path.join(stage, "extension")):
    for f in sorted(files):
        names.append(os.path.relpath(os.path.join(root, f), stage))
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names:
        z.write(os.path.join(stage, n), n)
PY
elif command -v zip >/dev/null 2>&1; then
  # -nw: "[Content_Types].xml" is a literal name, not a wildcard.
  (cd "$stage" && zip -q -X -r -nw "$vsix" "[Content_Types].xml" extension.vsixmanifest extension)
else
  echo "neither python3 nor zip is available to build the .vsix" >&2
  exit 1
fi
echo "built $(basename "$vsix")"

# "<socket> <extension host pid>" per listening Remote-SSH window socket
# (same detection as open-in-vscode.sh).
live_sockets() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -xlpn 2>/dev/null |
    sed -nE 's|.*[[:space:]](/[^[:space:]]*vscode-ipc-[^[:space:]]*\.sock)[[:space:]].*pid=([0-9]+).*|\1 \2|p'
}

# The remote CLI next to the extension host's node binary.
remote_cli_of() {
  local node cli
  node=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  cli="$(dirname "$node")/bin/remote-cli/code"
  [ -x "$cli" ] && printf '%s\n' "$cli"
}

# Prints "<socket> <cli>" of the newest connected Remote-SSH window, if any.
remote_window() {
  [ -d "$HOME/.vscode-server" ] && [ -d /proc ] || return 0
  local sockets sock pid cli newest="" newest_cli=""
  sockets=$(live_sockets)
  [ -n "$sockets" ] || return 0
  while read -r sock pid; do
    cli=$(remote_cli_of "$pid") || continue
    if [ -z "$newest" ] || [ "$sock" -nt "$newest" ]; then
      newest=$sock
      newest_cli=$cli
    fi
  done <<EOF
$sockets
EOF
  [ -n "$newest" ] && printf '%s %s\n' "$newest" "$newest_cli"
  return 0
}

window=$(remote_window)
if [ -n "$window" ]; then
  sock=${window%% *}
  cli=${window#* }
  echo "installing through the Remote-SSH window CLI: VSCODE_IPC_HOOK_CLI=$sock $cli"
  VSCODE_IPC_HOOK_CLI=$sock "$cli" --install-extension "$vsix" --force
  echo "installed $publisher.$name $version on this host"
  exit 0
fi

for cli in "$(command -v code 2>/dev/null || true)" \
  /usr/local/bin/code /opt/homebrew/bin/code /usr/bin/code /snap/bin/code \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
  if [ -n "$cli" ] && [ -x "$cli" ]; then
    echo "installing through the local VS Code CLI: $cli"
    "$cli" --install-extension "$vsix" --force
    echo "installed $publisher.$name $version"
    exit 0
  fi
done
echo "the VS Code 'code' command was not found" >&2
exit 2
