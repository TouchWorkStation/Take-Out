(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const pretty = (s) => String(s || '').replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/-/g, ' ');
  const slug = (s) => String(s || '').toLowerCase().replace(/\s+/g, '-');
  const wsURL = (p) => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + p;

  // ---------- terminal ----------
  const term = new Terminal({
    cursorBlink: true,
    allowTransparency: true,
    fontSize: window.innerWidth < 500 ? 12 : 14,
    lineHeight: 1.15,
    scrollback: 5000,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font'),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));

  let sock = null;
  let retry = 0;
  const status = $('#status');

  function sendInput(d) {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify({ t: 'i', d }));
  }
  function sendSize() {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
  }

  function connectTerm() {
    if (sock && sock.readyState <= 1) return;
    try { fit.fit(); } catch {}
    sock = new WebSocket(wsURL(`/ws/term?cols=${term.cols}&rows=${term.rows}`));
    sock.onopen = () => {
      retry = 0;
      status.className = 'status on';
      term.reset(); // server replays scrollback so you land exactly where you left off
    };
    sock.onmessage = (e) => term.write(e.data);
    sock.onclose = () => {
      status.className = 'status off';
      setTimeout(connectTerm, Math.min(8000, 400 * 2 ** retry++));
    };
  }

  // ---------- modifiers from the key bar ----------
  const mods = { ctrl: false, alt: false };
  function setMod(k, on) {
    mods[k] = on;
    document.querySelector(`[data-k="${k}"]`).classList.toggle('armed', on);
  }
  function applyMods(d) {
    if (mods.ctrl && d.length === 1) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
      else if (d === ' ') d = '\x00';
    }
    if (mods.alt) d = '\x1b' + d;
    if (mods.ctrl) setMod('ctrl', false);
    if (mods.alt) setMod('alt', false);
    return d;
  }

  term.onData((d) => sendInput(applyMods(d)));

  const SEQ = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', ctrlc: '\x03' };

  $('#keys').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the phone keyboard open
  $('#keys').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = b.dataset.k;
    if (k === 'ctrl' || k === 'alt') { setMod(k, !mods[k]); return term.focus(); }
    if (k === 'paste') {
      let text = null;
      try { text = await navigator.clipboard.readText(); } catch {}
      if (text == null) text = prompt('Paste into terminal');
      if (text) sendInput(text);
    } else if (SEQ[k]) {
      sendInput(k === 'ctrlc' ? SEQ[k] : applyMods(SEQ[k]));
    } else if (b.dataset.s) {
      sendInput(applyMods(b.dataset.s));
    }
    term.focus();
  });

  const refit = () => { try { fit.fit(); sendSize(); } catch {} };
  new ResizeObserver(refit).observe($('#termWrap'));
  window.visualViewport && window.visualViewport.addEventListener('resize', refit);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { connectTerm(); connectEvents(); } });

  // ---------- theme sync ----------
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
      document.documentElement.style.setProperty('--font', `"TakeoutMono", "${theme.font}", ui-monospace, monospace`);
      term.options.fontFamily = `"TakeoutMono", ui-monospace, monospace`;
      refit();
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
    set('--muted', c.muted || c.dark_foreground);
    set('--accent', c.accent);
    set('--red', c.red);
    set('--green', c.green);
    set('--yellow', c.yellow);
    document.documentElement.style.colorScheme = c.mode === 'light' ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', c.background);

    term.options.theme = {
      background: '#00000000',
      foreground: c.foreground,
      cursor: c.cursor || c.bright_foreground || c.foreground,
      cursorAccent: c.background,
      selectionBackground: c.selection || c.selection_background,
      selectionForeground: c.selection_foreground,
      black: c.color0 || c.background, red: c.red, green: c.green, yellow: c.yellow,
      blue: c.blue, magenta: c.magenta, cyan: c.cyan, white: c.color7 || c.foreground,
      brightBlack: c.color8 || c.muted, brightRed: c.bright_red, brightGreen: c.bright_green,
      brightYellow: c.bright_yellow, brightBlue: c.bright_blue, brightMagenta: c.bright_magenta,
      brightCyan: c.bright_cyan, brightWhite: c.color15 || c.bright_foreground,
    };

    const wall = $('#wall');
    wall.style.backgroundImage = theme.background ? `url(/api/background?v=${theme.background})` : 'none';

    $('#themeName').textContent = pretty(theme.name);
    loadFont(theme);

    const changed = current && current.name !== theme.name;
    current = theme;
    if (changed) toast(`now wearing ${pretty(theme.name)}`);
    if (pending && slug(pending) === slug(theme.name)) { pending = null; closeSheet(); }
    markCurrent();
  }

  let events = null;
  function connectEvents() {
    if (events && events.readyState <= 1) return;
    events = new WebSocket(wsURL('/ws/events'));
    events.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'theme') applyTheme(m.theme);
    };
    events.onclose = () => setTimeout(connectEvents, 2000);
  }

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
      const r = await fetch('/api/themes');
      const data = await r.json();
      if (!data.themes.length) {
        list.innerHTML = '<div class="empty">No Omarchy themes found on this machine. Takeout still follows whatever colors are active.</div>';
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
        for (const col of (s.dots || [])) {
          const i = document.createElement('i');
          i.style.background = col;
          dots.appendChild(i);
        }
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
    const r = await fetch('/api/theme/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: card.dataset.name }),
    }).catch(() => null);
    if (!r || !r.ok) { pending = null; card.classList.remove('busy'); toast('couldn’t switch theme'); }
  });

  $('#themeBtn').addEventListener('click', openSheet);
  $('#closeSheet').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

  // ---------- toast ----------
  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  connectEvents();
  connectTerm();
  term.focus();
})();
