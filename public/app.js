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
    $('#wall').style.backgroundImage = theme.background ? `url(/api/background?v=${theme.background})` : 'none';
    $('#themeName').textContent = pretty(theme.name);
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

  connect();
})();
