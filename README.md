# 🥡 Takeout

**Your Omarchy terminal, to go.**

Takeout puts a real terminal from your Omarchy machine on your phone, and it wears your Omarchy theme. Switch themes on your desktop and your phone follows. Tap a theme on your phone and your desktop switches too.

No cloud. No account. No app store. It's an Omarchy plugin that runs on your machine, and you reach it over Tailscale.

![Takeout on a phone](docs/screenshot.png)

## Install

```bash
omarchy plugin add https://github.com/OWNER/takeout --enable
```

Then, in any terminal:

```bash
takeout pair
```

Scan the QR code (or open the link) on your phone, then **Share → Add to Home Screen**.

**Needs:** Omarchy (tmux and mise ship with it), Node.js (`omarchy install dev-env node`), and [Tailscale](https://tailscale.com) on your machine and your phone.

## What it does

- **A terminal built for thumbs.** Type on a normal prompt line and hit send. One-tap esc, tab, ^c, ^d, arrows, ^r, and paste. Native scrolling and text selection, with a "latest" button when you've scrolled up.
- **Fast.** Commands echo back in about 40 ms over your tailnet, and only the changed part of the screen travels to your phone.
- **Your theme, live.** Every color comes from your active Omarchy theme, including colored `ls`, `git`, and 256-color and truecolor output. Change themes anywhere and the whole scrollback recolors instantly.
- **Theme picker.** All your installed themes with real swatches. Tap one to switch your whole desktop from the couch.
- **Your font, too.** Takeout serves the exact monospace font your desktop uses.
- **Never loses your place.** The session lives in tmux. Lock your phone, lose signal, come back: it's all still there. Sit down at your desk and run `takeout attach` to pick up the same session.
- **Sign-in links become taps.** When Claude Code, Codex, or `gh` print a login URL, Takeout offers to open it on your phone.

## Commands

```
takeout pair       Pairing link + QR code for your phone
takeout status     Is it running?
takeout attach     Open the same session at your desk
takeout restart    Restart the server (your session keeps running)
takeout reset      New pairing token: unpairs every device
```

## Security

Takeout gives whoever pairs with it a shell as you, so it's built to stay private:

- **It listens on your Tailscale IP only.** Without Tailscale it falls back to `127.0.0.1`. It never listens on your LAN or the internet by default.
- **Pairing token.** A random token in `~/.config/takeout/token` (mode 600). Pairing sets an HttpOnly, SameSite=Strict cookie, and `takeout reset` revokes every device at once.
- **Same-origin only.** Input, resize, and theme requests from any other site are refused. Theme switching only accepts names Omarchy itself lists, passed without a shell. Keys are sent to tmux from a fixed list.
- **Zero npm dependencies.** Nothing to audit but this repo.

Override the bind address with `TAKEOUT_HOST` and the port with `TAKEOUT_PORT` (default `7777`). Don't expose it to the open internet.

## How it works

- **Terminal:** a tmux session named `takeout`. Input goes in with `tmux send-keys` and the screen comes back from `tmux capture-pane`, pushed to your phone over Server-Sent Events as small diffs. This engine comes from [TouchWorkstation](https://touchworkstation.com).
- **Theme:** read from `~/.local/state/omarchy/current/theme` through Omarchy's own `omarchy-theme-color` resolver, so it matches your desktop exactly. Switching from the phone runs `omarchy-theme-set`.
- **Plugin:** `Service.qml` keeps the server running inside the Omarchy shell and restarts it if it stops.

Not on Omarchy's plugin system? There's a standalone installer that sets up a systemd user service instead:

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/takeout/main/install.sh | bash
```

## Trade-off

Takeout shows tmux's text, not a pixel-perfect terminal emulator. Shells, scripts, git, and AI coding CLIs like Claude Code and Codex work great. Full-screen apps like `nvim`, `btop`, and `lazygit` show as text snapshots rather than a live, interactive screen.

## Roadmap

- [ ] Bar widget: see when your phone is connected, pair from the bar
- [ ] Multiple sessions
- [ ] Push notification when a coding agent is waiting on you

## License

MIT. Not affiliated with Omarchy or 37signals. Just a fan.
