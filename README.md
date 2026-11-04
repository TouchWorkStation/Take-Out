# 🥡 Takeout

**Your Omarchy terminal, to go.**

Takeout is a tiny self-hosted web app that puts a real terminal from your Omarchy machine on your phone, and it wears your Omarchy theme. Switch themes on your desktop and your phone follows. Tap a theme on your phone and your desktop switches too.

No cloud. No account. No app store. It runs on your machine and you reach it over Tailscale.

![Takeout on a phone](docs/screenshot.png)

## What it does

- **A real terminal.** A full login shell (zsh, bash, whatever you use) running `nvim`, `btop`, `lazygit`, Claude Code, Codex, opencode, all of it.
- **Theme sync.** Colors come straight from your active Omarchy theme. Change it anywhere and every connected phone updates live.
- **Theme picker.** All your installed themes, with real swatches. Tap to switch your whole desktop from the couch.
- **Your font, too.** Takeout serves the exact monospace font your desktop uses, so the phone matches.
- **Survives your phone locking.** One persistent shell session. Close the tab, lock the screen, come back: you're exactly where you left off.
- **Phone keys.** esc, tab, sticky ctrl/alt, arrows, pipes, ^C, paste.
- **Add to Home Screen.** It runs as a full-screen app.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/takeout/main/install.sh | bash
```

That installs Takeout to `~/.local/share/takeout`, starts it as a systemd user service, and prints a pairing link (and a QR code, if `qrencode` is installed).

Open the link on your phone, then **Share → Add to Home Screen**.

**Requirements:** Linux (built for Omarchy), Node 18+ (the installer handles it via mise or pacman), and [Tailscale](https://tailscale.com) on both your machine and your phone.

## Commands

```
takeout pair       Print the pairing link + QR code
takeout status     Is it running?
takeout restart    Restart the service
takeout logs       Follow the log
takeout reset      New pairing token (unpairs every device)
takeout uninstall  Remove Takeout
```

## Security

Takeout gives whoever pairs with it a shell as you, so it's built to stay private:

- **It binds to your Tailscale IP only.** If Tailscale isn't running, it falls back to `127.0.0.1`. It never listens on your LAN or the internet by default.
- **Pairing token.** A random token lives in `~/.config/takeout/token` (mode 600). Pairing sets an HttpOnly, SameSite=Strict cookie. `takeout reset` revokes every device at once.
- **Same-origin WebSockets only**, constant-time token checks, and theme switching only accepts names Omarchy itself lists, passed without a shell.

You can override the bind address with `TAKEOUT_HOST` and the port with `TAKEOUT_PORT` (default `7777`). Don't expose it to the open internet.

## How theme sync works

Omarchy keeps the active theme at `~/.local/state/omarchy/current/theme`. Takeout reads its colors with Omarchy's own `omarchy-theme-color` resolver (so it matches your desktop exactly), watches for changes, and pushes them to every connected phone over a WebSocket. Switching from the phone just runs `omarchy-theme-set`.

## Roadmap

- [ ] Omarchy bar widget: see when your phone is connected, and pair with a QR code from the bar
- [ ] Multiple terminal tabs
- [ ] Push notification when a coding agent is waiting on you
- [ ] Background-image picker

## License

MIT. Not affiliated with Omarchy or 37signals. Just a fan.
