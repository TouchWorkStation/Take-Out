// ansi.js — renders tmux `capture-pane -e` lines as styled DOM.
//
// The 16 base colors render as CSS variables (--c0 … --c15) fed by the live
// Omarchy theme, so when the theme changes every line already on screen
// recolors instantly with no re-render. 256-color and truecolor codes are
// supported too (TouchWorkstation's renderer only knew the 16 base colors).

(function (global) {
  'use strict';

  const CUBE = [0, 95, 135, 175, 215, 255];
  const hex = (n) => n.toString(16).padStart(2, '0');

  function color256(n) {
    if (n < 16) return `var(--c${n})`;
    if (n < 232) {
      n -= 16;
      return `#${hex(CUBE[Math.floor(n / 36)])}${hex(CUBE[Math.floor(n / 6) % 6])}${hex(CUBE[n % 6])}`;
    }
    const g = 8 + (n - 232) * 10;
    return `#${hex(g)}${hex(g)}${hex(g)}`;
  }

  const blank = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, under: false, inverse: false, strike: false });
  const copy = (s) => ({ ...s });

  function applySgr(st, params) {
    const codes = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) Object.assign(st, blank());
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.under = true;
      else if (c === 7) st.inverse = true;
      else if (c === 9) st.strike = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 23) st.italic = false;
      else if (c === 24) st.under = false;
      else if (c === 27) st.inverse = false;
      else if (c === 29) st.strike = false;
      else if (c >= 30 && c <= 37) st.fg = `var(--c${c - 30})`;
      else if (c >= 90 && c <= 97) st.fg = `var(--c${c - 82})`;
      else if (c >= 40 && c <= 47) st.bg = `var(--c${c - 40})`;
      else if (c >= 100 && c <= 107) st.bg = `var(--c${c - 92})`;
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) {
        let col = null;
        if (codes[i + 1] === 5) { col = color256(codes[i + 2] | 0); i += 2; }
        else if (codes[i + 1] === 2) {
          col = `#${hex(codes[i + 2] & 255)}${hex(codes[i + 3] & 255)}${hex(codes[i + 4] & 255)}`;
          i += 4;
        }
        if (col) st[c === 38 ? 'fg' : 'bg'] = col;
      }
    }
  }

  function styleOf(st) {
    let fg = st.fg, bg = st.bg;
    if (st.inverse) { fg = st.bg || 'var(--bg)'; bg = st.fg || 'var(--fg)'; }
    let css = '';
    if (fg) css += `color:${fg};`;
    if (bg) css += `background:${bg};`;
    if (st.bold) css += 'font-weight:700;';
    if (st.dim) css += 'opacity:.62;';
    if (st.italic) css += 'font-style:italic;';
    if (st.under || st.strike) css += `text-decoration:${st.under ? 'underline ' : ''}${st.strike ? 'line-through' : ''};`;
    return css;
  }

  // CSI (incl. SGR), OSC (titles, hyperlinks), DCS/APC strings, charset selects.
  const TOKEN = /\x1b\[([0-9;:?]*)([A-Za-z@])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b./g;
  const CONTROL = /[\x00-\x08\x0B-\x1F\x7F]/g;

  // Renders one line into `el`, starting from style `start`. Returns the style at line end.
  function renderLine(el, line, start) {
    const st = copy(start);
    el.textContent = '';
    let pos = 0;
    let m;
    const push = (end) => {
      if (end <= pos) return;
      const text = line.slice(pos, end).replace(CONTROL, '');
      if (!text) return;
      const css = styleOf(st);
      if (!css) { el.appendChild(document.createTextNode(text)); return; }
      const span = document.createElement('span');
      span.style.cssText = css;
      span.textContent = text;
      el.appendChild(span);
    };
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(line))) {
      push(m.index);
      if (m[2] === 'm') applySgr(st, m[1] || '');
      pos = TOKEN.lastIndex;
    }
    push(line.length);
    return st;
  }

  global.Ansi = { renderLine, blank };
})(window);
