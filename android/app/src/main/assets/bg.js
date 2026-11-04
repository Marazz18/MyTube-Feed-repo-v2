/* Android varianta background.js: synchronizace přes Nostr + kontrola aktualizací (APK z GitHub Releases) */
(function () {
  chrome.storage.onChanged.addListener(function (ch) {
    if (ch.db || ch.wl || ch.watched || ch.settings) PTSync.onLocalChange();
  });
  chrome.alarms.onAlarm.addListener(function (a) {
    if (a.name === 'pt-sync-pull' || a.name === 'pt-sync-push') PTSync.syncNow();
    if (a.name === 'checkUpdate') checkForUpdates();
  });
  chrome.alarms.create('pt-sync-pull', { periodInMinutes: 5 });
  chrome.alarms.create('checkUpdate', { periodInMinutes: 720 });

  window.__bgHandle = async function (json, cb) {
    var out;
    try {
      var msg = JSON.parse(json);
      if (msg.type === 'sync-status') out = await PTSync.status();
      else if (msg.type === 'sync-setup') { await PTSync.configure(msg); await PTSync.syncNow(); out = await PTSync.status(); }
      else if (msg.type === 'sync-now') { await PTSync.syncNow(!!msg.soft); out = await PTSync.status(); }
      else if (msg.type === 'sync-reveal') out = { nsec: await PTSync.revealSecret() };
      else if (msg.type === 'sync-disable') { await PTSync.disable(); out = await PTSync.status(); }
      else out = { error: 'neznámá zpráva' };
    } catch (e) { out = { error: e.message || String(e) }; }
    window.PTFull.reply(cb, JSON.stringify(out === undefined ? null : out));
  };

  async function checkForUpdates() {
    try {
      var res = await fetch('https://api.github.com/repos/Marazz18/MyTube-Feed/releases/latest');
      if (!res.ok) return;
      var data = await res.json();
      var latest = String(data.tag_name || '').replace(/^v/, '');
      var current = chrome.runtime.getManifest().version;
      var apk = (data.assets || []).find(function (a) { return /\.apk$/i.test(a.name); });
      if (apk && latest.localeCompare(current, undefined, { numeric: true, sensitivity: 'base' }) > 0) {
        await chrome.storage.local.set({ updateAvailable: apk.browser_download_url, updateVersion: latest });
      } else {
        await chrome.storage.local.remove(['updateAvailable', 'updateVersion']);
      }
    } catch (e) { console.log('Kontrola aktualizací selhala', e); }
  }

  PTSync.syncNow();
  checkForUpdates();
})();
