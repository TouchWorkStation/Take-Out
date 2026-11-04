#!/bin/bash
# Takeout installer for when you're not using the Omarchy plugin system.
# On Omarchy, prefer:  omarchy plugin add https://github.com/OWNER/takeout --enable
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/takeout/main/install.sh | bash
set -euo pipefail

REPO="${TAKEOUT_REPO:-https://github.com/OWNER/takeout.git}"
DIR="$HOME/.local/share/takeout"
UNIT="$HOME/.config/systemd/user/takeout.service"

say() { printf '\033[1;34m🥡\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $(uname -s) == Linux ]] || die "Takeout runs on Linux (built for Omarchy)."
command -v tmux >/dev/null 2>&1 || die "Takeout needs tmux:  sudo pacman -S tmux"
command -v node >/dev/null 2>&1 || (command -v mise >/dev/null 2>&1 && mise which node >/dev/null 2>&1) \
  || die "Takeout needs Node.js 18+.  On Omarchy:  omarchy install dev-env node"
command -v tailscale >/dev/null 2>&1 || say "Tip: install Tailscale to reach Takeout from your phone."

say "Fetching Takeout…"
if [[ -d $DIR/.git ]]; then git -C "$DIR" pull --ff-only --quiet
else git clone --depth 1 --quiet "$REPO" "$DIR"
fi

say "Setting up the background service…"
mkdir -p "$(dirname "$UNIT")"
cat >"$UNIT" <<EOF
[Unit]
Description=Takeout — your Omarchy terminal, to go
After=graphical-session.target network-online.target tailscaled.service
PartOf=graphical-session.target

[Service]
ExecStart=/bin/bash $DIR/start.sh
Restart=on-failure
RestartSec=3
Environment=PATH=$PATH
Environment=SHELL=${SHELL:-/bin/bash}
Environment=OMARCHY_PATH=${OMARCHY_PATH:-$HOME/.local/share/omarchy}

[Install]
WantedBy=graphical-session.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now takeout.service >/dev/null 2>&1 || systemctl --user restart takeout.service
sleep 2

say "Takeout is running. Pair your phone:"
bash "$DIR/bin/takeout" pair
