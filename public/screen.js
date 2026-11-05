// Takeout screen view: your computer's live screen, made for touch.
//
// Built on noVNC (vendored, MPL-2.0). The phone talks only to Takeout's own
// paired WebSocket; Takeout starts wayvnc on a private socket while you look.
//
// Touch, direct like a tablet (Takeout's own gesture layer, not a trackpad):
//   tap = click where your finger is · double-tap = double-click
//   long-press = right-click · long-press then drag = drag / select
//   two-finger tap = right-click · two-finger drag = scroll
//   pinch = zoom the phone's view (up to 5×) · one-finger drag = pan when zoomed,
//   scroll when not
import RFB from '/vendor/novnc/core/rfb.js';
import KeyTable from '/vendor/novnc/core/input/keysym.js';
import keysyms from '/vendor/novnc/core/input/keysymdef.js';

const $ = (s) => document.querySelector(s);
const T = () => window.Takeout;

const stage = $('#scStage');
const surface = document.createElement('div');
surface.className = 'sc-surface';
stage.appendChild(surface);
const status = $('#scStatus');
const msg = $('#scMsg');
const kbd = $('#scKbd');

let rfb = null;
let wanted = false;     // the screen view is open
let retry = 0;
let retryTimer = null;

function setStatus(text, cls = '') { status.textContent = text; status.className = `sc-status ${cls}`; }
function showMsg(html) { msg.innerHTML = html; msg.hidden = !html; }

