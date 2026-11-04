import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import * as nip19 from 'nostr-tools/nip19';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

globalThis.NostrLib = {
  genSecretHex: () => bytesToHex(generateSecretKey()),
  pubHex: skHex => getPublicKey(hexToBytes(skHex)),
  sign: (skHex, tpl) => finalizeEvent(tpl, hexToBytes(skHex)),
  verify: ev => verifyEvent(ev),
  encrypt: (skHex, pkHex, text) => nip44.encrypt(text, nip44.getConversationKey(hexToBytes(skHex), pkHex)),
  decrypt: (skHex, pkHex, payload) => nip44.decrypt(payload, nip44.getConversationKey(hexToBytes(skHex), pkHex)),
  nsecEncode: skHex => nip19.nsecEncode(hexToBytes(skHex)),
  npubEncode: pkHex => nip19.npubEncode(pkHex),
  // přijme nsec1… nebo 64 hex znaků, vrátí hex
  parseSecret: s => {
    s = (s || '').trim();
    if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
    const d = nip19.decode(s);
    if (d.type !== 'nsec') throw new Error('Není to nsec klíč');
    return bytesToHex(d.data);
  }
};
