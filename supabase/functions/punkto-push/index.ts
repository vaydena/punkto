// Punkto - Erinnerungen als Mitteilung (Web Push).
//   key / status / subscribe / unsubscribe / test : Session-geschuetzt (Bearer-Token)
//   tick                                          : nur der Zeitplan (pg_cron -> pg_net, Header x-cron-key)
// Der private VAPID-Schluessel entsteht beim ersten Aufruf hier auf dem Server und
// liegt ausschliesslich in punkto.push_config (kein Zugriff fuer anon/authenticated).
import postgres from "npm:postgres@3";
import { newVapidKeys, sendPush } from "./webpush.ts";

const ORIGINS = new Set(["https://punkto.vaydena.de",
  ...String(Deno.env.get("PK_ALLOWED_ORIGINS") || "").split(",").map((x) => x.trim()).filter(Boolean)]);
function withCors(req: Request, res: Response) {
  const o = req.headers.get("origin") || "";
  res.headers.set("Access-Control-Allow-Origin", ORIGINS.has(o) ? o : "https://punkto.vaydena.de");
  res.headers.set("Vary", "Origin");
  return res;
}
const cors = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });

const SUBJECT = "mailto:kontakt@vaydena.de";
const MAX_SUBS = 5;            // Geraete je Konto
const APP_URL = "./app.html";

// Nur echte Push-Dienste der Browser als Ziel zulassen (sonst liesse sich die
// Funktion als Abruf-Werkzeug fuer beliebige Adressen missbrauchen).
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^jmt\d+\.google\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/,
];
function okEndpoint(v: unknown): string | null {
  const s = String(v || "");
  if (s.length < 20 || s.length > 1000) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  return PUSH_HOSTS.some((re) => re.test(u.hostname)) ? s : null;
}
const B64U = /^[A-Za-z0-9_-]+$/;

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function auth(req: Request) {
  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const th = await sha256hex(token);
  const r = await sql`
    select u.id from punkto.sessions s join punkto.users u on u.id = s.user_id
     where s.token_hash = ${th} and s.expires_at > now() limit 1`;
  return r[0] || null;
}

async function vapid() {
  let r = await sql`select vapid_jwk, vapid_pub from punkto.push_config where id = 1`;
  if (!r[0]) throw new Error("push_config_missing");
  if (!r[0].vapid_jwk) {
    const k = await newVapidKeys();
    // Nur setzen, wenn noch leer -> zwei gleichzeitige Erstaufrufe erzeugen kein zweites Paar.
    await sql`update punkto.push_config set vapid_jwk = ${sql.json(k.jwk as any)}, vapid_pub = ${k.pub}
               where id = 1 and vapid_jwk is null`;
    r = await sql`select vapid_jwk, vapid_pub from punkto.push_config where id = 1`;
  }
  return { jwk: r[0].vapid_jwk as JsonWebKey, pub: r[0].vapid_pub as string, subject: SUBJECT };
}

