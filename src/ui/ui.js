/* global ui, icon */
// Seeker browser chrome: tabs, address bar, panels. Talks to the main process via window.ui.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KIND = new URLSearchParams(location.search).get('kind') || 'normal';
document.documentElement.classList.add(KIND);
if (KIND !== 'normal') document.documentElement.classList.add('dark');
$('#kind-badge').textContent = { incognito: 'Incognito', tor: '🧅 Tor' }[KIND] || '';

let S = { tabs: [], activeId: null, active: null };
let SET = { gestures: {} };
let BOOKMARKS = [];
let DOWNLOADS = [];
let sidePanel = null; // 'ai' | 'downloads' | null

// ---------------------------------------------------------- layout & overlay
let overlayOn = false;
function setOverlay(on) {
  if (on === overlayOn) return;
  overlayOn = on;
  $('#catcher').hidden = !on;
  ui.cmd('overlay', on);
}
function closePopups() {
  $('#suggest').hidden = true;
  $('#popover').hidden = true;
  popoverCleanup?.(); popoverCleanup = null;
  setOverlay(false);
}
$('#catcher').addEventListener('mousedown', closePopups);
ui.on('close-popups', closePopups);
function reportLayout() {
  ui.cmd('layout', { top: $('#top').offsetHeight, right: $('#side').hidden ? 0 : $('#side').offsetWidth });
  $('#side').style.top = $('#top').offsetHeight + 'px';
}
new ResizeObserver(reportLayout).observe($('#top'));
new ResizeObserver(reportLayout).observe($('#side'));

// ---------------------------------------------------------- state from main
ui.on('state', (st) => { S = st; renderTabs(); renderToolbar(); });
ui.on('settings', (s) => {
  SET = s;
  const dark = s.dark || KIND !== 'normal';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('nobm', !s.showBookmarksBar || KIND === 'tor');
  renderBookmarks();
});
ui.on('bookmarks', (b) => { BOOKMARKS = b; renderBookmarks(); renderToolbar(); });
ui.on('downloads', (d) => { DOWNLOADS = d; renderDownloads(); });

// ---------------------------------------------------------- tabs
function favHtml(t) {
  if (t.loading && !t.sleeping) return '<span class="spinner"></span>';
  if (t.url.startsWith('seeker://')) return icon('seeker');
  if (t.favicon) return `<img src="${esc(t.favicon)}">`;
  return icon('globe');
}
function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = S.tabs.map((t) => `
    <div class="tab ${t.id === S.activeId ? 'active' : ''} ${t.pinned ? 'pinned' : ''} ${t.sleeping ? 'sleeping' : ''}" data-id="${t.id}" draggable="true" title="${esc(t.title)}\n${esc(t.url)}${t.sleeping ? '\n(sleeping to save memory)' : ''}">
      <span class="fav">${favHtml(t)}</span>
      <span class="title">${esc(t.title || t.url)}</span>
      ${t.audible || t.muted ? `<button class="snd" data-mute="${t.id}" title="${t.muted ? 'Unmute' : 'Mute'} tab">${icon(t.muted ? 'muted' : 'audio')}</button>` : ''}
      <button class="close" data-close="${t.id}" title="Close tab (Ctrl+W)">${icon('x')}</button>
    </div>`).join('');
}
$('#tabs').addEventListener('mousedown', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const id = +tab.dataset.id;
  if (e.button === 1) { e.preventDefault(); ui.cmd('closeTab', id); return; }
  if (e.button !== 0) return;
  if (e.target.closest('[data-close]') || e.target.closest('[data-mute]')) return;
  ui.cmd('activate', id);
});
$('#tabs').addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]'); if (c) return ui.cmd('closeTab', +c.dataset.close);
  const m = e.target.closest('[data-mute]'); if (m) return ui.cmd('mute', +m.dataset.mute);
});
$('#tabs').addEventListener('contextmenu', (e) => { const t = e.target.closest('.tab'); if (t) { e.preventDefault(); ui.cmd('tabMenu', +t.dataset.id); } });
$('#tabstrip').addEventListener('dblclick', (e) => { if (!e.target.closest('.tab, button')) ui.cmd('newTab'); });
$('#tabstrip').addEventListener('wheel', (e) => {
  if (!SET.gestures?.wheelTabs) return;
  ui.cmd(e.deltaY > 0 || e.deltaX > 0 ? 'nextTab' : 'prevTab');
}, { passive: true });
let dragId = null;
$('#tabs').addEventListener('dragstart', (e) => { const t = e.target.closest('.tab'); dragId = t ? +t.dataset.id : null; e.dataTransfer.effectAllowed = 'move'; });
$('#tabs').addEventListener('dragover', (e) => {
  if (dragId === null) return;
  e.preventDefault();
  document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
  e.target.closest('.tab')?.classList.add('drop-before');
});
$('#tabs').addEventListener('drop', (e) => {
  e.preventDefault();
  const t = e.target.closest('.tab');
  document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
  if (dragId === null || !t) return;
  const ids = S.tabs.map((x) => x.id);
  let to = ids.indexOf(+t.dataset.id);
  if (ids.indexOf(dragId) < to) to--;
  ui.cmd('moveTab', dragId, Math.max(0, to));
  dragId = null;
});
$('#tabs').addEventListener('dragend', () => { dragId = null; });
$('#newtab').onclick = () => ui.cmd('newTab');
$('#tabsearch-btn').onclick = () => tabSearch();

