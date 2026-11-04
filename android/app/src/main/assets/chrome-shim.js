/* Minimální náhrada chrome.* API pro Android WebView (storage.local, runtime, alarms) nad nativním mostem.
   Bridge: window.PTFull (feed + background, plný přístup) nebo window.PTWeb (YouTube, jen db/wl/watched). */
(function () {
  if (window.__ptShim) return;
  var B = window.PTFull || window.PTWeb;
  if (!B) return;
  window.__ptShim = 1;
  var FULL = !!window.PTFull;
  var ORIGIN = 'https://appassets.androidplatform.net';
  var c = window.chrome || (window.chrome = {});
  var seq = 0, pending = {}, fpend = {}, changeL = [], alarmL = [], alarms = {};

  function done(v, cb) {
    if (typeof cb === 'function') { setTimeout(function () { cb(v); }, 0); return undefined; }
    return Promise.resolve(v);
  }
  function parse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
  function keysOf(k) {
    if (k == null) return null;
    if (typeof k === 'string') return [k];
    if (Array.isArray(k)) return k;
    return Object.keys(k);
  }

  /* ---------- storage.local ---------- */
  c.storage = {
    local: {
      get: function (keys, cb) {
        var defs = (keys && typeof keys === 'object' && !Array.isArray(keys)) ? keys : null;
        var res = parse(B.get(JSON.stringify(keysOf(keys))));
        if (defs) Object.keys(defs).forEach(function (k) { if (!(k in res)) res[k] = defs[k]; });
        return done(res, cb);
      },
      set: function (items, cb) { B.set(JSON.stringify(items || {})); return done(undefined, cb); },
      remove: function (keys, cb) { B.remove(JSON.stringify(keysOf(keys) || [])); return done(undefined, cb); }
    },
    onChanged: { addListener: function (fn) { changeL.push(fn); } }
  };
  window.__ptChanged = function (ch) {
    var out = {};
    Object.keys(ch).forEach(function (k) {
      out[k] = {};
      if (ch[k].o != null) out[k].oldValue = ch[k].o;
      if (ch[k].n != null) out[k].newValue = ch[k].n;
    });
    changeL.forEach(function (fn) { try { fn(out, 'local'); } catch (e) { console.error(e); } });
  };

  /* ---------- runtime ---------- */
  c.runtime = {
    id: 'mytube-android',
    getURL: function (p) { return ORIGIN + '/' + (p || ''); },
    getManifest: function () { return { version: B.version() }; },
    onMessage: { addListener: function () {} },
    sendMessage: function (msg, cb) {
      var p;
      if (msg && msg.type === 'pt-open-feed') { B.openFeed(); p = Promise.resolve(); }
      else if (!FULL) p = Promise.reject(new Error('nepodporováno'));
      else p = new Promise(function (res, rej) {
        var id = 'm' + (++seq);
        pending[id] = { res: res, rej: rej };
        setTimeout(function () { if (pending[id]) { delete pending[id]; rej(new Error('časový limit')); } }, 45000);
        B.send(JSON.stringify(msg), id);
      });
      if (cb) { p.then(cb, function () { cb(); }); return undefined; }
      return p;
    }
  };
  window.__ptReply = function (id, res) {
    var p = pending[id];
    if (p) { delete pending[id]; p.res(res); }
  };

  if (!FULL) return;

  /* ---------- alarms (jen dokud běží aplikace) ---------- */
  function fire(name) {
    var a = alarms[name];
    if (!a) return;
    if (a.period) a.t = setTimeout(function () { fire(name); }, a.period * 60000); else delete alarms[name];
    alarmL.forEach(function (fn) { try { fn({ name: name }); } catch (e) { console.error(e); } });
  }
  c.alarms = {
    create: function (name, info) {
      if (alarms[name]) clearTimeout(alarms[name].t);
      var min = info.delayInMinutes != null ? info.delayInMinutes : info.periodInMinutes;
      alarms[name] = { period: info.periodInMinutes || 0 };
      alarms[name].t = setTimeout(function () { fire(name); }, min * 60000);
    },
    get: function (name, cb) { return done(alarms[name] ? { name: name } : undefined, cb); },
    clear: function (name, cb) {
      if (alarms[name]) { clearTimeout(alarms[name].t); delete alarms[name]; }
      return done(true, cb);
    },
    onAlarm: { addListener: function (fn) { alarmL.push(fn); } }
  };

  /* ---------- fetch RSS / oEmbed / stránek kanálů YouTube přes nativní vrstvu (CORS) ---------- */
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/^https:\/\/www\.youtube\.com\/(feeds\/|oembed\?|@|channel\/|c\/|user\/)/.test(url)) {
      return new Promise(function (res, rej) {
        var id = 'f' + (++seq);
        fpend[id] = { res: res, rej: rej };
        B.fetch(url, id);
      });
    }
    return nativeFetch(input, init);
  };
  window.__ptFetchDone = function (id, status, b64) {
    var p = fpend[id];
    if (!p) return;
    delete fpend[id];
    if (!status) { p.rej(new TypeError('Failed to fetch')); return; }
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    p.res(new Response(u8, { status: status }));
  };
})();
