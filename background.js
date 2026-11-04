importScripts('shared.js', 'nostr.bundle.js', 'sync.js');

const PATTERNS = [
  '*://www.youtube.com/watch*', '*://youtube.com/watch*', '*://m.youtube.com/watch*',
  '*://youtu.be/*', '*://www.youtube.com/shorts/*', '*://www.youtube.com/live/*',
  '*://l.facebook.com/l.php*', '*://lm.facebook.com/l.php*'
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pt-wl',
      title: 'Přidat do Watch later (MyTube)',
      contexts: ['link'],
      targetUrlPatterns: PATTERNS
    });
  });
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('feed.html') });
});

function flash(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

chrome.contextMenus.onClicked.addListener(async info => {
  if (info.menuItemId !== 'pt-wl') return;
  const id = PT.videoIdFromUrl(info.linkUrl);
  if (!id) { flash('✕', '#c62828'); return; }
  let title = id, channel = '';
  try {
    const r = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id),
      { credentials: 'omit' });
    if (r.ok) { const j = await r.json(); title = j.title || id; channel = j.author_name || ''; }
  } catch (e) { /* použije se ID */ }
  const { wl = [] } = await chrome.storage.local.get('wl');
  if (!wl.some(v => v.id === id)) wl.unshift({ id, title, channel, added: new Date().toISOString() });
  await chrome.storage.local.set({ wl });
  flash('✓', '#2e7d32');
});


/* ---------- synchronizace přes Nostr ---------- */
chrome.alarms.get('pt-sync-pull', a => { if (!a) chrome.alarms.create('pt-sync-pull', { periodInMinutes: 5 }); });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'pt-sync-pull' || a.name === 'pt-sync-push') PTSync.syncNow();
});
chrome.runtime.onStartup.addListener(() => PTSync.syncNow());
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch.db || ch.wl || ch.watched || ch.settings)) PTSync.onLocalChange();
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('sync-')) return;
  // jen z vlastních stránek rozšíření (ne z content scriptu na youtube.com)
  if (sender.id !== chrome.runtime.id || (sender.url || '').indexOf(chrome.runtime.getURL('')) !== 0) return;
  (async () => {
    try {
      if (msg.type === 'sync-status') return reply(await PTSync.status());
      if (msg.type === 'sync-setup') { await PTSync.configure(msg); await PTSync.syncNow(); return reply(await PTSync.status()); }
      if (msg.type === 'sync-now') { await PTSync.syncNow(!!msg.soft); return reply(await PTSync.status()); }
      if (msg.type === 'sync-reveal') return reply({ nsec: await PTSync.revealSecret() });
      if (msg.type === 'sync-disable') { await PTSync.disable(); return reply(await PTSync.status()); }
    } catch (e) { reply({ error: e.message || String(e) }); }
  })();
  return true;
});


/* ---------- KONTROLA AKTUALIZACÍ Z GITHUB RELEASES ---------- */
async function checkForUpdates() {
  try {
    const res = await fetch("https://api.github.com/repos/Marazz18/MyTube-Feed/releases/latest");
    if (!res.ok) return;
    const data = await res.json();
    const latestVersion = data.tag_name.replace('v', '');
    const currentVersion = chrome.runtime.getManifest().version;
    
    const cmp = latestVersion.localeCompare(currentVersion, undefined, { numeric: true, sensitivity: 'base' });
    if (cmp > 0) {
      chrome.action.setBadgeText({ text: "NEW" });
      chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
      
      let downloadUrl = data.html_url;
      const updAsset = (data.assets || []).find(a => /update\.bat$/i.test(a.name));
      if (updAsset) downloadUrl = updAsset.browser_download_url;
      await chrome.storage.local.set({ updateAvailable: downloadUrl, updateVersion: latestVersion });
    } else {
      chrome.action.setBadgeText({ text: "" });
      await chrome.storage.local.remove(['updateAvailable', 'updateVersion']);
    }
  } catch (e) {
    console.log("Kontrola aktualizací selhala", e);
  }
}

// Spustit při startu a nastavit alarm na každých 12 hodin (720 minut)
checkForUpdates();
chrome.alarms.create("checkUpdate", { periodInMinutes: 720 });
chrome.alarms.onAlarm.addListener(a => { 
  if (a.name === "checkUpdate") checkForUpdates(); 
});