// ---------------------------------------------------------- toolbar
function displayUrl(u) {
  if (!u) return '';
  if (u.startsWith('seeker://newtab')) { const q = new URL(u).searchParams.get('q'); return q || ''; }
  if (u.startsWith('seeker://error')) return new URL(u).searchParams.get('url') || u;
  return u;
}
function renderToolbar() {
  const a = S.active;
  $('#back').disabled = !a?.canBack;
  $('#forward').disabled = !a?.canFwd;
  const tab = S.tabs.find((t) => t.id === S.activeId);
  const loading = tab?.loading;
  $('#reload').innerHTML = icon(loading ? 'stop' : 'reload');
  $('#reload').title = loading ? 'Stop' : 'Reload (F5)';
  if (document.activeElement !== $('#url')) $('#url').value = displayUrl(a?.url);
  const u = a?.url || '';
  const si = $('#site-icon');
  si.className = '';
  let ic = 'search';
  if (/^https:\/\/[^/]*\.onion(\/|$|:)/.test(u) || /^http:\/\/[^/]*\.onion/.test(u)) { ic = 'onion'; si.className = 'onion'; si.title = 'Onion site — reached through Tor'; }
  else if (u.startsWith('https://')) { ic = 'lock'; si.className = 'secure'; si.title = 'Connection is secure'; }
  else if (u.startsWith('http://')) { ic = 'warn'; si.className = 'insecure'; si.title = 'Not secure'; }
  else if (u.startsWith('seeker://') && !u.startsWith('seeker://newtab')) { ic = 'seeker'; si.title = 'Seeker page'; }
  si.innerHTML = icon(ic);
  $('#zoom-badge').textContent = a && a.zoom !== 100 ? a.zoom + '%' : '';
  $('#star').classList.toggle('on', !!a?.bookmarked);
  $('#star').hidden = !a || u.startsWith('seeker://newtab') || KIND === 'tor';
  const media = a?.media || [];
  $('#media-btn').hidden = !media.length;
  $('#media-btn .count').textContent = media.length || '';
  const pv = a?.privacy;
  const n = (a?.blocked || 0) + (pv?.cookies || 0) + (pv?.fp?.length || 0) + (pv?.stripped || 0);
  $('#shield .count').textContent = n ? (n > 99 ? '99+' : n) : '';
  $('#shield').classList.toggle('off', !!pv && (pv.exception || pv.mode === 'off'));
  $('#shield').title = pv && (pv.exception || pv.mode === 'off') ? 'Privacy Shield is off for this site' : `Privacy Shield: ${n} things blocked on this page`;
}
$('#back').onclick = () => ui.cmd('back');
$('#forward').onclick = () => ui.cmd('forward');
$('#reload').onclick = () => (S.tabs.find((t) => t.id === S.activeId)?.loading ? ui.cmd('stop') : ui.cmd('reload'));
$('#home').onclick = () => ui.cmd('home');
$('#menu-btn').onclick = () => ui.cmd('menu');
$('#zoom-badge').onclick = () => ui.cmd('zoomReset');
$('#shield').onclick = () => shieldPopup();
$('#star').onclick = () => bookmarkPopup();
$('#media-btn').onclick = () => mediaPopup();
$('#dl-btn').onclick = () => toggleSide('downloads');
$('#ai-btn').onclick = () => toggleSide('ai');
$('#dl-manager').onclick = () => ui.cmd('downloads');
document.querySelectorAll('.side-close').forEach((b) => (b.onclick = () => toggleSide(null)));

