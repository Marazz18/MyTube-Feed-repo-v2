# MyTube Feed – Android aplikace (APK)

Aplikace obsahuje **jen feed** (složky kanálů, filtry, Watch later, Sync přes Nostr). Žádné vestavěné prohlížení YouTube.

## Přidávání videí a kanálů (copy-paste)
- Tlačítko **🔗** v záhlaví: vlož odkaz (nebo `@handle`).
  - **Video** (watch, youtu.be, shorts, live) → uloží se do **Watch later**; nabídne i přidání jeho kanálu.
  - **Kanál** (`@handle`, `/channel/UC…`, `/c/…`, `/user/…`) → vybereš složky (nebo založíš novou).
- Při otevření dialogu se odkaz sám předvyplní, pokud ho máš ve schránce.
- **Sdílení:** v YouTube aplikaci / prohlížeči *Sdílet → MyTube Feed* otevře rovnou tento dialog.

## Otevírání videí
Klik na video otevře odkaz ve zvoleném prohlížeči (Firefox, Brave, Chrome…). Při prvním kliknutí aplikace nabídne
seznam nainstalovaných prohlížečů; změna kdykoli v menu ⚙ → **🌐 Prohlížeč pro videa**.
(YouTube aplikace v nabídce schválně není – videa se otevírají v prohlížeči.)

## Build (GitHub Actions)
1. Nahraj celý obsah repa (včetně skryté složky `.github`).
2. Jednou nastav podpisový klíč – Settings → Secrets and variables → Actions:
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
   (bez něj se APK podepíše dočasným klíčem a další verze se nenainstaluje jako aktualizace).
3. Release s tagem `vX.Y.Z` → workflow *Android APK* sestaví `MyTubeFeed.apk` a přiloží ho k release.
   Ručně: Actions → *Android APK* → *Run workflow* (APK pak najdeš v Artifacts).

Workflow při buildu kopíruje `feed.html, feed.js, feed.css, shared.js, sync.js, nostr.bundle.js, addlink.js`
z kořene repa do `android/app/src/main/assets/`.

## Aktualizace aplikace
Aplikace jednou za 12 h hledá novější release s `.apk`; pokud ho najde, ve feedu se objeví červené tlačítko
„🚀 Stáhnout aktualizaci“ (otevře se ve zvoleném prohlížeči).
