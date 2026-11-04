#!/usr/bin/env node
// Takeout — your Omarchy terminal, to go.
// A small self-hosted web app: a real terminal on your phone that wears your Omarchy theme.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const VERSION = require('./package.json').version;
const HOME = os.homedir();
const CONFIG_DIR = process.env.TAKEOUT_CONFIG_DIR || path.join(HOME, '.config', 'takeout');
const STATE_DIR = process.env.TAKEOUT_OMARCHY_STATE || path.join(HOME, '.local', 'state', 'omarchy', 'current');
const PORT = parseInt(process.env.TAKEOUT_PORT || '7777', 10);
const SCROLLBACK_BYTES = 256 * 1024;
const COOKIE = 'takeout';

// ---------- token ----------
function loadToken() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(CONFIG_DIR, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const authed = (req) => safeEqual(cookies(req)[COOKIE], TOKEN);

// ---------- bind address: Tailscale first, never the open internet by default ----------
function pickHost() {
  if (process.env.TAKEOUT_HOST) return process.env.TAKEOUT_HOST;
  try {
    const ip = execFileSync('tailscale', ['ip', '-4'], { timeout: 2000 }).toString().trim().split('\n')[0];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  } catch {}
  return '127.0.0.1';
}
const HOST = pickHost();

// ---------- Omarchy theme ----------
const has = (cmd) => {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; }
};
const HAS_OMARCHY_COLOR = has('omarchy-theme-color');

function parseToml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\n]*))/);
    if (!m) continue;
    const v = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (v) out[m[1]] = v;
  }
  return out;
}

function mix(a, b, amt) {
  const h = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}$/i.test(a || '') || !/^#[0-9a-f]{6}$/i.test(b)) return a;
  const [x, y] = [h(a), h(b)];
  return '#' + x.map((v, i) => Math.round(v * (1 - amt) + y[i] * amt).toString(16).padStart(2, '0')).join('');
}

// Fallback resolver for when Omarchy's own resolver isn't on PATH (e.g. testing elsewhere).
function resolveColors(raw) {
  const c = { ...raw };
  const alias = (k, f) => { if (!c[k] && c[f]) c[k] = c[f]; };
  [['background', 'bg'], ['foreground', 'fg'], ['background', 'color0'], ['foreground', 'color7'],
   ['red', 'color1'], ['green', 'color2'], ['yellow', 'color3'], ['blue', 'color4'], ['magenta', 'color5'],
   ['cyan', 'color6'], ['muted', 'color8'], ['bright_red', 'color9'], ['bright_green', 'color10'],
   ['bright_yellow', 'color11'], ['bright_blue', 'color12'], ['bright_magenta', 'color13'],
   ['bright_cyan', 'color14'], ['bright_foreground', 'color15'], ['selection', 'selection_background']]
    .forEach(([k, f]) => alias(k, f));
  c.background ||= '#1e1e2e';
  c.foreground ||= '#cdd6f4';
  c.accent ||= c.blue || c.foreground;
  c.muted ||= mix(c.foreground, c.background, 0.5);
  c.selection ||= mix(c.accent, c.background, 0.6);
  c.lighter_background ||= mix(c.background, c.foreground, 0.08);
  c.dark_background ||= mix(c.background, '#000000', 0.25);
  c.bright_foreground ||= c.foreground;
  for (const k of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
    c[k] ||= c.foreground;
    c['bright_' + k] ||= mix(c[k], '#ffffff', 0.2);
  }
  if (!c.mode) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.background.slice(i, i + 2), 16));
    c.mode = r + g + b > 382 ? 'light' : 'dark';
  }
  return c;
}

function readColors() {
  const file = path.join(STATE_DIR, 'theme', 'colors.toml');
  if (HAS_OMARCHY_COLOR && !process.env.TAKEOUT_OMARCHY_STATE) {
    try {
      const out = execFileSync('omarchy-theme-color', ['--all'], { timeout: 3000 }).toString();
      const c = {};
      for (const line of out.split('\n')) {
        const [k, v] = line.split('\t');
        if (k && v) c[k] = v;
      }
      if (c.background) return c;
    } catch {}
  }
  try { return resolveColors(parseToml(fs.readFileSync(file, 'utf8'))); } catch { return resolveColors({}); }
}

function readThemeName() {
  try { return fs.readFileSync(path.join(STATE_DIR, 'theme.name'), 'utf8').trim(); } catch { return 'unknown'; }
}

function readFont() {
  if (process.env.TAKEOUT_FONT) return process.env.TAKEOUT_FONT;
  try { return execFileSync('fc-match', ['monospace', '-f', '%{family}'], { timeout: 2000 }).toString().split(',')[0].trim(); }
  catch { return 'monospace'; }
}

