// Punkto – eigene, leichte Authentifizierung (kein Supabase-Auth).
// Sessions als opake Tokens (nur SHA-256-Hash gespeichert), Passwoerter als bcrypt
// (pgcrypto). Zugriff auf das unexponierte Schema punkto ausschliesslich hier,
// als postgres-Owner ueber SUPABASE_DB_URL.
import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
const SITE = "https://punkto.vaydena.de";
const TRIAL_DAYS = 14;
const SESSION_DAYS = 120;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function esc(s: unknown) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}
function clientIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for") || "";
  return (xff.split(",")[0] || "").trim().slice(0, 45) || null;
}

function withTimeout<T>(p: Promise<T>, ms: number) {
  let t: number;
  const to = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}
async function sendMail(to: string, subject: string, text: string, html: string) {
  const user = Deno.env.get("MAIL_USER"); const pass = Deno.env.get("MAIL_PASSWORD");
  if (!user || !pass) return { ok: false, err: "mail_not_configured" };
  const host = Deno.env.get("MAIL_SMTP_HOST") || "smtp.hostinger.com";
  const port = Number(Deno.env.get("MAIL_SMTP_PORT") || "465");
  const from = Deno.env.get("MAIL_FROM") || user;
  let SMTPClient: any;
  try { ({ SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts")); }
  catch (e) { return { ok: false, err: "smtp_module:" + String((e && (e as Error).message) || e) }; }
  const client = new SMTPClient({ connection: { hostname: host, port, tls: true, auth: { username: user, password: pass } } });
  try {
    await withTimeout(client.send({ from: "Punkto <" + from + ">", to, subject, content: text, html }), 20000);
    return { ok: true };
  } catch (e) { return { ok: false, err: String((e && (e as Error).message) || e) }; }
  finally { try { await withTimeout(client.close(), 5000); } catch (_e) { /* ignore */ } }
}

const shell = (inner: string) =>
  `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#14232b;max-width:560px;margin:0 auto">`
  + `<div style="font-size:22px;font-weight:800;color:#0e7a50;margin:0 0 14px">Punkto<span style="color:#ff6b57">.</span></div>`
  + inner
  + `<p style="font-size:13px;color:#6b7d78;margin-top:22px">Herzliche Gruesse<br>Dein Punkto-Team &middot; kontakt@vaydena.de</p></div>`;

async function mailWelcome(to: string, name: string) {
  const link = SITE + "/app.html";
  const text = `Hallo ${name || ""},\n\nwillkommen bei Punkto! Deine 14 Tage kostenlos starten jetzt.\n`
    + `Leg direkt los: ${link}\n\nDu kannst dein Essen tracken, dein Punktebudget im Blick behalten `
    + `und deinen Fortschritt sehen.\n\nDein Punkto-Team`;
  const html = shell(
    `<h2 style="color:#0e7a50;margin:0 0 10px">Willkommen bei Punkto!</h2>`
    + `<p>Hallo ${esc(name)},</p><p>schoen, dass du dabei bist. Deine <b>14 Tage kostenlos</b> starten jetzt.</p>`
    + `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#16a06a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">Punkto oeffnen</a></p>`
    + `<p style="font-size:14px;color:#6b7d78">Tracke dein Essen, behalte dein Punktebudget im Blick und sieh deinen Fortschritt.</p>`
    + `<p style="font-size:12px;color:#9aa8a3">Punkto ist ein Ernaehrungs- und Motivationswerkzeug und ersetzt keine aerztliche oder ernaehrungsmedizinische Beratung.</p>`,
  );
  return await sendMail(to, "Willkommen bei Punkto", text, html);
}
async function mailReset(to: string, name: string, token: string) {
  const link = SITE + "/anmelden.html?reset=" + encodeURIComponent(token);
  const text = `Hallo ${name || ""},\n\ndu hast ein neues Passwort fuer Punkto angefordert.\n`
    + `Neues Passwort setzen (2 Stunden gueltig):\n${link}\n\n`
    + `Wenn du das nicht warst, ignoriere diese E-Mail einfach.\n\nDein Punkto-Team`;
  const html = shell(
    `<h2 style="color:#0e7a50;margin:0 0 10px">Passwort zuruecksetzen</h2>`
    + `<p>Hallo ${esc(name)},</p><p>du hast ein neues Passwort fuer Punkto angefordert.</p>`
    + `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#16a06a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">Neues Passwort setzen</a></p>`
    + `<p style="font-size:13px;color:#6b7d78">Der Link ist 2 Stunden gueltig. Wenn du das nicht warst, ignoriere diese E-Mail.</p>`,
  );
  return await sendMail(to, "Punkto – Passwort zuruecksetzen", text, html);
}

function pubUser(u: any) {
  return {
    id: u.id, email: u.email, display_name: u.display_name, sex: u.sex, birth_year: u.birth_year,
    height_cm: u.height_cm, start_weight_kg: u.start_weight_kg, goal_weight_kg: u.goal_weight_kg,
    activity_level: u.activity_level, daily_budget: u.daily_budget, weekly_extra: u.weekly_extra,
    onboarded: u.onboarded, email_verified: u.email_verified, created_at: u.created_at,
  };
}
async function subFor(user_id: string) {
  const r = await sql`
    select status, plan, trial_ends_at, current_period_end,
      greatest(coalesce(trial_ends_at,'epoch'::timestamptz), coalesce(current_period_end,'epoch'::timestamptz)) as ends_at,
      (now() < greatest(coalesce(trial_ends_at,'epoch'::timestamptz), coalesce(current_period_end,'epoch'::timestamptz))) as access
    from punkto.subscriptions where user_id = ${user_id} limit 1`;
  return r[0] || null;
}
async function sessionUser(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = (m ? m[1] : "").trim();
  if (!token) return null;
  const th = await sha256hex(token);
  const r = await sql`
    select u.* from punkto.sessions s join punkto.users u on u.id = s.user_id
     where s.token_hash = ${th} and s.expires_at > now() limit 1`;
  return r[0] || null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body?.action ?? "").trim();

  try {
    if (action === "register") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = (String(body.display_name || "").trim().slice(0, 40)) || email.split("@")[0].slice(0, 40);
      if (!EMAIL_RE.test(email)) return json({ error: "bad_email" }, 400);
      if (password.length < 8) return json({ error: "weak_password" }, 400);
      const dup = await sql`select 1 from punkto.users where lower(email) = ${email} limit 1`;
      if (dup.length) return json({ error: "email_taken" }, 409);
      const ins = await sql`
        insert into punkto.users (email, pass_hash, display_name)
        values (${email}, extensions.crypt(${password}, extensions.gen_salt('bf', 10)), ${name})
        returning *`;
      const u = ins[0];
      await sql`insert into punkto.subscriptions (user_id, status, trial_ends_at)
                values (${u.id}, 'trial', now() + make_interval(days => ${TRIAL_DAYS}))`;
      const token = newToken(); const th = await sha256hex(token);
      await sql`insert into punkto.sessions (token_hash, user_id, expires_at, user_agent)
                values (${th}, ${u.id}, now() + make_interval(days => ${SESSION_DAYS}), ${String(req.headers.get("user-agent") || "").slice(0, 200)})`;
      mailWelcome(email, name).catch(() => {});
      return json({ ok: true, token, user: pubUser(u), subscription: await subFor(u.id) });
    }

    if (action === "login") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!EMAIL_RE.test(email) || !password) return json({ error: "bad_credentials" }, 401);
      const fails = await sql`select count(*)::int c from punkto.auth_attempts
        where email = ${email} and kind = 'login' and ok = false and at > now() - interval '15 minutes'`;
      if (fails[0].c >= 10) return json({ error: "rate_limited" }, 429);
      const r = await sql`select * from punkto.users where lower(email) = ${email} limit 1`;
      const u = r[0];
      let good = false;
      if (u) {
        const chk = await sql`select (extensions.crypt(${password}, ${u.pass_hash}) = ${u.pass_hash}) as ok`;
        good = !!chk[0].ok;
      }
      await sql`insert into punkto.auth_attempts (email, kind, ok, ip) values (${email}, 'login', ${good}, ${clientIp(req)})`;
      if (!good) return json({ error: "bad_credentials" }, 401);
      await sql`update punkto.users set last_login_at = now() where id = ${u.id}`;
      const token = newToken(); const th = await sha256hex(token);
      await sql`insert into punkto.sessions (token_hash, user_id, expires_at, user_agent)
                values (${th}, ${u.id}, now() + make_interval(days => ${SESSION_DAYS}), ${String(req.headers.get("user-agent") || "").slice(0, 200)})`;
      return json({ ok: true, token, user: pubUser(u), subscription: await subFor(u.id) });
    }

    // ── Ab hier: Session erforderlich ────────────────────────────────────────
    if (action === "me" || action === "logout" || action === "update_profile" || action === "change_password") {
      const u = await sessionUser(req);
      if (!u) return json({ error: "unauthorized" }, 401);

      if (action === "me") {
        return json({ ok: true, user: pubUser(u), subscription: await subFor(u.id) });
      }
      if (action === "logout") {
        const auth = req.headers.get("authorization") || "";
        const token = (auth.match(/^Bearer\s+(.+)$/i)?.[1] || "").trim();
        if (token) await sql`delete from punkto.sessions where token_hash = ${await sha256hex(token)}`;
        return json({ ok: true });
      }
      if (action === "update_profile") {
        const p = body.profile && typeof body.profile === "object" ? body.profile : body;
        const clampNum = (v: any, lo: number, hi: number) => {
          const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
        };
        const name = p.display_name != null ? String(p.display_name).trim().slice(0, 40) : u.display_name;
        const sex = ["w", "m", "d"].includes(String(p.sex)) ? String(p.sex) : u.sex;
        const act = ["low", "med", "high"].includes(String(p.activity_level)) ? String(p.activity_level) : u.activity_level;
        const by = p.birth_year != null ? clampNum(p.birth_year, 1920, 2020) : u.birth_year;
        const hc = p.height_cm != null ? clampNum(p.height_cm, 120, 230) : u.height_cm;
        const sw = p.start_weight_kg != null ? clampNum(p.start_weight_kg, 30, 400) : u.start_weight_kg;
        const gw = p.goal_weight_kg != null ? clampNum(p.goal_weight_kg, 30, 400) : u.goal_weight_kg;
        const db = p.daily_budget != null ? clampNum(p.daily_budget, 10, 80) : u.daily_budget;
        const we = p.weekly_extra != null ? clampNum(p.weekly_extra, 0, 60) : u.weekly_extra;
        const ob = p.onboarded != null ? !!p.onboarded : u.onboarded;
        const r = await sql`update punkto.users set
            display_name = ${name}, sex = ${sex}, activity_level = ${act},
            birth_year = ${by}, height_cm = ${hc}, start_weight_kg = ${sw}, goal_weight_kg = ${gw},
            daily_budget = ${db}, weekly_extra = ${we}, onboarded = ${ob}
          where id = ${u.id} returning *`;
        return json({ ok: true, user: pubUser(r[0]), subscription: await subFor(u.id) });
      }
      if (action === "change_password") {
        const cur = String(body.current || ""); const nw = String(body.password || "");
        if (nw.length < 8) return json({ error: "weak_password" }, 400);
        const chk = await sql`select (extensions.crypt(${cur}, ${u.pass_hash}) = ${u.pass_hash}) as ok`;
        if (!chk[0].ok) return json({ error: "bad_credentials" }, 401);
        await sql`update punkto.users set pass_hash = extensions.crypt(${nw}, extensions.gen_salt('bf', 10)) where id = ${u.id}`;
        return json({ ok: true });
      }
    }

    if (action === "request_reset") {
      const email = String(body.email || "").trim().toLowerCase();
      if (EMAIL_RE.test(email)) {
        const r = await sql`select id, display_name from punkto.users where lower(email) = ${email} limit 1`;
        if (r.length) {
          const token = newToken(); const th = await sha256hex(token);
          await sql`insert into punkto.reset_tokens (token_hash, user_id, expires_at)
                    values (${th}, ${r[0].id}, now() + interval '2 hours')`;
          mailReset(email, r[0].display_name, token).catch(() => {});
        }
      }
      return json({ ok: true }); // keine Nutzer-Enumeration
    }

    if (action === "reset") {
      const token = String(body.token || "").trim();
      const password = String(body.password || "");
      if (!token || password.length < 8) return json({ error: "weak_password" }, 400);
      const th = await sha256hex(token);
      const r = await sql`select * from punkto.reset_tokens where token_hash = ${th} and used_at is null and expires_at > now() limit 1`;
      if (!r.length) return json({ error: "invalid_token" }, 400);
      const rt = r[0];
      await sql`update punkto.users set pass_hash = extensions.crypt(${password}, extensions.gen_salt('bf', 10)) where id = ${rt.user_id}`;
      await sql`update punkto.reset_tokens set used_at = now() where token_hash = ${th}`;
      await sql`delete from punkto.sessions where user_id = ${rt.user_id}`;
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    try { console.error("punkto-auth", action, String((e as Error)?.message || e)); } catch (_e) { /* ignore */ }
    return json({ error: "server_error" }, 500);
  }
});
