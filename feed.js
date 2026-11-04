const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

const EMBED = new URLSearchParams(location.search).has('embed');
document.body.classList.add(EMBED ? 'embed' : 'tab');

const WL = '__wl', ALL = '__all';
const TTL = 15 * 60 * 1000;
const rtf = new Intl.RelativeTimeFormat('cs', { numeric: 'auto' });
const DEF = { db: () => ({ folders: {}, channels: {} }), watched: () => ({}), wl: () => [], settings: () => ({ open: [] }) };

let S = { db: DEF.db(), cache: {}, watched: {}, wl: [], settings: { open: [] } };
const pending = new Set();
const chFilter = {};
const managing = new Set();

/* složky v „Můj feed“: výchozí stav po každém otevření feedu (false = sbalené, true = rozbalené).
   Ruční sbalení/rozbalení platí jen do dalšího otevření feedu. */
const START_OPEN = false;
const flipped = new Set();
const isOpen = n => START_OPEN !== flipped.has(n);
function setOpen(n, v) {
  if (isOpen(n) !== v) { if (flipped.has(n)) flipped.delete(n); else flipped.add(n); }
}

/* tagy: filtry jsou jen v paměti (Watch later a Subscribe list mají každý svůj) */
const wlTagSel = new Set(), subTagSel = new Set();
const normTag = t => t.trim().toLowerCase().replace(/\s+/g, ' ');
const countTags = lists => {
  const m = new Map();
  lists.forEach(l => (l || []).forEach(t => m.set(t, (m.get(t) || 0) + 1)));
  return m;
};
function askTags(known) {
  const r = prompt('Přidat tagy (více oddělených čárkou):' + (known.length ? '\nExistující: ' + known.join(', ') : ''));
  return r ? [...new Set(r.split(',').map(normTag).filter(Boolean))] : [];
}
const isSeenItem = i => (i.wl ? !!i.opened : PT.isSeen(S.watched, i.id));

const saveDb = () => chrome.storage.local.set({ db: S.db });
const saveSettings = () => chrome.storage.local.set({ settings: S.settings });
const saveCache = () => chrome.storage.local.set({ cache: S.cache });

