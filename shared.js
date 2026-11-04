var PT = {
  NEW_DAYS: 14,      // video je "nové", pokud je mladší než tolik dní a nezhlédnuté
  SEEN_SECONDS: 5,   // kolik sekund přehrávání stačí k označení jako zhlédnuté

  async getAll() {
    const d = await chrome.storage.local.get(['db', 'cache', 'watched', 'wl', 'settings']);
    const s = {
      db: d.db || { folders: {}, channels: {} },
      cache: d.cache || {},
      watched: d.watched || {},
      wl: d.wl || [],
      settings: d.settings || {}
    };
    s.db.folders = s.db.folders || {};
    s.db.channels = s.db.channels || {};
    s.settings.open = s.settings.open || [];
    return s;
  },

  isSeen(watched, id) {
    const r = watched[id];
    return !!r && (r.t || 0) >= PT.SEEN_SECONDS;
  },

  isNew(item, watched) {
    return !PT.isSeen(watched, item.id) &&
      Date.now() - new Date(item.published).getTime() < PT.NEW_DAYS * 86400000;
  },

  videoIdFromUrl(u) {
    const ok = x => (/^[\w-]{11}$/.test(x || '') ? x : null);
    try {
      let url = new URL(u);
      if (/(^|\.)facebook\.com$/.test(url.hostname) && url.pathname.startsWith('/l.php')) {
        url = new URL(url.searchParams.get('u'));
      }
      if (url.hostname === 'youtu.be') return ok(url.pathname.slice(1, 12));
      if (/(^|\.)youtube\.com$/.test(url.hostname)) {
        if (url.pathname === '/watch') return ok(url.searchParams.get('v'));
        const m = url.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
        if (m) return ok(m[2]);
      }
    } catch (e) { /* neplatná URL */ }
    return null;
  }
};
