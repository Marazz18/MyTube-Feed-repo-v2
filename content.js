(() => {
  const get = async (k, def) => (await chrome.storage.local.get(k))[k] ?? def;
  const set = (k, v) => chrome.storage.local.set({ [k]: v });
  const emptyDb = () => ({ folders: {}, channels: {} });

  /* ---------- pomocné: kanál na stránce videa ---------- */
  const ID_RES = [
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
    /channel_id=(UC[\w-]{22})/
  ];
  const idCache = {};
  const ownerEl = () => document.querySelector('ytd-watch-metadata #owner') || document.querySelector('#owner');
  const ownerLink = () => ownerEl()?.querySelector('a[href^="/@"], a[href^="/channel/"]');
  const curVideoId = () => new URLSearchParams(location.search).get('v');
  const ownerName = () => ownerEl()?.querySelector('ytd-channel-name a')?.textContent.trim() || '';

  async function resolveId(path) {
    const m = path.match(/^\/channel\/(UC[\w-]{22})/);
    if (m) return m[1];
    if (idCache[path]) return idCache[path];
    const html = await (await fetch('https://www.youtube.com' + path, { credentials: 'same-origin' })).text();
    for (const re of ID_RES) {
      const r = html.match(re);
      if (r) return (idCache[path] = r[1]);
    }
    return null;
  }

  /* ---------- nabídka složek (＋) ---------- */
  function closeMenu() { document.querySelector('.pt-menu')?.remove(); }

  async function patchChannel(id, name, avatar) {
    const db = await get('db', emptyDb());
    db.folders = db.folders || {};
    db.channels = db.channels || {};
    const old = db.channels[id] || {};
    db.channels[id] = { ...old, name, avatar: avatar || old.avatar };
    return db;
  }

  async function openMenu(btn, id, name, avatar) {
    closeMenu();
    const db0 = await get('db', emptyDb());
    const folders = db0.folders || {};
    const m = document.createElement('div');
    m.className = 'pt-menu';
    const t = document.createElement('div');
    t.className = 'pt-title';
    t.textContent = name;
    m.append(t);
    Object.keys(folders).forEach(g => {
      const l = document.createElement('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = folders[g].includes(id);
      c.onchange = async () => {
        const db = await patchChannel(id, name, avatar);
        const arr = db.folders[g] || [];
        db.folders[g] = c.checked ? [...new Set([...arr, id])] : arr.filter(k => k !== id);
        await set('db', db);
      };
      l.append(c, ' ' + g);
      m.append(l);
    });
    const n = document.createElement('button');
    n.textContent = '+ Nová složka';
    n.onclick = async () => {
      const f = prompt('Název složky:');
      if (!f) return;
      const db = await patchChannel(id, name, avatar);
      db.folders[f] = [...new Set([...(db.folders[f] || []), id])];
      await set('db', db);
      closeMenu();
    };
    m.append(n);
    const r = btn.getBoundingClientRect();
    m.style.top = Math.min(r.bottom + 4, innerHeight - 220) + 'px';
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - 230)) + 'px';
    document.documentElement.append(m);
  }

  const normImg = u => (u ? (u.startsWith('//') ? 'https:' + u : u) : '');
  const httpsImg = u => { const x = normImg(u); return x.startsWith('https://') ? x : ''; };
  const CH_PATH = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/;
  const CH_LINK = 'a[href^="/@"], a[href^="/channel/"]';

  // zjistí kanál podle toho, odkud bylo ＋ kliknuto
  function collect(btn) {
    const ctx = btn.dataset.ctx;
    if (ctx === 'watch') {
      const link = ownerLink();
      if (!link) return null;
      const path = new URL(link.href).pathname;
      return { path, name: ownerName() || path.slice(1), avatar: httpsImg(ownerEl()?.querySelector('img')?.src) };
    }
    if (ctx === 'channel') {
      const m = location.pathname.match(CH_PATH);
      if (!m) return null;
      const head = btn.closest('yt-page-header-renderer, ytd-c4-tabbed-header-renderer') || document;
      const name = head.querySelector('h1')?.textContent.trim()
        || document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
      const img = head.querySelector('yt-decorated-avatar-view-model img, #avatar img');
      return { path: '/' + m[1], name, avatar: httpsImg(img?.src) };
    }
    const root = btn.closest('ytd-channel-renderer, ytd-video-renderer');
    if (!root) return null;
    const link = root.querySelector('ytd-channel-name ' + CH_LINK.replace(', ', ', ytd-channel-name ')) || root.querySelector(CH_LINK);
    if (!link) return null;
    const path = new URL(link.href).pathname;
    const name = root.querySelector('ytd-channel-name a, ytd-channel-name #text')?.textContent.trim()
      || link.textContent.trim() || path.slice(1);
    const img = root.querySelector('#avatar img, #channel-info img, #channel-thumbnail img, yt-img-shadow img');
    return { path, name, avatar: httpsImg(img?.src) };
  }

  async function onAdd(btn) {
    const c = collect(btn);
    if (!c) { alert('Kanál se nepodařilo najít.'); return; }
    const old = btn.textContent;
    btn.textContent = '…';
    let id = null;
    try { id = await resolveId(c.path); } catch (e) { /* ignore */ }
    btn.textContent = old;
    if (!id) { alert('Nepodařilo se zjistit ID kanálu.'); return; }
    openMenu(btn, id, c.name, c.avatar);
  }

  /* ---------- watch later ---------- */
  async function toggleWl() {
    const id = curVideoId();
    if (!id) return;
    const wl = await get('wl', []);
    const i = wl.findIndex(v => v.id === id);
    if (i >= 0) wl.splice(i, 1);
    else {
      const title = document.querySelector('ytd-watch-metadata h1')?.textContent.trim()
        || document.title.replace(/ - YouTube$/, '');
      wl.unshift({ id, title, channel: ownerName(), added: new Date().toISOString() });
    }
    await set('wl', wl);
    paintWl();
  }

  async function paintWl() {
    const b = document.querySelector('.pt-wl');
    if (!b) return;
    const has = (await get('wl', [])).some(v => v.id === curVideoId());
    b.textContent = has ? '✓ Uloženo' : 'Později';
    b.classList.toggle('on', has);
  }

  function ensureWatchButtons() {
    if (location.pathname !== '/watch') return;
    const owner = ownerEl();
    if (!owner) return;
    let add = owner.querySelector('.pt-add');
    if (!add) {
      add = document.createElement('button');
      add.className = 'pt-add';
      add.textContent = '＋';
      add.title = 'Přidat kanál do složky';
      add.dataset.ctx = 'watch';
      const anchor = owner.querySelector('#subscribe-button');
      if (anchor) anchor.insertAdjacentElement('afterend', add); else owner.append(add);
    }
    if (!owner.querySelector('.pt-wl')) {
      const wl = document.createElement('button');
      wl.className = 'pt-wl';
      wl.title = 'Uložit toto video do Watch later';
      add.insertAdjacentElement('afterend', wl);
    }
    paintWl();
  }

  /* ---------- ＋ na profilu kanálu a ve vyhledávání ---------- */
  const SUB_SEL = '#subscribe-button, yt-subscribe-button-view-model, ytd-subscribe-button-renderer';

  function findSubscribe(root) {
    const el = root.querySelector(SUB_SEL);
    if (el) return el;
    const b = [...root.querySelectorAll('button')]
      .find(x => /^(odebírat|odebíráno|subscribe|subscribed)/i.test(x.textContent.trim()));
    return b ? (b.closest(SUB_SEL) || b) : null;
  }

  function placeAdd(root, anchor, ctx, small) {
    if (!root || !anchor || root.querySelector('.pt-add')) return;
    const b = document.createElement('button');
    b.className = 'pt-add' + (small ? ' pt-sm' : '');
    b.textContent = '＋';
    b.title = 'Přidat kanál do složky';
    b.dataset.ctx = ctx;
    b.style.position = 'relative';
    anchor.insertAdjacentElement('afterend', b);
    const p = b.parentElement;
    if (p && !/flex|grid/.test(getComputedStyle(p).display)) p.classList.add('pt-host');
    requestAnimationFrame(() => alignAdd(b));
  }

  // ＋ se výškou i středem srovná s tlačítkem vedle sebe (Odebírat / název kanálu)
  function alignAdd(b) {
    const anchor = b.previousElementSibling;
    if (!anchor) return;
    const ref = anchor.tagName === 'BUTTON' ? anchor : (anchor.querySelector('button') || anchor);
    const a = ref.getBoundingClientRect();
    if (!a.height) return;
    if (!b.classList.contains('pt-sm')) {
      const h = Math.round(a.height);
      if (h >= 28 && h <= 48 && b.style.height !== h + 'px') { b.style.height = h + 'px'; b.style.width = h + 'px'; }
    }
    const r = b.getBoundingClientRect();
    const dy = (a.top + a.height / 2) - (r.top + r.height / 2);
    if (Math.abs(dy) > 0.5) b.style.top = ((parseFloat(b.style.top) || 0) + dy) + 'px';
  }

  function ensureListButtons() {
    document.querySelectorAll('.pt-add:not([data-ctx="watch"])').forEach(alignAdd);
    if (CH_PATH.test(location.pathname)) {
      const scope = document.querySelector('ytd-browse[page-subtype="channels"]') || document;
      const head = scope.querySelector('yt-page-header-renderer, ytd-c4-tabbed-header-renderer, #channel-header');
      if (head) placeAdd(head, findSubscribe(head), 'channel', false);
    } else if (location.pathname === '/results') {
      document.querySelectorAll('ytd-channel-renderer').forEach(r => placeAdd(r, findSubscribe(r), 'search-channel', false));
      document.querySelectorAll('ytd-video-renderer').forEach(r =>
        placeAdd(r, r.querySelector('#channel-info ytd-channel-name') || r.querySelector('ytd-channel-name'), 'search-video', true));
    }
  }

  /* ---------- tlačítko u loga + panel ---------- */
  let panel;
  const extOrigin = chrome.runtime.getURL('').slice(0, -1);

  function icon() {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '24');
    s.setAttribute('height', '24');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M4 6h16v2H4V6zm0 5h10v2H4v-2zm0 5h16v2H4v-2zm13-5l5 3-5 3v-6z');
    p.setAttribute('fill', 'currentColor');
    s.append(p);
    return s;
  }

  function ensureTop() {
    if (document.querySelector('.pt-top')) return;
    const logo = document.querySelector('ytd-masthead ytd-topbar-logo-renderer')
      || document.querySelector('ytd-masthead #logo')
      || document.querySelector('#masthead #logo');
    const start = document.querySelector('ytd-masthead #start') || document.querySelector('#masthead #start');
    const b = document.createElement('button');
    b.className = 'pt-top';
    b.title = 'Můj feed';
    b.append(icon());
    if (logo) logo.insertAdjacentElement('afterend', b);
    else if (start) start.append(b);
    else if (document.querySelector('ytd-masthead, #masthead-container, #masthead')) {
      b.classList.add('pt-fixed');
      document.documentElement.append(b);
    } else return;
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.className = 'pt-panel';
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('feed.html?embed=1');
    panel.append(f);
    document.documentElement.append(panel);
    return panel;
  }

  function togglePanel() {
    const p = ensurePanel();
    const show = !p.classList.contains('open');
    p.classList.toggle('open', show);
    if (!show) return;
    const r = document.querySelector('.pt-top').getBoundingClientRect();
    p.style.top = r.bottom + 6 + 'px';
    p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8)) + 'px';
    p.firstChild.contentWindow?.postMessage('pt-open', extOrigin);
  }
  const closePanel = () => panel?.classList.remove('open');

  /* ---------- sledování zhlédnutí ---------- */
  let acc = 0, lastT = null, lastId = null, dur = 0, saveTimer = null;

  async function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!acc || !lastId) return;
    const add = acc, id = lastId, d = dur;
    acc = 0;
    const w = await get('watched', {});
    const r = w[id] || { t: 0, d: 0 };
    r.t = (r.t || 0) + add;
    r.d = d || r.d;
    r.ts = Date.now();
    w[id] = r;
    const keys = Object.keys(w);
    if (keys.length > 3000) {
      keys.sort((a, b) => (w[a].ts || 0) - (w[b].ts || 0)).slice(0, keys.length - 2500).forEach(k => delete w[k]);
    }
    await set('watched', w);
  }

  document.addEventListener('timeupdate', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || location.pathname !== '/watch') return;
    if (document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting')) { lastT = null; return; }
    const id = curVideoId();
    if (!id) return;
    if (id !== lastId) { if (acc > 0) flush(); lastId = id; lastT = null; }
    const t = v.currentTime;
    if (lastT !== null) { const d = t - lastT; if (d > 0 && d < 2) acc += d; }
    lastT = t;
    dur = v.duration || 0;
    if (!saveTimer) saveTimer = setTimeout(flush, 5000);
  }, true);
  document.addEventListener('pause', () => flush(), true);
  window.addEventListener('pagehide', () => flush());

  /* ---------- doplnění avatarů u již uložených kanálů ---------- */
  async function backfillAvatars() {
    const db = await get('db', emptyDb());
    const ids = [...new Set(Object.values(db.folders || {}).flat())]
      .filter(id => db.channels?.[id]?.avatar === undefined).slice(0, 5);
    for (const id of ids) {
      let avatar = '';
      try {
        const html = await (await fetch(`/channel/${id}`, { credentials: 'same-origin' })).text();
        const m = html.match(/<meta property="og:image" content="([^"]+)"/);
        if (m) avatar = m[1].replace(/=s\d+/, '=s96');
      } catch (e) { /* nic */ }
      const fresh = await get('db', emptyDb());
      fresh.channels = fresh.channels || {};
      fresh.channels[id] = { ...(fresh.channels[id] || {}), avatar };
      await set('db', fresh);
    }
  }

  /* ---------- události ---------- */
  document.addEventListener('click', e => {
    const t = e.target;
    const add = t.closest?.('.pt-add');
    const wl = t.closest?.('.pt-wl');
    const top = t.closest?.('.pt-top');
    if (add || wl || top) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (add) onAdd(add);
      else if (wl) toggleWl();
      else togglePanel();
      return;
    }
    if (!t.closest?.('.pt-menu')) closeMenu();
    if (!t.closest?.('.pt-panel')) closePanel();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); closePanel(); } });

  chrome.storage.onChanged.addListener(ch => {
    if (ch.wl) paintWl();
  });

  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { ensureTop(); ensureWatchButtons(); ensureListButtons(); }, 300); };
  document.addEventListener('yt-navigate-finish', () => { schedule(); closeMenu(); });
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  console.info('[MyTube] rozšíření načteno');
  ensureTop();
  ensureWatchButtons();
  ensureListButtons();
  setInterval(() => { ensureTop(); ensureListButtons(); }, 1500);
  setTimeout(backfillAvatars, 4000);
})();
