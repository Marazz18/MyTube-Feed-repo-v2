/* MyTube – synchronizace přes Nostr
 *
 * Co se synchronizuje: složky + kanály (db), Watch later (wl), zhlédnutá videa (watched),
 * pořadí složek a výběr složek v „Můj feed“ (settings.order / settings.myOff).
 * Nesynchronizuje se: cache feedu, záložky/přepínače (hideSeen…) – ty zůstávají na zařízení.
 *
 * Jak: 3 adresovatelné události kind 30078 (NIP-78), d = mytube:core | mytube:wl | mytube:watched.
 * Obsah = gzip+base64 JSON, zašifrovaný NIP-44 sám sobě (klíč sync identity).
 * Slučování: 3-way merge proti poslednímu synchronizovanému stavu (syncBase), takže funguje
 * i mazání (složka, kanál ve složce, video z Watch later) bez pomocných „náhrobků“.
 */
var PTSync = (() => {
  const KIND = 30078;
  const D = { core: 'mytube:core', wl: 'mytube:wl', watched: 'mytube:watched' };
  const NAMES = ['core', 'wl', 'watched'];
  const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
  const MAX_PACKED = 36000;     // max. délka zabaleného obsahu (znaků) – ať se vejde do limitů relayů
  const MAX_WATCHED = 2500;     // max. počet zhlédnutých videí v jedné události
  const seenSec = () => (typeof PT !== 'undefined' ? PT.SEEN_SECONDS : 5);

  /* ================= slučování (čisté funkce) ================= */
  const stable = v => JSON.stringify(v, (k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {})
      : x);
  const eq = (a, b) => stable(a) === stable(b);
  const str = x => stable(x) ?? '';

  // 3-way sjednocení množin: přidání na kterékoli straně se zachová, smazání na kterékoli straně vyhrává
  function mergeSet(b = [], l = [], r = []) {
    const B = new Set(b), L = new Set(l), R = new Set(r), out = [], done = new Set();
    for (const x of [...l, ...r]) {
      if (done.has(x)) continue;
      done.add(x);
      if (L.has(x) && R.has(x)) out.push(x);
      else if (!B.has(x)) out.push(x);
    }
    return out;
  }

  // 3-way výběr hodnoty; při skutečném konfliktu deterministický výsledek (stejný na obou zařízeních)
  function field(b, l, r, res) {
    if (eq(l, r)) return l;
    if (eq(l, b)) return r;
    if (eq(r, b)) return l;
    if (l === undefined) return r;
    if (r === undefined) return l;
    if (res) return res(l, r);
    return str(l) >= str(r) ? l : r;
  }

  function mergeRecord(b = {}, l = {}, r = {}, sets = [], maxes = []) {
    const out = {};
    for (const f of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const v = sets.includes(f)
        ? mergeSet(b[f], l[f], r[f])
        : field(b[f], l[f], r[f], maxes.includes(f) ? (x, y) => Math.max(x, y) : null);
      if (v !== undefined) out[f] = v;
    }
    return out;
  }

  function mergeMap(b = {}, l = {}, r = {}, item) {
    const out = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const inL = k in l, inR = k in r;
      if (inL && inR) out[k] = item(b[k], l[k], r[k]);
      else if (k in b) continue;            // smazáno na jedné straně
      else out[k] = inL ? l[k] : r[k];      // nově přidáno
    }
    return out;
  }

  function mergeWatched(b = {}, l = {}, r = {}, trunc = false) {
    let minTs = Infinity;
    for (const x of Object.values(r)) minTs = Math.min(minTs, x.ts || 0);
    const out = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const inL = k in l, inR = k in r;
      if (inL && inR) {
        const x = l[k], y = r[k];
        const o = { t: Math.max(x.t || 0, y.t || 0), d: Math.max(x.d || 0, y.d || 0), ts: Math.max(x.ts || 0, y.ts || 0) };
        if (x.manual || y.manual) o.manual = 1;
        out[k] = o;
      } else if (inL) {
        // na vzdálené straně chybí: smazáno, nebo jen oříznuto kvůli velikosti (pak je starší než nejstarší vzdálené)
        if (k in b && !(trunc && (l[k].ts || 0) < minTs)) continue;
        out[k] = l[k];
      } else {
        if (k in b) continue;
        out[k] = r[k];
      }
    }
    return out;
  }

  function mergeAll(base, local, remote) {
    const b = base || {};
    const r = { core: remote.core ?? local.core, wl: remote.wl ?? local.wl, watched: remote.watched ?? local.watched };
    const bc = b.core || {}, lc = local.core, rc = r.core;
    const core = {
      folders: mergeMap(bc.folders, lc.folders, rc.folders, mergeSet),
      channels: mergeMap(bc.channels, lc.channels, rc.channels, (x, y, z) => mergeRecord(x, y, z, ['tags'])),
      filters: mergeMap(bc.filters, lc.filters, rc.filters, (x, y, z) => mergeMap(x, y, z, mergeSet)),
      order: field(bc.order || [], lc.order, rc.order),
      myOff: mergeSet(bc.myOff, lc.myOff, rc.myOff)
    };
    const wl = mergeMap(b.wl, local.wl, r.wl, (x, y, z) => mergeRecord(x, y, z, ['tags'], ['opened']));
    const watched = mergeWatched(b.watched, local.watched, r.watched, !!remote.watchedTrunc);
    return { core, wl, watched };
  }

  /* ================= převod storage <-> snapshot <-> wire ================= */
  async function readLocal() {
    const d = await chrome.storage.local.get(['db', 'wl', 'watched', 'settings']);
    const db = d.db || {}, st = d.settings || {};
    const wl = {};
    (d.wl || []).forEach(v => { wl[v.id] = { ...v, tags: v.tags || [] }; });
    const watched = {};
    for (const [id, r] of Object.entries(d.watched || {})) {
      if ((r.t || 0) < seenSec()) continue;
      const o = { t: Math.round(r.t), d: Math.round(r.d || 0), ts: r.ts || 0 };
      if (r.manual) o.manual = 1;
      watched[id] = o;
    }
    return {
      raw: { db, wl: d.wl || [], watched: d.watched || {}, settings: st },
      snap: {
        core: { folders: db.folders || {}, channels: db.channels || {}, filters: db.filters || {}, order: st.order || [], myOff: st.myOff || [] },
        wl, watched
      }
    };
  }

  async function applyLocal(m, local) {
    const { raw, snap } = local, up = {};
    const c = m.core;
    if (!eq(snap.core.folders, c.folders) || !eq(snap.core.channels, c.channels) || !eq(snap.core.filters, c.filters)) {
      up.db = { ...raw.db, folders: c.folders, channels: c.channels, filters: c.filters };
    }
    if (!eq(snap.core.order, c.order) || !eq(snap.core.myOff, c.myOff)) {
      up.settings = { ...raw.settings, order: c.order, myOff: c.myOff };
    }
    if (!eq(snap.wl, m.wl)) {
      up.wl = Object.values(m.wl).sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')));
    }
    if (!eq(snap.watched, m.watched)) {
      const w = { ...raw.watched };
      for (const id of Object.keys(snap.watched)) if (!(id in m.watched)) delete w[id];
      for (const [id, v] of Object.entries(m.watched)) if (!eq(v, snap.watched[id])) w[id] = v;
      up.watched = w;
    }
    if (Object.keys(up).length) await chrome.storage.local.set(up);
    return Object.keys(up);
  }

  async function toWire(name, data) {
    if (name === 'core') return { v: 1, ...data };
    if (name === 'wl') {
      return { v: 1, items: Object.values(data).sort((a, b) => String(b.added || '').localeCompare(String(a.added || ''))) };
    }
    const all = Object.entries(data).sort((a, b) => (b[1].ts - a[1].ts) || (a[0] < b[0] ? -1 : 1));
    let n = Math.min(all.length, MAX_WATCHED), wire;
    for (;;) {
      wire = { v: 1, trunc: n < all.length, items: all.slice(0, n).map(([id, x]) => [id, x.t, x.d, x.ts, x.manual ? 1 : 0]) };
      if (n <= 50 || (await pack(wire)).length <= MAX_PACKED) break;
      n = Math.floor(n * 0.7);
    }
    return wire;
  }

  function fromWire(name, w) {
    if (!w || w.v > 1) throw new Error('Data ve vzdálené události jsou z novější verze rozšíření – aktualizuj ho.');
    if (name === 'core') {
      return { folders: w.folders || {}, channels: w.channels || {}, filters: w.filters || {}, order: w.order || [], myOff: w.myOff || [] };
    }
    if (name === 'wl') {
      const o = {};
      (w.items || []).forEach(v => { o[v.id] = { ...v, tags: v.tags || [] }; });
      return o;
    }
    const o = {};
    (w.items || []).forEach(([id, t, d, ts, m]) => { o[id] = { t, d, ts, ...(m ? { manual: 1 } : {}) }; });
    return o;
  }

  /* ================= balení (gzip + base64) ================= */
  const b64 = u8 => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function pack(obj) {
    const json = JSON.stringify(obj);
    if (typeof CompressionStream === 'undefined') return 'p1:' + json;
    const z = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    return 'z1:' + b64(new Uint8Array(await new Response(z).arrayBuffer()));
  }
  async function unpack(s) {
    if (s.startsWith('p1:')) return JSON.parse(s.slice(3));
    if (!s.startsWith('z1:')) throw new Error('Neznámý formát dat');
    const z = new Blob([unb64(s.slice(3))]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(z).text());
  }

  /* ================= relay klient ================= */
  function connect(url, ms = 7000) {
    return new Promise((res, rej) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { rej(e); return; }
      const t = setTimeout(() => { try { ws.close(); } catch (e) { /* */ } rej(new Error('časový limit připojení')); }, ms);
      ws.onopen = () => { clearTimeout(t); res(ws); };
      ws.onerror = () => { clearTimeout(t); rej(new Error('nepodařilo se připojit')); };
    });
  }

  async function queryRelay(url, filter, ms = 8000) {
    const ws = await connect(url);
    return new Promise(res => {
      const evs = [], sub = 'pt' + Math.random().toString(36).slice(2, 8);
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        try { ws.send(JSON.stringify(['CLOSE', sub])); } catch (e) { /* */ }
        try { ws.close(); } catch (e) { /* */ }
        res(evs);
      };
      const t = setTimeout(fin, ms);
      ws.onmessage = m => {
        let a;
        try { a = JSON.parse(m.data); } catch (e) { return; }
        if (a[1] !== sub) return;
        if (a[0] === 'EVENT') evs.push(a[2]);
        else if (a[0] === 'EOSE' || a[0] === 'CLOSED') fin();
      };
      ws.onclose = fin;
      ws.onerror = fin;
      ws.send(JSON.stringify(['REQ', sub, filter]));
    });
  }

  async function publishRelay(url, events, ms = 9000) {
    const ws = await connect(url);
    return new Promise((res, rej) => {
      const left = new Set(events.map(e => e.id));
      let failed = null;
      const t = setTimeout(() => { try { ws.close(); } catch (e) { /* */ } rej(new Error('relay neodpověděl')); }, ms);
      ws.onmessage = m => {
        let a;
        try { a = JSON.parse(m.data); } catch (e) { return; }
        if (a[0] !== 'OK' || !left.has(a[1])) return;
        left.delete(a[1]);
        if (!a[2] && !failed) failed = a[3] || 'odmítnuto';
        if (!left.size) {
          clearTimeout(t);
          try { ws.close(); } catch (e) { /* */ }
          failed ? rej(new Error(failed)) : res(true);
        }
      };
      ws.onerror = () => { clearTimeout(t); rej(new Error('chyba spojení')); };
      events.forEach(e => ws.send(JSON.stringify(['EVENT', e])));
    });
  }

  /* ================= konfigurace ================= */
  const getCfg = async () => (await chrome.storage.local.get('sync')).sync || null;
  const setCfg = cfg => chrome.storage.local.set({ sync: cfg });
  const setStatus = s => chrome.storage.local.set({ syncStatus: s });

  function cleanRelays(list) {
    const out = [];
    for (let u of list || []) {
      u = String(u).trim().replace(/\/+$/, '');
      if (/^wss:\/\/[^\s/]+/i.test(u) || /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(u)) if (!out.includes(u)) out.push(u);
    }
    return out.slice(0, 8);
  }

  async function configure({ nsec, generate, relays }) {
    const old = await getCfg();
    let sk = old?.sk;
    if (generate) sk = NostrLib.genSecretHex();
    else if (nsec) sk = NostrLib.parseSecret(nsec);
    if (!sk) throw new Error('Chybí klíč.');
    const list = cleanRelays(relays && relays.length ? relays : (old?.relays || DEFAULT_RELAYS));
    if (!list.length) throw new Error('Zadej aspoň jeden relay (wss://…).');
    if (old && old.sk !== sk) await chrome.storage.local.remove('syncBase');   // jiná identita = začít sjednocením
    await setCfg({ sk, relays: list });
  }

  async function disable() {
    await chrome.storage.local.remove(['sync', 'syncBase', 'syncStatus']);
    chrome.alarms?.clear('pt-sync-push');
  }

  async function status() {
    const cfg = await getCfg();
    const { syncStatus = null } = await chrome.storage.local.get('syncStatus');
    if (!cfg) return { enabled: false, relays: DEFAULT_RELAYS, last: syncStatus, running: !!running };
    const pk = NostrLib.pubHex(cfg.sk);
    return { enabled: true, npub: NostrLib.npubEncode(pk), relays: cfg.relays, last: syncStatus, running: !!running };
  }

  async function revealSecret() {
    const cfg = await getCfg();
    return cfg ? NostrLib.nsecEncode(cfg.sk) : null;
  }

  /* ================= vlastní synchronizace ================= */
  let running = null;

  async function run() {
    const cfg = await getCfg();
    if (!cfg) return;
    const sk = cfg.sk, pk = NostrLib.pubHex(sk);
    const dTags = Object.values(D);

    // 1) stáhnout
    const res = await Promise.all(cfg.relays.map(async url => {
      try { return { url, events: await queryRelay(url, { kinds: [KIND], authors: [pk], '#d': dTags }) }; }
      catch (e) { return { url, error: e.message || String(e) }; }
    }));
    const live = res.filter(r => !r.error);
    if (!live.length) throw new Error('Žádný relay neodpověděl (' + res.map(r => r.url + ': ' + r.error).join('; ') + ')');

    const newest = {}, has = {};
    for (const r of live) {
      has[r.url] = {};
      for (const ev of r.events) {
        if (ev.kind !== KIND || ev.pubkey !== pk) continue;
        const d = (ev.tags.find(t => t[0] === 'd') || [])[1];
        if (!dTags.includes(d) || !NostrLib.verify(ev)) continue;
        if (!has[r.url][d] || ev.created_at > has[r.url][d].created_at) has[r.url][d] = ev;
        if (!newest[d] || ev.created_at > newest[d].created_at) newest[d] = ev;
      }
    }

    // 2) dešifrovat
    const rawRemote = {}, remote = {};
    for (const n of NAMES) {
      const ev = newest[D[n]];
      if (!ev) continue;
      let w;
      try { w = await unpack(NostrLib.decrypt(sk, pk, ev.content)); }
      catch (e) { throw new Error('Nepodařilo se dešifrovat data z relaye (poškozená událost nebo jiný klíč).'); }
      rawRemote[n] = w;
      remote[n] = fromWire(n, w);
    }
    remote.watchedTrunc = !!rawRemote.watched?.trunc;

    // 3) sloučit a uložit lokálně (čtení a zápis těsně za sebou)
    const { syncBase } = await chrome.storage.local.get('syncBase');
    const local = await readLocal();
    const merged = mergeAll(syncBase, local.snap, remote);
    const changedLocal = await applyLocal(merged, local);

    // 4) odeslat, co je nové / co na relayích chybí
    const send = [];                         // {name, ev, all}
    let publishedAny = false;
    for (const n of NAMES) {
      const wire = await toWire(n, merged[n]);
      const old = newest[D[n]];
      if (old && eq(wire, rawRemote[n])) { send.push({ name: n, ev: old, isNew: false }); continue; }
      const content = NostrLib.encrypt(sk, pk, await pack(wire));
      const ev = NostrLib.sign(sk, {
        kind: KIND, content, tags: [['d', D[n]]],
        created_at: Math.max(Math.floor(Date.now() / 1000), (old?.created_at || 0) + 1)
      });
      send.push({ name: n, ev, isNew: true });
    }
    const relayRes = res.map(r => ({ url: r.url, ok: !r.error, error: r.error || null }));
    const okCount = {};                      // kolik relayů má danou datovou sadu aktuální
    for (const s of send) okCount[s.name] = 0;
    await Promise.all(live.map(async (r, idx) => {
      const need = send.filter(s => s.isNew || has[r.url][D[s.name]]?.id !== s.ev.id);
      const haveNow = send.filter(s => !need.includes(s));
      haveNow.forEach(s => { okCount[s.name]++; });
      if (!need.length) return;
      try {
        await publishRelay(r.url, need.map(s => s.ev));
        need.forEach(s => { okCount[s.name]++; });
        publishedAny = true;
      } catch (e) {
        const rr = relayRes.find(x => x.url === r.url);
        rr.ok = false;
        rr.error = 'odeslání: ' + (e.message || e);
      }
    }));

    // 5) base posunout jen u sad, které jsou skutečně na nějakém relayi
    const base = { ...(syncBase || {}) };
    for (const n of NAMES) if (okCount[n] > 0) base[n] = merged[n];
    await chrome.storage.local.set({ syncBase: base });

    const failedAll = send.some(s => okCount[s.name] === 0);
    await setStatus({
      ts: Date.now(), error: failedAll ? 'Data se nepodařilo odeslat na žádný relay.' : null,
      relays: relayRes, pulled: changedLocal, pushed: publishedAny
    });
  }

  function syncNow(soft) {
    if (running) return running;
    running = (async () => {
      try {
        if (soft) {
          const { syncStatus } = await chrome.storage.local.get('syncStatus');
          if (syncStatus && !syncStatus.error && Date.now() - syncStatus.ts < 60000) return;
        }
        await run();
      } catch (e) {
        const prev = (await chrome.storage.local.get('syncStatus')).syncStatus || {};
        await setStatus({ ...prev, ts: Date.now(), error: e.message || String(e) });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // zavolat při změně lokálních dat: naplánuje odeslání, pokud se něco liší od posledního stavu
  async function onLocalChange() {
    const cfg = await getCfg();
    if (!cfg) return;
    const { syncBase } = await chrome.storage.local.get('syncBase');
    const { snap } = await readLocal();
    if (syncBase && NAMES.every(n => eq(snap[n], syncBase[n]))) return;
    if (!(await chrome.alarms.get('pt-sync-push'))) chrome.alarms.create('pt-sync-push', { delayInMinutes: 0.5 });
  }

  return { configure, disable, status, revealSecret, syncNow, onLocalChange, DEFAULT_RELAYS, _t: { mergeAll, mergeSet, readLocal } };
})();
if (typeof module !== 'undefined') module.exports = PTSync;
