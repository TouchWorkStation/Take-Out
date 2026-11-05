// Takeout screen view: your computer's live screen, made for touch.
//
// Built on noVNC (vendored, MPL-2.0). The phone talks only to Takeout's own
// paired WebSocket; Takeout starts wayvnc on a private socket while you look.
//
// Two ways to control it (Settings in the screen view's top bar; saved per phone):
//
// Trackpad (default, made for one hand): the screen sits at the top and the
// space below is a laptop-style trackpad that moves an on-screen pointer.
//   move a finger = move the pointer (faster flicks go further)
//   tap = click · tap, then touch again and drag = drag / select
//   two-finger tap = right-click · two-finger drag = scroll · pinch = zoom
//
// Touch (direct, like a tablet):
//   tap = click where your finger is · double-tap = double-click
//   long-press = right-click · long-press then drag = drag / select
//   two-finger tap = right-click · two-finger drag = scroll
//   pinch = zoom (up to 5×) · one-finger drag = pan when zoomed, scroll when not
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

const PREFS_KEY = 'takeout.screen';
const prefs = { mode: 'trackpad', speed: 1 };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch {}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }

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
    requestAnimationFrame(() => { layout(); centerPointer(); });
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
// black around it. Smaller than the phone: centered across, pinned to the top
// (so your thumb has the space below — the trackpad in trackpad mode).
function clampAxis(off, stageLen, surfLen, imgLen, imgStart) {
  if (imgLen <= stageLen) return imgStart === 0 ? 0 : (stageLen - surfLen) / 2;
  return Math.min(-imgStart, Math.max(stageLen - imgStart - imgLen, off));
}
function layout() {
  const r = stage.getBoundingClientRect();
  const w = r.width * view.z, h = r.height * view.z;
  const c = canvas();
  if (c && c.width && c.height) {
    const fit = Math.min(r.width / c.width, r.height / c.height) * view.z;
    const iw = c.width * fit, ih = c.height * fit;
    view.x = clampAxis(view.x, r.width, w, iw, (w - iw) / 2);
    view.y = clampAxis(view.y, r.height, h, ih, 0);
  } else {
    view.x = Math.min(0, Math.max(r.width - w, view.x));
    view.y = Math.min(0, Math.max(r.height - h, view.y));
  }
  surface.style.width = `${w}px`;
  surface.style.height = `${h}px`;
  surface.style.left = `${view.x}px`;
  surface.style.top = `${view.y}px`;
  const zb = $('#scZoom');
  zb.textContent = view.z > 1.05 ? `${Math.round(view.z * 10) / 10}×` : 'zoom';
  zb.classList.toggle('on', view.z > 1.05);
  placePad();
  placeCursor();
}
function zoomAt(z, cx, cy) {
  z = Math.max(1, Math.min(5, z));
  const k = z / view.z;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.z = z;
  layout();
}
// Where you last tapped, as a fraction of the desktop, so that when the
// keyboard pushes the view up while zoomed, the box you're typing into stays in sight.
let lastTap = null;
function keepTapVisible() {
  const c = canvas();
  if (!lastTap || !c || view.z <= 1.05) return;
  const sr = stage.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  const px = cr.left + cr.width * lastTap.fx - sr.left;   // where that spot sits in the stage now
  const py = cr.top + cr.height * lastTap.fy - sr.top;
  const pad = 40;
  if (px < pad || px > sr.width - pad) view.x += sr.width / 2 - px;
  if (py < pad || py > sr.height - pad) view.y += sr.height / 2 - py;
  layout();
}

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
function rememberTap(cx, cy) {
  const c = canvas();
  if (!c) return;
  const r = c.getBoundingClientRect();
  lastTap = { fx: Math.max(0, Math.min(1, (cx - r.left) / r.width)), fy: Math.max(0, Math.min(1, (cy - r.top) / r.height)) };
}
function click(cx, cy, right = false) {
  rememberTap(cx, cy);
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
function trackpad() { return prefs.mode === 'trackpad'; }

// ---------- the trackpad pointer ----------
// Kept in desktop pixels; shown instantly on the phone as a small pointer so
// you're never waiting on the network to see where it is.
const ptr = { x: null, y: null };
const cursorEl = document.createElement('div');
cursorEl.className = 'sc-cursor';
cursorEl.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 2 L3 16 L7 12.5 L9.6 18 L12 17 L9.5 11.6 L15 11.6 Z"/></svg>';
stage.appendChild(cursorEl);
const padEl = document.createElement('div');
padEl.className = 'sc-pad';
padEl.innerHTML = '<span>trackpad</span><small>tap to click · tap-tap-drag to drag<br>two fingers: scroll, or tap to right-click</small>';
stage.appendChild(padEl);

function fb() { const c = canvas(); return c && c.width ? { w: c.width, h: c.height } : null; }
function centerPointer() {
  const f = fb();
  if (f && ptr.x == null) { ptr.x = f.w / 2; ptr.y = f.h / 2; }
  placeCursor();
}
function ptrClient() {
  const c = canvas(), f = fb();
  if (!c || !f || ptr.x == null) return null;
  const r = c.getBoundingClientRect();
  return { x: r.left + (ptr.x + 0.5) * r.width / f.w, y: r.top + (ptr.y + 0.5) * r.height / f.h };
}
function placeCursor() {
  const p = trackpad() && rfb ? ptrClient() : null;
  cursorEl.hidden = !p;
  if (!p) return;
  const s = stage.getBoundingClientRect();
  cursorEl.style.transform = `translate(${p.x - s.left}px, ${p.y - s.top}px)`;
}
// The space under the picture, drawn as a pad so it's obvious where your thumb goes.
function placePad() {
  const c = canvas();
  if (!trackpad() || !c || !rfb) { padEl.hidden = true; return; }
  const s = stage.getBoundingClientRect(), r = c.getBoundingClientRect();
  const top = Math.max(0, r.bottom - s.top);
  padEl.hidden = s.height - top < 90;
  padEl.style.top = `${top}px`;
}
// Move the pointer by a finger movement. Slow = precise, fast flick = far.
function movePointer(dx, dy, dt) {
  const c = canvas(), f = fb();
  if (!c || !f) return;
  const fitWidth = c.getBoundingClientRect().width / view.z;    // picture width at 1×
  const v = Math.hypot(dx, dy) / Math.max(dt, 8);                // px per ms
  const accel = Math.min(2.6, Math.max(0.45, 0.4 + v * 1.1));
  const k = (f.w / fitWidth) * 0.8 * prefs.speed * accel;
  ptr.x = Math.max(0, Math.min(f.w - 1, ptr.x + dx * k));
  ptr.y = Math.max(0, Math.min(f.h - 1, ptr.y + dy * k));
  // zoomed in: the view follows the pointer
  if (view.z > 1.05) {
    const p = ptrClient(), sr = stage.getBoundingClientRect(), pad = 36;
    if (p) {
      if (p.x < sr.left + pad) view.x += sr.left + pad - p.x;
      if (p.x > sr.right - pad) view.x -= p.x - (sr.right - pad);
      if (p.y < sr.top + pad) view.y += sr.top + pad - p.y;
      if (p.y > sr.bottom - pad) view.y -= p.y - (sr.bottom - pad);
      layout();
    }
  }
  placeCursor();
}
// Where a click, right-click or scroll lands: the pointer (trackpad) or the finger (touch).
function here(fallback) { return trackpad() ? ptrClient() || fallback : fallback; }

// ---------- two fingers: the same in both modes ----------
function twoStart(t) {
  if (g) { clearTimeout(g.hold); if (g.mode === 'drag' || g.mode === 'tp-drag') { const p = here({ x: g.lx, y: g.ly }); mouse('mouseup', p.x, p.y, 0); } }
  const m = mid(t[0], t[1]);
  g = { mode: 'two', d0: dist(t[0], t[1]), z0: view.z, m0: m, lm: m, ox: view.x, oy: view.y, r: stage.getBoundingClientRect(), t0: Date.now() };
}
function twoMove(t) {
  if (t.length < 2) return;
  const m = mid(t[0], t[1]);
  const ratio = dist(t[0], t[1]) / g.d0;
  if (g.mode === 'two') {
    if (Math.abs(ratio - 1) > 0.12) g.mode = 'pinch';
    else if (Math.hypot(m.x - g.m0.x, m.y - g.m0.y) > 14) g.mode = 'scroll2';
    else return;
  }
  if (g.mode === 'pinch') {
    const z = Math.max(1, Math.min(5, g.z0 * ratio));
    const cx = g.m0.x - g.r.left, cy = g.m0.y - g.r.top;
    view.z = z;
    view.x = cx - (cx - g.ox) * (z / g.z0) + (m.x - g.m0.x);
    view.y = cy - (cy - g.oy) * (z / g.z0) + (m.y - g.m0.y);
    layout();
  } else {
    const p = here(m);
    wheel(p.x, p.y, (g.lm.x - m.x) * 2.2, (g.lm.y - m.y) * 2.2);
  }
  g.lm = m;
}
const isTwo = () => g && (g.mode === 'two' || g.mode === 'pinch' || g.mode === 'scroll2');
function twoTapRightClick() {
  if (g.mode === 'two' && Date.now() - g.t0 < 350) { const p = here(g.m0); click(p.x, p.y, true); buzz(); }
}

// ---------- touch mode: tap where you want ----------
const direct = {
  start(e) {
    const t = e.touches;
    if (t.length === 1) {
      const f = t[0];
      g = { mode: 'pending', sx: f.clientX, sy: f.clientY, lx: f.clientX, ly: f.clientY, t0: Date.now() };
      g.hold = setTimeout(() => { if (g && g.mode === 'pending') { g.mode = 'hold'; buzz(); } }, HOLD_MS);
    } else if (t.length === 2) twoStart(t);
    else if (g) g.mode = 'ignore';
  },
  move(e) {
    if (!g) return;
    const t = e.touches;
    if (isTwo()) return twoMove(t);
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
    if (g.mode === 'pan') { view.x += f.clientX - g.lx; view.y += f.clientY - g.ly; layout(); }
    else if (g.mode === 'scroll') wheel(f.clientX, f.clientY, (g.lx - f.clientX) * 2.2, (g.ly - f.clientY) * 2.2);
    else if (g.mode === 'drag') mouse('mousemove', f.clientX, f.clientY, 1, 0);
    g.lx = f.clientX;
    g.ly = f.clientY;
  },
  end(e) {
    if (!g) return;
    if (e.touches.length) { if (isTwo()) { twoTapRightClick(); g.mode = 'ignore'; } return; }
    clearTimeout(g.hold);
    if (g.mode === 'pending') click(g.sx, g.sy);
    else if (g.mode === 'hold') click(g.sx, g.sy, true);
    else if (g.mode === 'drag') mouse('mouseup', g.lx, g.ly, 0, 0);
    else twoTapRightClick();
    g = null;
    releaseGrab();
  },
};

// ---------- trackpad mode: move a pointer, like a laptop ----------
let lastTapEnd = 0, lastTapAt = null;
const pad = {
  start(e) {
    const t = e.touches;
    centerPointer();
    if (t.length === 1) {
      const f = t[0], now = Date.now();
      // touching again right after a tap = tap-and-drag
      const again = now - lastTapEnd < 320 && lastTapAt && Math.hypot(f.clientX - lastTapAt.x, f.clientY - lastTapAt.y) < 60;
      g = { mode: again ? 'tp-again' : 'tp-pending', sx: f.clientX, sy: f.clientY, lx: f.clientX, ly: f.clientY, lt: now, t0: now };
    } else if (t.length === 2) twoStart(t);
    else if (g) g.mode = 'ignore';
  },
  move(e) {
    if (!g) return;
    const t = e.touches;
    if (isTwo()) return twoMove(t);
    if (t.length !== 1) return;
    const f = t[0], now = Date.now();
    const far = Math.hypot(f.clientX - g.sx, f.clientY - g.sy) > SLOP;
    if (g.mode === 'tp-pending' && far) g.mode = 'tp-move';
    else if (g.mode === 'tp-again' && far) {
      g.mode = 'tp-drag';
      const p = ptrClient();
      if (p) { mouse('mousemove', p.x, p.y); mouse('mousedown', p.x, p.y, 1, 0); buzz(); }
    }
    if (g.mode === 'tp-move' || g.mode === 'tp-drag') {
      movePointer(f.clientX - g.lx, f.clientY - g.ly, now - g.lt);
      const p = ptrClient();
      if (p) mouse('mousemove', p.x, p.y, g.mode === 'tp-drag' ? 1 : 0, 0);
    }
    g.lx = f.clientX;
    g.ly = f.clientY;
    g.lt = now;
  },
  end(e) {
    if (!g) return;
    if (e.touches.length) { if (isTwo()) { twoTapRightClick(); g.mode = 'ignore'; } return; }
    const p = ptrClient();
    const quick = Date.now() - g.t0 < 300;
    if (g.mode === 'tp-pending' && quick && p) {
      click(p.x, p.y);
      lastTapEnd = Date.now();
      lastTapAt = { x: g.sx, y: g.sy };
    } else if (g.mode === 'tp-again' && p) {
      click(p.x, p.y);          // second tap = double-click
      lastTapEnd = 0;
    } else if (g.mode === 'tp-drag' && p) {
      mouse('mouseup', p.x, p.y, 0, 0);
      lastTapEnd = 0;
    } else twoTapRightClick();
    g = null;
    releaseGrab();
  },
};

const handler = () => (trackpad() ? pad : direct);
// Capture before noVNC so its own gestures never see these touches.
const swallow = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(e); };
stage.addEventListener('touchstart', swallow((e) => handler().start(e)), { capture: true, passive: false });
stage.addEventListener('touchmove', swallow((e) => handler().move(e)), { capture: true, passive: false });
stage.addEventListener('touchend', swallow((e) => handler().end(e)), { capture: true, passive: false });
stage.addEventListener('touchcancel', swallow(() => {
  if (g && (g.mode === 'drag' || g.mode === 'tp-drag')) { const p = here({ x: g.lx, y: g.ly }); mouse('mouseup', p.x, p.y, 0); }
  if (g) clearTimeout(g.hold);
  g = null;
  releaseGrab();
}), { capture: true, passive: false });
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true });