function sameKey(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Zeitplan: alle 15 Minuten. Jedes Abo wird je Kalendertag (in seiner Zeitzone)
// genau einmal bewertet - im Fenster ab der gewaehlten Uhrzeit (60 Minuten).
async function tick() {
  const v = await vapid();
  const rows = await sql`
    with s as (
      select p.*, (now() at time zone p.tz) as lt from punkto.push_subs p
    )
    select s.id, s.endpoint, s.p256dh, s.auth, s.diary_on, s.weigh_on, s.lt::date as ld,
           exists(select 1 from punkto.diary_entries d
                   where d.user_id = s.user_id and d.day = s.lt::date and d.deleted_at is null) as has_diary,
           (select max(w.day) from punkto.weight_logs w
             where w.user_id = s.user_id and w.deleted_at is null) as last_w,
           s.last_weigh_sent
      from s
      join punkto.users u on u.id = s.user_id and u.onboarded
      left join punkto.subscriptions sb on sb.user_id = u.id
     where (extract(hour from s.lt) * 60 + extract(minute from s.lt))::int between s.at_min and s.at_min + 59
       and (s.last_run is null or s.last_run < s.lt::date)
       and sb.status is distinct from 'blocked'
       and now() < greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz))
     limit 500`;
  let sent = 0, gone = 0, failed = 0;
  for (const r of rows) {
    const ld = String(r.ld instanceof Date ? r.ld.toISOString().slice(0, 10) : r.ld).slice(0, 10);
    const day = (x: any) => x == null ? null : Math.floor(Date.parse(String(x instanceof Date ? x.toISOString().slice(0, 10) : x).slice(0, 10) + "T00:00:00Z") / 86400000);
    const today = day(ld)!;
    const lw = day(r.last_w), ls = day(r.last_weigh_sent);
    const wantDiary = r.diary_on && !r.has_diary;
    const wantWeigh = r.weigh_on && (lw == null || today - lw >= 7) && (ls == null || today - ls >= 7);
    const parts: string[] = [];
    if (wantDiary) parts.push("Heute steht noch nichts im Tagebuch.");
    if (wantWeigh) parts.push(lw == null ? "Noch kein Gewicht eingetragen." : "Die letzte Messung ist " + (today - lw) + " Tage her.");
    if (!parts.length) {
      await sql`update punkto.push_subs set last_run = ${ld} where id = ${r.id}`;
      continue;
    }
    const st = await sendPush(r as any, JSON.stringify({
      title: "Punkto", body: parts.join(" "), tag: "pk-remind", url: APP_URL,
    }), v, 4 * 3600);
    if (st === 404 || st === 410) {
      await sql`delete from punkto.push_subs where id = ${r.id}`; gone++;
    } else if (st >= 200 && st < 300) {
      if (wantWeigh) await sql`update punkto.push_subs set last_run = ${ld}, last_weigh_sent = ${ld}, fails = 0 where id = ${r.id}`;
      else await sql`update punkto.push_subs set last_run = ${ld}, fails = 0 where id = ${r.id}`;
      sent++;
    } else {
      // voruebergehender Fehler: heute nicht erneut versuchen (kein Dauerfeuer), nur zaehlen
      await sql`update punkto.push_subs set last_run = ${ld}, fails = fails + 1, last_status = ${st} where id = ${r.id}`;
      failed++;
    }
  }
  return { ok: true, checked: rows.length, sent, gone, failed };
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(b.action || "");
  try {
    if (action === "tick") {
      const c = await sql`select cron_key from punkto.push_config where id = 1`;
      if (!c[0] || !sameKey(String(req.headers.get("x-cron-key") || ""), String(c[0].cron_key))) return json({ error: "forbidden" }, 403);
      return json(await tick());
    }

    const u = await auth(req);
    if (!u) return json({ error: "unauthorized" }, 401);

    if (action === "key") return json({ key: (await vapid()).pub });

    if (action === "status") {
      const ep = okEndpoint(b.endpoint);
      if (!ep) return json({ active: false });
      const r = await sql`select at_min, diary_on, weigh_on, tz from punkto.push_subs where endpoint = ${ep} and user_id = ${u.id}`;
      return json(r[0] ? { active: true, at_min: r[0].at_min, diary: r[0].diary_on, weigh: r[0].weigh_on, tz: r[0].tz } : { active: false });
    }

    if (action === "subscribe") {
      const ep = okEndpoint(b.endpoint);
      const p256dh = String(b.p256dh || ""), au = String(b.auth || "");
      if (!ep) return json({ error: "bad_endpoint" }, 400);
      if (!B64U.test(p256dh) || p256dh.length > 200 || !B64U.test(au) || au.length > 100) return json({ error: "bad_keys" }, 400);
      const at = Math.round(Number(b.at_min));
      if (!Number.isFinite(at) || at < 0 || at > 1380) return json({ error: "bad_time" }, 400);
      let tz = String(b.tz || "Europe/Berlin").slice(0, 64);
      const tzOk = await sql`select 1 from pg_timezone_names where name = ${tz} limit 1`;
      if (!tzOk[0]) tz = "Europe/Berlin";
      const diary = b.diary !== false, weigh = b.weigh !== false;
      // last_run nur dann zuruecksetzen, wenn sich die Uhrzeit aendert -> eine spaeter
      // gewaehlte Uhrzeit greift noch am selben Tag, ohne doppelte Mitteilung sonst.
      await sql`
        insert into punkto.push_subs (user_id, endpoint, p256dh, auth, tz, at_min, diary_on, weigh_on)
        values (${u.id}, ${ep}, ${p256dh}, ${au}, ${tz}, ${at}, ${diary}, ${weigh})
        on conflict (endpoint) do update set
          user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz,
          last_run = case when punkto.push_subs.at_min = excluded.at_min and punkto.push_subs.user_id = excluded.user_id
                          then punkto.push_subs.last_run else null end,
          last_weigh_sent = case when punkto.push_subs.user_id = excluded.user_id then punkto.push_subs.last_weigh_sent else null end,
          at_min = excluded.at_min, diary_on = excluded.diary_on, weigh_on = excluded.weigh_on,
          fails = 0, updated_at = now()`;
      await sql`
        delete from punkto.push_subs where user_id = ${u.id} and id not in (
          select id from punkto.push_subs where user_id = ${u.id} order by updated_at desc limit ${MAX_SUBS})`;
      return json({ ok: true, at_min: at, tz });
    }

    if (action === "unsubscribe") {
      const ep = String(b.endpoint || "");
      if (ep) await sql`delete from punkto.push_subs where endpoint = ${ep} and user_id = ${u.id}`;
      else await sql`delete from punkto.push_subs where user_id = ${u.id}`;
      return json({ ok: true });
    }

    if (action === "test") {
      const ep = okEndpoint(b.endpoint);
      if (!ep) return json({ error: "bad_endpoint" }, 400);
      const r = await sql`
        update punkto.push_subs set last_test_at = now()
         where endpoint = ${ep} and user_id = ${u.id}
           and (last_test_at is null or last_test_at < now() - interval '20 seconds')
        returning endpoint, p256dh, auth`;
      if (!r[0]) {
        const ex = await sql`select 1 from punkto.push_subs where endpoint = ${ep} and user_id = ${u.id}`;
        return json({ error: ex[0] ? "too_fast" : "not_subscribed" }, ex[0] ? 429 : 404);
      }
      const st = await sendPush(r[0] as any, JSON.stringify({
        title: "Punkto", body: "Test: So sehen deine Erinnerungen aus.", tag: "pk-test", url: APP_URL,
      }), await vapid(), 300);
      if (st === 404 || st === 410) {
        await sql`delete from punkto.push_subs where endpoint = ${ep} and user_id = ${u.id}`;
        return json({ error: "gone" }, 410);
      }
      if (!(st >= 200 && st < 300)) return json({ error: "push_failed", status: st }, 502);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("punkto-push", action, (e as Error)?.message);
    return json({ error: "server" }, 500);
  }
}

Deno.serve(async (req: Request) => withCors(req, await handler(req)));
