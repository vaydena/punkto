// Punkto - Betreiber-Bereich (Operator). Zugang nur mit Betreiber-Schluessel
// (SHA-256-Hash in punkto.admin_auth id=1, constant-time). Kein Konto noetig.
// Aktionen: stats, users, user, extend (Abo verlaengern, plan monthly|yearly),
// grant_free (dauerhaft kostenlos freischalten, plan='comp', ohne Zahlung),
// set_status, add_note, export, central_list (zentrale DB ansehen),
// central_update (Eintrag bearbeiten), central_delete (Eintrag entfernen),
// off_bulk_upsert (Open-Food-Facts-Naehrwerte batchweise importieren, ODbL,
// getrennte Tabelle punkto.off_products), off_stats (Import-Zaehler),
// set_key (Schluessel rotieren).
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

// Kein Storage-Bucket mehr: die zentrale Datenbank enthaelt ausschliesslich Skalare
// (Name/Marke/Naehrwerte/Barcode/Diaet-Flags) und hoechstens eine oeffentliche Open-
// Food-Facts-Foto-URL. Es gibt keine hochgeladenen Fotos und keine Foto-Moderation mehr.

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
      const [tot, active, trial, expired, rev, recent, central] = await Promise.all([
        sql`select count(*)::int as n from punkto.users`,
        sql`select count(*)::int as n from punkto.subscriptions where current_period_end > now()`,
        sql`select count(*)::int as n from punkto.subscriptions where (current_period_end is null or current_period_end <= now()) and trial_ends_at > now()`,
        sql`select count(*)::int as n from punkto.subscriptions where coalesce(current_period_end, trial_ends_at) <= now()`,
        sql`select coalesce(sum(amount_cents),0)::int as c, count(*)::int as n from punkto.payments`,
        sql`select date_trunc('day', created_at)::date::text as day, count(*)::int as n
              from punkto.users where created_at > now() - interval '30 days'
              group by 1 order by 1`,
        sql`select count(*)::int as n from punkto.community_products where status = 'approved'`,
      ]);
      return json({
        ok: true,
        users_total: tot[0].n, subs_active: active[0].n, subs_trial: trial[0].n, subs_expired: expired[0].n,
        revenue_cents: rev[0].c, payments_count: rev[0].n, signups_30d: recent,
        central_count: central[0].n,
      });
    }

    if (action === "users") {
      const limit = clamp(Number(body.limit) || 50, 1, 200);
      const offset = clamp(Number(body.offset) || 0, 0, 100000);
      const q = String(body.q || "").trim().toLowerCase();
      const like = "%" + q.replace(/[%_]/g, "") + "%";
      const rows = q
        ? await sql`
            select u.id, u.email, u.display_name, u.created_at, u.last_login_at, u.last_active_on,
                   sb.status, sb.trial_ends_at, sb.current_period_end,
                   greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz)) as ends_at,
                   (now() < greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz))) as access
              from punkto.users u left join punkto.subscriptions sb on sb.user_id = u.id
             where lower(u.email) like ${like} or lower(coalesce(u.display_name,'')) like ${like}
             order by u.created_at desc limit ${limit} offset ${offset}`
        : await sql`
            select u.id, u.email, u.display_name, u.created_at, u.last_login_at, u.last_active_on,
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
                   activity_level, daily_budget, weekly_extra, onboarded, email_verified, created_at, last_login_at, last_active_on
              from punkto.users where id = ${id} limit 1`,
        sql`select status, plan, trial_ends_at, current_period_end, notes, created_at, updated_at,
                   (now() < greatest(coalesce(trial_ends_at,'epoch'::timestamptz), coalesce(current_period_end,'epoch'::timestamptz))) as access
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
      const plan = ["monthly", "yearly"].includes(String(body.plan)) ? String(body.plan) : "monthly";
      const ref = body.ref ? String(body.ref).slice(0, 120) : null;
      const note = body.note ? String(body.note).slice(0, 300) : null;
      // Basis = groesserer von jetzt / bisherigem Periodenende; darauf N Monate.
      const upd = await sql`
        insert into punkto.subscriptions (user_id, status, plan, current_period_end, updated_at)
        values (${id}, 'active', ${plan},
                greatest(now(), coalesce((select current_period_end from punkto.subscriptions where user_id = ${id}), now())) + (${months} * interval '1 month'),
                now())
        on conflict (user_id) do update set
          status = 'active',
          plan = ${plan},
          current_period_end = greatest(now(), coalesce(punkto.subscriptions.current_period_end, now())) + (${months} * interval '1 month'),
          updated_at = now()
        returning status, current_period_end`;
      await sql`insert into punkto.payments (user_id, amount_cents, method, months, ref, note, created_by)
                values (${id}, ${amount}, ${method}, ${months}, ${ref}, ${note}, 'operator')`;
      return json({ ok: true, subscription: upd[0] });
    }

    if (action === "grant_free") {
      // Dauerhafter Gratis-Zugang (z. B. fuer Freunde/Tester): plan='comp' + Periodenende in
      // ferner Zukunft. Zugriff wird ueberall ueber (now() < current_period_end) geprueft, also
      // wirkt das sofort. Es wird KEINE Zahlung verbucht (im Gegensatz zu extend). Bestehende
      // interne Notizen bleiben erhalten; ein Standard-Vermerk wird nur bei Neuanlage gesetzt.
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const note = body.note ? String(body.note).slice(0, 300) : "Gratis (Freund)";
      const upd = await sql`
        insert into punkto.subscriptions (user_id, status, plan, current_period_end, notes, updated_at)
        values (${id}, 'active', 'comp', now() + interval '100 years', ${note}, now())
        on conflict (user_id) do update set
          status = 'active',
          plan = 'comp',
          current_period_end = now() + interval '100 years',
          updated_at = now()
        returning status, plan, current_period_end`;
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
      const [users, subs, payments, community] = await Promise.all([
        sql`select id, email, display_name, created_at, last_login_at, onboarded from punkto.users order by created_at`,
        sql`select user_id, status, plan, trial_ends_at, current_period_end, updated_at from punkto.subscriptions`,
        sql`select id, user_id, amount_cents, method, months, ref, note, created_by, created_at from punkto.payments order by created_at`,
        sql`select id, barcode, name, brand, unit, base_g, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, vegan, vegetarian, status, photo_url, photo_id, created_at, moderated_at from punkto.community_products order by created_at`,
      ]);
      return json({ ok: true, exported_at: new Date().toISOString(), users, subscriptions: subs, payments, community_products: community });
    }

    if (action === "central_list") {
      // Nur-Ansicht der zentralen Datenbank (freigegebene Produkte) fuer den Betreiber-
      // Bereich. Kein Crowdsourcing/keine Moderation mehr -> Eintraege pflegt der Betreiber
      // direkt in der App (central_add). Hier nur auflisten und ggf. entfernen.
      const limit = clamp(Number(body.limit) || 500, 1, 3000);
      const rows = await sql`
        select id, barcode, name, brand, unit, base_g, kcal, sat_fat_g, sugar_g, protein_g, fiber_g,
               vegan, vegetarian, photo_url, created_at, moderated_at
          from punkto.community_products where status = 'approved'
          order by moderated_at desc nulls last, created_at desc limit ${limit}`;
      return json({ ok: true, products: rows, count: rows.length });
    }

    if (action === "central_update") {
      // Einen bestehenden Eintrag der zentralen Datenbank per id bearbeiten. Nur
      // Skalare + Diaet-Flags (vegan impliziert vegetarisch). Das Produktfoto (falls
      // vorhanden, ausschliesslich eine oeffentliche OFF-URL) bleibt unveraendert.
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json({ error: "bad_name" }, 400);
      const barcode = String(body.barcode || "").replace(/\D/g, "").slice(0, 40);
      const brand = String(body.brand || "").trim().slice(0, 80);
      const unit = String(body.unit) === "ml" ? "ml" : "g";
      const base_g = clamp(num(body.base_g, 100), 1, 100000);
      const kcal = clamp(num(body.kcal), 0, 99999);
      const sat = clamp(num(body.sat_fat_g), 0, 1000);
      const sugar = clamp(num(body.sugar_g), 0, 1000);
      const protein = clamp(num(body.protein_g), 0, 1000);
      const fiber = clamp(num(body.fiber_g), 0, 1000);
      const vegan = body.vegan === true || body.vegan === "true" || body.vegan === 1;
      const vegetarian = vegan || body.vegetarian === true || body.vegetarian === "true" || body.vegetarian === 1;
      const r = await sql`update punkto.community_products set
            barcode = ${barcode}, name = ${name}, brand = ${brand}, unit = ${unit}, base_g = ${base_g},
            kcal = ${kcal}, sat_fat_g = ${sat}, sugar_g = ${sugar}, protein_g = ${protein}, fiber_g = ${fiber},
            vegan = ${vegan}, vegetarian = ${vegetarian},
            status = 'approved', moderated_at = now(), moderated_by = 'operator'
          where id = ${id}
          returning id, barcode, name, brand, unit, base_g, kcal, sat_fat_g, sugar_g, protein_g, fiber_g,
                    vegan, vegetarian, photo_url, created_at, moderated_at`;
      if (!r[0]) return json({ error: "not_found" }, 404);
      return json({ ok: true, product: r[0] });
    }

    if (action === "central_delete") {
      // Einen Eintrag aus der zentralen Datenbank entfernen (harte Loeschung -- die
      // Tabelle enthaelt nur Skalare/oeffentliche URLs, keine PII/Fotos im Storage).
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const r = await sql`delete from punkto.community_products where id = ${id} returning id`;
      if (!r.length) return json({ error: "not_found" }, 404);
      return json({ ok: true, id: r[0].id });
    }

    if (action === "off_bulk_upsert") {
      // Bulk-Upsert von Open-Food-Facts-Naehrwerten (DE/AT/CH) in punkto.off_products.
      // Wird vom lokalen Import-Skript (04_off_upload.py) in Batches (~500) aufgerufen.
      // GETRENNT von community_products/bls_foods gehalten (ODbL Share-alike). Naehrwerte
      // werden OHNE Clamping gespeichert (Audit-Treue; Punkte berechnet der Client). Der
      // Plausibilitaets-Check ist bereits lokal gelaufen -> plausible + quality_flags
      // kommen fertig mit. Konflikt auf barcode -> Feld-Update (fuer Monats-Refresh).
      const rowsIn = Array.isArray(body.rows) ? body.rows : null;
      if (!rowsIn) return json({ error: "bad_rows" }, 400);
      const batch = rowsIn.slice(0, 2000); // Sicherheitskappe (max ~34k Parameter << 65535)
      const txt = (v: any, max: number) => {
        if (v === null || v === undefined) return null;
        const s = String(v).split(String.fromCharCode(0)).join("").trim();
        return s ? s.slice(0, max) : null;
      };
      const numOrNull = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      const tsOrNull = (v: any) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
      const clean: Record<string, any>[] = [];
      let skipped = 0;
      for (const r of batch) {
        const barcode = String(r?.barcode ?? "").replace(/\D/g, "");
        if (barcode.length < 8) { skipped++; continue; } // ungueltiger/zu kurzer EAN -> raus
        clean.push({
          barcode: barcode.slice(0, 40),
          name: txt(r?.name, 200),
          brand: txt(r?.brand, 120),
          quantity: txt(r?.quantity, 60),
          categories: txt(r?.categories, 300),
          kcal: numOrNull(r?.kcal),
          sat_fat_g: numOrNull(r?.sat_fat_g),
          sugar_g: numOrNull(r?.sugar_g),
          protein_g: numOrNull(r?.protein_g),
          fiber_g: numOrNull(r?.fiber_g),
          fat_g: numOrNull(r?.fat_g),
          carbs_g: numOrNull(r?.carbs_g),
          alcohol_g: numOrNull(r?.alcohol_g),
          // plausible=true als Default; nur explizit falsy-Werte kippen es auf false:
          plausible: !(r?.plausible === false || r?.plausible === "false" || r?.plausible === 0 || r?.plausible === "0"),
          quality_flags: txt(r?.quality_flags, 500),
          completeness: numOrNull(r?.completeness),
          off_last_modified: tsOrNull(r?.off_last_modified),
        });
      }
      if (!clean.length) return json({ ok: true, received: batch.length, upserted: 0, skipped });
      const OFF_COLS = ["barcode", "name", "brand", "quantity", "categories", "kcal",
        "sat_fat_g", "sugar_g", "protein_g", "fiber_g", "fat_g", "carbs_g", "alcohol_g",
        "plausible", "quality_flags", "completeness", "off_last_modified"];
      const up = await sql`
        insert into punkto.off_products ${sql(clean, ...OFF_COLS)}
        on conflict (barcode) do update set
          name = excluded.name, brand = excluded.brand, quantity = excluded.quantity,
          categories = excluded.categories, kcal = excluded.kcal, sat_fat_g = excluded.sat_fat_g,
          sugar_g = excluded.sugar_g, protein_g = excluded.protein_g, fiber_g = excluded.fiber_g,
          fat_g = excluded.fat_g, carbs_g = excluded.carbs_g, alcohol_g = excluded.alcohol_g,
          plausible = excluded.plausible, quality_flags = excluded.quality_flags,
          completeness = excluded.completeness, off_last_modified = excluded.off_last_modified,
          source = 'openfoodfacts', imported_at = now()
        returning barcode`;
      return json({ ok: true, received: batch.length, upserted: up.length, skipped });
    }

    if (action === "off_stats") {
      // Zaehler fuer den OFF-Import (Betreiber-Sicht / Import-Skript-Verifikation).
      const [tot, plaus, flagged, last] = await Promise.all([
        sql`select count(*)::int as n from punkto.off_products`,
        sql`select count(*)::int as n from punkto.off_products where plausible`,
        sql`select count(*)::int as n from punkto.off_products where not plausible`,
        sql`select max(imported_at) as t from punkto.off_products`,
      ]);
      return json({ ok: true, total: tot[0].n, plausible: plaus[0].n, flagged: flagged[0].n, last_import: last[0].t });
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
