// Web Push ohne Fremdbibliothek - nur WebCrypto (laeuft in Deno und Node).
//   - VAPID (RFC 8292): ES256-JWT, Schluesselpaar P-256
//   - Nutzlast-Verschluesselung (RFC 8291, Content-Encoding aes128gcm / RFC 8188)
const te = new TextEncoder();

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s: string): Uint8Array {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Neues VAPID-Schluesselpaar: privater Teil als JWK (bleibt auf dem Server),
// oeffentlicher Teil als unkomprimierter Punkt (65 Byte, base64url) fuer den Browser.
export async function newVapidKeys(): Promise<{ jwk: JsonWebKey; pub: string }> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { jwk, pub };
}

export async function vapidAuth(endpoint: string, jwk: JsonWebKey, pub: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(head + "." + body));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + pub;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

// Verschluesselt die Nutzlast fuer genau ein Abo (p256dh + auth aus dem Browser).
export async function encryptPayload(p256dh: string, auth: string, payload: string): Promise<Uint8Array> {
  const uaPub = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPub.length !== 65 || authSecret.length !== 16) throw new Error("bad_subscription_keys");
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // ein einziger Record: Daten + 0x02 (Schlussmarke des letzten Records)
  const plain = concat(te.encode(payload), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPub.length;
  return concat(head, asPub, ct);
}

// Sendet eine Mitteilung. Rueckgabe: HTTP-Status des Push-Dienstes (0 = Netzfehler).
export async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapid: { jwk: JsonWebKey; pub: string; subject: string },
  ttl = 3600,
): Promise<number> {
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, payload);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidAuth(sub.endpoint, vapid.jwk, vapid.pub, vapid.subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": String(ttl),
        "Urgency": "normal",
      },
      body,
    });
    try { await res.body?.cancel(); } catch { /* egal */ }
    return res.status;
  } catch {
    return 0;
  }
}
