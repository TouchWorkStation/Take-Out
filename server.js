#!/usr/bin/env node
// Takeout — your Omarchy terminal, to go.
//
// The terminal engine is TouchWorkstation's: every session is a tmux session,
// input is sent with `tmux send-keys`, and what you see is tmux's own pane
// text (`capture-pane`). That's what makes it fast and reliable on a phone —
// native scrolling, native text selection, and the session lives on in tmux
// when your phone locks. You can even `tmux attach -t takeout` at your desk.
//
// Zero npm dependencies on purpose: Takeout installs as an Omarchy plugin,
// which is a plain git checkout with no build or install step.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const VERSION = require('./package.json').version;
const HOME = os.homedir();
const CONFIG_DIR = process.env.TAKEOUT_CONFIG_DIR || path.join(HOME, '.config', 'takeout');
const STATE_DIR = process.env.TAKEOUT_OMARCHY_STATE || path.join(HOME, '.local', 'state', 'omarchy', 'current');
const PORT = parseInt(process.env.TAKEOUT_PORT || '7777', 10);
const SESSION = 'takeout';
const HISTORY_LINES = 3000;
const COOKIE = 'takeout';
const PUBLIC = path.join(__dirname, 'public');

// ---------- token ----------
let firstRun = false;
function loadToken() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(CONFIG_DIR, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  firstRun = true;
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

// ---------- PATH (from TouchWorkstation) ----------
// The service starts with a minimal PATH; make user-installed CLIs (claude,
// codex, mise shims, cargo, bun…) runnable inside the terminal anyway.
function augmentPath(current) {
  const extra = [
    `${HOME}/.local/bin`, `${HOME}/.local/share/mise/shims`, `${HOME}/.npm-global/bin`, `${HOME}/bin`,
    `${HOME}/.cargo/bin`, `${HOME}/.deno/bin`, `${HOME}/.bun/bin`,
    `${HOME}/.local/share/omarchy/bin`, '/usr/local/bin', '/usr/bin', '/bin',
  ];
  if (process.env.OMARCHY_PATH) extra.unshift(`${process.env.OMARCHY_PATH}/bin`);
  return [...new Set([...(current || '').split(':'), ...extra])].filter(Boolean).join(':');
}
const ENV = { ...process.env, PATH: augmentPath(process.env.PATH), TAKEOUT: '1' };

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { env: ENV, maxBuffer: 8 << 20, timeout: 5000, ...opts }, (err, out, errOut) =>
    err ? reject(Object.assign(err, { stderr: errOut })) : resolve(out.toString())));

const has = (cmd) => {
  try { execFileSync('sh', ['-c', 'command -v "$1"', '_', cmd], { stdio: 'ignore', env: ENV }); return true; }
  catch { return false; }
};

// ---------- address ----------
// Takeout listens on every interface of this computer, so your phone reaches
// it on your home network — and over a VPN like Tailscale too, if you add one
// later. Every page still needs the pairing token.
// Override the bind address with TAKEOUT_HOST or ~/.config/takeout/host.
const HOST_FILE = path.join(CONFIG_DIR, 'host');
function configuredHost() {
  if (process.env.TAKEOUT_HOST) return process.env.TAKEOUT_HOST;
  try { const h = fs.readFileSync(HOST_FILE, 'utf8').trim(); if (h) return h; } catch {}
  return null;
}
const HOST = configuredHost() || '0.0.0.0';