// ---------------------------------------------------------- omnibox + suggestions
const url = $('#url');
let sugg = [], sel = -1, typed = '', suggTimer = null;
url.addEventListener('focus', () => setTimeout(() => url.select(), 0));
url.addEventListener('input', () => {
  typed = url.value; sel = -1;
  clearTimeout(suggTimer);
  suggTimer = setTimeout(async () => {
    if (!url.value.trim()) return closePopups();
    const q = url.value;
    const list = await ui.cmd('suggest', q);
    if (url.value !== q || document.activeElement !== url) return;
    sugg = [{ type: q.startsWith('?') ? 'ai' : 'go', title: q, url: null }, ...list];
    renderSuggest();
  }, 70);
});
function renderSuggest() {
  const r = $('#omni').getBoundingClientRect();
  const box = $('#suggest');
  Object.assign(box.style, { left: r.left + 'px', top: r.bottom + 4 + 'px', width: r.width + 'px' });
  box.innerHTML = sugg.slice(0, 10).map((s, i) => {
    const ic = { bookmark: 'star', history: 'globe', search: 'search', go: 'search', ai: 'sparkle' }[s.type];
    const label = s.type === 'go' ? (/\s/.test(s.title) || !/\./.test(s.title) ? `${esc(s.title)} <span class="muted">— Search with ${esc(SET.engines?.[SET.searchEngine]?.name || 'Seeker')}</span>` : esc(s.title))
      : s.type === 'ai' ? `${esc(s.title.replace(/^\?\s*/, ''))} <span class="muted">— Ask AI</span>` : esc(s.title);
    return `<div class="sg ${i === sel ? 'sel' : ''}" data-i="${i}">${icon(ic)}<span class="t">${label}</span>${s.url && s.type !== 'search' ? `<span class="u">— ${esc(s.url)}</span>` : ''}</div>`;
  }).join('');
  box.hidden = false;
  setOverlay(true);
}
$('#suggest').addEventListener('mousedown', (e) => {
  const row = e.target.closest('.sg');
  if (!row) return;
  e.preventDefault();
  go(sugg[+row.dataset.i], e.ctrlKey || e.button === 1);
});
function go(s, newTab) {
  const text = s ? (s.url || s.title) : url.value;
  closePopups();
  url.blur();
  if (!text.trim()) return;
  ui.cmd('navigate', text, newTab);
}
url.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if ($('#suggest').hidden) return;
    e.preventDefault();
    const n = Math.min(sugg.length, 10);
    sel = e.key === 'ArrowDown' ? (sel + 1) % n : (sel - 1 + n) % n;
    const s = sugg[sel];
    url.value = s.type === 'go' || s.type === 'ai' ? typed : (s.type === 'search' ? s.title : s.url);
    renderSuggest();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.altKey) return go(null, true);
    go(sel >= 0 ? sugg[sel] : null, false);
  } else if (e.key === 'Escape') {
    if (!$('#suggest').hidden) { closePopups(); url.value = typed; } else { url.value = displayUrl(S.active?.url); url.blur(); ui.cmd('activate', S.activeId); }
  }
});
url.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== url && !$('#suggest').hidden) closePopups(); url.value = displayUrl(S.active?.url); }, 150));
ui.on('focus-omnibox', () => { url.focus(); url.select(); });

// ---------------------------------------------------------- bookmarks bar
function renderBookmarks() {
  const bar = BOOKMARKS.filter((b) => b.folder !== 'other');
  $('#bmbar').innerHTML = bar.map((b) => {
    let fav = '';
    try { fav = `https://www.google.com/s2/favicons?sz=32&domain=${new URL(b.url).hostname}`; } catch { /* */ }
    return `<button class="bm" data-id="${b.id}" title="${esc(b.title)}\n${esc(b.url)}">${KIND === 'normal' && fav ? `<img src="${fav}">` : icon('globe')}<span>${esc(b.title)}</span></button>`;
  }).join('');
}
$('#bmbar').addEventListener('mouseup', (e) => {
  const b = e.target.closest('.bm'); if (!b) return;
  const bm = BOOKMARKS.find((x) => x.id === b.dataset.id); if (!bm) return;
  if (e.button === 0) ui.cmd('openBookmark', bm.url, e.ctrlKey);
  if (e.button === 1) ui.cmd('openBookmark', bm.url, true);
});
$('#bmbar').addEventListener('contextmenu', (e) => { const b = e.target.closest('.bm'); if (b) { e.preventDefault(); ui.cmd('bookmarkMenu', b.dataset.id); } });

// ---------------------------------------------------------- popover helper
let popoverCleanup = null;
function popover(html, anchor, { width = 340, onMount } = {}) {
  const p = $('#popover');
  p.innerHTML = html;
  p.style.width = width + 'px';
  const r = anchor ? anchor.getBoundingClientRect() : { right: innerWidth / 2 + width / 2, bottom: 90 };
  p.style.left = Math.max(8, Math.min(innerWidth - width - 8, r.right - width)) + 'px';
  p.style.top = (r.bottom + 6) + 'px';
  p.hidden = false;
  setOverlay(true);
  onMount?.(p);
}

