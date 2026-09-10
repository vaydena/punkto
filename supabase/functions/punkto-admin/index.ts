// Punkto - Betreiber-Bereich (Operator). Zugang nur mit Betreiber-Schluessel
// (SHA-256-Hash in punkto.admin_auth id=1, constant-time). Kein Konto noetig.
// Aktionen: stats, users, user, extend (Abo verlaengern), set_status, add_note,
// export, set_key (Schluessel rotieren).
import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// --- Storage (privater Bucket punkto-community): Review-URL signieren, Objekt loeschen ---
// Der Bucket ist privat, damit ausstehende Fotos NIE oeffentlich erreichbar sind. Der
// Betreiber sieht Vorschlaege nur ueber kurzlebige signierte URLs; erst mit der Freigabe
// wird eine lang gueltige signierte URL erzeugt und am Gemeinschaftsprodukt gespeichert.
const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PHOTO_BUCKET = "punkto-community";
async function storageSignUrl(path: string, expiresIn: number): Promise<string> {
  if (!SERVICE_KEY || !SUPA_URL || !path) return "";
  try {
    const res = await fetch(`${SUPA_URL}/storage/v1/object/sign/${PHOTO_BUCKET}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) return "";
    const j = await res.json().catch(() => null);
    const signed = j?.signedURL || j?.signedUrl || "";
    if (!signed) return "";
    return signed.startsWith("http") ? signed : `${SUPA_URL}/storage/v1${signed}`;
  } catch { return ""; }
}
async function storageDelete(path: string): Promise<boolean> {
  if (!SERVICE_KEY || !SUPA_URL || !path) return false;
  try {
    const res = await fetch(`${SUPA_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SERVICE_KEY}` },
    });
    return res.ok;
  } catch { return false; }
}

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function ctEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function checkAdmin(req: Request) {
  const key = (req.headers.get("x-admin-key") || "").trim();
  if (!key) return false;
  const h = await sha256hex(key);
  const r = await sql`select secret_sha256 from punkto.admin_auth where id = 1 limit 1`;
  const stored = r[0]?.secret_sha256;
  if (!stored) return false;
  return ctEq(h, String(stored));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body?.action ?? "").trim();

  if (!(await checkAdmin(req))) return json({ error: "forbidden" }, 403);

  try {
    if (action === "login") {
      return json({ ok: true });
    }

    if (action === "stats") {
      const [tot, active, trial, expired, rev, recent, pend, photoPend] = await Promise.all([
        sql`select count(*)::int as n from punkto.users`,
        sql`select count(*)::int as n from punkto.subscriptions where current_period_end > now()`,
        sql`select count(*)::int as n from punkto.subscriptions where (current_period_end is null or current_period_end <= now()) and trial_ends_at > now()`,
        sql`select count(*)::int as n from punkto.subscriptions where coalesce(current_period_end, trial_ends_at) <= now()`,
        sql`select coalesce(sum(amount_cents),0)::int as c, count(*)::int as n from punkto.payments`,
        sql`select date_trunc('day', created_at)::date::text as day, count(*)::int as n
              from punkto.users where created_at > now() - interval '30 days'
              group by 1 order by 1`,
        sql`select count(*)::int as n from punkto.community_products where status = 'pending'`,
        sql`select count(*)::int as n from punkto.community_photos where status = 'pending'`,
      ]);
      return json({
        ok: true,
        users_total: tot[0].n, subs_active: active[0].n, subs_trial: trial[0].n, subs_expired: expired[0].n,
        revenue_cents: rev[0].c, payments_count: rev[0].n, signups_30d: recent,
        community_pending: pend[0].n, photos_pending: photoPend[0].n,
      });
    }

    if (action === "users") {
      const limit = clamp(Number(body.limit) || 50, 1, 200);
      const offset = clamp(Number(body.offset) || 0, 0, 100000);
      const q = String(body.q || "").trim().toLowerCase();
      const like = "%" + q.replace(/[%_]/g, "") + "%";
      const rows = q
        ? await sql`
            select u.id, u.email, u.display_name, u.created_at, u.last_login_at,
                   sb.status, sb.trial_ends_at, sb.current_period_end,
                   greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz)) as ends_at,
                   (now() < greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz))) as access
              from punkto.users u left join punkto.subscriptions sb on sb.user_id = u.id
             where lower(u.email) like ${like} or lower(coalesce(u.display_name,'')) like ${like}
             order by u.created_at desc limit ${limit} offset ${offset}`
        : await sql`
            select u.id, u.email, u.display_name, u.created_at, u.last_login_at,
                   sb.status, sb.trial_ends_at, sb.current_period_end,
                   greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz)) as ends_at,
                   (now() < greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz))) as access
              from punkto.users u left join punkto.subscriptions sb on sb.user_id = u.id
             order by u.created_at desc limit ${limit} offset ${offset}`;
      return json({ ok: true, users: rows });
    }

    if (action === "user") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const [uu, sb, pay, diaryN, wN] = await Promise.all([
        sql`select id, email, display_name, sex, birth_year, height_cm, start_weight_kg, goal_weight_kg,
                   activity_level, daily_budget, weekly_extra, onboarded, email_verified, created_at, last_login_at
              from punkto.users where id = ${id} limit 1`,
        sql`select status, plan, trial_ends_at, current_period_end, notes, created_at, updated_at
              from punkto.subscriptions where user_id = ${id} limit 1`,
        sql`select id, amount_cents, method, months, ref, note, created_by, created_at
              from punkto.payments where user_id = ${id} order by created_at desc limit 50`,
        sql`select count(*)::int as n from punkto.diary_entries where user_id = ${id}`,
        sql`select count(*)::int as n from punkto.weight_logs where user_id = ${id}`,
      ]);
      if (!uu.length) return json({ error: "not_found" }, 404);
      return json({ ok: true, user: uu[0], subscription: sb[0] || null, payments: pay, diary_count: diaryN[0].n, weight_count: wN[0].n });
    }

    if (action === "extend") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const months = clamp(Number(body.months) || 1, 1, 36);
      const amount = clamp(Number(body.amount_cents) ?? 299, 0, 1000000);
      const method = ["bank", "paypal", "cash", "other"].includes(String(body.method)) ? String(body.method) : "bank";
      const ref = body.ref ? String(body.ref).slice(0, 120) : null;
      const note = body.note ? String(body.note).slice(0, 300) : null;
      // Basis = groesserer von jetzt / bisherigem Periodenende; darauf N Monate.
      const upd = await sql`
        insert into punkto.subscriptions (user_id, status, plan, current_period_end, updated_at)
        values (${id}, 'active', 'monthly',
                greatest(now(), coalesce((select current_period_end from punkto.subscriptions where user_id = ${id}), now())) + (${months} * interval '1 month'),
                now())
        on conflict (user_id) do update set
          status = 'active',
          current_period_end = greatest(now(), coalesce(punkto.subscriptions.current_period_end, now())) + (${months} * interval '1 month'),
          updated_at = now()
        returning status, current_period_end`;
      await sql`insert into punkto.payments (user_id, amount_cents, method, months, ref, note, created_by)
                values (${id}, ${amount}, ${method}, ${months}, ${ref}, ${note}, 'operator')`;
      return json({ ok: true, subscription: upd[0] });
    }

    if (action === "set_status") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const status = ["trial", "active", "past_due", "canceled", "blocked"].includes(String(body.status)) ? String(body.status) : null;
      if (!status) return json({ error: "bad_status" }, 400);
      const clearEnd = body.clear_period === true;
      const upd = clearEnd
        ? await sql`insert into punkto.subscriptions (user_id, status, current_period_end, updated_at)
                     values (${id}, ${status}, null, now())
                     on conflict (user_id) do update set status = ${status}, current_period_end = null, updated_at = now()
                     returning status, current_period_end`
        : await sql`insert into punkto.subscriptions (user_id, status, updated_at)
                     values (${id}, ${status}, now())
                     on conflict (user_id) do update set status = ${status}, updated_at = now()
                     returning status, current_period_end`;
      return json({ ok: true, subscription: upd[0] });
    }

    if (action === "add_note") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const note = String(body.notes || "").slice(0, 2000);
      const upd = await sql`insert into punkto.subscriptions (user_id, notes, updated_at) values (${id}, ${note}, now())
                     on conflict (user_id) do update set notes = ${note}, updated_at = now() returning notes`;
      return json({ ok: true, notes: upd[0]?.notes ?? null });
    }

    if (action === "export") {
      const [users, subs, payments, community, photos] = await Promise.all([
        sql`select id, email, display_name, created_at, last_login_at, onboarded from punkto.users order by created_at`,
        sql`select user_id, status, plan, trial_ends_at, current_period_end, updated_at from punkto.subscriptions`,
        sql`select id, user_id, amount_cents, method, months, ref, note, created_by, created_at from punkto.payments order by created_at`,
        sql`select id, barcode, name, brand, unit, base_g, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, vegan, vegetarian, status, photo_url, photo_id, created_at, moderated_at from punkto.community_products order by created_at`,
        sql`select id, community_product_id, barcode, storage_path, status, reject_reason, submitted_by, created_at, moderated_at from punkto.community_photos order by created_at`,
      ]);
      return json({ ok: true, exported_at: new Date().toISOString(), users, subscriptions: subs, payments, community_products: community, community_photos: photos });
    }

    if (action === "products_pending") {
      // Offene Community-Vorschlaege fuer die Moderation (aelteste zuerst).
      const limit = clamp(Number(body.limit) || 200, 1, 500);
      const rows = await sql`
        select id, barcode, name, brand, unit, base_g, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, vegan, vegetarian, created_at
          from punkto.community_products where status = 'pending'
          order by created_at asc limit ${limit}`;
      return json({ ok: true, products: rows });
    }

    if (action === "product_moderate") {
      // Vorschlag freigeben (approved) oder ablehnen (rejected). Der Betreiber darf
      // die Naehrwerte vor der Freigabe optional korrigieren (patch), damit ein
      // sonst guter Eintrag nicht wegen eines Tippfehlers verworfen werden muss.
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const decision = ["approved", "rejected"].includes(String(body.decision)) ? String(body.decision) : null;
      if (!decision) return json({ error: "bad_decision" }, 400);
      const reason = body.reason ? String(body.reason).slice(0, 200) : "";
      const p = body.patch && typeof body.patch === "object" ? body.patch : null;
      if (p) {
        // Diaet-Flags als echte Booleans/null aufloesen. Invariante: vegan impliziert
        // vegetarisch -> wird vegan gesetzt, ist vegetarisch zwingend wahr (Server ist
        // die letzte Instanz, egal was der Client schickt).
        const veganVal = p.vegan != null ? (p.vegan === true || p.vegan === "true" || p.vegan === 1) : null;
        let vegetarianVal = p.vegetarian != null ? (p.vegetarian === true || p.vegetarian === "true" || p.vegetarian === 1) : null;
        if (veganVal === true) vegetarianVal = true;
        await sql`update punkto.community_products set
            name      = coalesce(${p.name != null ? String(p.name).trim().slice(0, 120) : null}, name),
            brand     = coalesce(${p.brand != null ? String(p.brand).trim().slice(0, 80) : null}, brand),
            unit      = coalesce(${p.unit === "ml" ? "ml" : (p.unit === "g" ? "g" : null)}, unit),
            base_g    = coalesce(${p.base_g != null ? clamp(num(p.base_g, 100), 1, 100000) : null}, base_g),
            kcal      = coalesce(${p.kcal != null ? clamp(num(p.kcal), 0, 99999) : null}, kcal),
            sat_fat_g = coalesce(${p.sat_fat_g != null ? clamp(num(p.sat_fat_g), 0, 1000) : null}, sat_fat_g),
            sugar_g   = coalesce(${p.sugar_g != null ? clamp(num(p.sugar_g), 0, 1000) : null}, sugar_g),
            protein_g = coalesce(${p.protein_g != null ? clamp(num(p.protein_g), 0, 1000) : null}, protein_g),
            fiber_g   = coalesce(${p.fiber_g != null ? clamp(num(p.fiber_g), 0, 1000) : null}, fiber_g),
            vegan      = coalesce(${veganVal}, vegan),
            vegetarian = coalesce(${vegetarianVal}, vegetarian)
          where id = ${id} and status = 'pending'`;
      }
      const r = await sql`update punkto.community_products
          set status = ${decision}, reject_reason = ${reason}, moderated_at = now(), moderated_by = 'operator'
          where id = ${id} returning id, status`;
      if (!r.length) return json({ error: "not_found" }, 404);
      return json({ ok: true, product: r[0] });
    }

    if (action === "photos_pending") {
      // Offene Foto-Vorschlaege fuer die Moderation (aelteste zuerst). Je Foto eine
      // KURZLEBIGE signierte URL (1 h), damit der Betreiber das Bild pruefen kann,
      // ohne dass der Bucket oeffentlich wird.
      const limit = clamp(Number(body.limit) || 100, 1, 300);
      const rows = await sql`
        select ph.id, ph.community_product_id, ph.barcode, ph.storage_path, ph.submitted_by, ph.created_at,
               cp.name as product_name, cp.brand as product_brand, cp.status as product_status
          from punkto.community_photos ph
          left join punkto.community_products cp on cp.id = ph.community_product_id
         where ph.status = 'pending'
         order by ph.created_at asc limit ${limit}`;
      const out = [];
      for (const r of rows) {
        const review_url = await storageSignUrl(String(r.storage_path || ""), 3600);
        out.push({
          id: r.id, community_product_id: r.community_product_id, barcode: r.barcode,
          submitted_by: r.submitted_by, created_at: r.created_at,
          product_name: r.product_name, product_brand: r.product_brand, product_status: r.product_status,
          review_url,
        });
      }
      return json({ ok: true, photos: out });
    }

    if (action === "photo_moderate") {
      // Foto-Vorschlag freigeben (approved) oder ablehnen (rejected).
      //  - rejected: Storage-Objekt loeschen, Zeile als abgelehnt markieren.
      //  - approved: lang gueltige signierte URL erzeugen, am Gemeinschaftsprodukt
      //    speichern (photo_url + photo_id). Ein evtl. vorher freigegebenes Foto
      //    desselben Produkts wird ersetzt (altes Objekt geloescht, Zeile abgelehnt).
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const decision = ["approved", "rejected"].includes(String(body.decision)) ? String(body.decision) : null;
      if (!decision) return json({ error: "bad_decision" }, 400);
      const reason = body.reason ? String(body.reason).slice(0, 200) : "";
      const ph = await sql`select id, community_product_id, storage_path, status
                             from punkto.community_photos where id = ${id} limit 1`;
      if (!ph.length) return json({ error: "not_found" }, 404);
      const photo = ph[0];

      if (decision === "rejected") {
        await storageDelete(String(photo.storage_path || ""));
        const r = await sql`update punkto.community_photos
            set status = 'rejected', reject_reason = ${reason || "abgelehnt"}, moderated_at = now(), moderated_by = 'operator'
            where id = ${id} returning id, status`;
        return json({ ok: true, photo: r[0] });
      }

      // approved: lang gueltige signierte URL (10 Jahre -> stabil/cachebar fuer die Offline-PWA)
      const signed = await storageSignUrl(String(photo.storage_path || ""), 315360000);
      if (!signed) return json({ error: "sign_failed" }, 502);

      // Vorheriges Foto desselben Produkts ermitteln (zum Ersetzen/Aufraeumen).
      let prevId: string | null = null;
      let prevPath = "";
      if (photo.community_product_id) {
        const cur = await sql`select photo_id from punkto.community_products where id = ${photo.community_product_id} limit 1`;
        prevId = cur[0]?.photo_id || null;
        if (prevId && prevId !== id) {
          const old = await sql`select storage_path from punkto.community_photos where id = ${prevId} limit 1`;
          prevPath = String(old[0]?.storage_path || "");
        }
      }

      const r = await sql`update punkto.community_photos
          set status = 'approved', public_url = ${signed}, reject_reason = '', moderated_at = now(), moderated_by = 'operator'
          where id = ${id} returning id, status`;

      if (photo.community_product_id) {
        await sql`update punkto.community_products
            set photo_url = ${signed}, photo_id = ${id}
            where id = ${photo.community_product_id}`;
      }

      if (prevId && prevId !== id) {
        if (prevPath) await storageDelete(prevPath);
        await sql`update punkto.community_photos
            set status = 'rejected', reject_reason = 'ersetzt', moderated_at = now(), moderated_by = 'operator'
            where id = ${prevId}`;
      }

      return json({ ok: true, photo: r[0], photo_url: signed });
    }

    if (action === "set_key") {
      const nk = String(body.new_key || "").trim();
      if (nk.length < 12) return json({ error: "key_too_short" }, 400);
      const h = await sha256hex(nk);
      await sql`insert into punkto.admin_auth (id, secret_sha256, updated_at) values (1, ${h}, now())
                on conflict (id) do update set secret_sha256 = ${h}, updated_at = now()`;
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    try { console.error("punkto-admin", action, String((e as Error)?.message || e)); } catch (_e) { /* ignore */ }
    return json({ error: "server_error" }, 500);
  }
});