// The address to show: this computer's IP on the network its internet goes through.
function localIp() {
  try {
    const out = execFileSync('ip', ['-4', 'route', 'get', '1.1.1.1'], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = out.match(/\bsrc (\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}
const SHOWN_HOST = HOST === '0.0.0.0' ? localIp() : HOST;
const PAIR_URL = `http://${SHOWN_HOST}:${PORT}/pair?t=${TOKEN}`;

if (process.argv.includes('--pair')) { console.log(PAIR_URL); process.exit(0); }

// ---------- tmux terminal ----------
if (!has('tmux')) {
  console.error('[takeout] tmux is required (Omarchy ships it; otherwise: sudo pacman -S tmux)');
  process.exit(1);
}

async function ensureSession(cols = 80, rows = 24) {
  try { await run('tmux', ['has-session', '-t', `=${SESSION}`]); return; } catch {}
  const shell = process.env.SHELL || '/bin/bash';
  await run('tmux', ['new-session', '-d', '-s', SESSION, '-x', String(cols), '-y', String(rows), '-c', HOME, shell, '-l']);
}

// Special keys go to tmux by name; everything else is sent literally.
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'Home', 'End',
  'PageUp', 'PageDown', 'DC', 'C-a', 'C-b', 'C-c', 'C-d', 'C-e', 'C-k', 'C-l', 'C-r', 'C-u', 'C-w', 'C-z']);

async function sendInput({ text, key, keys }) {
  await ensureSession();
  const list = Array.isArray(keys) ? keys : [];
  if (typeof text === 'string' && text.length) {
    await run('tmux', ['send-keys', '-t', `=${SESSION}:`, '-l', '--', text.slice(0, 65536)]);
  }
  for (const k of [key, ...list]) {
    if (k && KEYS.has(k)) await run('tmux', ['send-keys', '-t', `=${SESSION}:`, k]);
  }
}

let lastSize = '';
async function resize(cols, rows) {
  cols = Math.max(20, Math.min(400, cols | 0));
  rows = Math.max(6, Math.min(200, rows | 0));
  const key = `${cols}x${rows}`;
  if (key === lastSize) return;
  lastSize = key;
  await ensureSession(cols, rows);
  await run('tmux', ['resize-window', '-t', `=${SESSION}:`, '-x', String(cols), '-y', String(rows)]).catch(() => {});
}

async function capture() {
  try {
    return await run('tmux', ['capture-pane', '-t', `=${SESSION}:`, '-p', '-e', '-S', `-${HISTORY_LINES}`]);
  } catch { return null; }
}

// ---------- Omarchy theme ----------
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
  if (!/^#[0-9a-f]{6}$/i.test(a || '') || !/^#[0-9a-f]{6}$/i.test(b || '')) return a;
  const h = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [h(a), h(b)];
  return '#' + x.map((v, i) => Math.round(v * (1 - amt) + y[i] * amt).toString(16).padStart(2, '0')).join('');
}

// Fallback resolver, mirroring omarchy-theme-color, for when it isn't on PATH.
function resolveColors(raw) {
  const c = { ...raw };
  const alias = (k, f) => { if (!c[k] && c[f]) c[k] = c[f]; };
  [['background', 'bg'], ['foreground', 'fg'], ['background', 'color0'], ['foreground', 'color7'],
   ['red', 'color1'], ['green', 'color2'], ['yellow', 'color3'], ['blue', 'color4'], ['magenta', 'color5'],
   ['cyan', 'color6'], ['muted', 'color8'], ['bright_red', 'color9'], ['bright_green', 'color10'],
   ['bright_yellow', 'color11'], ['bright_blue', 'color12'], ['bright_magenta', 'color13'],
   ['bright_cyan', 'color14'], ['bright_foreground', 'color15'], ['magenta', 'purple'],
   ['selection', 'selection_background']].forEach(([k, f]) => alias(k, f));
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
  if (HAS_OMARCHY_COLOR && !process.env.TAKEOUT_OMARCHY_STATE) {
    try {
      const out = execFileSync('omarchy-theme-color', ['--all'], { timeout: 3000, env: ENV }).toString();
      const c = {};
      for (const line of out.split('\n')) { const [k, v] = line.split('\t'); if (k && v) c[k] = v; }
      if (c.background) return c;
    } catch {}
  }
  try { return resolveColors(parseToml(fs.readFileSync(path.join(STATE_DIR, 'theme', 'colors.toml'), 'utf8'))); }
  catch { return resolveColors({}); }
}

const readThemeName = () => { try { return fs.readFileSync(path.join(STATE_DIR, 'theme.name'), 'utf8').trim(); } catch { return 'unknown'; } };

function fontFilePath() {
  if (process.env.TAKEOUT_FONT_FILE) return process.env.TAKEOUT_FONT_FILE;
  try {
    const f = execFileSync('fc-match', ['monospace', '-f', '%{file}'], { timeout: 2000 }).toString().trim();
    if (/\.(ttf|otf|woff2?)$/i.test(f) && fs.statSync(f).isFile()) return f;
  } catch {}
  return null;
}
function readFont() {
  try { return execFileSync('fc-match', ['monospace', '-f', '%{family}'], { timeout: 2000 }).toString().split(',')[0].trim(); }
  catch { return 'monospace'; }
}
function backgroundPath() {
  try { const p = fs.realpathSync(path.join(STATE_DIR, 'background')); if (fs.statSync(p).isFile()) return p; } catch {}
  return null;
}
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

function snapshotTheme() {
  const bg = backgroundPath();
  let bgId = null;
  if (bg) { try { bgId = hash(bg + fs.statSync(bg).mtimeMs); } catch {} }
  const ff = fontFilePath();
  const bgType = bg && /\.(mp4|webm|mov|mkv)$/i.test(bg) ? 'video' : 'image';
  const theme = { name: readThemeName(), colors: readColors(), font: readFont(), fontFile: ff ? hash(ff) : null, background: bgId, backgroundType: bgType };
  theme.id = hash(JSON.stringify(theme));
  return theme;
}

function listThemes(cb) {
  if (!has('omarchy-theme-list')) return cb([]);
  execFile('omarchy-theme-list', { timeout: 5000, env: ENV }, (err, out) =>
    cb(err ? [] : out.toString().split('\n').map((s) => s.trim()).filter(Boolean)));
}
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

// ---------- wallpaper, sized for a phone ----------
// Omarchy wallpapers run up to 8K (38 megapixels) — slow over Wi-Fi and more
// than some phones will decode. Make a cached copy about 2400px tall with the
// libvips / ImageMagick that Omarchy ships. Videos are served as they are.
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'takeout');
const resizing = new Map();
function phoneWallpaper(src) {
  if (/\.(mp4|webm|mov|mkv|gif)$/i.test(src)) return Promise.resolve(src);
  let st;
  try { st = fs.statSync(src); } catch { return Promise.resolve(src); }
  const out = path.join(CACHE_DIR, `bg-${hash(src + st.mtimeMs + st.size)}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (resizing.has(out)) return resizing.get(out);
  const job = (async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = out + '.tmp.jpg';
    const attempts = [
      ['vipsthumbnail', [src, '--size', 'x2400>', '-o', `${tmp}[Q=84,strip]`]],
      ['magick', [src, '-resize', 'x2400>', '-strip', '-quality', '84', tmp]],
      ['convert', [src, '-resize', 'x2400>', '-strip', '-quality', '84', tmp]],
    ];
    for (const [cmd, args] of attempts) {
      try {
        await run(cmd, args, { timeout: 30000 });
        if (fs.statSync(tmp).size > 0) { fs.renameSync(tmp, out); return out; }
      } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    return src; // no image tools: send the original
  })().finally(() => resizing.delete(out));
  resizing.set(out, job);
  return job;
}

// ---------- home screen: system + desktop ----------
let lastCpu = null;
function cpuPercent() {
  const t = os.cpus().reduce((a, c) => {
    const total = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { idle: a.idle + c.times.idle, total: a.total + total };
  }, { idle: 0, total: 0 });
  const prev = lastCpu;
  lastCpu = t;
  if (!prev || t.total <= prev.total) return Math.round((1 - t.idle / t.total) * 100);
  return Math.max(0, Math.min(100, Math.round((1 - (t.idle - prev.idle) / (t.total - prev.total)) * 100)));
}
function memory() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => +(m.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [0, 0])[1] * 1024;
    const total = kb('MemTotal');
    return { used: total - kb('MemAvailable'), total };
  } catch { return { used: os.totalmem() - os.freemem(), total: os.totalmem() }; }
}
function disk() {
  try { const s = fs.statfsSync('/'); return { used: (s.blocks - s.bavail) * s.bsize, total: s.blocks * s.bsize }; }
  catch { return null; }
}
function battery() {
  try {
    const dir = '/sys/class/power_supply';
    const bat = fs.readdirSync(dir).find((d) => /^BAT/i.test(d));
    if (!bat) return null;
    const read = (f) => fs.readFileSync(path.join(dir, bat, f), 'utf8').trim();
    return { pct: +read('capacity'), status: read('status') };
  } catch { return null; }
}
async function workspaces() {
  try {
    const [all, active] = await Promise.all([run('hyprctl', ['-j', 'workspaces']), run('hyprctl', ['-j', 'activeworkspace'])]);
    const list = JSON.parse(all).filter((w) => w.id > 0).map((w) => ({ id: w.id, windows: w.windows }));
    return { list: list.sort((a, b) => a.id - b.id), active: JSON.parse(active).id };
  } catch { return null; }
}
async function homeData() {
  return {
    user: os.userInfo().username,
    host: os.hostname(),
    cpu: cpuPercent(),
    load: os.loadavg()[0],
    mem: memory(),
    disk: disk(),
    battery: battery(),
    uptime: os.uptime(),
    workspaces: await workspaces(),
  };
}

// ---------- live stream (Server-Sent Events) ----------
// One stream per phone carries both theme changes and terminal updates.
// Terminal updates are diffs against what that phone already has: only the
// changed tail of the pane travels, so typing stays fast over Tailscale.
const streams = new Set();
let currentTheme = snapshotTheme();
let paneText = '';

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

function diff(prev, next) {
  if (prev === next) return null;
  const n = Math.min(prev.length, next.length);
  let i = 0;
  // Fast skip in chunks, then by character.
  while (i + 256 <= n && prev.slice(i, i + 256) === next.slice(i, i + 256)) i += 256;
  while (i < n && prev.charCodeAt(i) === next.charCodeAt(i)) i++;
  // Never cut through an escape sequence or a surrogate pair: back up to a line start.
  const ls = next.lastIndexOf('\n', i - 1);
  i = ls < 0 ? 0 : ls + 1;
  return { keep: i, add: next.slice(i) };
}

let polling = false;
let pollTimer = null;
async function pollPane() {
  if (polling) return;
  polling = true;
  try {
    const text = await capture();
    if (text != null && text !== paneText) {
      for (const s of streams) {
        const d = diff(s.sent, text);
        if (d) { sse(s.res, 'pane', d); s.sent = text; }
      }
      paneText = text;
    }
  } finally { polling = false; }
}
function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollPane();
    if (streams.size) schedulePoll(250);
  }, ms);
}
// After input, look again quickly: echo shows up almost instantly.
function burst() { setTimeout(pollPane, 40); setTimeout(pollPane, 140); schedulePoll(320); }

// Omarchy swaps symlinks on theme change, which inotify handles poorly — poll.
setInterval(() => {
  const next = snapshotTheme();
  if (next.id === currentTheme.id) return;
  currentTheme = next;
  console.log(`[takeout] theme → ${next.name}`);
  const bg = backgroundPath();
  if (bg) phoneWallpaper(bg); // have it ready before the phone asks
  for (const s of streams) sse(s.res, 'theme', currentTheme);
}, 1200).unref();

// Keep proxies and phones from idling the stream out.
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 20000).unref();

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.webmanifest': 'application/manifest+json' };

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, data, code = 200) => send(res, code, JSON.stringify(data), TYPES['.json']);
function sendFile(res, file, extra) {
  fs.readFile(file, (err, data) => err ? send(res, 404, 'not found')
    : send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', extra));
}
// Wallpapers can be videos, and iPhones only play video served with byte ranges.
function sendRange(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err) return send(res, 404, 'not found');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      return fs.createReadStream(file).pipe(res);
    }
    let start = m[1] === '' ? st.size - (+m[2]) : +m[1];
    let end = m[1] !== '' && m[2] !== '' ? +m[2] : st.size - 1;
    if (start < 0) start = 0;
    if (end >= st.size) end = st.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

function readBody(req, cb, limit = 70000) {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > limit) req.destroy(); });
  req.on('end', () => cb(b));
}
const setCookie = () => `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;

// State-changing requests must come from Takeout's own page.
function sameOrigin(req) {
  const o = req.headers.origin;
  return !o || o.replace(/^https?:\/\//, '') === req.headers.host;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/pair') {
    if (!safeEqual(url.searchParams.get('t'), TOKEN)) return sendFile(res, path.join(PUBLIC, 'login.html'));
    return send(res, 302, '', undefined, { 'Set-Cookie': setCookie(), Location: '/' });
  }
  if (p === '/login' && req.method === 'POST') {
    return readBody(req, (b) => {
      const t = (new URLSearchParams(b).get('token') || '').trim();
      if (!safeEqual(t, TOKEN)) return send(res, 302, '', undefined, { Location: '/pair?bad=1' });
      send(res, 302, '', undefined, { 'Set-Cookie': setCookie(), Location: '/' });
    }, 4096);
  }
  if (p === '/manifest.webmanifest' || p === '/icon.svg') return sendFile(res, path.join(PUBLIC, p.slice(1)));

  if (!authed(req)) return p === '/' ? sendFile(res, path.join(PUBLIC, 'login.html')) : send(res, 401, 'unauthorized');

  if (p === '/') return sendFile(res, path.join(PUBLIC, 'index.html'));
  if (p === '/app.js' || p === '/app.css' || p === '/ansi.js') return sendFile(res, path.join(PUBLIC, p.slice(1)));

  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const s = { res, sent: '' };
    streams.add(s);
    sse(res, 'theme', currentTheme);
    ensureSession().then(pollPane).then(() => {
      // pollPane only pushes on change; make sure a fresh phone gets the full pane.
      const d = diff(s.sent, paneText);
      if (d) { sse(res, 'pane', d); s.sent = paneText; }
      schedulePoll(250);
    });
    req.on('close', () => streams.delete(s));
    return;
  }

  if (p === '/api/input' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    return readBody(req, async (b) => {
      let m = {};
      try { m = JSON.parse(b); } catch {}
      try { await sendInput(m); burst(); json(res, { ok: true }); }
      catch (e) { json(res, { ok: false, error: String(e.stderr || e.message) }, 500); }
    });
  }
  if (p === '/api/resize' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    return readBody(req, async (b) => {
      let m = {};
      try { m = JSON.parse(b); } catch {}
      await resize(m.cols, m.rows);
      burst();
      json(res, { ok: true });
    });
  }
  if (p === '/api/session/new' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    return run('tmux', ['kill-session', '-t', `=${SESSION}`]).catch(() => {})
      .then(() => ensureSession(...(lastSize ? lastSize.split('x').map(Number) : [])))
      .then(() => { burst(); json(res, { ok: true }); });
  }

  if (p === '/api/theme') return json(res, currentTheme);
  if (p === '/api/themes') {
    return listThemes((list) => json(res, { current: currentTheme.name, themes: list.map((name) => ({ name, swatch: themeSwatch(name) })) }));
  }
  if (p === '/api/theme/set' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    return readBody(req, (b) => {
      let name = '';
      try { name = String(JSON.parse(b).name || ''); } catch {}
      listThemes((list) => {
        const match = list.find((n) => n === name || n.toLowerCase().replace(/\s+/g, '-') === name);
        // Only names Omarchy itself lists, passed as an argument with no shell.
        if (!match) return json(res, { ok: false, error: 'unknown theme' }, 400);
        const child = spawn('omarchy-theme-set', [match], { detached: true, stdio: 'ignore', env: ENV });
        child.on('error', () => {});
        child.unref();
        json(res, { ok: true });
      });
    }, 4096);
  }
  if (p === '/api/font') {
    const f = fontFilePath();
    if (!f) return send(res, 404, 'none');
    return sendFile(res, f, { 'Cache-Control': 'private, max-age=604800' });
  }
  if (p === '/api/background') {
    const bg = backgroundPath();
    if (!bg) return send(res, 404, 'none');
    return phoneWallpaper(bg).then((file) => sendRange(req, res, file));
  }
  if (p === '/api/home') return homeData().then((d) => json(res, d));
  if (p === '/api/workspace' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    return readBody(req, (b) => {
      let id = 0;
      try { id = parseInt(JSON.parse(b).id, 10); } catch {}
      if (!(id >= 1 && id <= 20)) return json(res, { ok: false }, 400);
      run('hyprctl', ['dispatch', 'workspace', String(id)]).then(() => json(res, { ok: true }), () => json(res, { ok: false }, 500));
    }, 256);
  }
  if (p === '/api/background/next' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    if (!has('omarchy-theme-bg-next')) return json(res, { ok: false, error: 'not on Omarchy' }, 400);
    const child = spawn('omarchy-theme-bg-next', [], { detached: true, stdio: 'ignore', env: ENV });
    child.on('error', () => {});
    child.unref();
    return json(res, { ok: true });
  }
  send(res, 404, 'not found');
});

server.listen(PORT, HOST, () => {
  { const bg = backgroundPath(); if (bg) phoneWallpaper(bg); }
  console.log(`\n  🥡  Takeout v${VERSION}`);
  console.log(`  Serving   http://${SHOWN_HOST}:${PORT}`);
  console.log(`  Theme     ${currentTheme.name}`);
  console.log(`  Session   tmux attach -t ${SESSION}`);
  console.log(`  Pair      ${PAIR_URL}\n`);
  if (firstRun && has('notify-send')) {
    spawn('notify-send', ['-a', 'Takeout', '🥡 Takeout is ready', 'Run `takeout pair` in a terminal to connect your phone.'],
      { stdio: 'ignore', env: ENV }).on('error', () => {});
  }
});
server.on('error', (e) => { console.error(`[takeout] ${e.message}`); process.exit(1); });
