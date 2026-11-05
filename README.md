# 🥡 Takeout

**Your Omarchy terminal, to go.**

Takeout puts a real terminal from your Omarchy machine on your phone, and it wears your Omarchy theme. Switch themes on your desktop and your phone follows. Tap a theme on your phone and your desktop switches too.

No cloud. No account. No app store. It's an Omarchy plugin that runs on your machine, and your phone reaches it over your home Wi-Fi. Add a private VPN later to reach it from anywhere.

![Takeout's home screen in Tokyo Night, Tokyo Night scrolled, Catppuccin Latte, and Hackerman](docs/home.png)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/TouchWorkStation/Take-Out/main/install.sh | bash
```

That one line installs Node if you need it, adds Takeout as an Omarchy plugin, and prints a link to pair your phone. Open it on your phone, then **Share → Add to Home Screen**. Run the same line again anytime to update.

Prefer doing it by hand?

```bash
omarchy plugin add https://github.com/TouchWorkStation/Take-Out --enable
takeout pair
```

**Needs:** Omarchy (tmux and mise ship with it) and Node.js (the installer handles it). Your phone and computer on the same Wi-Fi.

**Away from home:** run `takeout vpn` (the installer offers it too). It sets up [Tailscale](https://tailscale.com), a free private network between your devices, so your phone reaches Takeout from anywhere, and `takeout pair` shows that link as well.

## What it does

- **Your Omarchy desktop, on your phone.** Takeout opens to a home screen built the way Omarchy builds your desktop: your actual wallpaper, square windows with your theme's border (gradient and all), and the same top bar your desktop shows, read from your own bar layout: the Omarchy logo, workspaces (with the layout glyph on the active one), the clock in your format, weather, Bluetooth, network, volume, monitor and battery, with Omarchy's own icons. Tap a workspace to switch your desktop, or the clock for the alternate format. Widgets sit at the bottom near your thumb: a big clock, CPU, memory, disk, battery, and a live preview of your terminal. Tap the system widget for every running process with live CPU and memory, sortable by CPU, memory, or name, like btop. On Tokyo Night it looks like Tokyo Night.
- **A terminal built for thumbs.** Type on a normal prompt line and hit send. One-tap esc, tab, ^c, ^d, arrows, ^r, and paste. Native scrolling and text selection, with a "latest" button when you've scrolled up.
- **Fast.** Commands echo back in about 40 ms over your tailnet, and only the changed part of the screen travels to your phone.
- **Your theme, live.** Every color comes from your active Omarchy theme, including colored `ls`, `git`, and 256-color and truecolor output. Change themes anywhere and the whole scrollback recolors instantly.
- **Theme picker.** All your installed themes with real swatches. Tap one to switch your whole desktop from the couch.
- **Your font, too.** Takeout serves the exact monospace font your desktop uses.
- **Never loses your place.** The session lives in tmux. Lock your phone, lose signal, come back: it's all still there. Sit down at your desk and run `takeout attach` to pick up the same session.
- **Sign-in links become taps.** When Claude Code, Codex, or `gh` print a login URL, Takeout offers to open it on your phone.

![The terminal in Catppuccin, the theme picker, Tokyo Night, and Rose Pine](docs/screenshot.png)

## Commands

```
takeout pair       Pairing link + QR code for your phone
takeout status     Is it running?
takeout attach     Open the same session at your desk
takeout vpn        Reach Takeout away from home (sets up Tailscale)
takeout firewall   Let your phone through Omarchy's firewall (home network only)
takeout restart    Restart the server (your session keeps running)
takeout reset      New pairing token: unpairs every device
```

## Security

Takeout gives whoever pairs with it a shell as you, so it's built to stay private:

- **It stays on your own networks.** Takeout listens on your computer's network connections (your home Wi-Fi, plus Tailscale if you add it). It's never published to the internet. Omarchy's firewall blocks incoming connections, so the installer opens Takeout's port to private home-network addresses only (and Tailscale, if you use it), never to the internet.
- **Pairing token.** A random token in `~/.config/takeout/token` (mode 600). Pairing sets an HttpOnly, SameSite=Strict cookie, and `takeout reset` revokes every device at once.
- **Same-origin only.** Input, resize, and theme requests from any other site are refused. Theme switching only accepts names Omarchy itself lists, passed without a shell. Keys are sent to tmux from a fixed list.
- **Zero npm dependencies.** Nothing to audit but this repo.

To listen on just one address, set `TAKEOUT_HOST` or put the address in `~/.config/takeout/host`. Change the port with `TAKEOUT_PORT` (default `7777`). Don't port-forward Takeout to the open internet; use `takeout vpn` instead.

## How it works

- **Terminal:** a tmux session named `takeout`. Input goes in with `tmux send-keys` and the screen comes back from `tmux capture-pane`, pushed to your phone over Server-Sent Events as small diffs. This engine comes from [TouchWorkstation](https://touchworkstation.com).
- **Theme:** read from `~/.local/state/omarchy/current/theme` through Omarchy's own `omarchy-theme-color` resolver, so it matches your desktop exactly. Switching from the phone runs `omarchy-theme-set`.
- **Plugin:** `Service.qml` keeps the server running inside the Omarchy shell and restarts it if it stops.

Not on Omarchy? The same install line sets up a systemd user service instead.

## Trade-off

Takeout shows tmux's text, not a pixel-perfect terminal emulator. Shells, scripts, git, and AI coding CLIs like Claude Code and Codex work great. Full-screen apps like `nvim`, `btop`, and `lazygit` show as text snapshots rather than a live, interactive screen.

## Roadmap

- [ ] Bar widget: see when your phone is connected, pair from the bar
- [ ] Multiple sessions
- [ ] Push notification when a coding agent is waiting on you

## License

MIT. Not affiliated with Omarchy or 37signals. Just a fan.
