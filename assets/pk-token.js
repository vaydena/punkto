/* ============================================================================
   Punkto — Abo-Token (Ed25519) OFFLINE-Pruefung.
   Die Edge Function punkto-data signiert einen "gueltig-bis"-Token mit dem
   PRIVATEN Ed25519-Schluessel (nur als Supabase-Secret PK_TOKEN_SK). Die App
   traegt NUR den OEFFENTLICHEN Schluessel (unten im Klartext) und prueft den
   Token damit vollstaendig OFFLINE ueber die Web-Crypto-API. Der oeffentliche
   Schluessel kann ausschliesslich PRUEFEN, nie signieren -> unbedenklich.

   Token-Format:  base64url(JSON) + "." + base64url(Ed25519-Signatur)
   Signiert wird die base64url-JSON-ZEICHENKETTE (nicht die Rohbytes des JSON).
   Nutzlast:  { v:1, uid, exp, iat, status, plan }
     - exp : "gueltig-bis" als Unix-SEKUNDEN (Ende von Trial/Abo)
     - iat : Ausstellzeit (Server-Uhr) als Unix-SEKUNDEN -> Uhr-Rueckdreh-Schutz

   Zugriffs-Policy (rein, testbar):
     - aktiv          bis exp
     - Kulanz-Fenster exp .. exp + GRACE_DAYS (weiter schreibbar, mit Hinweis)
     - danach         nur-lesen (read-only)
   Uhr-Rueckdreh-Schutz: effektive Zeit = max(Geraete-Uhr, hoechstes je gesehenes iat).
   Ein Zurueckstellen der Uhr kann die Sperre daher nicht umgehen; ein
   Vorstellen sperrt nur frueher (kein Sicherheitsleck).

   Global: window.PKToken
     - verify(token)              -> Promise<payload|null>   (Signatur + v==1)
     - gate(payload, nowSec)      -> { state, validUntil, graceUntil }
     - effectiveNow(devSec, floor)-> Sekunden (Uhr-Rueckdreh-Schutz)
     - GRACE_DAYS, PUBKEY_B64
   ============================================================================ */
(function (root) {
  "use strict";

  /* OEFFENTLICHER Schluessel (raw 32 Byte, base64). Gegenstueck zum Secret
     PK_TOKEN_SK. Bewusst im Klartext — er kann nur pruefen, nicht signieren. */
  var PUBKEY_B64 = "Xi7ALIsQTuQKihTRjSeezoAXiop6iZ3nQQP0zqQPfm4=";

  /* Kulanz-Fenster nach Ablauf: weiter voll nutzbar, danach nur-lesen. */
  var GRACE_DAYS = 7;

  /* --- base64 / base64url -> Bytes ----------------------------------------- */
  function b64ToBytes(s) {
    var bin = atob(String(s || ""));
    var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function b64urlToBytes(s) {
    s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return b64ToBytes(s);
  }
  function b64urlToStr(s) {
    return new TextDecoder().decode(b64urlToBytes(s));
  }

  /* --- Oeffentlichen Schluessel EINMAL importieren (gecached) --------------- */
  var _keyPromise = null;
  function pubKey() {
    if (_keyPromise) return _keyPromise;
    _keyPromise = (async function () {
      try {
        if (!root.crypto || !root.crypto.subtle) return null;
        return await root.crypto.subtle.importKey(
          "raw", b64ToBytes(PUBKEY_B64), { name: "Ed25519" }, false, ["verify"]
        );
      } catch (e) { return null; }
    })();
    return _keyPromise;
  }

  /* --- Token pruefen: Signatur + Grundform, liefert die Nutzlast ----------- */
  async function verify(token) {
    if (typeof token !== "string") return null;
    var dot = token.indexOf(".");
    if (dot < 0) return null;
    var p = token.slice(0, dot);      // base64url(JSON) — genau diese Zeichen wurden signiert
    var sig = token.slice(dot + 1);
    var key = await pubKey();
    if (!key) return null;
    var ok = false;
    try {
      ok = await root.crypto.subtle.verify(
        { name: "Ed25519" }, key, b64urlToBytes(sig), new TextEncoder().encode(p)
      );
    } catch (e) { return null; }
    if (!ok) return null;
    var payload;
    try { payload = JSON.parse(b64urlToStr(p)); } catch (e) { return null; }
    if (!payload || payload.v !== 1) return null;
    return payload;
  }

  /* --- Uhr-Rueckdreh-Schutz: effektive "jetzt"-Zeit ------------------------ */
  function effectiveNow(deviceSec, iatFloorSec) {
    var d = Number(deviceSec) || 0;
    var f = Number(iatFloorSec) || 0;
    return d > f ? d : f;
  }

  /* --- Zugriffs-Zustand aus Nutzlast + jetzt ------------------------------- */
  /* Rueckgabe .state: "active" | "grace" | "expired" | "none"
     "none" = kein/kaputter Token -> App bleibt vorlaeufig ungated (fail-open). */
  function gate(payload, nowSec) {
    if (!payload) return { state: "none", validUntil: 0, graceUntil: 0 };
    var exp = Number(payload.exp) || 0;
    var graceUntil = exp + GRACE_DAYS * 86400;
    var now = Number(nowSec) || 0;
    var state = now <= exp ? "active" : (now <= graceUntil ? "grace" : "expired");
    return { state: state, validUntil: exp, graceUntil: graceUntil };
  }

  root.PKToken = {
    PUBKEY_B64: PUBKEY_B64,
    GRACE_DAYS: GRACE_DAYS,
    verify: verify,
    gate: gate,
    effectiveNow: effectiveNow
  };
})(typeof window !== "undefined" ? window : globalThis);
