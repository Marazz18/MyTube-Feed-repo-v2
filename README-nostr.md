# MyTube Feed 0.8.0 – synchronizace přes Nostr

## Nastavení
1. Načti složku jako rozbalené rozšíření (chrome://extensions → Režim pro vývojáře → Načíst rozbalené).
2. Otevři feed → tlačítko **⇄ Sync** → **Vytvořit nový sync klíč**.
3. Na dalším zařízení: **⇄ Sync** → vlož nsec (na prvním zařízení „Zobrazit sync klíč“) → **Použít tento klíč**.

## Jak to funguje
- 3 šifrované (NIP-44, sám sobě) adresovatelné události kind 30078: `mytube:core` (složky, kanály, tagy kanálů,
  pořadí složek, výběr složek v Můj feed), `mytube:wl` (Watch later vč. tagů), `mytube:watched` (zhlédnutá).
- Slučování je 3-way proti poslednímu synchronizovanému stavu → funguje i mazání, bez náhrobků.
- Odeslání cca 30 s po změně, stahování každých 5 min, při startu prohlížeče a při otevření feedu.
- Nesynchronizuje se: cache feedu, záložka, „Skrýt zhlédnutá/shorts“.
- Zhlédnutá videa: jen ta s ≥ 5 s přehrání a max. ~2500 nejnovějších (limit velikosti události);
  starší zůstávají lokálně.

## Přebuildování nostr.bundle.js
cd nostr-src && npm i && npm run build
