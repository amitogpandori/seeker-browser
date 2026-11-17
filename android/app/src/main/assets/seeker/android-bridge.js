// window.seeker for the Android app: the same API the desktop app's main process offers the
// Seeker page (search.fetch, newtab.get/set, history.top, localindex.search). Messages go to the
// native side through a WebMessageListener that only this page's origin can see.
(function () {
  'use strict';
  const native = window.SeekerNative;
  if (!native) return; // old WebView: sources.js falls back to fetch()
  let seq = 0;
  const pending = new Map();
  native.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  };
  window.seeker = {
    call: (name, ...args) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      native.postMessage(JSON.stringify({ id, name, args }));
    }),
    on: () => {},
  };
})();