async function connect() {
  clearTimeout(retryTimer);
  if (rfb || !wanted) return;
  showMsg('');
  let st;
  try { st = await (await fetch('/api/screen')).json(); } catch { st = { available: false, reason: 'offline' }; }
  if (!wanted) return;
  if (!st.available) {
    setStatus('screen unavailable', 'bad');
    if (st.reason === 'wayvnc') {
      showMsg(`<p>Seeing your screen needs <b>wayvnc</b>, a small screen-sharing tool made for Hyprland.</p>
        <button id="scInstall" class="sc-cta">Install it in the terminal</button>
        <p class="sc-fine">You'll type your password there. Takeout only shares your screen over its own private connection, and only while you're looking.</p>`);
      $('#scInstall').addEventListener('click', () => T().runInTerminal('sudo pacman -S --needed wayvnc'));
    } else {
      showMsg('<p>Takeout can’t find your desktop session right now.</p>');
    }
    return;
  }
  setStatus('connecting…');
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/screen`;
  try {
    rfb = new RFB(surface, url, { wsProtocols: ['binary'] });
  } catch {
    setStatus('couldn’t connect', 'bad');
    return;
  }
  rfb.scaleViewport = true;     // always fit the surface; zoom = a bigger surface
  rfb.clipViewport = false;
  rfb.dragViewport = false;
  rfb.resizeSession = false;   // never change your monitor's resolution
  rfb.showDotCursor = true;
  rfb.focusOnClick = false;    // taps click; the "type" button brings up the keyboard
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
  rfb.background = 'transparent';
  rfb.addEventListener('connect', () => {
    retry = 0;
    setStatus('live', 'ok');
    requestAnimationFrame(layout);
    if (innerHeight > innerWidth && !hinted) { hinted = true; T().toast('turn your phone sideways for a bigger screen'); }
  });
  rfb.addEventListener('disconnect', (e) => {
    rfb = null;
    if (!wanted) return;
    setStatus(e.detail.clean ? 'disconnected' : 'reconnecting…', 'bad');
    retryTimer = setTimeout(connect, Math.min(8000, 600 * 2 ** retry++));
  });
  rfb.addEventListener('securityfailure', () => setStatus('screen sharing refused the connection', 'bad'));
  rfb.addEventListener('credentialsrequired', () => {
    setStatus('needs a password', 'bad');
    showMsg('<p>Your screen-sharing server asks for a password. Takeout runs wayvnc without one on a private socket; check for a <code>~/.config/wayvnc/config</code> that turns auth on.</p>');
  });
}

function disconnect() {
  clearTimeout(retryTimer);
  if (rfb) { const r = rfb; rfb = null; try { r.disconnect(); } catch {} }
  surface.replaceChildren();
}
let hinted = false;

// ---------- open / close (driven by app.js views) ----------
window.addEventListener('takeout:view', (e) => {
  const open = e.detail === 'screen';
  if (open === wanted) return;
  wanted = open;
  if (open) { retry = 0; connect(); } else { kbd.blur(); disconnect(); }
});
document.addEventListener('visibilitychange', () => {
  if (!wanted) return;
  if (document.hidden) disconnect(); else connect(); // don't stream to a pocket
});

$('#scHome').addEventListener('click', () => T().back());
$('#scZoom').addEventListener('click', () => {
  const steps = [1, 2, 3.5];
  const next = steps[(steps.findIndex((z) => Math.abs(z - view.z) < 0.05) + 1) % steps.length] || 1;
  const r = stage.getBoundingClientRect();
  zoomAt(next, r.width / 2, r.height / 2);
});
$('#scNext').addEventListener('click', async () => {
  const r = await fetch('/api/screen/next', { method: 'POST' }).then((x) => x.json()).catch(() => ({}));
  T().toast(r.ok ? 'next monitor' : 'only one monitor');
});

// ---------- keys ----------
const K = {
  super: KeyTable.XK_Super_L, ctrl: KeyTable.XK_Control_L, alt: KeyTable.XK_Alt_L, shift: KeyTable.XK_Shift_L,
  esc: KeyTable.XK_Escape, tab: KeyTable.XK_Tab, enter: KeyTable.XK_Return, return: KeyTable.XK_Return,
  bksp: KeyTable.XK_BackSpace, up: KeyTable.XK_Up, down: KeyTable.XK_Down, left: KeyTable.XK_Left, right: KeyTable.XK_Right,
  space: KeyTable.XK_space,
};
const CODE = { super: 'MetaLeft', ctrl: 'ControlLeft', alt: 'AltLeft', shift: 'ShiftLeft' };
const armed = new Set();

function keysymFor(name) {
  if (K[name] != null) return K[name];
  if (name.length === 1) return keysyms.lookup(name.codePointAt(0));
  return null;
}
// Press any armed modifiers, tap the key, release them — like a real chord.
function tap(keysym, extraMods = []) {
  if (!rfb || keysym == null) return;
  const mods = [...new Set([...extraMods, ...armed])];
  for (const m of mods) rfb.sendKey(K[m], CODE[m], true);
  rfb.sendKey(keysym, null, true);
  rfb.sendKey(keysym, null, false);
  for (const m of mods.reverse()) rfb.sendKey(K[m], CODE[m], false);
  if (armed.size) { armed.clear(); document.querySelectorAll('.sc-key[data-mod]').forEach((b) => b.classList.remove('on')); }
}

const keys = $('#scKeys');
keys.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the phone keyboard up
keys.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.a === 'kbd') {
    if (document.activeElement === kbd) kbd.blur(); else { kbd.value = SENTINEL; kbd.focus(); }
    return;
  }
  if (b.dataset.mod) {
    const m = b.dataset.mod;
    if (armed.has(m)) armed.delete(m); else armed.add(m);
    b.classList.toggle('on', armed.has(m));
    return;
  }
  if (b.dataset.key) return tap(keysymFor(b.dataset.key));
  if (b.dataset.combo) {
    const parts = b.dataset.combo.split('+');
    const key = parts.pop();
    tap(keysymFor(key), parts);
  }
});

// The phone keyboard types into a hidden field that always holds a little
// placeholder text, so backspace works even on an "empty" field on iPhone.
const SENTINEL = '··';
kbd.value = SENTINEL;
kbd.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); tap(K.enter); }
  else if (e.key === 'Tab') { e.preventDefault(); tap(K.tab); }
  else if (e.key === 'Escape') { e.preventDefault(); tap(K.esc); }
  else if (e.key.startsWith('Arrow')) { e.preventDefault(); tap(K[e.key.slice(5).toLowerCase()]); }
});
kbd.addEventListener('input', () => {
  const v = kbd.value;
  if (v.length < SENTINEL.length) {
    for (let i = v.length; i < SENTINEL.length; i++) tap(K.bksp);
  } else if (v.startsWith(SENTINEL)) {
    for (const ch of v.slice(SENTINEL.length)) tap(ch === '\n' ? K.enter : keysyms.lookup(ch.codePointAt(0)));
  } else {
    // autocorrect replaced the text: send what's new
    for (const ch of v.replace(/·/g, '')) tap(keysyms.lookup(ch.codePointAt(0)));
  }
  kbd.value = SENTINEL;
});
kbd.addEventListener('focus', () => document.querySelector('.sc-kbd-btn').classList.add('on'));
kbd.addEventListener('blur', () => document.querySelector('.sc-kbd-btn').classList.remove('on'));

// ---------- zoom & pan (on the phone) ----------
const view = { z: 1, x: 0, y: 0 };
// Keep the desktop image itself on screen: pan to its edges, not into the
// black bars around it; when it's smaller than the phone, keep it centered.
function clampAxis(off, stageLen, surfLen, imgLen) {
  const margin = (surfLen - imgLen) / 2;
  if (imgLen <= stageLen) return (stageLen - surfLen) / 2;
  return Math.min(-margin, Math.max(stageLen - margin - imgLen, off));
}
function layout() {
  const r = stage.getBoundingClientRect();
  const w = r.width * view.z, h = r.height * view.z;
  const c = canvas();
  if (c && c.width && c.height) {
    const fit = Math.min(r.width / c.width, r.height / c.height) * view.z;
    view.x = clampAxis(view.x, r.width, w, c.width * fit);
    view.y = clampAxis(view.y, r.height, h, c.height * fit);
  } else {
    view.x = Math.min(0, Math.max(r.width - w, view.x));
    view.y = Math.min(0, Math.max(r.height - h, view.y));
  }
  surface.style.width = `${w}px`;
  surface.style.height = `${h}px`;
  surface.style.left = `${view.x}px`;
  surface.style.top = `${view.y}px`;
  const zb = $('#scZoom');
  zb.textContent = view.z > 1.05 ? `${view.z.toFixed(view.z < 2 ? 1 : 0)}×` : 'zoom';
  zb.classList.toggle('on', view.z > 1.05);
}
function zoomAt(z, cx, cy) {
  z = Math.max(1, Math.min(5, z));
  const k = z / view.z;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.z = z;
  layout();
}
new ResizeObserver(layout).observe(stage);
layout();

// ---------- touch → precise mouse on the computer ----------
function canvas() { return surface.querySelector('canvas'); }
function pointOn(cx, cy) {
  const c = canvas();
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: Math.max(r.left, Math.min(r.right - 1, cx)), y: Math.max(r.top, Math.min(r.bottom - 1, cy)) };
}
// While a button is held, noVNC lays an invisible "capture" layer over the
// page (like a real mouse grab) and only lets go when a mouse-up reaches it.
// So moves and releases go to that layer when it's up, as a real mouse's would.
const captureLayer = () => {
  const el = document.getElementById('noVNC_mouse_capture_elem');
  return el && el.style.display !== 'none' ? el : null;
};
function mouse(type, cx, cy, buttons = 0, button = 0) {
  const c = canvas();
  const p = pointOn(cx, cy);
  if (!c || !p || !rfb) return;
  const target = (type === 'mouseup' || type === 'mousemove') && captureLayer() || c;
  target.dispatchEvent(new MouseEvent(type, { clientX: p.x, clientY: p.y, buttons, button, bubbles: true, cancelable: true }));
}
// Belt and braces: never leave the capture layer up between gestures.
function releaseGrab() {
  const el = captureLayer();
  if (el) el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
}
function click(cx, cy, right = false) {
  mouse('mousemove', cx, cy);
  mouse('mousedown', cx, cy, right ? 2 : 1, right ? 2 : 0);
  mouse('mouseup', cx, cy, 0, right ? 2 : 0);
}
function wheel(cx, cy, dx, dy) {
  const c = canvas();
  const p = pointOn(cx, cy);
  if (!c || !p || !rfb) return;
  c.dispatchEvent(new WheelEvent('wheel', { clientX: p.x, clientY: p.y, deltaX: dx, deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }));
}
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch {} };

const HOLD_MS = 420, SLOP = 9;
let g = null; // the current gesture
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

function onStart(e) {
  const t = e.touches;
  if (t.length === 1) {
    const f = t[0];
    g = { mode: 'pending', sx: f.clientX, sy: f.clientY, lx: f.clientX, ly: f.clientY, t0: Date.now() };
    g.hold = setTimeout(() => { if (g && g.mode === 'pending') { g.mode = 'hold'; buzz(); } }, HOLD_MS);
  } else if (t.length === 2) {
    if (g) { clearTimeout(g.hold); if (g.mode === 'drag') mouse('mouseup', g.lx, g.ly, 0); }
    const m = mid(t[0], t[1]);
    const r = stage.getBoundingClientRect();
    g = { mode: 'two', d0: dist(t[0], t[1]), z0: view.z, m0: m, lm: m, ox: view.x, oy: view.y, r, t0: Date.now(), moved: false };
  } else if (g) {
    g.mode = 'ignore';
  }
}
function onMove(e) {
  if (!g) return;
  const t = e.touches;
  if (g.mode === 'two' || g.mode === 'pinch' || g.mode === 'scroll2') {
    if (t.length < 2) return;
    const m = mid(t[0], t[1]);
    const ratio = dist(t[0], t[1]) / g.d0;
    if (g.mode === 'two') {
      if (Math.abs(ratio - 1) > 0.12) g.mode = 'pinch';
      else if (Math.hypot(m.x - g.m0.x, m.y - g.m0.y) > 14) g.mode = 'scroll2';
      else return;
      g.moved = true;
    }
    if (g.mode === 'pinch') {
      // zoom around the pinch, and follow the fingers as they move
      const z = Math.max(1, Math.min(5, g.z0 * ratio));
      const cx = g.m0.x - g.r.left, cy = g.m0.y - g.r.top;
      view.z = z;
      view.x = cx - (cx - g.ox) * (z / g.z0) + (m.x - g.m0.x);
      view.y = cy - (cy - g.oy) * (z / g.z0) + (m.y - g.m0.y);
      layout();
    } else {
      wheel(m.x, m.y, (g.lm.x - m.x) * 2.2, (g.lm.y - m.y) * 2.2);
    }
    g.lm = m;
    return;
  }
  if (t.length !== 1) return;
  const f = t[0];
  const far = Math.hypot(f.clientX - g.sx, f.clientY - g.sy) > SLOP;
  if (g.mode === 'pending' && far) {
    clearTimeout(g.hold);
    g.mode = view.z > 1.05 ? 'pan' : 'scroll';
  } else if (g.mode === 'hold' && far) {
    g.mode = 'drag';
    mouse('mousemove', g.sx, g.sy);
    mouse('mousedown', g.sx, g.sy, 1, 0);
  }
  if (g.mode === 'pan') {
    view.x += f.clientX - g.lx;
    view.y += f.clientY - g.ly;
    layout();
  } else if (g.mode === 'scroll') {
    wheel(f.clientX, f.clientY, (g.lx - f.clientX) * 2.2, (g.ly - f.clientY) * 2.2);
  } else if (g.mode === 'drag') {
    mouse('mousemove', f.clientX, f.clientY, 1, 0);
  }
  g.lx = f.clientX;
  g.ly = f.clientY;
}
function onEnd(e) {
  if (!g) return;
  if (e.touches.length) {
    // one finger of a two-finger gesture lifted: the gesture is over
    if (g.mode === 'two' || g.mode === 'pinch' || g.mode === 'scroll2') {
      if (g.mode === 'two' && Date.now() - g.t0 < 350) { click(g.m0.x, g.m0.y, true); buzz(); }
      g.mode = 'ignore';
    }
    return;
  }
  clearTimeout(g.hold);
  if (g.mode === 'pending') click(g.sx, g.sy);
  else if (g.mode === 'hold') click(g.sx, g.sy, true);
  else if (g.mode === 'drag') mouse('mouseup', g.lx, g.ly, 0, 0);
  else if (g.mode === 'two' && Date.now() - g.t0 < 350) { click(g.m0.x, g.m0.y, true); buzz(); }
  g = null;
  releaseGrab();
}
// Capture before noVNC so its own (trackpad-style) gestures never see these touches.
const swallow = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(e); };
stage.addEventListener('touchstart', swallow(onStart), { capture: true, passive: false });
stage.addEventListener('touchmove', swallow(onMove), { capture: true, passive: false });
stage.addEventListener('touchend', swallow(onEnd), { capture: true, passive: false });
stage.addEventListener('touchcancel', swallow((e) => { if (g && g.mode === 'drag') mouse('mouseup', g.lx, g.ly, 0); clearTimeout(g && g.hold); g = null; }), { capture: true, passive: false });
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true });