// The phone doesn't have your Nerd Font, so Takeout serves the exact file your desktop uses.
function fontFilePath() {
  if (process.env.TAKEOUT_FONT_FILE) return process.env.TAKEOUT_FONT_FILE;
  try {
    const f = execFileSync('fc-match', ['monospace', '-f', '%{file}'], { timeout: 2000 }).toString().trim();
    if (/\.(ttf|otf|woff2?)$/i.test(f) && fs.statSync(f).isFile()) return f;
  } catch {}
  return null;
}

function backgroundPath() {
  const link = path.join(STATE_DIR, 'background');
  try { const p = fs.realpathSync(link); if (fs.statSync(p).isFile()) return p; } catch {}
  return null;
}

function snapshotTheme() {
  const bg = backgroundPath();
  let bgId = null;
  if (bg) { try { const s = fs.statSync(bg); bgId = crypto.createHash('sha1').update(bg + s.mtimeMs).digest('hex').slice(0, 10); } catch {} }
  const ff = fontFilePath();
  const fontFile = ff ? crypto.createHash('sha1').update(ff).digest('hex').slice(0, 10) : null;
  const theme = { name: readThemeName(), colors: readColors(), font: readFont(), fontFile, background: bgId };
  theme.id = crypto.createHash('sha1').update(JSON.stringify(theme)).digest('hex').slice(0, 12);
  return theme;
}

let currentTheme = snapshotTheme();
const eventClients = new Set();

function broadcastTheme() {
  const msg = JSON.stringify({ type: 'theme', theme: currentTheme });
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
}

// Poll rather than inotify: Omarchy swaps symlinks on theme change, which fs.watch handles poorly.
setInterval(() => {
  const next = snapshotTheme();
  if (next.id !== currentTheme.id) {
    currentTheme = next;
    console.log(`[takeout] theme changed → ${next.name}`);
    broadcastTheme();
  }
}, 1200).unref();

function listThemes(cb) {
  if (!has('omarchy-theme-list')) return cb([]);
  execFile('omarchy-theme-list', { timeout: 5000 }, (err, out) =>
    cb(err ? [] : out.toString().split('\n').map((s) => s.trim()).filter(Boolean)));
}

// Swatches for the picker: read each theme's own colors.toml (user themes win, like omarchy-theme-dir).
function themeSwatch(name) {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const dirs = [path.join(HOME, '.config', 'omarchy', 'themes', slug)];
  if (process.env.OMARCHY_PATH) dirs.push(path.join(process.env.OMARCHY_PATH, 'themes', slug));
  dirs.push(path.join(HOME, '.local', 'share', 'omarchy', 'themes', slug));
  for (const d of dirs) {
    try {
      const c = resolveColors(parseToml(fs.readFileSync(path.join(d, 'colors.toml'), 'utf8')));
      return { bg: c.background, fg: c.foreground, accent: c.accent, dots: [c.red, c.yellow, c.green, c.blue, c.magenta] };
    } catch {}
  }
  return null;
}

// ---------- persistent terminal session ----------
// One shell that survives your phone locking. Reconnect and you're right where you left off.
let term = null;
let scrollback = '';
const termClients = new Set();

function ensureTerm(cols, rows) {
  if (term) return term;
  const shell = process.env.SHELL || '/bin/bash';
  term = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: HOME,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TAKEOUT: '1' },
  });
  scrollback = '';
  term.onData((d) => {
    scrollback += d;
    if (scrollback.length > SCROLLBACK_BYTES) scrollback = scrollback.slice(-SCROLLBACK_BYTES);
    for (const ws of termClients) if (ws.readyState === 1) ws.send(d);
  });
  term.onExit(() => {
    for (const ws of termClients) if (ws.readyState === 1) ws.send('\r\n\x1b[2m[shell exited — reconnect for a fresh one]\x1b[0m\r\n');
    term = null;
  });
  return term;
}