function bookmarkPopup(id) {
  const a = S.active; if (!a && !id) return;
  const tab = S.tabs.find((t) => t.id === S.activeId);
  let bm = id ? BOOKMARKS.find((b) => b.id === id) : BOOKMARKS.find((b) => b.url === a.url);
  const fresh = !bm;
  if (fresh) { ui.cmd('setBookmark', { url: a.url, title: tab?.title || a.url, folder: 'bar' }); bm = { url: a.url, title: tab?.title || a.url, folder: 'bar' }; }
  popover(`
    <h3>${fresh ? 'Bookmark added' : 'Edit bookmark'}</h3>
    <label>Name <input type="text" id="bm-title" value="${esc(bm.title)}"></label>
    ${id ? `<label>Address <input type="text" id="bm-url" value="${esc(bm.url)}"></label>` : ''}
    <label>Folder <select id="bm-folder"><option value="bar">Bookmarks bar</option><option value="other">Other bookmarks</option></select></label>
    <div class="btns"><button class="pill warn" id="bm-remove">Remove</button><button class="pill primary" id="bm-done">Done</button></div>`,
  id ? null : $('#star'), {
    onMount: (p) => {
      p.querySelector('#bm-folder').value = bm.folder || 'bar';
      const t = p.querySelector('#bm-title'); t.focus(); t.select();
      const save = () => {
        const cur = BOOKMARKS.find((b) => (id ? b.id === id : b.url === bm.url));
        ui.cmd('setBookmark', { id: cur?.id, url: p.querySelector('#bm-url')?.value || bm.url, title: t.value || bm.url, folder: p.querySelector('#bm-folder').value });
        closePopups();
      };
      p.querySelector('#bm-done').onclick = save;
      p.querySelector('#bm-remove').onclick = () => { ui.cmd('removeBookmark', id || bm.url); closePopups(); };
      p.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') closePopups(); });
    },
  });
}
ui.on('bookmark-popup', () => bookmarkPopup());
ui.on('bookmark-edit', (id) => bookmarkPopup(id));

function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function mediaPopup() {
  const media = S.active?.media || [];
  popover(`<h3>Media on this page</h3>
    ${media.map((m, i) => {
      let name = ''; try { name = decodeURIComponent(new URL(m.url).pathname.split('/').pop()) || m.type; } catch { name = m.type; }
      return `<div class="media-row"><b>${esc(m.type)} ${m.size ? '· ' + fmtSize(m.size) : ''}</b><button class="pill primary" data-i="${i}">Download</button><span class="u" title="${esc(m.url)}">${esc(name)}</span></div>`;
    }).join('')}
    <p class="muted" style="font-size:12px;margin:10px 0 0">Protected (DRM) streams can't be saved. Please respect copyright and site terms.</p>`, $('#media-btn'), {
    width: 380,
    onMount: (p) => p.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => {
      const m = media[+b.dataset.i];
      const tab = S.tabs.find((t) => t.id === S.activeId);
      let fname;
      if (/mpegurl/.test(m.mime) || /\.m3u8/i.test(m.url)) fname = (tab?.title || 'video').replace(/[<>:"/\\|?*]/g, '_').slice(0, 100) + '.ts';
      ui.cmd('downloadUrl', m.url, fname);
      closePopups();
    })),
  });
}

function shieldPopup() {
  const a = S.active; const pv = a?.privacy;
  if (!pv || !pv.host) { ui.cmd('settings'); return; }
  const fpNames = { canvas: 'canvas drawing', webgl: 'graphics card', audio: 'audio', hardware: 'CPU & memory', screen: 'screen size', battery: 'battery' };
  const on = !pv.exception && pv.mode !== 'off';
  popover(`<h3 style="display:flex;align-items:center;gap:8px">${icon('shield')} ${esc(pv.site)}</h3>
    <label class="chk" style="color:var(--text);font-size:13.5px"><input type="checkbox" id="sh-on" ${on ? 'checked' : ''} ${pv.mode === 'off' ? 'disabled' : ''}> Privacy Shield ${on ? 'on' : 'off'} for this site</label>
    <div style="display:grid;grid-template-columns:1fr auto;gap:4px 12px;font-size:13px;margin:4px 0 12px">
      <span>Ads & trackers blocked</span><b>${a.blocked || 0}</b>
      <span>Cross-site cookies blocked</span><b>${pv.cookies || 0}</b>
      <span>Tracking removed from links</span><b>${pv.stripped || 0}</b>
      <span>Fingerprinting blocked</span><b>${pv.fp.length ? esc(pv.fp.map((x) => fpNames[x] || x).join(', ')) : 'none seen'}</b>
      <span>Connection</span><b>${KIND === 'tor' || pv.route === 'tor' ? 'via Tor' : pv.route === 'proxy' ? 'via your proxy' : 'direct (site sees your IP)'}</b>
    </div>
    <p class="muted" style="font-size:12px;margin:0 0 10px">${pv.mode === 'off' ? 'Privacy Shield is turned off in Settings.' : on ? 'This site sees a unique-to-this-site fingerprint and can\'t follow you to other sites.' : 'Turned off so sign-in and site features work normally here.'}</p>
    <div class="btns"><button class="pill" id="sh-set">Settings</button><button class="pill warn" id="sh-forget">Forget this site</button></div>`, $('#shield'), {
    width: 360,
    onMount: (p) => {
      p.querySelector('#sh-on').onchange = (e) => { ui.cmd('privacyException', pv.host, !e.target.checked); closePopups(); };
      p.querySelector('#sh-forget').onclick = () => { ui.cmd('forgetSite', pv.host); closePopups(); };
      p.querySelector('#sh-set').onclick = () => { ui.cmd('settings'); closePopups(); };
    },
  });
}

