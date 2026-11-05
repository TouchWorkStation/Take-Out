// Takeout — TouchWorkstation's minimal Omarchy terminal (MinimalTerminalPTY),
// ported to plain JS, with the live Omarchy theme driving every color.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const pretty = (s) => String(s || '').replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/-/g, ' ');
  const slug = (s) => String(s || '').toLowerCase().replace(/\s+/g, '-');
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  const pane = $('#pane');
  const input = $('#input');
  const dot = $('#status');
  const caret = $('#caret');

  // ---------- pane rendering ----------
  // Lines render individually and only from the first changed line onward,
  // with each line's starting style cached, so a new line of output doesn't
  // re-render 3000 lines of scrollback.
  let text = '';
  let lines = [];          // current raw lines
  let startStates = [];    // style at the start of each line
  let autoScroll = true;

  function render(next) {
    const nextLines = next.replace(/\n+$/, '').split('\n');
    // Trailing blank rows below the cursor just push output away from the prompt.
    while (nextLines.length > 1 && !nextLines[nextLines.length - 1].replace(/\x1b\[[0-9;:]*m/g, '').trim()) nextLines.pop();

    let i = 0;
    const n = Math.min(lines.length, nextLines.length);
    while (i < n && lines[i] === nextLines[i]) i++;

    const rows = pane.children;
    while (rows.length > i) pane.lastChild.remove();
    let st = i ? startStates[i] || Ansi.blank() : Ansi.blank();
    const frag = document.createDocumentFragment();
    for (let j = i; j < nextLines.length; j++) {
      startStates[j] = st;
      const el = document.createElement('div');
      st = Ansi.renderLine(el, nextLines[j], st);
      frag.appendChild(el);
    }
    startStates.length = nextLines.length;
    pane.appendChild(frag);
    lines = nextLines;
    if (autoScroll) pane.scrollTop = pane.scrollHeight;
  }

  function onScroll() {
    autoScroll = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 60;
    $('#jump').hidden = autoScroll;
  }
  pane.addEventListener('scroll', onScroll, { passive: true });
  $('#jump').addEventListener('click', () => { autoScroll = true; $('#jump').hidden = true; pane.scrollTop = pane.scrollHeight; });

  // ---------- sign-in link detection (from TW) ----------
  // Claude Code, Codex and gh print a sign-in URL; surface it as a tap.
  let authUrl = null;
  function detectLinks(added) {
    const plain = added.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
    const joined = plain.replace(/[\r\n]+/g, '');
    const m = joined.match(/https?:\/\/[^\s'"]*(?:oauth|authorize|login|callback|setup|device)[^\s'"]*\?[^\s'"]+/i);
    if (m && /client_id=|code=|token=|user_code=/i.test(m[0]) && m[0] !== authUrl) {
      authUrl = m[0];
      $('#auth').hidden = false;
    }
  }
  $('#authOpen').addEventListener('click', () => authUrl && window.open(authUrl, '_blank', 'noopener'));
  $('#authClose').addEventListener('click', () => { $('#auth').hidden = true; });

  // ---------- input ----------
  async function sendInput(body) {
    const r = await post('/api/input', body).catch(() => null);
    if (!r || !r.ok) toast('not connected');
  }
  // Blank Enter is valid and common (dismissing a prompt, paging less) — never swallow it.
  $('#promptRow').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    autoScroll = true;
    sendInput({ text: t, key: 'Enter' });
  });

  $('#keys').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the phone keyboard up
  $('#keys').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'paste') return paste();
    // Anything typed but not yet sent goes first, then the key (so `cd sr` + tab completes).
    const pending = input.value;
    input.value = '';
    sendInput({ text: pending, key: b.dataset.k });
    input.focus();
  });

  async function paste() {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.readText) {
      try { const t = await navigator.clipboard.readText(); if (t) return sendInput({ text: t }); } catch {}
    }
    // Plain http over Tailscale isn't a "secure context", so most phones land here.
    $('#pasteFallback').hidden = false;
    $('#pasteText').focus();
  }
  function submitPaste() {
    const t = $('#pasteText').value;
    if (t) sendInput({ text: t });
    $('#pasteText').value = '';
    $('#pasteFallback').hidden = true;
    input.focus();
  }
  $('#pasteSend').addEventListener('click', submitPaste);
  $('#pasteText').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPaste(); });
  $('#pasteCancel').addEventListener('click', () => { $('#pasteText').value = ''; $('#pasteFallback').hidden = true; });

  // ---------- sizing (from TW) ----------
  // Size tmux to the real phone width so Claude Code / Codex wrap to fit
  // instead of rendering ~120 columns wide and running off-screen.
  let lastSize = '';
  function measure() {
    // Hidden behind the home screen: nothing to measure, and tmux must not shrink to nothing.
    if (!pane.clientWidth || !pane.clientHeight) return;
    let cols = 80, rows = 24;
    try {
      const probe = document.createElement('span');
      probe.textContent = '0'.repeat(50);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px';
      pane.appendChild(probe);
      const cw = probe.getBoundingClientRect().width / 50;
      probe.remove();
      const cs = getComputedStyle(pane);
      const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.55;
      const w = pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (cw > 0) cols = Math.max(20, Math.min(220, Math.floor(w / cw)));
      if (lh > 0) rows = Math.max(6, Math.min(80, Math.floor(pane.clientHeight / lh)));
    } catch {}
    const key = `${cols}x${rows}`;
    if (key === lastSize) return;
    lastSize = key;
    post('/api/resize', { cols, rows }).catch(() => { lastSize = ''; });
  }

  // iOS: track the visual viewport so the keyboard never leaves a dead gap (from TW).
  function setVVH() {
    const vv = window.visualViewport;
    document.documentElement.style.setProperty('--tw-vvh', `${vv ? vv.height : window.innerHeight}px`);
    document.documentElement.style.setProperty('--tw-vv-top', `${vv ? vv.offsetTop : 0}px`);
    // The keyboard is up when the visible area is much shorter than the window.
    const kbdUp = !!vv && window.innerHeight - vv.height > 120;
    document.documentElement.classList.toggle('kbd', kbdUp);
    autoScroll = true;
    $('#jump').hidden = true;
    requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; measure(); });
  }
  setVVH();
  window.addEventListener('resize', setVVH);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setVVH);
    window.visualViewport.addEventListener('scroll', setVVH);
  }

  // ---------- theme ----------
  let current = null;
  let pending = null;
  let fontLoaded = null;

  async function loadFont(theme) {
    if (!theme.fontFile || fontLoaded === theme.fontFile) return;
    try {
      const face = new FontFace('TakeoutMono', `url(/api/font?v=${theme.fontFile})`);
      await face.load();
      document.fonts.add(face);
      fontLoaded = theme.fontFile;
      document.documentElement.style.setProperty('--mono', `"TakeoutMono", ui-monospace, SFMono-Regular, Menlo, monospace`);
      lastSize = '';
      measure();
    } catch {}
  }

  function applyTheme(theme) {
    const c = theme.colors;
    const root = document.documentElement.style;
    const set = (k, v) => v && root.setProperty(k, v);
    set('--bg', c.background);
    set('--bg-2', c.dark_background || c.background);
    set('--bg-3', c.lighter_background || c.selection);
    set('--fg', c.foreground);
    set('--muted', c.muted || c.dark_foreground || c.color8);
    set('--accent', c.accent);
    set('--green', c.green);
    set('--red', c.red);
    const ansi = [c.color0 || c.lighter_background || c.background, c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.color7 || c.foreground,
      c.color8 || c.muted, c.bright_red, c.bright_green, c.bright_yellow, c.bright_blue, c.bright_magenta, c.bright_cyan, c.color15 || c.bright_foreground];
    ansi.forEach((v, i) => set(`--c${i}`, v));
    document.documentElement.style.colorScheme = c.mode === 'light' ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', c.background);
    $('#wall').style.backgroundImage = theme.background && theme.backgroundType !== 'video' ? `url(/api/background?v=${theme.background})` : 'none';
    $('#themeName').textContent = pretty(theme.name);
    set('--win-border', borderImage(c.hyprland_active_border, c.accent));
    setWallpaper(theme);
    loadFont(theme);

    const changed = current && current.name !== theme.name;
    current = theme;
    if (changed) toast(`now wearing ${pretty(theme.name)}`);
    if (pending && slug(pending) === slug(theme.name)) { pending = null; closeSheet(); }
    markCurrent();
  }

  // ---------- live stream ----------
  let es = null;
  function connect() {
    if (es && es.readyState !== 2) return;
    es = new EventSource('/api/stream');
    // Every (re)connect starts the server's diff from empty, so start ours from empty too.
    es.onopen = () => { text = ''; dot.className = 'mt-dot live'; caret.textContent = '❯'; lastSize = ''; measure(); };
    es.onerror = () => {
      dot.className = 'mt-dot down';
      caret.textContent = '…';
      if (es.readyState === 2) setTimeout(connect, 1500); // closed for good (e.g. 401): retry ourselves
    };
    es.addEventListener('theme', (e) => applyTheme(JSON.parse(e.data)));
    es.addEventListener('pane', (e) => {
      const d = JSON.parse(e.data);
      text = text.slice(0, d.keep) + d.add;
      render(text);
      if (view === 'home') renderPeek();
      detectLinks(d.add.slice(-4000));
    });
  }
  // The stream reconnects on its own; a fresh connection starts from an empty diff.
  const resetPane = () => { text = ''; };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!es || es.readyState === 2)) { resetPane(); connect(); }
  });

  // ---------- theme picker ----------
  const sheet = $('#sheet');
  const list = $('#themeList');

  function markCurrent() {
    if (!current) return;
    list.querySelectorAll('.theme-card').forEach((el) => {
      el.classList.toggle('current', slug(el.dataset.name) === slug(current.name));
      if (!pending || slug(el.dataset.name) !== slug(pending)) el.classList.remove('busy');
    });
  }

  async function openSheet() {
    sheet.showModal();
    list.innerHTML = '<div class="empty">Loading themes…</div>';
    try {
      const data = await (await fetch('/api/themes')).json();
      if (!data.themes.length) {
        list.innerHTML = '<div class="empty">No Omarchy themes found. Takeout still follows whatever colors are active.</div>';
        return;
      }
      list.innerHTML = '';
      for (const t of data.themes) {
        const s = t.swatch || {};
        const b = document.createElement('button');
        b.className = 'theme-card';
        b.dataset.name = t.name;
        b.style.background = s.bg || 'var(--bg-3)';
        b.style.color = s.fg || 'var(--fg)';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = t.name;
        const dots = document.createElement('span');
        dots.className = 'dots';
        for (const col of s.dots || []) { const i = document.createElement('i'); i.style.background = col; dots.appendChild(i); }
        b.append(name, dots);
        list.appendChild(b);
      }
      markCurrent();
    } catch {
      list.innerHTML = '<div class="empty">Couldn’t load themes.</div>';
    }
  }
  function closeSheet() { if (sheet.open) sheet.close(); }

  list.addEventListener('click', async (e) => {
    const card = e.target.closest('.theme-card');
    if (!card || card.classList.contains('current')) return;
    pending = card.dataset.name;
    card.classList.add('busy');
    const r = await post('/api/theme/set', { name: card.dataset.name }).catch(() => null);
    if (!r || !r.ok) { pending = null; card.classList.remove('busy'); toast('couldn’t switch theme'); }
  });
  $('#themeBtn').addEventListener('click', openSheet);
  $('#closeSheet').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  $('#newSession').addEventListener('click', async () => {
    if (!confirm('End the current terminal session and start a fresh one?')) return;
    closeSheet();
    await post('/api/session/new');
    toast('fresh session');
  });

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- home screen ----------
  // The theme's window border: Omarchy's hyprland_active_border when the theme
  // sets one (e.g. "rgba(26a269ee) rgba(2ec27eee) 45deg"), otherwise the accent.
  function borderImage(spec, accent) {
    const toCss = (tok) => {
      let m = tok.match(/^rgba?\(([0-9a-f]{6})([0-9a-f]{2})?\)$/i);
      if (m) return `#${m[1]}${m[2] || ''}`;
      m = tok.match(/^#?([0-9a-f]{6,8})$/i);
      return m ? `#${m[1]}` : null;
    };
    const parts = String(spec || '').trim().split(/\s+/).filter(Boolean);
    const angle = (parts.find((t) => /deg$/.test(t)) || '180deg');
    const cols = parts.map(toCss).filter(Boolean);
    if (!cols.length) cols.push(accent || 'currentColor');
    if (cols.length === 1) cols.push(cols[0]);
    return `linear-gradient(${angle}, ${cols.join(', ')}) 1`;
  }

  // Image wallpapers paint on the root page background (see app.css — it's the
  // only thing iPhones draw in the strip at the bottom); videos play in the page.
  let wallKey = null;
  function setWallpaper(theme) {
    const key = theme.background || 'none';
    if (key === wallKey) return;
    wallKey = key;
    const root = document.documentElement.style;
    const wall = $('#homeWall');
    wall.replaceChildren();
    $('#home').classList.remove('video');
    if (!theme.background) { root.removeProperty('--page-wall'); return; }
    const src = `/api/background?v=${theme.background}`;
    if (theme.backgroundType === 'video') {
      root.removeProperty('--page-wall');
      $('#home').classList.add('video');
      const v = document.createElement('video');
      Object.assign(v, { src, muted: true, loop: true, autoplay: true, playsInline: true });
      v.setAttribute('playsinline', '');
      wall.appendChild(v);
      v.play().catch(() => {});
    } else {
      const img = new Image();
      img.onload = () => root.setProperty('--page-wall', `url("${src}")`);
      img.src = src;
    }
  }

  // The newest lines of the live terminal, in a little window.
  const peek = $('#peek');
  function renderPeek() {
    const n = lines.length;
    const from = Math.max(0, n - 12);
    const frag = document.createDocumentFragment();
    let st = startStates[from] || Ansi.blank();
    for (let j = from; j < n; j++) {
      const el = document.createElement('div');
      st = Ansi.renderLine(el, lines[j], st);
      frag.appendChild(el);
    }
    peek.replaceChildren(frag);
  }

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const pad = (n) => String(n).padStart(2, '0');
  function tickClock() {
    const d = new Date();
    const hh = pad(d.getHours()), mm = pad(d.getMinutes());
    $('#time').innerHTML = `${hh}<span class="colon">:</span>${mm}`;
    $('#date').textContent = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
    if (barClock && barClock.el.isConnected) barClock.el.textContent = qtFormat(barClock.alt ? barClock.formatAlt : barClock.format, d);
  }

  const gb = (b) => b >= 1e12 ? `${(b / 1e12).toFixed(1)}T` : `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)}G`;
  function meter(bar, val, pct, label) {
    const b = $(bar);
    b.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    b.className = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : '';
    $(val).textContent = label;
  }
  function uptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
    return `up ${d ? d + 'd ' : ''}${h ? h + 'h ' : ''}${m}m`;
  }

  let homeTimer = null;
  async function refreshHome() {
    let h;
    try { h = await (await fetch('/api/home')).json(); } catch { return; }
    $('#who').innerHTML = '';
    const b = document.createElement('b');
    b.textContent = h.user;
    $('#who').append(b, `@${h.host}`);
    meter('#cpuBar', '#cpuVal', h.cpu, `${h.cpu}%`);
    meter('#memBar', '#memVal', (h.mem.used / h.mem.total) * 100, `${gb(h.mem.used)}/${gb(h.mem.total)}`);
    if (h.disk) meter('#diskBar', '#diskVal', (h.disk.used / h.disk.total) * 100, `${gb(h.disk.used)}/${gb(h.disk.total)}`);
    const bat = h.battery;
    $('#batRow').hidden = !bat;
    if (bat) meter('#batBar', '#batVal', 100 - bat.pct, `${bat.pct}%${bat.status === 'Charging' ? ' ⚡' : ''}`);
    if (bat) $('#batBar').style.width = `${Math.max(2, bat.pct)}%`;
    $('#uptime').textContent = uptime(h.uptime);
    $('#load').textContent = `load ${h.load.toFixed(2)}`;

    renderBar(h);
  }

  // ---------- the desktop's bar ----------
  // Same widgets, same order, same glyphs as the Omarchy bar on the desktop,
  // from the layout in ~/.config/omarchy/shell.json.
  const G = {
    wifi: ['󰤯', '󰤟', '󰤢', '󰤥', '󰤨'],
    batCharging: ['󰢜', '󰂆', '󰂇', '󰂈', '󰢝', '󰂉', '󰢞', '󰂊', '󰂋', '󰂅'],
    bat: ['󰁺', '󰁻', '󰁼', '󰁽', '󰁾', '󰁿', '󰂀', '󰂁', '󰂂', '󰁹'],
  };
  const glyph = {
    network: (n) => !n ? '' : n.kind === 'wifi' ? G.wifi[Math.max(0, Math.min(4, Math.ceil((n.strength || 0) / 20) - 1))] : n.kind === 'ethernet' ? '󰈀' : '󰤮',
    bluetooth: (b) => !b ? '' : !b.enabled ? '󰂲' : b.connected ? '󰂱' : '󰂯',
    audio: (a) => !a ? '' : a.headphones ? '\u{f02cb}' : a.muted ? '\u{eee8}' : a.volume >= 0.67 ? '' : a.volume >= 0.34 ? '' : a.volume > 0 ? '' : '\u{eee8}',
    power: (b) => {
      if (!b) return '';
      const i = Math.max(0, Math.min(9, Math.floor(b.pct / 10)));
      if (b.status === 'Full') return '󰂅';
      return b.status === 'Charging' ? G.batCharging[i] : G.bat[i];
    },
    layout: (m) => m === 'scrolling' ? '󰝥' : m === 'floating' ? '󰔶' : '󱓻',
  };

  // Qt date formats, as the desktop clock uses them ("dddd HH:mm", "d MMMM 'W'ww yyyy").
  function qtFormat(fmt, d) {
    const week = (() => {
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
      return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
    })();
    const h12 = d.getHours() % 12 || 12;
    const T = {
      dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3), dd: pad(d.getDate()), d: d.getDate(),
      MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3), MM: pad(d.getMonth() + 1), M: d.getMonth() + 1,
      yyyy: d.getFullYear(), yy: String(d.getFullYear()).slice(2),
      HH: pad(d.getHours()), H: d.getHours(), hh: pad(h12), h: h12, mm: pad(d.getMinutes()), m: d.getMinutes(),
      ss: pad(d.getSeconds()), s: d.getSeconds(), AP: d.getHours() < 12 ? 'AM' : 'PM', ap: d.getHours() < 12 ? 'am' : 'pm',
      ww: pad(week), w: week,
    };
    return String(fmt).replace(/'([^']*)'|dddd|ddd|dd|d|MMMM|MMM|MM|M|yyyy|yy|HH|H|hh|h|mm|m|ss|s|AP|ap|ww|w/g,
      (tok, lit) => (lit !== undefined ? lit : String(T[tok])));
  }

  let barClock = null;   // { el, format, formatAlt, alt }
  let lastHome = null;
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function widget(w, h) {
    const b = h.bar || {};
    switch (w.id) {
      case 'omarchy.menu': {
        const m = el('button', 'om-w om-logo', '');
        m.setAttribute('aria-label', 'Omarchy menu');
        m.addEventListener('click', () => openMenu('root'));
        return m;
      }
      case 'omarchy.workspaces': {
        const box = el('div', 'om-ws');
        const info = h.workspaces;
        const ids = new Set([1, 2, 3, 4, 5, ...(info ? info.list.filter((x) => x.id <= 10).map((x) => x.id) : [])]);
        for (const id of [...ids].sort((x, y) => x - y)) {
          const ws = info && info.list.find((x) => x.id === id);
          const active = info && info.active === id;
          const btn = el('button', 'om-w', active ? glyph.layout(b.layoutMode) : (id === 10 ? '0' : String(id)));
          btn.dataset.id = id;
          if (!(active || (ws && ws.windows))) btn.classList.add('dim');
          if (!info) btn.disabled = true;
          box.appendChild(btn);
        }
        return box;
      }
      case 'omarchy.clock': {
        const c = el('button', 'om-w om-clock-w');
        const alt = barClock && barClock.alt;
        barClock = { el: c, format: w.format || 'dddd HH:mm', formatAlt: w.formatAlt || "d MMMM 'W'ww yyyy", alt };
        c.addEventListener('click', () => { barClock.alt = !barClock.alt; tickClock(); });
        return c;
      }
      case 'omarchy.weather': return b.weather ? el('span', 'om-w', b.weather) : null;
      case 'omarchy.system-update': return b.update ? el('span', 'om-w om-update', '') : null;
      case 'omarchy.elsewhen': return el('span', 'om-w', '󰇧');
      case 'omarchy.bluetooth': { const g = glyph.bluetooth(b.bluetooth); return g ? el('span', 'om-w', g) : null; }
      case 'omarchy.network': return el('span', 'om-w', glyph.network(b.network));
      case 'omarchy.audio': { const g = glyph.audio(b.audio); return g ? el('span', 'om-w', g) : null; }
      case 'omarchy.monitor': return b.monitors ? el('span', 'om-w', b.monitors > 1 ? '󰍺' : '󰍹') : null;
      case 'omarchy.power': {
        const g = glyph.power(h.battery);
        if (!g) return null;
        const s = el('span', 'om-w', g);
        if (h.battery.status !== 'Charging' && h.battery.pct <= 15) s.classList.add('crit');
        return s;
      }
      default: return null; // tray, agents, keyboard layout… desktop-only for now
    }
  }
  function renderBar(h) {
    lastHome = h;
    const L = (h.bar && h.bar.layout) || {};
    const fill = (target, ids) => {
      const out = [];
      for (const w of ids.flatMap((k) => L[k] || [])) { const e = widget(w, h); if (e) out.push(e); }
      target.replaceChildren(...out);
    };
    fill($('#barLeft'), ['left']);
    fill($('#barCenter'), ['centerBegin', 'center', 'centerEnd']);
    fill($('#barRight'), ['right']);
    $('#bar').classList.toggle('see-through', h.bar && h.bar.background === 'transparent');
    tickClock();
  }
  $('#barLeft').addEventListener('click', async (e) => {
    const b = e.target.closest('.om-ws button');
    if (!b || b.disabled) return;
    await post('/api/workspace', { id: +b.dataset.id }).catch(() => {});
    refreshHome();
  });

  // The Omarchy logo comes from Omarchy's own font.
  new FontFace('OmarchyLogo', 'url(/api/font/omarchy)').load().then((f) => document.fonts.add(f)).catch(() => {});

  // ---------- the Omarchy menu ----------
  // Same rows, icons, checkmarks and actions as the menu the logo opens on the
  // desktop. Picking a row runs it on the computer, exactly as clicking it there.
  const CONFIRM = new Set(['system.logout', 'system.reboot', 'system.shutdown', 'system.suspend', 'system.hibernate']);
  let menuStack = [];
  async function openMenu(id, push = true) {
    $('#menu').hidden = false;
    if (push) menuStack.push(id);
    $('#menuBack').hidden = menuStack.length <= 1;
    const rowsEl = $('#menuRows');
    if (!rowsEl.children.length || push) rowsEl.replaceChildren(el('div', 'om-menu-note', '…'));
    let m;
    try {
      const r = await fetch(`/api/menu?id=${encodeURIComponent(id)}`);
      m = await r.json();
      if (!r.ok) throw new Error(m.error);
    } catch {
      rowsEl.replaceChildren(el('div', 'om-menu-note', 'The Omarchy menu isn’t available on this computer.'));
      return;
    }
    if (menuStack[menuStack.length - 1] !== id) return; // moved on while it loaded
    $('#menuTitle').textContent = m.title || '';
    const rows = m.rows.map((r) => {
      const b = el('button', 'om-menu-row');
      b.dataset.id = r.id;
      b.dataset.kind = r.provider ? 'provider' : r.kind;
      b.dataset.label = r.label;
      if (r.disabled) b.disabled = true;
      const icon = el('span', 'om-menu-icon', r.icon);
      if (r.iconFont) icon.classList.add('brand');
      b.append(icon, el('span', 'om-menu-label', r.label));
      if (r.kind === 'menu' || r.kind === 'link') b.append(el('span', 'om-menu-more', '›'));
      return b;
    });
    rowsEl.replaceChildren(...(rows.length ? rows : [el('div', 'om-menu-note', 'Nothing here on this computer.')]));
    rowsEl.scrollTop = 0;
  }
  function closeMenu() { $('#menu').hidden = true; menuStack = []; $('#menuRows').replaceChildren(); }
  $('#menuClose').addEventListener('click', closeMenu);
  $('#menu').addEventListener('click', (e) => { if (e.target.id === 'menu') closeMenu(); });
  $('#menuBack').addEventListener('click', () => { menuStack.pop(); openMenu(menuStack[menuStack.length - 1], false); });
  $('#menuRows').addEventListener('click', async (e) => {
    const b = e.target.closest('.om-menu-row');
    if (!b || b.disabled) return;
    const { id, kind, label } = b.dataset;
    if (kind === 'menu' || kind === 'link') return openMenu(id);
    const name = label.replace(/ ✓$/, '');
    if (CONFIRM.has(id) && !confirm(`${name} your computer?`)) return;
    b.classList.add('busy');
    const r = await post('/api/menu/run', { id }).catch(() => null);
    b.classList.remove('busy');
    const res = r && r.ok ? await r.json().catch(() => ({})) : null;
    if (!res || !res.ok) { toast('couldn’t run that'); return; }
    closeMenu();
    // Something opened on the computer: go watch it and finish it there.
    if ((res.opensWindow || kind === 'provider') && screenOk) { show('screen'); toast(`${name} — on your screen`); }
    else toast(kind === 'provider' ? `${name} opened on your computer` : `${name} → your computer`);
  });

  // ---------- processes ----------
  let procSort = 'cpu';
  let procTimer = null;
  const openRows = new Set();
  function pctClass(v, mid, high) { return v <= 0 ? 'zero' : v >= high ? 'high' : v >= mid ? 'mid' : ''; }
  const fmtCpu = (v) => (v >= 10 ? Math.round(v) : v.toFixed(1)) + '%';
  async function refreshProcs() {
    let d;
    try { d = await (await fetch(`/api/processes?sort=${procSort}`)).json(); } catch { return; }
    if (d.warming) setTimeout(refreshProcs, 600); // first look has no CPU baseline yet
    $('#procCount').textContent = `${d.count} running`;
    const list = $('#procList');
    const rows = d.rows.map((p) => {
      const row = el('div', 'om-proc-row');
      row.dataset.pid = p.pid;
      if (openRows.has(p.pid)) row.classList.add('open');
      const main = el('div');
      main.append(el('span', 'om-proc-name', p.name), el('span', 'om-proc-cmd', `${p.pid} · ${p.user} · ${p.cmd}`));
      row.append(main, el('em', pctClass(p.cpu, 25, 75), fmtCpu(p.cpu)), el('em', pctClass(p.mem, 10, 30), `${p.mem.toFixed(1)}%`));
      return row;
    });
    list.replaceChildren(...rows);
  }
  $('#procList').addEventListener('click', (e) => {
    const row = e.target.closest('.om-proc-row');
    if (!row) return;
    const pid = +row.dataset.pid;
    row.classList.toggle('open');
    if (row.classList.contains('open')) openRows.add(pid); else openRows.delete(pid);
  });
  $('.om-sort').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    procSort = b.dataset.sort;
    document.querySelectorAll('.om-sort button').forEach((x) => x.classList.toggle('on', x === b));
    $('#procList').scrollTop = 0;
    refreshProcs();
  });

  // ---------- desktop widget: a live still of your screen ----------
  let screenOk = false;
  let thumbTimer = null;
  async function checkScreen() {
    try { screenOk = !!(await (await fetch('/api/screen')).json()).available; } catch { screenOk = false; }
    return screenOk;
  }
  function refreshThumb() {
    const img = $('#deskThumb');
    const next = new Image();
    next.onload = () => { img.src = next.src; $('#deskWin').classList.add('has-thumb'); };
    next.src = `/api/screen/thumb?t=${Date.now()}`;
  }

  // ---------- views: home ⇄ processes ⇄ terminal ⇄ screen ----------
  let view = 'home';
  const VIEWS = ['terminal', 'processes', 'screen'];
  const hashOf = (v) => (v === 'home' ? '#' : `#${v}`);
  const viewOfHash = () => VIEWS.find((v) => location.hash === `#${v}`) || 'home';
  function show(next, push = true) {
    view = next;
    const onHome = next === 'home' || next === 'processes';
    const procs = next === 'processes';
    $('#home').hidden = !onHome;
    $('#termView').hidden = next !== 'terminal';
    $('#screenView').hidden = next !== 'screen';
    document.documentElement.classList.toggle('home', onHome);
    document.documentElement.classList.toggle('screen', next === 'screen');
    $('#home').classList.toggle('procs', procs);
    $('#procWin').hidden = !procs;
    clearInterval(homeTimer);
    clearInterval(procTimer);
    clearInterval(thumbTimer);
    if (onHome) {
      refreshHome();
      homeTimer = setInterval(() => { if (!document.hidden) refreshHome(); }, 2500);
    }
    if (next === 'home') {
      renderPeek();
      refreshThumb();
      thumbTimer = setInterval(() => { if (!document.hidden) refreshThumb(); }, 5000);
    }
    if (procs) {
      refreshProcs();
      procTimer = setInterval(() => { if (!document.hidden) refreshProcs(); }, 2000);
    }
    if (next === 'terminal') {
      autoScroll = true;
      lastSize = '';
      requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; measure(); });
      input.focus({ preventScroll: true });
    }
    window.dispatchEvent(new CustomEvent('takeout:view', { detail: next }));
    if (push) history.pushState({ view: next }, '', hashOf(next));
  }
  const goBack = () => (history.state && history.state.view !== 'home' && history.length > 1 ? history.back() : show('home'));
  window.addEventListener('popstate', (e) => show((e.state && e.state.view) || viewOfHash(), false));
  $('#peekWin').addEventListener('click', () => show('terminal'));
  $('#peekWin').addEventListener('keydown', (e) => { if (e.key === 'Enter') show('terminal'); });
  $('#sysWin').addEventListener('click', () => show('processes'));
  $('#sysWin').addEventListener('keydown', (e) => { if (e.key === 'Enter') show('processes'); });
  $('#deskWin').addEventListener('click', () => show('screen'));
  $('#deskWin').addEventListener('keydown', (e) => { if (e.key === 'Enter') show('screen'); });
  $('#procBack').addEventListener('click', goBack);
  $('#homeBtn').addEventListener('click', goBack);

  // For screen.js (a separate module).
  window.Takeout = {
    show, toast, back: goBack,
    runInTerminal(cmd) { show('terminal'); sendInput({ text: cmd, key: 'Enter' }); },
  };
  checkScreen();

  tickClock();
  setInterval(tickClock, 1000);
  history.replaceState({ view: viewOfHash() }, '');
  show(viewOfHash(), false);
  connect();
})();
