/* Přidání videa / kanálu vložením (copy-paste) odkazu + sdílení z jiných aplikací.
   Video  → Watch later.  Kanál (@handle, /channel/UC…, /c/…, /user/…) → vybrané složky.
   Spoléhá na globály z feed.js: $, h, S, PT, saveDb, render, refreshAll. */
(() => {
  const dlg = $('#addDlg'), inp = $('#addUrl'), out = $('#addBody');
  const APP = !!(window.PTFull && PTFull.openUrl);

  const CH_RE = /^\/(@[^/?#]+|channel\/UC[\w-]{22}|c\/[^/?#]+|user\/[^/?#]+)/;
  const ID_RES = [
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
    /"channelId":"(UC[\w-]{22})"/,
    /itemprop="(?:channelId|identifier)" content="(UC[\w-]{22})"/,
    /channel_id=(UC[\w-]{22})/
  ];
  const unesc = s => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; };
  const meta = (html, p) => { const m = html.match(new RegExp('<meta property="' + p + '" content="([^"]*)"')); return m ? unesc(m[1]) : ''; };

  /* ---------- rozpoznání odkazu ---------- */
  function parse(text) {
    const t = (text || '').trim();
    if (!t) return null;
    if (/^@[\w.\-]+$/.test(t)) return { kind: 'channel', path: '/' + t };
    const m = t.match(/https?:\/\/[^\s<>"']+/);
    let u;
    try { u = new URL(m ? m[0] : t); } catch (e) {
      try { u = new URL('https://' + t); } catch (e2) { return null; }
    }
    const vid = PT.videoIdFromUrl(u.href);
    if (vid) return { kind: 'video', id: vid };
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      const c = u.pathname.match(CH_RE);
      if (c) return { kind: 'channel', path: '/' + c[1] };
    }
    return null;
  }

  /* ---------- zjištění informací ---------- */
  async function videoInfo(id) {
    let title = id, channel = '', authorUrl = '';
    try {
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id));
      if (r.ok) { const j = await r.json(); title = j.title || id; channel = j.author_name || ''; authorUrl = j.author_url || ''; }
    } catch (e) { /* použije se ID */ }
    return { id, title, channel, authorUrl };
  }

  async function channelInfo(path) {
    const r = await fetch('https://www.youtube.com' + path);
    if (!r.ok) throw new Error('YouTube vrátil chybu ' + r.status);
    const html = await r.text();
    let id = (path.match(/^\/channel\/(UC[\w-]{22})/) || [])[1];
    if (!id) for (const re of ID_RES) { const m = html.match(re); if (m) { id = m[1]; break; } }
    if (!id) throw new Error('nepodařilo se zjistit ID kanálu');
    const img = meta(html, 'og:image');
    return { id, name: meta(html, 'og:title') || path.slice(1), avatar: img.startsWith('https://') ? img.replace(/=s\d+/, '=s96') : '' };
  }

  /* ---------- zobrazení ---------- */
  let token = 0;
  const say = (text, cls) => out.replaceChildren(h('p', { className: cls || '', textContent: text }));
  const HINT = 'Vlož odkaz na video (uloží se do Watch later) nebo na kanál (přidá se do složky). Funguje i sdílení z YouTube: Sdílet → MyTube Feed.';

  async function analyze() {
    const my = ++token;
    if (!inp.value.trim()) return say(HINT);
    const p = parse(inp.value);
    if (!p) return say('Tohle nevypadá jako odkaz na video ani kanál YouTube.', 'err');
    say('Zjišťuji…');
    try {
      if (p.kind === 'video') { const v = await videoInfo(p.id); if (my === token) showVideo(v); }
      else { const c = await channelInfo(p.path); if (my === token) showChannel(c); }
    } catch (e) { if (my === token) say('Nepodařilo se načíst informace: ' + (e.message || e), 'err'); }
  }

  function showVideo(v) {
    const has = () => S.wl.some(x => x.id === v.id);
    const save = h('button', { className: 'primary' });
    const paint = () => { save.textContent = has() ? '✓ Už je ve Watch later' : '＋ Uložit do Watch later'; save.disabled = has(); };
    save.onclick = async () => {
      if (has()) return;
      S.wl.unshift({ id: v.id, title: v.title, channel: v.channel, added: new Date().toISOString() });
      await chrome.storage.local.set({ wl: S.wl });
      render();
      paint();
    };
    paint();
    const row = h('div', { className: 'row' }, save);
    if (v.authorUrl) row.append(h('button', { textContent: 'Přidat i kanál do složky…', onclick: () => { inp.value = v.authorUrl; analyze(); } }));
    out.replaceChildren(
      h('div', { className: 'addcard' },
        h('img', { src: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, alt: '' }),
        h('div', {}, h('div', { className: 'title', textContent: v.title }), h('div', { className: 'sub', textContent: v.channel }))),
      row);
  }

  function showChannel(c) {
    const folders = Object.keys(S.db.folders);
    const chosen = new Set(folders.filter(f => S.db.folders[f].includes(c.id)));
    const status = h('div', {});
    const nf = h('input', { type: 'text', placeholder: 'Nová složka (volitelně)' });
    const list = h('div', { className: 'flist' }, ...folders.map(f => h('label', {},
      h('input', { type: 'checkbox', checked: chosen.has(f), onchange: e => { if (e.target.checked) chosen.add(f); else chosen.delete(f); } }),
      ' ' + f)));
    const save = h('button', { className: 'primary', textContent: 'Uložit', onclick: async () => {
      const nn = nf.value.trim();
      if (!chosen.size && !nn) { status.className = 'err'; status.textContent = 'Vyber aspoň jednu složku nebo napiš novou.'; return; }
      S.db.folders = S.db.folders || {};
      S.db.channels = S.db.channels || {};
      const old = S.db.channels[c.id] || {};
      S.db.channels[c.id] = { ...old, name: c.name || old.name, avatar: c.avatar || old.avatar };
      if (nn && !S.db.folders[nn]) S.db.folders[nn] = [];
      if (nn) chosen.add(nn);
      for (const f of Object.keys(S.db.folders)) {
        const arr = S.db.folders[f], has = arr.includes(c.id), want = chosen.has(f);
        if (want && !has) S.db.folders[f] = [...arr, c.id];
        if (!want && has) {
          S.db.folders[f] = arr.filter(k => k !== c.id);
          if (S.db.filters?.[f]) { delete S.db.filters[f][c.id]; if (!Object.keys(S.db.filters[f]).length) delete S.db.filters[f]; }
        }
      }
      await saveDb();
      render();
      refreshAll(false);
      status.className = 'ok';
      status.textContent = '✓ Kanál „' + c.name + '“ je ve složkách: ' + [...chosen].join(', ');
    } });
    out.replaceChildren(
      h('div', { className: 'addcard' },
        c.avatar ? h('img', { src: c.avatar, className: 'av2', alt: '' }) : h('span', {}),
        h('div', {}, h('div', { className: 'title', textContent: c.name }),
          h('div', { className: 'sub', textContent: chosen.size ? 'Už je ve složkách: ' + [...chosen].join(', ') : 'Zatím v žádné složce' }))),
      list, nf, h('div', { className: 'row' }, save), status);
  }

  /* ---------- otevření dialogu ---------- */
  async function clip() {
    try {
      if (APP && PTFull.clipboard) return PTFull.clipboard();
      if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText();
    } catch (e) { /* schránka nedostupná */ }
    return '';
  }

  async function openAdd(text) {
    inp.value = text || '';
    if (!dlg.open) dlg.showModal();
    if (!text) { const c = await clip(); if (c && parse(c)) inp.value = c.trim(); }
    analyze();
  }

  $('#addLink').onclick = () => openAdd('');
  $('#addClose').onclick = () => dlg.close();
  $('#addPaste').onclick = async () => {
    const c = await clip();
    if (c && c.trim()) { inp.value = c.trim(); analyze(); } else say('Schránka je prázdná.', 'err');
  };
  let t;
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(analyze, 350); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); analyze(); } });

  /* ---------- sdílení z jiných aplikací (Android) ---------- */
  const checkShare = () => { try { const s = window.PTFull && PTFull.takeShare && PTFull.takeShare(); if (s) openAdd(s); } catch (e) { /* nic */ } };
  window.addEventListener('message', e => { if (e.data === 'pt-open') checkShare(); });
  setTimeout(checkShare, 600);

  /* ---------- Android aplikace: odkazy ven do zvoleného prohlížeče ---------- */
  if (APP) {
    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href^="http"]');
      if (!a) return;
      e.preventDefault();            // ostatní obsluhy kliku (označení jako otevřené) proběhnou dál
      PTFull.openUrl(a.href);
    }, true);
    const b = $('#browserBtn');
    if (b) { b.hidden = false; b.onclick = () => PTFull.chooseBrowser(); }
  }

  window.PTAdd = { parse };
})();