// ---------- settings ----------
const prefsEl = $('#scPrefs');
const NOTES = {
  trackpad: 'Your thumb moves a pointer, like a laptop trackpad. Tap to click. Tap, then touch again and drag to drag. Two fingers scroll, or tap with two fingers to right-click. Pinch to zoom.',
  touch: 'Tap exactly where you want. Long-press to right-click, long-press and drag to drag. Two fingers scroll. Pinch to zoom; one finger pans while zoomed.',
};
function renderPrefs() {
  prefsEl.querySelectorAll('[data-pref]').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(prefs[seg.dataset.pref]) === b.dataset.v));
  });
  $('#scModeNote').textContent = NOTES[prefs.mode];
  $('#scSpeedRow').hidden = prefs.mode !== 'trackpad';
  placePad();
  placeCursor();
}
prefsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pref] button');
  if (!b) return;
  const key = b.closest('[data-pref]').dataset.pref;
  prefs[key] = key === 'speed' ? Number(b.dataset.v) : b.dataset.v;
  savePrefs();
  g = null;
  renderPrefs();
});
$('#scSettings').addEventListener('click', (e) => {
  e.stopPropagation();
  prefsEl.hidden = !prefsEl.hidden;
  $('#scSettings').classList.toggle('on', !prefsEl.hidden);
});
document.addEventListener('click', (e) => {
  if (!prefsEl.hidden && !prefsEl.contains(e.target) && e.target.id !== 'scSettings') { prefsEl.hidden = true; $('#scSettings').classList.remove('on'); }
});
renderPrefs();

// Start-up, after everything above exists.
new ResizeObserver(() => { layout(); keepTapVisible(); }).observe(stage);
// noVNC resizes the picture on its own schedule (after ours, on rotation or
// connect). Watch for it, then re-place the pad and pointer and re-clamp.
let lastCanvasSize = '';
new MutationObserver(() => {
  const c = canvas();
  const size = c ? `${c.style.width}x${c.style.height}` : '';
  if (size === lastCanvasSize) { placePad(); placeCursor(); return; }
  lastCanvasSize = size;
  requestAnimationFrame(() => { layout(); keepTapVisible(); });
}).observe(surface, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
layout();
// Opened straight onto the screen (a reload, or the phone reopening the app
// where you left it): app.js showed it before this module loaded, so start now.
if (!$('#screenView').hidden && !wanted) { wanted = true; retry = 0; connect(); }
