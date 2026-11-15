// Runs in every tab (isolated from the page's own scripts).
// 1) Gives seeker:// internal pages a safe API.  2) Touchpad + mouse gestures.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'seeker:') {
  contextBridge.exposeInMainWorld('seeker', {
    call: (name, ...args) => ipcRenderer.invoke('internal', name, ...args),
    ai: (action, arg) => ipcRenderer.invoke('ai', action, arg),
    on: (cb) => {
      const h = (e, name, data) => cb(name, data);
      ipcRenderer.on('seeker-event', h);
      return () => ipcRenderer.removeListener('seeker-event', h);
    },
  });
}

let cfg = { swipe: true, mouse: true, rocker: true, wheelTabs: true };
try { cfg = { ...cfg, ...(ipcRenderer.sendSync('gesture-config') || {}) }; } catch { /* defaults */ }
ipcRenderer.on('gesture-config', (e, c) => { cfg = { ...cfg, ...c }; });
const send = (action) => ipcRenderer.send('gesture', action);

// Elements we add use custom tag names + !important styles so page CSS can't break them.
function el(tag, styles) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(styles)) e.style.setProperty(k, v, 'important');
  return e;
}
const root = () => document.documentElement || document.body;

// ---------- Two-finger touchpad swipe → back / forward (like Chrome & Edge) ----------
const SWIPE_DONE = 260;
let swipeAcc = 0, swipeTimer = null, swipeEl = null;
function canScrollX(target, dx) {
  for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(cs.overflowX)) {
      if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
    }
  }
  const se = document.scrollingElement;
  if (se && se.scrollWidth > se.clientWidth + 1) {
    if (dx < 0 ? se.scrollLeft > 0 : se.scrollLeft + se.clientWidth < se.scrollWidth - 1) return true;
  }
  return false;
}
function showSwipe(acc) {
  const back = acc < 0;
  const p = Math.min(1, Math.abs(acc) / SWIPE_DONE);
  if (!swipeEl) {
    swipeEl = el('seeker-swipe', {
      position: 'fixed', top: '50%', width: '52px', height: '52px', 'margin-top': '-26px', 'border-radius': '50%',
      background: '#1a73e8', color: '#fff', display: 'flex', 'align-items': 'center', 'justify-content': 'center',
      font: 'bold 26px system-ui, sans-serif', 'z-index': '2147483647', 'pointer-events': 'none',
      'box-shadow': '0 4px 16px rgba(0,0,0,.3)', transition: 'opacity .15s',
    });
    root().appendChild(swipeEl);
  }
  swipeEl.textContent = back ? '←' : '→';
  swipeEl.style.setProperty('left', back ? `${-52 + p * 76}px` : 'auto', 'important');
  swipeEl.style.setProperty('right', back ? 'auto' : `${-52 + p * 76}px`, 'important');
  swipeEl.style.setProperty('opacity', String(0.3 + p * 0.7), 'important');
  swipeEl.style.setProperty('background', p >= 1 ? '#1a73e8' : '#5f6368', 'important');
}
function hideSwipe() { if (swipeEl) { swipeEl.remove(); swipeEl = null; } }

window.addEventListener('wheel', (e) => {
  // Hold right mouse button + wheel → switch tabs
  if (rightDown && cfg.wheelTabs) {
    e.preventDefault(); e.stopImmediatePropagation();
    suppressMenu = true;
    send(e.deltaY > 0 ? 'nextTab' : 'prevTab');
    return;
  }
  if (!cfg.swipe || e.ctrlKey) return; // ctrl+wheel = pinch zoom, handled by the browser
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && Math.abs(e.deltaX) > 1;
  if (!horizontal) { if (!swipeTimer) swipeAcc = 0; return; }
  if (swipeAcc === 0 && canScrollX(e.target, e.deltaX)) return;
  if (e.deltaMode !== 0) return; // only pixel-precise touchpads, not mouse tilt wheels
  swipeAcc += e.deltaX;
  showSwipe(swipeAcc);
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(() => {
    if (Math.abs(swipeAcc) >= SWIPE_DONE) send(swipeAcc < 0 ? 'back' : 'forward');
    swipeAcc = 0; swipeTimer = null; hideSwipe();
  }, 140);
}, { passive: false, capture: true });

// ---------- Mouse gestures (hold right button and draw) + rocker gestures ----------
const GESTURES = {
  L: ['back', 'Back'], R: ['forward', 'Forward'], U: ['top', 'Scroll to top'], D: ['bottom', 'Scroll to bottom'],
  UD: ['reload', 'Reload'], DR: ['closeTab', 'Close tab'], UL: ['reopen', 'Reopen closed tab'], UR: ['newTab', 'New tab'],
  RL: ['prevTab', 'Previous tab'], LR: ['nextTab', 'Next tab'],
};
let rightDown = false, leftDown = false, suppressMenu = false, suppressClick = false, gesturing = false;
let start = null, last = null, dirs = '', canvas = null, ctx = null, label = null;

function startTrail() {
  const dpr = window.devicePixelRatio || 1;
  canvas = el('canvas', { position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'z-index': '2147483646', 'pointer-events': 'none' });
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(start.x, start.y);
  label = el('seeker-gesture', {
    position: 'fixed', left: '50%', bottom: '40px', transform: 'translateX(-50%)', padding: '6px 14px', 'border-radius': '16px',
    background: 'rgba(32,33,36,.9)', color: '#fff', font: '14px system-ui, sans-serif', 'z-index': '2147483647', 'pointer-events': 'none',
  });
  root().append(canvas, label);
}
function endTrail() { canvas?.remove(); label?.remove(); canvas = ctx = label = null; }

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    leftDown = true;
    if (rightDown && cfg.rocker) { e.preventDefault(); e.stopImmediatePropagation(); suppressMenu = true; suppressClick = true; send('forward'); }
  } else if (e.button === 2) {
    if (leftDown && cfg.rocker) { e.preventDefault(); suppressMenu = true; send('back'); return; }
    rightDown = true; gesturing = false; dirs = '';
    start = last = { x: e.clientX, y: e.clientY };
  }
}, true);

window.addEventListener('mousemove', (e) => {
  if (!rightDown || !cfg.mouse || !(e.buttons & 2)) return;
  const p = { x: e.clientX, y: e.clientY };
  if (!gesturing) {
    if (Math.hypot(p.x - start.x, p.y - start.y) < 14) return;
    gesturing = true; startTrail();
  }
  ctx.lineTo(p.x, p.y); ctx.stroke();
  const dx = p.x - last.x, dy = p.y - last.y;
  if (Math.hypot(dx, dy) >= 28) {
    const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
    if (d !== dirs.slice(-1)) dirs += d;
    last = p;
    const g = GESTURES[dirs];
    label.textContent = g ? g[1] : dirs.split('').map((c) => ({ L: '←', R: '→', U: '↑', D: '↓' })[c]).join(' ');
  }
}, true);

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) leftDown = false;
  if (e.button !== 2) return;
  rightDown = false;
  if (!gesturing) return;
  gesturing = false;
  endTrail();
  suppressMenu = true;
  const g = GESTURES[dirs];
  if (!g) return;
  if (g[0] === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
  else if (g[0] === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  else send(g[0]);
}, true);

window.addEventListener('click', (e) => {
  if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); suppressClick = false; }
}, true);
window.addEventListener('contextmenu', (e) => {
  if (suppressMenu) { e.preventDefault(); e.stopImmediatePropagation(); suppressMenu = false; }
}, true);
window.addEventListener('blur', () => { rightDown = leftDown = false; if (gesturing) { gesturing = false; endTrail(); } });