function ago(iso) {
  const s = (new Date(iso) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
  return 'právě teď';
}

/* ---------- pokročilé filtry kanálů ve složce ----------
   S.db.filters = { složka: { channelId: ['text', …] } }
   Kanál s pravidly zobrazí v dané složce jen videa, jejichž název obsahuje aspoň jeden text
   (bez ohledu na velikost písmen a diakritiku). Kanály bez pravidel se chovají jako dřív. */
const normTxt = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const rulesOf = (folder, id) => S.db.filters?.[folder]?.[id] || [];
function passesIn(folder, id, item) {
  const r = rulesOf(folder, id);
  if (!r.length) return true;
  const t = normTxt(item.title);
  return r.some(x => t.includes(normTxt(x)));
}
// v „Subscribed“/záložce Vše: video projde, pokud ho pustí aspoň jedna složka, ve které kanál je
function passes(folder, id, item) {
  if (folder !== ALL) return passesIn(folder, id, item);
  const fs = Object.keys(S.db.folders).filter(k => S.db.folders[k].includes(id));
  return !fs.length || fs.some(f => passesIn(f, id, item));
}

async function addRule(folder, id) {
  const v = prompt(`Zobrazit z kanálu „${S.db.channels[id]?.name || id}“ jen videa, jejichž název obsahuje:\n(více pravidel = stačí splnit jedno)`);
  const t = (v || '').trim();
  if (!t) return;
  S.db.filters = S.db.filters || {};
  const f = S.db.filters[folder] = S.db.filters[folder] || {};
  f[id] = [...new Set([...(f[id] || []), t])];
  await saveDb();
  render();
}

async function removeRule(folder, id, t) {
  const f = S.db.filters?.[folder];
  if (!f) return;
  f[id] = (f[id] || []).filter(x => x !== t);
  if (!f[id].length) delete f[id];
  if (!Object.keys(f).length) delete S.db.filters[folder];
  await saveDb();
  render();
}

/* ---------- data ---------- */
const idsOf = name => name === ALL
  ? [...new Set(Object.values(S.db.folders).flat())]
  : (S.db.folders[name] || []);

function mergeCache(n) {
  for (const id in n) if (!S.cache[id] || n[id].t >= S.cache[id].t) S.cache[id] = n[id];
}

async function fetchChannel(id, force) {
  const c = S.cache[id];
  if (pending.has(id) || (c && !force && Date.now() - c.t < TTL)) return false;
  pending.add(id);
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { credentials: 'omit', cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const items = [...xml.getElementsByTagName('entry')].map(e => ({
      id: e.getElementsByTagName('yt:videoId')[0]?.textContent,
      title: e.getElementsByTagName('title')[0]?.textContent,
      published: e.getElementsByTagName('published')[0]?.textContent,
      channel: e.getElementsByTagName('name')[0]?.textContent,
      short: /\/shorts\//.test(e.getElementsByTagName('link')[0]?.getAttribute('href') || '')
        || /#shorts?\b/i.test(e.getElementsByTagName('title')[0]?.textContent || ''),
      cid: id
    })).filter(i => i.id);
    S.cache[id] = { t: Date.now(), items };
  } catch (err) {
    S.cache[id] = { t: c?.t || 0, items: c?.items || [], error: String(err) };
  } finally {
    pending.delete(id);
  }
  return true;
}

let raf, dragging = null, pendingRender = false, filterOpen = false;
const scheduleRender = () => {
  if (dragging) { pendingRender = true; return; }
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(render);
};

async function refreshAll(force) {
  const ids = idsOf(ALL);
  let i = 0, fetched = false;
  const worker = async () => {
    while (i < ids.length) {
      if (await fetchChannel(ids[i++], force)) { fetched = true; scheduleRender(); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (fetched) await saveCache();
}

/* ---------- výpočty ---------- */
function newCounts(ids, folderName) {
  const out = {};
  ids.forEach(id => { out[id] = (S.cache[id]?.items || []).filter(i => PT.isNew(i, S.watched) && !(S.settings.hideShorts && i.short) && passes(folderName, id, i)).length; });
  return out;
}

function itemsOf(name) {
  if (name === WL) return S.wl.map(v => ({ id: v.id, title: v.title, channel: v.channel || '', published: v.added, wl: true, opened: v.opened, tags: v.tags || [] }));
  let ids = idsOf(name);
  if (chFilter[name]) ids = ids.filter(id => id === chFilter[name]);
  let items = ids.flatMap(id => (S.cache[id]?.items || []).filter(i => passes(name, id, i)));
  if (S.settings.hideShorts) items = items.filter(i => !i.short);
  return items.sort((a, b) => new Date(b.published) - new Date(a.published));
}

/* ---------- akce ---------- */
async function toggleSeen(id, isWl) {
  if (isWl) {
    // Watch later: „zhlédnuté“ = z feedu jsem na video klikl
    const v = S.wl.find(x => x.id === id);
    if (!v) return;
    if (v.opened) delete v.opened; else v.opened = Date.now();
    await chrome.storage.local.set({ wl: S.wl });
    render();
    return;
  }
  const w = (await chrome.storage.local.get('watched')).watched || {};
  if (PT.isSeen(w, id)) delete w[id];
  else w[id] = { t: PT.SEEN_SECONDS, d: 0, ts: Date.now(), manual: true };
  S.watched = w;
  await chrome.storage.local.set({ watched: w });
  render();
}

async function markOpened(id) {
  const v = S.wl.find(x => x.id === id);
  if (!v || v.opened) return;
  v.opened = Date.now();
  await chrome.storage.local.set({ wl: S.wl });
  scheduleRender();
}

async function addWlTags(id) {
  const v = S.wl.find(x => x.id === id);
  if (!v) return;
  const add = askTags([...countTags(S.wl.map(x => x.tags)).keys()]);
  if (!add.length) return;
  v.tags = [...new Set([...(v.tags || []), ...add])];
  await chrome.storage.local.set({ wl: S.wl });
  render();
}

async function removeWlTag(id, t) {
  const v = S.wl.find(x => x.id === id);
  if (!v) return;
  v.tags = (v.tags || []).filter(x => x !== t);
  await chrome.storage.local.set({ wl: S.wl });
  render();
}

async function addChTags(id) {
  const add = askTags([...countTags(Object.values(S.db.channels).map(c => c.tags)).keys()]);
  if (!add.length) return;
  const c = S.db.channels[id] = S.db.channels[id] || {};
  c.tags = [...new Set([...(c.tags || []), ...add])];
  await saveDb();
  render();
}

async function removeChTag(id, t) {
  const c = S.db.channels[id];
  if (!c) return;
  c.tags = (c.tags || []).filter(x => x !== t);
  await saveDb();
  render();
}

async function removeWl(id) {
  S.wl = S.wl.filter(v => v.id !== id);
  await chrome.storage.local.set({ wl: S.wl });
  render();
}

async function removeChannel(name, id) {
  const targets = name === ALL ? Object.keys(S.db.folders) : [name];
  targets.forEach(k => {
    S.db.folders[k] = (S.db.folders[k] || []).filter(x => x !== id);
    if (S.db.filters?.[k]) { delete S.db.filters[k][id]; if (!Object.keys(S.db.filters[k]).length) delete S.db.filters[k]; }
  });
  await saveDb();
  render();
}

function toggleOpen(name) {
  setOpen(name, !isOpen(name));
  render();
}

/* ---------- pořadí, záložky, filtr ---------- */
const titleOf = n => (n === WL ? 'Watch later' : n === ALL ? '★ Subscribed' : n);
const TABS = ['my', 'all', 'subs', 'wl'];
const tab = () => (TABS.includes(S.settings.tab) ? S.settings.tab : 'my');
const myOff = () => S.settings.myOff ?? [];

function orderedNames() {
  const all = Object.keys(S.db.folders);
  const order = (S.settings.order || []).filter(n => all.includes(n));
  return [...order, ...all.filter(n => !order.includes(n))];
}
const visibleNames = () => orderedNames().filter(n => !myOff().includes(n));

function reorder(from, to, after) {
  const list = orderedNames().filter(n => n !== from);
  list.splice(list.indexOf(to) + (after ? 1 : 0), 0, from);
  S.settings.order = list;
  saveSettings();
  render();
}

function renderChrome() {
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab()));
  $('#filterBtn').hidden = tab() !== 'my';
  const f = $('#filter');
  f.hidden = tab() !== 'my' || !filterOpen;
  f.replaceChildren();
  if (f.hidden) return;
  const off = myOff();
  orderedNames().forEach(n => {
    const cb = h('input', { type: 'checkbox', checked: !off.includes(n), onchange: e => {
      const o = new Set(myOff());
      if (e.target.checked) o.delete(n); else o.add(n);
      S.settings.myOff = [...o];
      saveSettings();
      render();
    } });
    f.append(h('label', { className: 'chip' }, cb, ' ' + titleOf(n)));
  });
}

/* ---------- vykreslení ---------- */
function avatar(id, count, name) {
  const c = S.db.channels[id] || {};
  const el = h('div', {
    className: 'av' + (count ? '' : ' dim') + (chFilter[name] === id ? ' sel' : '') + (rulesOf(name, id).length ? ' filt' : ''),
    title: `${c.name || id}${count ? ` · ${count} nových` : ''}${rulesOf(name, id).length ? ` · filtr: ${rulesOf(name, id).join(' | ')}` : ''}`,
    onclick: () => {
      chFilter[name] = chFilter[name] === id ? null : id;
      setOpen(name, true);
      render();
    }
  });
  el.append(c.avatar
    ? h('img', { src: c.avatar, alt: '', referrerPolicy: 'no-referrer' })
    : h('span', { textContent: (c.name || '?')[0].toUpperCase() }));
  if (count) el.append(h('b', { textContent: count > 9 ? '9+' : String(count) }));
  return el;
}

/* řádek s tagy: klik na tag = filtr, ✕ = odebrat tag, „+ tag“ = přidat */
function tagRow(tags, sel, onAdd, onRemove) {
  const stop = fn => e => { e.preventDefault(); e.stopPropagation(); fn(); };
  const row = h('div', { className: 'tagrow' });
  tags.forEach(t => row.append(h('span', {
    className: 'ctag' + (sel.has(t) ? ' on' : ''), title: 'Filtrovat podle tagu',
    onclick: stop(() => { if (sel.has(t)) sel.delete(t); else sel.add(t); render(); })
  }, t, h('span', { className: 'x', textContent: '✕', title: 'Odebrat tag', onclick: stop(() => onRemove(t)) }))));
  row.append(h('button', { className: 'addtag', textContent: '+ tag', title: 'Přidat tag', onclick: stop(onAdd) }));
  return row;
}

function tagBar(all, sel) {
  [...sel].forEach(t => { if (!all.has(t)) sel.delete(t); });
  if (!all.size) return null;
  const bar = h('div', { className: 'tagbar' });
  [...all.entries()].sort((a, b) => a[0].localeCompare(b[0], 'cs')).forEach(([t, n]) => bar.append(h('span', {
    className: 'chip' + (sel.has(t) ? ' on' : ''), textContent: `${t} (${n})`,
    onclick: () => { if (sel.has(t)) sel.delete(t); else sel.add(t); render(); }
  })));
  if (sel.size) bar.append(h('button', { textContent: '✕ zrušit filtr', onclick: () => { sel.clear(); render(); } }));
  return bar;
}

function card(i, grid) {
  const seen = isSeenItem(i);
  const seenTitle = i.wl
    ? (seen ? 'Označit jako neotevřené' : 'Označit jako otevřené')
    : (seen ? 'Označit jako nezhlédnuté' : 'Označit jako zhlédnuté');
  const thumb = h('div', { className: 'thumb' },
    h('img', { src: `https://i.ytimg.com/vi/${i.id}/mqdefault.jpg`, loading: 'lazy', alt: '' }),
    h('button', { className: 'seenbtn', textContent: seen ? '↺' : '✓', title: seenTitle,
      onclick: e => { e.preventDefault(); e.stopPropagation(); toggleSeen(i.id, i.wl); } }));
  if (i.wl) thumb.append(h('button', { className: 'rmbtn', textContent: '✕', title: 'Odebrat z Watch later',
    onclick: e => { e.preventDefault(); e.stopPropagation(); removeWl(i.id); } }));
  const body = h('div', {},
    h('div', { className: 'title', textContent: i.title }),
    h('div', { className: 'sub', textContent: `${i.channel ? i.channel + ' · ' : ''}${i.wl ? 'přidáno ' : ''}${ago(i.published)}` }));
  if (i.wl) body.append(tagRow(i.tags, wlTagSel, () => addWlTags(i.id), t => removeWlTag(i.id, t)));
  const onOpen = () => { if (i.wl) markOpened(i.id); };
  return h('a', {
    className: 'card' + (grid ? ' gcard' : '') + (seen ? ' seen' : ''),
    href: `https://www.youtube.com/watch?v=${i.id}`,
    target: EMBED ? '_top' : '_blank',
    rel: 'noopener noreferrer',
    onclick: onOpen,
    onauxclick: e => { if (e.button === 1) onOpen(); }
  }, thumb, body);
}

function folder(name) {
  const open = isOpen(name);
  const title = titleOf(name);
  const ids = name === WL ? [] : idsOf(name);
  const counts = newCounts(ids, name);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const btn = (t, tt, fn) => h('button', { textContent: t, title: tt, onclick: e => { e.stopPropagation(); fn(); } });

  const head = h('div', { className: 'fhead', onclick: () => toggleOpen(name) },
    h('span', { className: 'chev', textContent: open ? '▾' : '▸' }),
    h('h2', { textContent: title }),
    h('span', { className: 'info', textContent: name === WL ? String(S.wl.length) : `${ids.length} kanálů` }),
    total ? h('span', { className: 'new', textContent: `${total} nových` }) : '',
    h('span', { className: 'sp' }));
  if (name !== WL) head.append(btn('⚙', 'Spravovat kanály', () => { managing.has(name) ? managing.delete(name) : managing.add(name); setOpen(name, true); render(); }));
  if (name !== WL && name !== ALL) {
    head.append(
      btn('✎', 'Přejmenovat', async () => {
        const n = prompt('Nový název:', name);
        if (!n || n === name || S.db.folders[n]) return;
        S.db.folders = Object.fromEntries(Object.entries(S.db.folders).map(([k, v]) => [k === name ? n : k, v]));
        if (flipped.has(name)) { flipped.delete(name); flipped.add(n); }
        S.settings.order = (S.settings.order || []).map(x => (x === name ? n : x));
        if (S.db.filters?.[name]) S.db.filters = Object.fromEntries(Object.entries(S.db.filters).map(([k, v]) => [k === name ? n : k, v]));
        if (S.settings.myOff) S.settings.myOff = S.settings.myOff.map(x => (x === name ? n : x));
        await saveDb(); saveSettings(); render();
      }),
      btn('🗑', 'Smazat složku', async () => {
        if (!confirm(`Smazat složku „${name}“?`)) return;
        delete S.db.folders[name];
        if (S.db.filters) delete S.db.filters[name];
        flipped.delete(name);
        await saveDb(); saveSettings(); render();
      }));
  }

  const el = h('section', { className: 'folder' + (open ? ' open' : '') }, head);

  const grip = h('span', { className: 'grip', textContent: '⠿', title: 'Přetáhni pro změnu pořadí' });
  head.prepend(grip);
  head.draggable = true;
  head.addEventListener('dragstart', e => {
    dragging = name;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', name);
    e.dataTransfer.setDragImage(el, 20, 20);
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  head.addEventListener('dragend', () => {
    dragging = null;
    document.querySelectorAll('.dragging, .drop-before, .drop-after').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-after'));
    if (pendingRender) { pendingRender = false; render(); }
  });
  const isAfter = e => {
    const r = el.getBoundingClientRect();
    return EMBED ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
  };
  el.addEventListener('dragover', e => {
    if (!dragging || dragging === name) return;
    e.preventDefault();
    const after = isAfter(e);
    el.classList.toggle('drop-before', !after);
    el.classList.toggle('drop-after', after);
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('drop', e => {
    if (!dragging || dragging === name) return;
    e.preventDefault();
    const from = dragging, after = isAfter(e);
    dragging = null;
    pendingRender = false;
    reorder(from, name, after);
  });

  if (name !== WL) {
    const shown = open ? ids : ids.filter(id => counts[id] > 0);
    if (shown.length) el.append(h('div', { className: 'dash' }, ...shown.map(id => avatar(id, counts[id], name))));
  }

  if (open && managing.has(name)) {
    const m = h('div', { className: 'manage' });
    if (!ids.length) m.append(h('div', { className: 'none', textContent: 'Složka je prázdná.' }));
    ids.forEach(id => {
      const rules = rulesOf(name, id);
      m.append(h('div', { className: 'mrow' },
        h('span', { textContent: S.db.channels[id]?.name || id }),
        h('span', { className: 'mact' },
          name === ALL ? '' : h('button', { className: rules.length ? 'on' : '', textContent: '⚗ Filtr', title: 'Pokročilý filtr: z tohoto kanálu v této složce jen videa s určitým textem v názvu', onclick: () => addRule(name, id) }),
          h('button', { textContent: '✕', title: name === ALL ? 'Odebrat ze všech složek' : 'Odebrat ze složky', onclick: () => removeChannel(name, id) }))));
      if (rules.length) m.append(h('div', { className: 'tagrow rules' }, ...rules.map(t => h('span', { className: 'ctag', title: 'Odebrat pravidlo' },
        'název obsahuje: ' + t, h('span', { className: 'x', textContent: '✕', onclick: () => removeRule(name, id, t) })))));
    });
    el.append(m);
  }

  if (open) {
    let items = itemsOf(name);
    if (S.settings.hideSeen) items = items.filter(i => !PT.isSeen(S.watched, i.id));
    items = items.slice(0, name === WL ? 100 : 50);
    const list = h('div', { className: 'list' });
    list.dataset.f = name;
    if (!items.length) {
      list.append(h('div', { className: 'none', textContent: name === WL
        ? 'Zatím nic. Klikni na „Později“ pod videem nebo na odkaz pravým tlačítkem.'
        : (S.settings.hideSeen ? 'Žádná nezhlédnutá videa.' : 'Zatím žádná videa.') }));
    } else items.forEach(i => list.append(card(i)));
    el.append(list);
  }
  return el;
}

/* ---------- záložky: Vše / Subscribe list / Watch later ---------- */
let allLimit = 60;
const foldersOf = id => Object.keys(S.db.folders).filter(k => S.db.folders[k].includes(id));
const empty = text => h('p', { className: 'empty', textContent: text });

function renderAllTab(main) {
  const ids = idsOf(ALL);
  if (!ids.length) { main.append(empty('Zatím nemáš žádné uložené kanály. Otevři video na YouTube a klikni na ＋ vedle názvu kanálu.')); return; }
  let items = itemsOf(ALL);
  if (S.settings.hideSeen) items = items.filter(i => !PT.isSeen(S.watched, i.id));
  main.append(h('div', { className: 'vhead', textContent: `Videa ze všech složek (${items.length})` }));
  if (!items.length) {
    main.append(h('div', { className: 'none', textContent: S.settings.hideSeen ? 'Žádná nezhlédnutá videa.' : 'Zatím žádná videa.' }));
    return;
  }
  main.append(h('div', { className: 'vgrid' }, ...items.slice(0, allLimit).map(i => card(i, true))));
  if (items.length > allLimit) {
    main.append(h('button', { className: 'more', textContent: `Zobrazit další (${items.length - allLimit})`,
      onclick: () => { allLimit += 60; render(); } }));
  }
}

function renderSubsTab(main) {
  const nameOfCh = id => S.db.channels[id]?.name || id;
  const allIds = idsOf(ALL).sort((a, b) => nameOfCh(a).localeCompare(nameOfCh(b), 'cs'));
  if (!allIds.length) {
    main.append(h('div', { className: 'vhead', textContent: 'Uložené kanály (0)' }));
    main.append(empty('Zatím nemáš žádné uložené kanály. Otevři video na YouTube a klikni na ＋ vedle názvu kanálu.'));
    return;
  }
  const bar = tagBar(countTags(allIds.map(id => S.db.channels[id]?.tags)), subTagSel);
  const ids = subTagSel.size
    ? allIds.filter(id => [...subTagSel].every(t => (S.db.channels[id]?.tags || []).includes(t)))
    : allIds;
  main.append(h('div', { className: 'vhead', textContent: `Uložené kanály (${ids.length}${ids.length !== allIds.length ? ' z ' + allIds.length : ''})` }));
  if (bar) main.append(bar);
  const list = h('div', { className: 'sublist' });
  ids.forEach(id => {
    const c = S.db.channels[id] || {};
    const name = nameOfCh(id);
    const av = h('div', { className: 'av' }, c.avatar
      ? h('img', { src: c.avatar, alt: '', referrerPolicy: 'no-referrer' })
      : h('span', { textContent: name[0].toUpperCase() }));
    const link = h('a', { className: 'subname', textContent: name, href: `https://www.youtube.com/channel/${id}`,
      target: EMBED ? '_top' : '_blank', rel: 'noopener noreferrer' });
    const tags = h('div', { className: 'subtags' }, ...foldersOf(id).map(f => h('span', { className: 'subtag', textContent: f })));
    tags.append(...(c.tags || []).map(t => h('span', {
      className: 'ctag' + (subTagSel.has(t) ? ' on' : ''), title: 'Filtrovat podle tagu',
      onclick: () => { if (subTagSel.has(t)) subTagSel.delete(t); else subTagSel.add(t); render(); }
    }, t, h('span', { className: 'x', textContent: '✕', title: 'Odebrat tag',
      onclick: e => { e.stopPropagation(); removeChTag(id, t); } }))));
    tags.append(h('button', { className: 'addtag', textContent: '+ tag', title: 'Přidat tag kanálu', onclick: () => addChTags(id) }));
    const rm = h('button', { textContent: '✕', title: 'Odebrat ze všech složek',
      onclick: async () => { if (confirm(`Odebrat „${name}“ ze všech složek?`)) await removeChannel(ALL, id); } });
    list.append(h('div', { className: 'subrow' }, av, link, tags, rm));
  });
  main.append(list);
}

function renderWlTab(main) {
  const all = itemsOf(WL);
  if (!all.length) {
    main.append(h('div', { className: 'vhead', textContent: 'Watch later (0)' }));
    main.append(h('div', { className: 'none', textContent: 'Zatím nic. Klikni na „Později“ pod videem nebo na odkaz pravým tlačítkem.' }));
    return;
  }
  const bar = tagBar(countTags(all.map(i => i.tags)), wlTagSel);
  let items = all;
  if (wlTagSel.size) items = items.filter(i => [...wlTagSel].every(t => i.tags.includes(t)));
  if (S.settings.hideSeen) items = items.filter(i => !isSeenItem(i));
  main.append(h('div', { className: 'vhead', textContent: `Watch later (${items.length}${items.length !== all.length ? ' z ' + all.length : ''})` }));
  if (bar) main.append(bar);
  if (!items.length) {
    main.append(h('div', { className: 'none', textContent: 'Žádné video neodpovídá filtru.' }));
    return;
  }
  main.append(h('div', { className: 'vgrid' }, ...items.map(i => card(i, true))));
}

function render() {
  const main = $('#cols');
  const sl = main.scrollLeft, st = main.scrollTop;
  const tops = {};
  main.querySelectorAll('.list').forEach(l => { tops[l.dataset.f] = l.scrollTop; });
  main.replaceChildren();
  $('#hideSeen').checked = !!S.settings.hideSeen;
  $('#hideShorts').checked = !!S.settings.hideShorts;
  renderChrome();
  const t = tab();
  document.body.dataset.view = t;
  if (t === 'all') renderAllTab(main);
  else if (t === 'subs') renderSubsTab(main);
  else if (t === 'wl') renderWlTab(main);
  else {
    const names = visibleNames();
    names.forEach(n => main.append(folder(n)));
    if (!names.length) {
      main.append(h('p', { className: 'empty', textContent: Object.keys(S.db.folders).length
        ? 'V záložce „Můj feed“ nejsou vybrané žádné složky. Vyber je tlačítkem „Složky ▾“ nahoře.'
        : 'Zatím nemáš žádné složky. Otevři video na YouTube a klikni na ＋ vedle názvu kanálu, nebo vytvoř složku tlačítkem nahoře.' }));
    }
  }
  main.scrollLeft = sl;
  main.scrollTop = st;
  main.querySelectorAll('.list').forEach(l => { l.scrollTop = tops[l.dataset.f] || 0; });
}

/* ---------- ovládání ---------- */
document.querySelectorAll('.tabs [data-tab]').forEach(b => {
  b.onclick = () => { S.settings.tab = b.dataset.tab; saveSettings(); render(); };
});
$('#filterBtn').onclick = () => { filterOpen = !filterOpen; render(); };
$('#refresh').onclick = () => refreshAll(true);
$('#hideSeen').onchange = e => { S.settings.hideSeen = e.target.checked; saveSettings(); render(); };
$('#hideShorts').onchange = e => {
  S.settings.hideShorts = e.target.checked;
  saveSettings();
  render();
  // starší záznamy v cache ještě nemají příznak shorts – jednorázově je načti znovu
  if (e.target.checked && idsOf(ALL).some(id => (S.cache[id]?.items || []).some(i => i.short === undefined))) refreshAll(true);
};
$('#popout').onclick = () => window.open('feed.html', '_blank');

/* ozubené kolečko: vyjížděcí menu (obnovit, celá stránka, sync, export, import) */
const menu = $('#menu'), menuBtn = $('#menuBtn');
const setMenu = open => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
menuBtn.onclick = e => { e.stopPropagation(); setMenu(menu.hidden); };
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
menu.addEventListener('click', () => setTimeout(() => setMenu(false), 0));
$('#newFolder').onclick = async () => {
  const n = prompt('Název složky:');
  if (n && !S.db.folders[n]) { S.db.folders[n] = []; await saveDb(); render(); }
};
$('#export').onclick = () => {
  const json = JSON.stringify({ db: S.db, wl: S.wl, watched: S.watched }, null, 2);
  if (window.PTFull && PTFull.saveFile) { PTFull.saveFile('mytube-zaloha.json', json); return; }   // Android aplikace
  const blob = new Blob([json], { type: 'application/json' });
  h('a', { href: URL.createObjectURL(blob), download: 'mytube-zaloha.json' }).click();
};
$('#import').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const n = JSON.parse(await f.text());
    const d = n.db || n;
    for (const [k, v] of Object.entries(d.folders || {})) S.db.folders[k] = [...new Set([...(S.db.folders[k] || []), ...v])];
    Object.assign(S.db.channels, d.channels || {});
    const ids = new Set(S.wl.map(v => v.id));
    (n.wl || []).forEach(v => { if (!ids.has(v.id)) S.wl.push(v); });
    Object.assign(S.watched, n.watched || {});
    await chrome.storage.local.set({ db: S.db, wl: S.wl, watched: S.watched });
    render(); refreshAll(false);
  } catch (err) { alert('Neplatný soubor.'); }
  e.target.value = '';
};

chrome.storage.onChanged.addListener(ch => {
  let refresh = false;
  for (const k of ['db', 'watched', 'wl', 'settings']) {
    if (ch[k]) { S[k] = ch[k].newValue ?? DEF[k](); if (k === 'db') refresh = true; }
  }
  S.settings.open = S.settings.open || [];
  if (ch.cache) mergeCache(ch.cache.newValue || {});
  scheduleRender();
  if (refresh) refreshAll(false);
});

const syncSoft = () => chrome.runtime.sendMessage({ type: 'sync-now', soft: true }).catch(() => {});
window.addEventListener('message', e => { if (e.data === 'pt-open') { flipped.clear(); render(); refreshAll(false); syncSoft(); } });

(async () => {
  S = await PT.getAll();
  const upd = await chrome.storage.local.get(['updateAvailable', 'updateVersion']);
  if (upd.updateAvailable) {
    const ub = $('#updateBanner');
    if (ub) { 
      ub.href = upd.updateAvailable; 
      if (upd.updateVersion) ub.title = 'Nová verze ' + upd.updateVersion + ' – stáhne MyTubeFeed-Update.bat';
      ub.hidden = false; 
    }
  }

  render();
  refreshAll(false);
  syncSoft();
  setInterval(() => refreshAll(false), TTL);
})();

/* ---------- synchronizace přes Nostr (UI) ---------- */
const SYNC = { dlg: $('#syncDlg'), body: $('#syncBody'), msg: '', msgErr: false, reveal: '' };
const sendSync = msg => chrome.runtime.sendMessage(msg).then(r => { if (r?.error) throw new Error(r.error); return r; });
const fmtTs = ts => (ts ? new Date(ts).toLocaleString('cs') : 'nikdy');

async function syncPaint() {
  let st;
  try { st = await sendSync({ type: 'sync-status' }); } catch (e) { st = { enabled: false, relays: [] }; }
  { $('#syncBtn').classList.toggle('on', !!st.enabled); $('#menuBtn').classList.toggle('on', !!st.enabled); }
  const b = SYNC.body;
  b.replaceChildren();
  const say = (t, cls) => b.append(h('p', { textContent: t, className: cls || '' }));
  if (SYNC.msg) say(SYNC.msg, SYNC.msgErr ? 'err' : 'ok');

  const relayBox = h('textarea', { value: (st.relays || []).join('\n'), spellcheck: false });
  const relayRow = () => { b.append(h('label', { textContent: 'Relaye (jeden na řádek, wss://…)' }), relayBox); };
  const relaysVal = () => relayBox.value.split(/\s+/).filter(Boolean);
  const run = (label, fn) => async () => {
    SYNC.msg = label; SYNC.msgErr = false; syncPaint();
    try { await fn(); SYNC.msg = ''; } catch (e) { SYNC.msg = e.message; SYNC.msgErr = true; }
    syncPaint();
  };

  if (!st.enabled) {
    say('Data (složky, kanály, Watch later, zhlédnutá videa) se zašifrují (NIP-44) a uloží jako události na Nostr relayích. Na dalším zařízení stačí zadat stejný klíč.');
    b.append(h('div', { className: 'row' },
      h('button', { textContent: 'Vytvořit nový sync klíč', onclick: run('Zakládám…', () => sendSync({ type: 'sync-setup', generate: true, relays: relaysVal() })) })));
    const inp = h('input', { type: 'password', placeholder: 'nsec1… (klíč z jiného zařízení)', autocomplete: 'off', spellcheck: false });
    b.append(h('label', { textContent: 'Nebo zadej existující klíč' }), inp);
    b.append(h('div', { className: 'row' },
      h('button', { textContent: 'Použít tento klíč', onclick: run('Připojuji…', () => sendSync({ type: 'sync-setup', nsec: inp.value, relays: relaysVal() })) })));
    relayRow();
    b.append(h('div', { className: 'warn', textContent: 'Doporučení: nepoužívej svůj hlavní nostr klíč, vytvoř dedikovaný. Klíč je uložený v úložišti rozšíření.' }));
    return;
  }

  b.append(h('label', { textContent: 'Veřejný klíč (npub)' }), h('code', { textContent: st.npub }));
  const last = st.last;
  const ls = h('p', { className: last?.error ? 'err' : '', style: 'margin-top:10px' });
  ls.textContent = last
    ? (last.error ? 'Chyba: ' + last.error : 'Poslední synchronizace: ' + fmtTs(last.ts))
    : 'Zatím nesynchronizováno.';
  b.append(ls);
  (last?.relays || []).forEach(r => b.append(h('div', { className: 'rl ' + (r.ok ? 'ok' : 'err'), textContent: (r.ok ? '● ' : '○ ') + r.url + (r.error ? ' – ' + r.error : '') })));

  b.append(h('div', { className: 'row' },
    h('button', { textContent: '↻ Synchronizovat teď', onclick: run('Synchronizuji…', () => sendSync({ type: 'sync-now' })) })));

  relayRow();
  b.append(h('div', { className: 'row' },
    h('button', { textContent: 'Uložit relaye a synchronizovat', onclick: run('Ukládám…', () => sendSync({ type: 'sync-setup', relays: relaysVal() })) })));

  b.append(h('label', { textContent: 'Přidání dalšího zařízení' }));
  if (SYNC.reveal) {
    b.append(h('input', { type: 'text', value: SYNC.reveal, readOnly: true, onfocus: e => e.target.select() }));
    b.append(h('div', { className: 'warn', textContent: 'Kdo má tento klíč, přečte všechna tvoje synchronizovaná data. Nikomu ho neposílej.' }));
  }
  b.append(h('div', { className: 'row' },
    h('button', { textContent: SYNC.reveal ? 'Skrýt klíč' : 'Zobrazit sync klíč (nsec)', onclick: async () => {
      if (SYNC.reveal) SYNC.reveal = '';
      else { try { SYNC.reveal = (await sendSync({ type: 'sync-reveal' })).nsec || ''; } catch (e) { /* */ } }
      syncPaint();
    } }),
    h('button', { textContent: 'Vypnout synchronizaci', onclick: async () => {
      if (!confirm('Vypnout synchronizaci na tomto zařízení? Místní data zůstanou, data na relayích se nemažou.')) return;
      SYNC.reveal = '';
      await run('Vypínám…', () => sendSync({ type: 'sync-disable' }))();
    } })));
}

$('#syncBtn').onclick = () => { SYNC.msg = ''; SYNC.reveal = ''; syncPaint(); SYNC.dlg.showModal(); };
$('#syncClose').onclick = () => { SYNC.reveal = ''; SYNC.dlg.close(); };
SYNC.dlg.addEventListener('close', () => { SYNC.reveal = ''; });
chrome.storage.onChanged.addListener(ch => { if (ch.syncStatus && SYNC.dlg.open) syncPaint(); });
sendSync({ type: 'sync-status' }).then(st => { $('#syncBtn').classList.toggle('on', !!st.enabled); $('#menuBtn').classList.toggle('on', !!st.enabled); }).catch(() => {});