function tabSearch() {
  popover(`<input type="text" id="ts-q" placeholder="Search open tabs" style="width:100%"><div class="tabsearch-list" id="ts-list"></div>`, $('#tabsearch-btn'), {
    width: 400,
    onMount: (p) => {
      const q = p.querySelector('#ts-q'), list = p.querySelector('#ts-list');
      let items = [], idx = 0;
      const draw = () => {
        const v = q.value.toLowerCase();
        items = S.tabs.filter((t) => !v || t.title.toLowerCase().includes(v) || t.url.toLowerCase().includes(v));
        idx = Math.min(idx, Math.max(0, items.length - 1));
        list.innerHTML = items.map((t, i) => `<div class="ts-item ${i === idx ? 'sel' : ''}" data-id="${t.id}">${t.favicon ? `<img src="${esc(t.favicon)}">` : icon('globe')}<span>${esc(t.title)}</span></div>`).join('') || '<p class="muted">No matching tabs</p>';
      };
      draw(); q.focus();
      q.oninput = () => { idx = 0; draw(); };
      q.onkeydown = (e) => {
        if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); draw(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }
        if (e.key === 'Enter' && items[idx]) { ui.cmd('activate', items[idx].id); closePopups(); }
        if (e.key === 'Escape') closePopups();
      };
      list.onclick = (e) => { const it = e.target.closest('.ts-item'); if (it) { ui.cmd('activate', +it.dataset.id); closePopups(); } };
    },
  });
}
ui.on('tab-search', tabSearch);

// Permission & download prompts from main
ui.on('ask', (q) => {
  const answer = (v) => { ui.cmd('answer', q.reqId, v); closePopups(); };
  if (q.type === 'permission') {
    const what = { media: 'use your camera/microphone', video: 'use your camera', audio: 'use your microphone', 'audio & video': 'use your camera and microphone', 'video & audio': 'use your camera and microphone', geolocation: 'know your location', notifications: 'show notifications', midi: 'use MIDI devices', midiSysex: 'use MIDI devices', 'clipboard-read': 'see text and images you copy', openExternal: 'open an app on your computer', hid: 'use HID devices', serial: 'use serial ports', usb: 'use USB devices', 'idle-detection': 'know when you’re idle', 'display-capture': 'share your screen' }[q.permission] || q.permission;
    popover(`<h3>${esc(new URL(q.origin).host)} wants to</h3><p style="margin:0 0 12px">${esc(what)}</p>
      ${KIND === 'normal' ? '<label class="chk"><input type="checkbox" id="p-rem" checked> Remember for this site</label>' : ''}
      <div class="btns"><button class="pill" id="p-no">Block</button><button class="pill primary" id="p-yes">Allow</button></div>`, $('#site-icon'), {
      onMount: (p) => {
        const rem = () => !!p.querySelector('#p-rem')?.checked;
        p.querySelector('#p-yes').onclick = () => answer({ allow: true, remember: rem() });
        p.querySelector('#p-no').onclick = () => answer({ allow: false, remember: rem() });
        popoverCleanup = () => ui.cmd('answer', q.reqId, { allow: false, remember: false });
      },
    });
  } else if (q.type === 'download') {
    popover(`<h3>Download file</h3><label>Save as <input type="text" id="d-name" value="${esc(q.filename || '')}"></label>
      <p class="muted" style="font-size:12px;word-break:break-all;margin:0 0 10px">${esc(q.url)}</p>
      <div class="btns"><button class="pill" id="d-cancel">Cancel</button><button class="pill" id="d-later">Download later</button><button class="pill primary" id="d-now">Start download</button></div>`, $('#dl-btn'), {
      width: 400,
      onMount: (p) => {
        const name = () => p.querySelector('#d-name').value.trim();
        p.querySelector('#d-now').onclick = () => answer({ filename: name(), startMode: 'now' });
        p.querySelector('#d-later').onclick = () => answer({ filename: name(), startMode: 'paused' });
        p.querySelector('#d-cancel').onclick = () => answer(null);
        popoverCleanup = () => ui.cmd('answer', q.reqId, null);
      },
    });
  }
});

// ---------------------------------------------------------- info bars / toasts
function infobar({ text, kind = '', action, timeout = 6000, id, progress }) {
  let el = id && document.getElementById('ib-' + id);
  if (!el) {
    el = document.createElement('div');
    if (id) el.id = 'ib-' + id;
    $('#infobars').appendChild(el);
  }
  el.className = 'infobar ' + kind;
  el.innerHTML = `<span class="msg">${esc(text)}</span>${progress !== undefined ? `<span class="bar"><i style="width:${progress}%"></i></span>` : ''}${action ? `<button class="pill primary act">${esc(action.label)}</button>` : ''}<button class="ibtn small x">${icon('x')}</button>`;
  el.querySelector('.x').onclick = () => el.remove();
  if (action) el.querySelector('.act').onclick = () => { ui.cmd(action.cmd, action.arg); el.remove(); };
  clearTimeout(el._t);
  if (timeout) el._t = setTimeout(() => el.remove(), timeout);
  const all = $('#infobars').children;
  while (all.length > 3) all[0].remove();
  return el;
}
ui.on('toast', (t) => infobar(t));