// ---------- HTTP ----------
const PUBLIC = path.join(__dirname, 'public');
const VENDOR = {
  '/vendor/xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

function readBody(req, cb) {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
  req.on('end', () => cb(b));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Pairing link: /pair?t=TOKEN sets a cookie, then strips the token from the address bar.
  if (p === '/pair') {
    if (!safeEqual(url.searchParams.get('t'), TOKEN)) return sendFile(res, path.join(PUBLIC, 'login.html'));
    return send(res, 302, '', 'text/plain', {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      Location: '/',
    });
  }
  if (p === '/login' && req.method === 'POST') {
    return readBody(req, (b) => {
      const t = new URLSearchParams(b).get('token');
      if (!safeEqual((t || '').trim(), TOKEN)) return send(res, 302, '', 'text/plain', { Location: '/pair?bad=1' });
      send(res, 302, '', 'text/plain', {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        Location: '/',
      });
    });
  }
  if (p === '/manifest.webmanifest' || p === '/icon.svg') return sendFile(res, path.join(PUBLIC, p.slice(1)));

  if (!authed(req)) {
    if (p === '/') return sendFile(res, path.join(PUBLIC, 'login.html'));
    return send(res, 401, 'unauthorized');
  }

  if (p === '/') return sendFile(res, path.join(PUBLIC, 'index.html'));
  if (VENDOR[p]) return sendFile(res, VENDOR[p]);
  if (p === '/app.js' || p === '/app.css') return sendFile(res, path.join(PUBLIC, p.slice(1)));
  if (p === '/api/theme') return send(res, 200, JSON.stringify(currentTheme), TYPES['.json']);
  if (p === '/api/font') {
    const f = fontFilePath();
    if (!f) return send(res, 404, 'none');
    return fs.readFile(f, (err, data) => err ? send(res, 404, 'none')
      : send(res, 200, data, 'font/' + path.extname(f).slice(1).toLowerCase(), { 'Cache-Control': 'private, max-age=604800' }));
  }
  if (p === '/api/background') {
    const bg = backgroundPath();
    return bg ? sendFile(res, bg) : send(res, 404, 'none');
  }
  if (p === '/api/themes') {
    return listThemes((list) => send(res, 200, JSON.stringify({
      current: currentTheme.name,
      themes: list.map((name) => ({ name, swatch: themeSwatch(name) })),
    }), TYPES['.json']));
  }
  if (p === '/api/theme/set' && req.method === 'POST') {
    return readBody(req, (b) => {
      let name = '';
      try { name = JSON.parse(b).name; } catch {}
      listThemes((list) => {
        // theme.name holds the slug while the list is title-cased; accept either form.
        const match = list.find((n) => n === name || n.toLowerCase().replace(/\s+/g, '-') === name);
        if (match) name = match;
        // Only names Omarchy itself lists, passed as an argument (no shell) — nothing to inject.
        if (!list.includes(name)) return send(res, 400, JSON.stringify({ ok: false, error: 'unknown theme' }), TYPES['.json']);
        const child = spawn('omarchy-theme-set', [name], { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        send(res, 200, JSON.stringify({ ok: true }), TYPES['.json']);
      });
    });
  }
  send(res, 404, 'not found');
});

// ---------- WebSockets ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  const sameOrigin = !origin || origin.replace(/^https?:\/\//, '') === req.headers.host;
  if (!authed(req) || !sameOrigin || !['/ws/term', '/ws/events'].includes(url.pathname)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/ws/events') {
      eventClients.add(ws);
      ws.send(JSON.stringify({ type: 'theme', theme: currentTheme }));
      ws.on('close', () => eventClients.delete(ws));
      return;
    }
    const cols = parseInt(url.searchParams.get('cols'), 10) || 80;
    const rows = parseInt(url.searchParams.get('rows'), 10) || 24;
    const t = ensureTerm(cols, rows);
    termClients.add(ws);
    if (scrollback) ws.send(scrollback);
    try { t.resize(cols, rows); } catch {}
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      const live = ensureTerm(cols, rows);
      if (m.t === 'i' && typeof m.d === 'string') live.write(m.d);
      else if (m.t === 'r' && m.c > 0 && m.r > 0 && m.c < 1000 && m.r < 1000) { try { live.resize(m.c, m.r); } catch {} }
    });
    ws.on('close', () => termClients.delete(ws));
  });
});

// Keep phone connections honest: drop sockets that stop answering pings.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000).unref();
wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

// ---------- CLI ----------
if (process.argv.includes('--pair')) {
  const addr = `http://${HOST === '0.0.0.0' ? os.hostname() : HOST}:${PORT}`;
  console.log(`${addr}/pair?t=${TOKEN}`);
  process.exit(0);
}

server.listen(PORT, HOST, () => {
  const addr = `http://${HOST}:${PORT}`;
  console.log(`\n  🥡  Takeout v${VERSION}`);
  console.log(`  Serving   ${addr}`);
  console.log(`  Theme     ${currentTheme.name}`);
  console.log(`  Pair      ${addr}/pair?t=${TOKEN}\n`);
  if (HOST === '127.0.0.1') console.log('  Tailscale not found — listening on localhost only. Install Tailscale to reach Takeout from your phone.\n');
});
