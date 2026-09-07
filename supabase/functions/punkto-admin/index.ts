// Punkto - Betreiber-Bereich (Operator). Zugang nur mit Betreiber-Schluessel
// (SHA-256-Hash in punkto.admin_auth id=1, constant-time). Kein Konto noetig.
// Aktionen: stats, users, user, extend (Abo verlaengern), set_status, add_payment,
// moderate (Post ein-/ausblenden, loeschen), export, set_key (Schluessel rotieren).
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
      const [tot, active, trial, expired, rev, posts, recent] = await Promise.all([
        sql`select count(*)::int as n from punkto.users`,
        sql`select count(*)::int as n from punkto.subscriptions where current_period_end > now()`,
        sql`select count(*)::int as n from punkto.subscriptions where (current_period_end is null or current_period_end <= now()) and trial_ends_at > now()`,
        sql`select count(*)::int as n from punkto.subscriptions where coalesce(current_period_end, trial_ends_at) <= now()`,
        sql`select coalesce(sum(amount_cents),0)::int as c, count(*)::int as n from punkto.payments`,
        sql`select count(*)::int as n from punkto.community_posts where hidden = false`,
        sql`select date_trunc('day', created_at)::date::text as day, count(*)::int as n
              from punkto.users where created_at > now() - interval '30 days'
              group by 1 order by 1`,
      ]);
      return json({
        ok: true,
        users_total: tot[0].n, subs_active: active[0].n, subs_trial: trial[0].n, subs_expired: expired[0].n,
        revenue_cents: rev[0].c, payments_count: rev[0].n, posts_count: posts[0].n, signups_30d: recent,
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
      const amount = clamp(Number(body.amount_cents) ?? 499, 0, 1000000);
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

    if (action === "moderate") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const op = String(body.op || "");
      if (op === "hide") await sql`update punkto.community_posts set hidden = true where id = ${id}`;
      else if (op === "show") await sql`update punkto.community_posts set hidden = false where id = ${id}`;
      else if (op === "delete") { await sql`delete from punkto.community_likes where post_id = ${id}`; await sql`delete from punkto.community_posts where id = ${id}`; }
      else return json({ error: "bad_op" }, 400);
      return json({ ok: true });
    }

    if (action === "posts") {
      const limit = clamp(Number(body.limit) || 50, 1, 200);
      const onlyReported = body.reported === true;
      const rows = onlyReported
        ? await sql`select id, author_name, kind, body, meta, likes, hidden, created_at from punkto.community_posts
                     where (meta->>'reported') = 'true' order by created_at desc limit ${limit}`
        : await sql`select id, author_name, kind, body, meta, likes, hidden, created_at from punkto.community_posts
                     order by created_at desc limit ${limit}`;
      return json({ ok: true, posts: rows });
    }

    if (action === "export") {
      const [users, subs, payments] = await Promise.all([
        sql`select id, email, display_name, created_at, last_login_at, onboarded from punkto.users order by created_at`,
        sql`select user_id, status, plan, trial_ends_at, current_period_end, updated_at from punkto.subscriptions`,
        sql`select id, user_id, amount_cents, method, months, ref, note, created_by, created_at from punkto.payments order by created_at`,
      ]);
      return json({ ok: true, exported_at: new Date().toISOString(), users, subscriptions: subs, payments });
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