// ---------------------------------------------------------- find in page
const findInput = $('#find-input');
let findTerm = '';
function showFind() { $('#findbar').hidden = false; findInput.focus(); findInput.select(); if (findInput.value) ui.cmd('findText', findInput.value, true, false); }
function hideFind() { $('#findbar').hidden = true; ui.cmd('stopFind'); $('#find-count').textContent = ''; ui.cmd('activate', S.activeId); }
function findStep(forward) { if (!findInput.value) return showFind(); ui.cmd('findText', findInput.value, forward, findInput.value === findTerm); findTerm = findInput.value; }
findInput.addEventListener('input', () => { findTerm = ''; if (findInput.value) findStep(true); else { ui.cmd('findText', ''); $('#find-count').textContent = ''; } });
findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') findStep(!e.shiftKey); if (e.key === 'Escape') hideFind(); });
$('#find-next').onclick = () => findStep(true);
$('#find-prev').onclick = () => findStep(false);
$('#find-close').onclick = hideFind;
ui.on('show-find', showFind);
ui.on('find-step', (fwd) => { if ($('#findbar').hidden) showFind(); else findStep(fwd); });
ui.on('find-result', (r) => { $('#find-count').textContent = r.total ? `${r.active}/${r.total}` : 'No results'; findInput.classList.toggle('none', !r.total); });
ui.on('find-reset', () => { if (!$('#findbar').hidden) { findTerm = ''; $('#find-count').textContent = ''; } });

// ---------------------------------------------------------- side panel
function toggleSide(which) {
  sidePanel = sidePanel === which ? null : which;
  $('#side').hidden = !sidePanel;
  $('#ai-panel').hidden = sidePanel !== 'ai';
  $('#dl-panel').hidden = sidePanel !== 'downloads';
  $('#ai-btn').classList.toggle('on', sidePanel === 'ai');
  reportLayout();
  if (sidePanel === 'ai') { initAI(); $('#ai-input').focus(); }
  if (sidePanel === 'downloads') renderDownloads();
}
ui.on('toggle-ai', () => toggleSide('ai'));

