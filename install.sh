#!/bin/bash
# Takeout installer — curl -fsSL https://raw.githubusercontent.com/OWNER/takeout/main/install.sh | bash
set -euo pipefail

REPO="${TAKEOUT_REPO:-https://github.com/OWNER/takeout.git}"
DIR="$HOME/.local/share/takeout"
UNIT="$HOME/.config/systemd/user/takeout.service"

say() { printf '\033[1;34m🥡\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $(uname -s) == Linux ]] || die "Takeout runs on Linux (built for Omarchy)."
[[ -d $HOME/.local/state/omarchy ]] || say "No Omarchy found — Takeout will still work, just without theme sync."

# Node: use what's there, otherwise ask mise (Omarchy ships it), otherwise pacman.
if ! command -v node >/dev/null 2>&1; then
  if command -v mise >/dev/null 2>&1; then
    say "Installing Node with mise…"
    mise use -g node@lts
    eval "$(mise activate bash)"
  elif command -v pacman >/dev/null 2>&1; then
    say "Installing Node with pacman…"
    sudo pacman -S --needed --noconfirm nodejs npm
  else
    die "Please install Node.js 18+ first."
  fi
fi
NODE=$(command -v node || mise which node)
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || die "Node 18+ is required."

command -v tailscale >/dev/null 2>&1 || say "Tip: install Tailscale to reach Takeout from your phone (sudo pacman -S tailscale)."

say "Fetching Takeout…"
if [[ -d $DIR/.git ]]; then
  git -C "$DIR" pull --ff-only --quiet
elif [[ -n ${TAKEOUT_SRC:-} ]]; then
  mkdir -p "$DIR" && cp -r "$TAKEOUT_SRC"/. "$DIR"/
else
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

say "Installing dependencies…"
(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --silent 2>/dev/null || npm install --omit=dev --no-audit --no-fund --silent)

mkdir -p "$HOME/.local/bin"
chmod +x "$DIR/bin/takeout"
ln -sf "$DIR/bin/takeout" "$HOME/.local/bin/takeout"

say "Setting up the background service…"
mkdir -p "$(dirname "$UNIT")"
cat >"$UNIT" <<EOF
[Unit]
Description=Takeout — your Omarchy terminal, to go
After=graphical-session.target network-online.target tailscaled.service
PartOf=graphical-session.target

[Service]
ExecStart=$NODE $DIR/server.js
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
sleep 1

say "Takeout is running. Pair your phone:"
"$HOME/.local/bin/takeout" pair
