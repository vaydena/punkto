// Punkto – eigene, leichte Authentifizierung (kein Supabase-Auth).
// Sessions als opake Tokens (nur SHA-256-Hash gespeichert), Passwoerter als bcrypt
// (pgcrypto). Zugriff auf das unexponierte Schema punkto ausschliesslich hier,
// als postgres-Owner ueber SUPABASE_DB_URL.
import postgres from "npm:postgres@3";

// CORS: nur bekannte Urspruenge (Browser). Zusaetzliche per Secret PK_ALLOWED_ORIGINS
// (kommagetrennt), z. B. fuer lokale Tests. Aufrufe ohne Origin (Server/CLI) unberuehrt.
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
const SITE = "https://punkto.vaydena.de";
const TRIAL_DAYS = 14;
const SESSION_DAYS = 120;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// bcrypt wertet nur die ersten 72 Byte aus -> laengere Passwoerter ablehnen statt still kuerzen.
const pwTooLong = (p: string) => new TextEncoder().encode(p).length > 72;
function bearer(req: Request) {
  return ((req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "").trim();
}
// Einfaches Ratenlimit ueber punkto.auth_attempts (kind frei waehlbar).
async function tooMany(kind: string, by: { email?: string; ip?: string | null }, max: number, minutes: number, onlyFails = true) {
  if (by.email == null && !by.ip) return false;
  const r = by.email != null
    ? await sql`select count(*)::int c from punkto.auth_attempts where email = ${by.email} and kind = ${kind}
                 and (${!onlyFails} or ok = false) and at > now() - make_interval(mins => ${minutes})`
    : await sql`select count(*)::int c from punkto.auth_attempts where ip = ${by.ip!} and kind = ${kind}
                 and (${!onlyFails} or ok = false) and at > now() - make_interval(mins => ${minutes})`;
  return r[0].c >= max;
}
async function logAttempt(kind: string, email: string | null, ok: boolean, ip: string | null) {
  try { await sql`insert into punkto.auth_attempts (email, kind, ok, ip) values (${email}, ${kind}, ${ok}, ${ip})`; }
  catch (_e) { /* reines Protokoll */ }
}

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
      (status is distinct from 'blocked'
        and now() < greatest(coalesce(trial_ends_at,'epoch'::timestamptz), coalesce(current_period_end,'epoch'::timestamptz))) as access
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

const handler = async (req: Request): Promise<Response> => {
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
      if (pwTooLong(password)) return json({ error: "password_too_long" }, 400);
      const ip = clientIp(req);
      if (await tooMany("register", { ip }, 5, 60, false)) return json({ error: "rate_limited" }, 429);
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
      await logAttempt("register", email, true, ip);
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
      if (await tooMany("login", { ip: clientIp(req) }, 30, 15)) return json({ error: "rate_limited" }, 429);
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
    if (action === "me" || action === "logout" || action === "update_profile" || action === "change_password" || action === "delete_account") {
      const u = await sessionUser(req);
      if (!u) return json({ error: "unauthorized" }, 401);

      if (action === "me") {
        return json({ ok: true, user: pubUser(u), subscription: await subFor(u.id) });
      }
      if (action === "logout") {
        const token = bearer(req);
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
        if (pwTooLong(nw)) return json({ error: "password_too_long" }, 400);
        if (await tooMany("change_password", { email: u.email }, 5, 15)) return json({ error: "rate_limited" }, 429);
        const chk = await sql`select (extensions.crypt(${cur}, ${u.pass_hash}) = ${u.pass_hash}) as ok`;
        if (!chk[0].ok) { await logAttempt("change_password", u.email, false, clientIp(req)); return json({ error: "bad_credentials" }, 401); }
        const keep = await sha256hex(bearer(req));
        await sql.begin(async (tx) => {
          await tx`update punkto.users set pass_hash = extensions.crypt(${nw}, extensions.gen_salt('bf', 10)) where id = ${u.id}`;
          // Alle ANDEREN Sitzungen beenden (z. B. ein verlorenes Handy); diese bleibt aktiv.
          await tx`delete from punkto.sessions where user_id = ${u.id} and token_hash <> ${keep}`;
        });
        return json({ ok: true });
      }
      if (action === "delete_account") {
        // Konto endgueltig loeschen (DSGVO Art. 17). Passwort-Bestaetigung Pflicht.
        // Gibt es verbuchte Zahlungen, muessen diese (Aufbewahrungspflicht, § 147 AO)
        // bleiben: dann werden alle Nutzungsdaten geloescht und das Konto anonymisiert;
        // sonst wird der Nutzer komplett entfernt (FKs: ON DELETE CASCADE).
        const cur = String(body.password || "");
        if (await tooMany("delete_account", { email: u.email }, 5, 15)) return json({ error: "rate_limited" }, 429);
        const chk = await sql`select (extensions.crypt(${cur}, ${u.pass_hash}) = ${u.pass_hash}) as ok`;
        if (!chk[0].ok) { await logAttempt("delete_account", u.email, false, clientIp(req)); return json({ error: "bad_credentials" }, 401); }
        const oldEmail = String(u.email || "").toLowerCase();
        let mode = "deleted";
        await sql.begin(async (tx) => {
          const pay = await tx`select 1 from punkto.payments where user_id = ${u.id} limit 1`;
          await tx`update punkto.community_products set submitted_by = null where submitted_by = ${u.id}`;
          if (!pay.length) {
            await tx`delete from punkto.users where id = ${u.id}`;
          } else {
            mode = "anonymized";
            await tx`delete from punkto.diary_entries where user_id = ${u.id}`;
            await tx`delete from punkto.weight_logs where user_id = ${u.id}`;
            await tx`delete from punkto.activity_logs where user_id = ${u.id}`;
            await tx`delete from punkto.custom_foods where user_id = ${u.id}`;
            await tx`delete from punkto.recipes where user_id = ${u.id}`;
            await tx`delete from punkto.sessions where user_id = ${u.id}`;
            await tx`delete from punkto.reset_tokens where user_id = ${u.id}`;
            await tx`update punkto.users set email = ${"geloescht-" + u.id + "@invalid"},
                pass_hash = extensions.crypt(${newToken()}, extensions.gen_salt('bf', 10)), display_name = 'Geloescht',
                sex = null, birth_year = null, height_cm = null, start_weight_kg = null, goal_weight_kg = null,
                activity_level = null, daily_budget = null, onboarded = false, email_verified = false, last_active_on = null
              where id = ${u.id}`;
            await tx`update punkto.subscriptions set status = 'canceled', updated_at = now() where user_id = ${u.id}`;
          }
          await tx`delete from punkto.auth_attempts where lower(email) = ${oldEmail}`;
        });
        return json({ ok: true, mode });
      }
    }

    if (action === "request_reset") {
      const email = String(body.email || "").trim().toLowerCase();
      const ip = clientIp(req);
      const limited = (EMAIL_RE.test(email) && await tooMany("reset_req", { email }, 3, 60, false))
        || await tooMany("reset_req", { ip }, 10, 60, false);
      if (EMAIL_RE.test(email) && !limited) {
        await logAttempt("reset_req", email, true, ip);
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
      if (pwTooLong(password)) return json({ error: "password_too_long" }, 400);
      const ip = clientIp(req);
      if (await tooMany("reset", { ip }, 10, 15)) return json({ error: "rate_limited" }, 429);
      const th = await sha256hex(token);
      // Token atomar verbrauchen (kein doppeltes Einloesen bei parallelen Aufrufen).
      const r = await sql`update punkto.reset_tokens set used_at = now()
                           where token_hash = ${th} and used_at is null and expires_at > now() returning user_id`;
      if (!r.length) { await logAttempt("reset", null, false, ip); return json({ error: "invalid_token" }, 400); }
      const rt = r[0];
      await sql.begin(async (tx) => {
        await tx`update punkto.users set pass_hash = extensions.crypt(${password}, extensions.gen_salt('bf', 10)) where id = ${rt.user_id}`;
        await tx`delete from punkto.sessions where user_id = ${rt.user_id}`;
      });
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    try { console.error("punkto-auth", action, String((e as Error)?.message || e)); } catch (_e) { /* ignore */ }
    return json({ error: "server_error" }, 500);
  }
};
Deno.serve(async (req: Request) => withCors(req, await handler(req)));
