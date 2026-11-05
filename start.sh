#!/bin/bash
# Launches the Takeout server. Run by the Omarchy plugin (Service.qml) or by
# the systemd user service from install.sh.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Put `takeout` on PATH so `takeout pair` works from any terminal — but never
# clobber some other command that already owns the name.
mkdir -p "$HOME/.local/bin"
link="$HOME/.local/bin/takeout"
if [[ ! -e $link && ! -L $link ]] || [[ $(readlink "$link") == */bin/takeout && $(readlink "$link") == *takeout* ]]; then
  ln -sfn "$DIR/bin/takeout" "$link"
fi

# Node: what's on PATH, else mise (Omarchy ships it), else ask for it once.
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
elif command -v mise >/dev/null 2>&1; then
  NODE=$(mise which node 2>/dev/null || true)
fi

if [[ -z $NODE ]]; then
  flag="${XDG_CONFIG_HOME:-$HOME/.config}/takeout/.node-notice"
  if [[ ! -f $flag ]] && command -v notify-send >/dev/null 2>&1; then
    mkdir -p "$(dirname "$flag")" && touch "$flag"
    notify-send -a Takeout "🥡 Takeout needs Node.js" "Run: omarchy install dev-env node"
  fi
  echo "Node.js not found. Install it with: omarchy install dev-env node" >&2
  exit 1
fi
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/takeout/.node-notice"

exec "$NODE" "$DIR/server.js"
