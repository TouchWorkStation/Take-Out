#!/bin/bash
# 🥡 Takeout installer
#
#   curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/Take-Out/main/install.sh | bash
#
# On Omarchy it installs Takeout as an Omarchy plugin. On other Linux it
# installs a systemd user service instead. Either way it ends by printing the
# link to pair your phone.
set -euo pipefail

REPO="${TAKEOUT_REPO:-https://github.com/TouchWorkStation/Take-Out}"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/takeout"
SERVICE_DIR="$HOME/.local/share/takeout"
UNIT="$HOME/.config/systemd/user/takeout.service"

say() { printf '\033[1;34m🥡\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# When piped from curl, stdin is the script itself. Prompts read from the terminal instead.
TTY=/dev/null
if [[ -t 0 ]]; then TTY=/dev/stdin; elif [[ -r /dev/tty ]] && : </dev/tty 2>/dev/null; then TTY=/dev/tty; fi

[[ $(uname -s) == Linux ]] || die "Takeout runs on Linux (built for Omarchy)."
command -v git >/dev/null 2>&1 || die "Takeout needs git:  sudo pacman -S git"
command -v tmux >/dev/null 2>&1 || die "Takeout needs tmux:  sudo pacman -S tmux"

have_node() { command -v node >/dev/null 2>&1 || { command -v mise >/dev/null 2>&1 && mise which node >/dev/null 2>&1; }; }

# ---------- Node ----------
if ! have_node; then
  if command -v omarchy-install-dev-env >/dev/null 2>&1; then
    say "Takeout needs Node.js — installing it the Omarchy way…"
    omarchy-install-dev-env node <"$TTY" || die "Node install failed. Run 'omarchy install dev-env node' and try again."
    hash -r
    command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims 2>/dev/null)" || true
  fi
  have_node || die "Takeout needs Node.js 18+.  On Omarchy:  omarchy install dev-env node"
fi

pair() {
  local cli="$1"
  say "Waiting for Takeout to start…"
  for _ in $(seq 1 20); do
    bash "$cli" status >/dev/null 2>&1 && break
    sleep 0.5
  done
  if bash "$cli" status >/dev/null 2>&1; then
    say "Takeout is running. Pair your phone:"
    bash "$cli" pair
  else
    say "Installed, but Takeout hasn't answered yet. Give it a few seconds, then run:  takeout pair"
  fi
}

tailscale_tip() {
  if ! command -v tailscale >/dev/null 2>&1 || ! tailscale ip -4 >/dev/null 2>&1; then
    echo
    say "Tailscale isn't up, so Takeout is only reachable from this computer for now."
    echo "   To reach it from your phone:"
    echo "     sudo pacman -S tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up"
    echo "     then:  takeout restart && takeout pair"
    echo "   (and sign in to the Tailscale app on your phone with the same account)"
  fi
}

# ---------- Omarchy: install as a plugin ----------
if command -v omarchy-plugin-add >/dev/null 2>&1; then
  if [[ -d $PLUGIN_DIR ]]; then
    say "Takeout is already installed — updating it…"
    omarchy-plugin-update takeout --yes >/dev/null 2>&1 || git -C "$PLUGIN_DIR" pull --ff-only --quiet || true
    omarchy-plugin-enable takeout >/dev/null 2>&1 || true
  else
    say "Installing Takeout as an Omarchy plugin…"
    if [[ $TTY != /dev/null ]]; then
      # Omarchy shows its own warning about third-party plugins and asks you to confirm.
      omarchy-plugin-add "$REPO" --enable <"$TTY" || die "Plugin install was cancelled."
    else
      die "No terminal to confirm the plugin install. Run this instead:
   omarchy plugin add $REPO --enable"
    fi
  fi
  pair "$PLUGIN_DIR/bin/takeout"
  tailscale_tip
  exit 0
fi

# ---------- Any other Linux: systemd user service ----------
say "Omarchy not found — installing Takeout as a systemd user service."
if [[ -d $SERVICE_DIR/.git ]]; then git -C "$SERVICE_DIR" pull --ff-only --quiet
else git clone --depth 1 --quiet "$REPO" "$SERVICE_DIR"
fi
mkdir -p "$(dirname "$UNIT")"
cat >"$UNIT" <<EOF
[Unit]
Description=Takeout — your Omarchy terminal, to go
After=graphical-session.target network-online.target tailscaled.service
PartOf=graphical-session.target

[Service]
ExecStart=/bin/bash $SERVICE_DIR/start.sh
Restart=on-failure
RestartSec=3
Environment=PATH=$PATH
Environment=SHELL=${SHELL:-/bin/bash}

[Install]
WantedBy=graphical-session.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now takeout.service >/dev/null 2>&1 || systemctl --user restart takeout.service
pair "$SERVICE_DIR/bin/takeout"
tailscale_tip