// ---------------------------------------------------------- downloads panel
let lastCompleted = new Set();
function renderDownloads() {
  const active = DOWNLOADS.filter((d) => ['downloading', 'connecting'].includes(d.status));
  const btn = $('#dl-btn');
  const total = active.reduce((a, d) => a + (d.size || 0), 0), got = active.reduce((a, d) => a + (d.received || 0), 0);
  btn.classList.toggle('active', active.length > 0);
  btn.style.setProperty('--off', String(100.5 - (total ? got / total : 0) * 100.5));
  const done = new Set(DOWNLOADS.filter((d) => d.status === 'completed').map((d) => d.id));
  for (const id of done) if (lastCompleted.size && !lastCompleted.has(id)) { btn.classList.remove('done'); void btn.offsetWidth; btn.classList.add('done'); }
  lastCompleted = done.size ? done : new Set(['_']);
  if (sidePanel !== 'downloads') return;
  $('#dl-list').innerHTML = DOWNLOADS.slice(0, 25).map((d) => {
    const pct = d.size ? Math.floor((d.received / d.size) * 100) : (d.hlsTotal ? Math.floor((d.hlsDone / d.hlsTotal) * 100) : 0);
    const st = {
      downloading: `${fmtSize(d.received)}${d.size ? ' of ' + fmtSize(d.size) : ''} · ${fmtSize(d.speed)}/s${d.eta ? ' · ' + fmtEta(d.eta) + ' left' : ''}`,
      connecting: 'Connecting…', queued: 'Queued', paused: `Paused · ${pct}%`, scheduled: 'Scheduled',
      completed: fmtSize(d.size) + ' · Done', error: d.error || 'Failed',
    }[d.status] || d.status;
    const acts = d.status === 'completed'
      ? `<button class="ibtn small" data-a="open" title="Open">${icon('file')}</button><button class="ibtn small" data-a="folder" title="Show in folder">${icon('folder')}</button>`
      : ['downloading', 'connecting', 'queued'].includes(d.status)
        ? `<button class="ibtn small" data-a="pause" title="Pause">${icon('pause')}</button>`
        : `<button class="ibtn small" data-a="resume" title="Resume">${icon('play')}</button>`;
    return `<div class="dl ${d.status}" data-id="${d.id}"><span class="ic">${icon(d.status === 'completed' ? 'file' : 'download')}</span>
      <span class="nm" title="${esc(d.filename)}">${esc(d.filename)}</span>
      <span class="acts">${acts}</span>
      ${d.status !== 'completed' ? `<span class="pb"><i style="width:${pct}%"></i></span>` : ''}
      <span class="st">${esc(st)}</span></div>`;
  }).join('') || '<p class="muted" style="padding:16px">No downloads yet. Links you download, and videos found on pages, will show here.</p>';
}
function fmtEta(s) { if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`; return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; }
$('#dl-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  ui.cmd('dl', b.dataset.a, b.closest('.dl').dataset.id);
});

// ---------------------------------------------------------- AI assistant
let aiReady = false, chat = [], running = null;
const SYSTEM = 'You are the AI assistant built into the Seeker web browser. Be accurate, clear and concise. Use Markdown (short paragraphs, bullet lists, tables when comparing). If the page content is provided, base your answer on it and say when something is not covered by the page.';
async function initAI() {
  if (aiReady) return;
  aiReady = true;
  const prov = await ui.ai('providers');
  const sel = $('#ai-provider');
  sel.innerHTML = Object.entries(prov).map(([k, p]) => `<option value="${k}">${esc(p.name)}${p.key === true && !p.hasKey ? ' (needs key)' : ''}</option>`).join('');
  sel.value = SET.ai?.provider || 'ollama';
  sel.onchange = async () => { await ui.ai('select', { provider: sel.value, model: '' }); loadModels(); };
  window._providers = prov;
  loadModels(true);
}
async function loadModels(keep) {
  const prov = $('#ai-provider').value;
  const p = window._providers?.[prov];
  $('#ai-help').textContent = p?.help || '';
  const ms = $('#ai-model');
  ms.innerHTML = '<option>Loading models…</option>';
  try {
    const list = await ui.ai('models', { provider: prov });
    const cur = keep ? SET.ai?.model : '';
    ms.innerHTML = list.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('') || '<option value="">No models found</option>';
    if (cur && !list.some((m) => m.id === cur)) ms.insertAdjacentHTML('afterbegin', `<option value="${esc(cur)}">${esc(cur)}</option>`);
    ms.value = cur || list[0]?.id || '';
    if (ms.value !== SET.ai?.model) ui.ai('select', { model: ms.value });
    if (!list.length && prov === 'ollama') $('#ai-help').textContent = 'No models yet. In a terminal run: ollama pull llama3.2:3b (fits 8 GB RAM).';
  } catch (e) {
    ms.innerHTML = '<option value="">—</option>';
    $('#ai-help').textContent = String(e.message || e).replace(/^Error invoking remote method 'ai': (Error: )?/, '');
    $('#ai-cfg').hidden = false;
  }
}
$('#ai-model').onchange = () => ui.ai('select', { model: $('#ai-model').value });
$('#ai-model-custom').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) { const v = e.target.value.trim(); $('#ai-model').insertAdjacentHTML('afterbegin', `<option value="${esc(v)}">${esc(v)}</option>`); $('#ai-model').value = v; ui.ai('select', { model: v }); e.target.value = ''; } };
$('#ai-refresh').onclick = () => loadModels(true);
$('#ai-cfg-btn').onclick = () => { $('#ai-cfg').hidden = !$('#ai-cfg').hidden; };
$('#ai-keys').onclick = () => ui.cmd('settings');
$('#ai-new').onclick = () => { if (running) ui.ai('stop', { id: running }); chat = []; $('#ai-msgs').innerHTML = ''; };

function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (m, lang, code) => { blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a data-href="$2">$1</a>');
  const lines = s.split('\n'); const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); out.push(`<h3>${m[1]}</h3>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${m[1]}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${m[1]}</li>`); }
    else if (/^\|.*\|\s*$/.test(line)) { close(); out.push(line); }
    else if (!line.trim()) { close(); out.push(''); }
    else { close(); out.push(`<p>${line}</p>`); }
  }
  close();
  let html = out.join('\n');
  html = html.replace(/((?:^\|.*\|\s*$\n?)+)/gm, (tbl) => {
    const rows = tbl.trim().split('\n').filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()));
    return '<table border="1" cellpadding="4" style="border-collapse:collapse">' + rows.map((r, i) => '<tr>' + r.trim().slice(1, -1).split('|').map((c) => (i ? `<td>${c.trim()}</td>` : `<th>${c.trim()}</th>`)).join('') + '</tr>').join('') + '</table>';
  });
  return html.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[+i]);
}
$('#ai-msgs').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]'); if (a) ui.cmd('newTab', a.dataset.href, true);
  const c = e.target.closest('[data-copy]'); if (c) { navigator.clipboard.writeText(chat[+c.dataset.copy]?.content || ''); c.textContent = 'Copied'; }
});

const PRESETS = {
  summarise: 'Summarise this page: start with a one-line TL;DR, then 5–8 bullet points with the most important information.',
  points: 'List the key facts, figures and takeaways from this page as concise bullet points.',
  simple: 'Explain what this page is about in simple language, as if to a 12-year-old. Use a short analogy.',
  selection: 'Explain the selected text in simple terms and give any useful background.',
  hindi: 'Translate the main content of this page into simple Hindi (Devanagari). Keep headings and structure.',
  punjabi: 'Translate the main content of this page into simple Punjabi (Gurmukhi). Keep headings and structure.',
  english: 'Translate the main content of this page into clear English. Keep headings and structure.',
};
$('#ai-chips').onclick = (e) => { const b = e.target.closest('[data-act]'); if (b) sendAI(PRESETS[b.dataset.act], { forcePage: true, selectionOnly: b.dataset.act === 'selection' }); };
$('#ai-form').onsubmit = (e) => { e.preventDefault(); const v = $('#ai-input').value.trim(); if (running) { ui.ai('stop', { id: running }); return; } if (v) { $('#ai-input').value = ''; sendAI(v); } };
$('#ai-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ai-form').requestSubmit(); } };
ui.on('open-ai', ({ prompt, action }) => {
  if (sidePanel !== 'ai') toggleSide('ai');
  if (action === 'summarise') sendAI(PRESETS.summarise, { forcePage: true });
  else if (prompt) sendAI(prompt, { forcePage: false });
});

async function sendAI(text, { forcePage = false, selectionOnly = false } = {}) {
  if (running) return;
  if (!SET.ai?.model) { $('#ai-cfg').hidden = false; await initAI(); }
  let system = SYSTEM;
  if (forcePage || $('#ai-usepage').checked) {
    const info = await ui.cmd('pageInfo');
    if (info && !String(info.url).startsWith('seeker://newtab')) {
      if (selectionOnly && !info.selection) { addMsg('assistant', 'Select some text on the page first, then click “Explain selection”.', true); return; }
      system += `\n\nThe user is viewing: "${info.title}" (${info.url}).`;
      if (info.selection) system += `\n\nText the user has selected:\n"""${info.selection}"""`;
      if (!selectionOnly && info.text) system += `\n\nPage content:\n"""${info.text}"""`;
    }
  }
  chat.push({ role: 'user', content: text });
  addMsg('user', text);
  const id = 'r' + Date.now();
  running = id;
  $('#ai-send').textContent = 'Stop';
  const el = addMsg('assistant', '', false, true);
  const off = ui.on('ai-delta', (rid, t) => { if (rid === id) { el.innerHTML = md(t); el.classList.add('typing'); scrollAI(); } });
  try {
    const full = await ui.ai('chat', { id, system, messages: chat.slice(-12) });
    chat.push({ role: 'assistant', content: full || '' });
    el.innerHTML = md(full || '_(no answer)_');
    el.insertAdjacentHTML('beforeend', `<div class="msg-tools"><button data-copy="${chat.length - 1}">Copy</button></div>`);
  } catch (e) {
    chat.pop();
    el.classList.add('err');
    el.textContent = String(e.message || e).replace(/^Error invoking remote method 'ai': (Error: )?/, '');
  } finally {
    el.classList.remove('typing');
    off(); running = null; $('#ai-send').textContent = 'Send'; scrollAI();
  }
}
function addMsg(role, text, isErr, pending) {
  $('.ai-empty')?.remove();
  const el = document.createElement('div');
  el.className = role === 'user' ? 'msg-u' : 'msg-a' + (isErr ? ' err' : '') + (pending ? ' typing' : '');
  if (role === 'user') el.textContent = text; else el.innerHTML = md(text);
  $('#ai-msgs').appendChild(el);
  scrollAI();
  return el;
}
function scrollAI() { const m = $('#ai-msgs'); m.scrollTop = m.scrollHeight; }

// ---------------------------------------------------------- Tor window controls
if (KIND === 'tor') {
  $('#tor-tools').hidden = false;
  $('#tor-identity').onclick = () => ui.cmd('torNewIdentity');
  let safest = false;
  $('#tor-safest').onclick = () => ui.cmd('torSafest', !safest);
  ui.on('tor', (t) => {
    safest = !!t.safest;
    $('#tor-safest').textContent = safest ? 'Safest (JS off)' : 'Standard';
    $('#tor-safest').title = safest ? 'Safest: JavaScript is off. Click to allow JavaScript.' : 'Standard: click to turn JavaScript off for more safety';
    if (t.status === 'starting') infobar({ id: 'tor', text: `Connecting to the Tor network… ${t.message || ''}`, progress: t.progress, timeout: 0 });
    else if (t.status === 'error') infobar({ id: 'tor', kind: 'error', text: t.message, action: { label: 'Retry', cmd: 'torRetry' }, timeout: 0 });
    else if (t.status === 'ready') { document.getElementById('ib-tor')?.remove(); if (!window._torShown) { window._torShown = true; infobar({ text: `Connected via ${t.source}. Traffic in this window goes through Tor; nothing is saved when you close it.`, timeout: 8000 }); } }
  });
}

// broken favicons → globe icon (inline onerror is blocked by our CSP)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG') img.replaceWith(document.createRange().createContextualFragment(icon('globe')));
}, true);

// keyboard inside the UI
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlayOn) closePopups();
});
reportLayout();
