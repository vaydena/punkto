// Punkto - Tracking-Daten (Tagebuch, Gewicht, Aktivitaet, eigene Lebensmittel,
// Rezepte). Session-geschuetzt. Schreibaktionen verlangen aktiven Zugang
// (Testphase oder Abo); Lesen ist immer moeglich (keine Datenverluste).
import postgres from "npm:postgres@3";
import QRCode from "npm:qrcode@1";

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Gibt einen gueltigen ISO-Zeitstempel zurueck oder null (fuer optionale client-
// seitige created_at / den Sync-Cursor „since"). Niemals werfen -> null bei Muell.
const tsOrNull = (v: any): string | null => {
  if (v == null || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// --- Zahlung (manuell): feste Betreiber-Bankdaten + Preis --------------------
const PRICE_CENTS = 299;        // 2,99 EUR / Monat
const PRICE_CENTS_YEAR = 2999;  // 29,99 EUR / Jahr (rund 2 Monate gratis ggue. 12x2,99 = 35,88)
const BANK = { holder: "Karl-Heinz Bicker", iban: "DE95700510030000785303", bic: "BYLADEM1FSI" };
const PAYPAL = { email: "kontakt@vaydena.de", link: "" }; // link leer => "an E-Mail senden"-Weg
const ISSUER = {
  name: "Vaydena - Softwarelösungen",
  owner: "Karl-Heinz Bicker",
  street: "Biberstraße 27",
  zip: "85354",
  city: "Freising",
  email: "kontakt@vaydena.de",
};
const TAX_NOTE = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).";

function formatIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
// EPC069-12 (GiroCode) Nutzdaten - eine Zahlung, EUR, mit Verwendungszweck.
function buildEpcPayload(p: { holder: string; iban: string; bic: string; amount: number; reference: string }): string | null {
  const holder = p.holder.trim();
  const iban = p.iban.replace(/\s+/g, "").toUpperCase();
  const bic = (p.bic || "").replace(/\s+/g, "").toUpperCase();
  const reference = (p.reference || "").trim();
  if (!holder || holder.length > 70) return null;
  if (!iban || iban.length > 34) return null;
  if (bic && bic.length !== 8 && bic.length !== 11) return null;
  if (reference.length > 140) return null;
  if (!Number.isFinite(p.amount)) return null;
  const amount = Math.round(p.amount * 100) / 100;
  if (amount < 0.01 || amount > 999999999.99) return null;
  const lines = ["BCD", "002", "1", "SCT", bic, holder, iban, `EUR${amount.toFixed(2)}`, "", "", reference];
  const payload = lines.join("\n");
  if (new TextEncoder().encode(payload).length > 331) return null;
  return payload;
}
// Rendert den GiroCode als SVG-Pfad (Modul = 1x1) + Kantenlaenge inkl. Ruhezone.
function buildGiro(p: { holder: string; iban: string; bic: string; amount: number; reference: string }): { path: string; size: number } | null {
  const payload = buildEpcPayload(p);
  if (!payload) return null;
  try {
    const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const data = qr.modules.data;
    const quiet = 4;
    const size = n + quiet * 2;
    let path = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (data[r * n + c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return { path, size };
  } catch {
    return null;
  }
}

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Hinweis: Der fruehere Community-Foto-Upload (privater Storage-Bucket) wurde entfernt.
// Die zentrale Lebensmittel-Datenbank pflegt jetzt ausschliesslich der Betreiber ueber
// die App; Produktbilder kommen als stabile, oeffentliche Open-Food-Facts-https-URL
// (kein Upload, kein Bucket -> keine PII, kein EXIF).

async function auth(req: Request) {
  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const th = await sha256hex(token);
  const r = await sql`
    select u.id, u.email, u.display_name, u.sex, u.birth_year, u.height_cm,
           u.start_weight_kg, u.goal_weight_kg, u.activity_level, u.daily_budget,
           u.weekly_extra, u.onboarded, u.email_verified, u.is_admin, u.created_at,
           sb.status as sub_status, sb.plan as sub_plan,
           sb.trial_ends_at, sb.current_period_end,
           greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz)) as ends_at,
           (sb.status is distinct from 'blocked'
             and now() < greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz))) as access
      from punkto.sessions s
      join punkto.users u on u.id = s.user_id
      left join punkto.subscriptions sb on sb.user_id = u.id
     where s.token_hash = ${th} and s.expires_at > now() limit 1`;
  return r[0] || null;
}
function pubUser(u: any) {
  return {
    id: u.id, email: u.email, display_name: u.display_name, sex: u.sex, birth_year: u.birth_year,
    height_cm: u.height_cm, start_weight_kg: u.start_weight_kg, goal_weight_kg: u.goal_weight_kg,
    activity_level: u.activity_level, daily_budget: u.daily_budget, weekly_extra: u.weekly_extra,
    onboarded: u.onboarded, email_verified: u.email_verified, is_admin: !!u.is_admin, created_at: u.created_at,
  };
}
function subView(u: any) {
  return { status: u.sub_status, plan: u.sub_plan, trial_ends_at: u.trial_ends_at, current_period_end: u.current_period_end, ends_at: u.ends_at, access: u.access };
}

// --- Abo-Token (Ed25519, offline pruefbar) -----------------------------------
// Die App traegt NUR den oeffentlichen Schluessel (assets/pk-token.js) und prueft
// den Token offline per crypto.subtle.verify. Der PRIVATE Schluessel liegt
// AUSSCHLIESSLICH als Edge-Function-Secret PK_TOKEN_SK (base64 PKCS#8) vor -
// nie im Repo, nie auf Hostinger. Fehlt das Secret, liefert mintToken() null;
// die App bleibt dann uneingeschraenkt nutzbar (Uebergang, kein Lockout).
// Token = base64url(JSON payload) + "." + base64url(Ed25519-Signatur).
// payload = { v, uid, exp(=gueltig-bis, Unix-Sekunden), iat, status, plan }.
function b64urlBytes(bytes: Uint8Array): string {
  let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string { return b64urlBytes(new TextEncoder().encode(s)); }

let _tokKey: CryptoKey | null | undefined; // undefined = noch nicht versucht, null = nicht verfuegbar
async function tokenKey(): Promise<CryptoKey | null> {
  if (_tokKey !== undefined) return _tokKey;
  try {
    const b64 = Deno.env.get("PK_TOKEN_SK");
    if (!b64) { _tokKey = null; return null; }
    const raw = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
    _tokKey = await crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
  } catch (_e) { _tokKey = null; }
  return _tokKey;
}
async function mintToken(u: any): Promise<string | null> {
  try {
    const key = await tokenKey();
    if (!key) return null;
    // Gesperrt (Betreiber) -> Token sofort abgelaufen (App wird schreibgeschuetzt, Daten bleiben lesbar).
    const endsMs = (u.ends_at && u.sub_status !== "blocked") ? new Date(u.ends_at).getTime() : 0;
    const exp = Number.isFinite(endsMs) ? Math.floor(endsMs / 1000) : 0;
    const iat = Math.floor(Date.now() / 1000);
    const payload = { v: 1, uid: String(u.id), exp, iat, status: u.sub_status || null, plan: u.sub_plan || null };
    const payloadB64 = b64urlStr(JSON.stringify(payload));
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(payloadB64));
    return payloadB64 + "." + b64urlBytes(new Uint8Array(sig));
  } catch (_e) { return null; }
}
// --- Aktivitaetssignal (opportunistisch, datensparsam) -----------------------
// Haelt NUR ein Datum "zuletzt aktiv" je Nutzer - KEIN Zaehler, KEINE Ereignis-
// historie. Aktualisiert wird ausschliesslich bei ohnehin stattfindenden Online-
// Aufrufen (state-Boot / token-Refresh), hoechstens einmal je Kalendertag, und
// NIE erzwungen. Faellt still aus (try/catch), damit ein fehlendes Feld oder ein
// DB-Zucken NIE einen Datenabruf kippt und NIE das lokale Speichern blockiert.
async function touchActive(u: any) {
  try {
    await sql`update punkto.users set last_active_on = current_date
                where id = ${u.id}
                  and (last_active_on is null or last_active_on < current_date)`;
  } catch (_e) { /* egal - reines Signal, nie kritisch */ }
}
function weekRange(dayStr: string) {
  const d = new Date(dayStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mo = 0
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const f = (x: Date) => x.toISOString().slice(0, 10);
  return { start: f(mon), end: f(sun) };
}

const WRITE = new Set([
  "diary_add", "diary_update", "diary_del", "weight_set", "weight_del",
  "activity_add", "activity_set_steps", "activity_del",
  "food_add", "food_update", "food_del", "recipe_add", "recipe_update", "recipe_del",
  "sync_push", // Dual-Write-Batch: schreibt Tagebuch/Gewicht/Aktivitaet -> Zugang noetig
]);

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body?.action ?? "").trim();

  const u = await auth(req);
  if (!u) return json({ error: "unauthorized" }, 401);
  if (WRITE.has(action) && !u.access) return json({ error: "no_access", subscription: subView(u) }, 402);

  const today = new Date().toISOString().slice(0, 10);
  const day = DATE_RE.test(String(body.day)) ? String(body.day) : today;

  try {
    if (action === "state") {
      const { start, end } = weekRange(day);
      const [diary, act, wToday, weights, week, weekBonus, foods, recipes] = await Promise.all([
        sql`select id, meal, name, points, qty, unit, kcal, source, ref_code, created_at
              from punkto.diary_entries where user_id = ${u.id} and day = ${day} and deleted_at is null order by created_at`,
        sql`select id, kind, steps, minutes, bonus_points, note, created_at
              from punkto.activity_logs where user_id = ${u.id} and day = ${day} and deleted_at is null order by created_at`,
        sql`select weight_kg from punkto.weight_logs where user_id = ${u.id} and day = ${day} and deleted_at is null limit 1`,
        sql`select day, weight_kg from punkto.weight_logs where user_id = ${u.id} and deleted_at is null order by day desc limit 200`,
        sql`select day::text as day, sum(points)::float as points from punkto.diary_entries
              where user_id = ${u.id} and day between ${start} and ${end} and deleted_at is null group by day`,
        sql`select day::text as day, sum(bonus_points)::float as bonus from punkto.activity_logs
              where user_id = ${u.id} and day between ${start} and ${end} and deleted_at is null group by day`,
        sql`select id, name, brand, per, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, points, barcode
              from punkto.custom_foods where user_id = ${u.id} order by created_at desc limit 500`,
        sql`select id, name, servings, items, points_total, points_per_serving
              from punkto.recipes where user_id = ${u.id} order by created_at desc limit 200`,
      ]);
      await touchActive(u); // opportunistisch: App ist gerade online (Boot/Tageswechsel)
      return json({
        ok: true, day, week_start: start,
        user: pubUser(u), subscription: subView(u),
        token: await mintToken(u),
        diary, activity: act,
        weight_today: wToday[0]?.weight_kg ?? null,
        weights: weights.reverse(),
        week, week_bonus: weekBonus,
        custom_foods: foods, recipes,
      });
    }

    if (action === "token") {
      // Schlanker Refresh des Abo-Tokens (ohne vollen state-Abruf). Nie gesperrt:
      // ist der Zugang abgelaufen, traegt der frische Token einfach ein exp in der
      // Vergangenheit -> die App erkennt "abgelaufen" korrekt (Read-only/Paywall).
      await touchActive(u); // opportunistisch: Token-Refresh passiert nur online
      return json({ ok: true, token: await mintToken(u), subscription: subView(u) });
    }

    if (action === "billing") {
      // Manuelle Zahlung: feste Bankdaten + GiroCode; Verwendungszweck = Konto-E-Mail,
      // damit der Betreiber den Zahlungseingang eindeutig zuordnen kann.
      const amount = PRICE_CENTS / 100;
      const reference = `Punkto ${u.email}`.slice(0, 140);
      const giro = buildGiro({ holder: BANK.holder, iban: BANK.iban, bic: BANK.bic, amount, reference });
      // Zwei Zahlweisen: Monat (2,99) und Jahr (29,99, rund 2 Monate gratis). Jede hat
      // einen eigenen Verwendungszweck (enthaelt weiterhin die E-Mail zur Zuordnung)
      // und einen eigenen GiroCode. Die Top-Level-Felder bleiben monatlich (Kompat.).
      const yearAmount = PRICE_CENTS_YEAR / 100;
      const yearReference = `Punkto Jahr ${u.email}`.slice(0, 140);
      const yearGiro = buildGiro({ holder: BANK.holder, iban: BANK.iban, bic: BANK.bic, amount: yearAmount, reference: yearReference });
      const plans = [
        { plan: "monthly", months: 1, price_cents: PRICE_CENTS, amount, reference, giro, label: "Monatlich", per: "Monat" },
        { plan: "yearly", months: 12, price_cents: PRICE_CENTS_YEAR, amount: yearAmount, reference: yearReference, giro: yearGiro, label: "Jährlich", per: "Jahr" },
      ];
      return json({
        ok: true,
        subscription: subView(u),
        user: { id: u.id, email: u.email, display_name: u.display_name },
        price_cents: PRICE_CENTS,
        amount,
        currency: "EUR",
        reference,
        bank: { holder: BANK.holder, iban: BANK.iban, iban_pretty: formatIban(BANK.iban), bic: BANK.bic },
        paypal: PAYPAL,
        giro,
        plans,
        issuer: ISSUER,
        tax_note: TAX_NOTE,
      });
    }

    if (action === "diary_add") {
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json({ error: "bad_name" }, 400);
      const meal = ["breakfast", "lunch", "dinner", "snack", "other"].includes(String(body.meal)) ? String(body.meal) : "other";
      // Idempotent: der Client vergibt die UUID (crypto.randomUUID) und sendet sie mit;
      // erneutes Senden desselben Eintrags aktualisiert ihn statt zu duplizieren. Fehlt
      // die id (Alt-Client), wird eine erzeugt. created_at optional (Backfill alter Zeilen).
      const cid = UUID_RE.test(String(body.id)) ? String(body.id) : crypto.randomUUID();
      const created = tsOrNull(body.created_at);
      const r = await sql`insert into punkto.diary_entries (id, user_id, day, meal, name, points, qty, unit, kcal, source, ref_code, created_at, updated_at, deleted_at)
        values (${cid}, ${u.id}, ${day}, ${meal}, ${name}, ${clamp(num(body.points), 0, 200)}, ${clamp(num(body.qty, 1), 0, 9999)},
                ${body.unit ? String(body.unit).slice(0, 20) : null}, ${body.kcal != null ? clamp(num(body.kcal), 0, 99999) : null},
                ${body.source ? String(body.source).slice(0, 20) : "manual"}, ${body.ref_code ? String(body.ref_code).slice(0, 40) : null},
                coalesce(${created}::timestamptz, now()), now(), null)
        on conflict (id) do update set day = excluded.day, meal = excluded.meal, name = excluded.name,
                points = excluded.points, qty = excluded.qty, unit = excluded.unit, kcal = excluded.kcal,
                source = excluded.source, ref_code = excluded.ref_code, updated_at = now(), deleted_at = null
              where diary_entries.user_id = ${u.id}
        returning id, meal, name, points, qty, unit, kcal, source, ref_code, created_at`;
      return json({ ok: true, entry: r[0] });
    }
    if (action === "diary_update") {
      // Bestehenden Tagebuch-Eintrag bearbeiten (nur die editierbaren Felder:
      // Mahlzeit, Punkte, Menge, Einheit, kcal). Name/Tag/Quelle bleiben fix —
      // es ist dasselbe Lebensmittel, nur anders verbucht. Scope per user_id.
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const meal = ["breakfast", "lunch", "dinner", "snack", "other"].includes(String(body.meal)) ? String(body.meal) : "other";
      const r = await sql`update punkto.diary_entries set
              meal = ${meal},
              points = ${clamp(num(body.points), 0, 200)},
              qty = ${clamp(num(body.qty, 1), 0, 9999)},
              unit = ${body.unit ? String(body.unit).slice(0, 20) : null},
              kcal = ${body.kcal != null ? clamp(num(body.kcal), 0, 99999) : null},
              updated_at = now()
            where id = ${id} and user_id = ${u.id}
          returning id, meal, name, points, qty, unit, kcal, source, ref_code, created_at`;
      if (!r[0]) return json({ error: "not_found" }, 404);
      return json({ ok: true, entry: r[0] });
    }
    if (action === "diary_del") {
      // SOFT-Delete (Grabstein): deleted_at markiert die Zeile als geloescht, damit
      // andere Geraete das Loeschen per Delta nachziehen koennen. and deleted_at is null
      // haelt den Grabstein-Zeitstempel stabil (kein erneutes updated_at bei Doppel-Del).
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      await sql`update punkto.diary_entries set deleted_at = now(), updated_at = now()
                  where id = ${id} and user_id = ${u.id} and deleted_at is null`;
      return json({ ok: true });
    }

    if (action === "weight_set") {
      // Ein Gewicht je Tag (UNIQUE user_id, day). Beim Setzen updated_at frisch und
      // deleted_at = null -> ein zuvor geloeschter (getombsteinter) Tageswert lebt wieder
      // auf, wenn er neu eingetragen wird; andere Geraete ziehen das per Delta nach.
      const w = clamp(num(body.weight_kg), 30, 400);
      if (!w) return json({ error: "bad_weight" }, 400);
      const r = await sql`insert into punkto.weight_logs (user_id, day, weight_kg, updated_at, deleted_at)
          values (${u.id}, ${day}, ${w}, now(), null)
        on conflict (user_id, day) do update set weight_kg = excluded.weight_kg, updated_at = now(), deleted_at = null
        returning day::text as day, weight_kg`;
      return json({ ok: true, weight: r[0] });
    }
    if (action === "weight_del") {
      // SOFT-Delete (Grabstein) statt Zeile entfernen -> Loeschen synct auf andere Geraete.
      // and deleted_at is null haelt den Grabstein-Zeitstempel bei Doppel-Del stabil.
      await sql`update punkto.weight_logs set deleted_at = now(), updated_at = now()
                  where user_id = ${u.id} and day = ${day} and deleted_at is null`;
      return json({ ok: true });
    }

    if (action === "activity_add") {
      // Idempotent wie diary_add: der Client vergibt die UUID und created_at, erneutes
      // Senden aktualisiert statt zu duplizieren. Fehlt die id (Alt-Client), wird eine erzeugt.
      const kind = ["steps", "workout"].includes(String(body.kind)) ? String(body.kind) : "steps";
      const cid = UUID_RE.test(String(body.id)) ? String(body.id) : crypto.randomUUID();
      const created = tsOrNull(body.created_at);
      const r = await sql`insert into punkto.activity_logs (id, user_id, day, kind, steps, minutes, bonus_points, note, created_at, updated_at, deleted_at)
        values (${cid}, ${u.id}, ${day}, ${kind}, ${body.steps != null ? clamp(num(body.steps), 0, 200000) : null},
                ${body.minutes != null ? clamp(num(body.minutes), 0, 1440) : null}, ${clamp(num(body.bonus_points), 0, 50)},
                ${body.note ? String(body.note).slice(0, 120) : null}, coalesce(${created}::timestamptz, now()), now(), null)
        on conflict (id) do update set day = excluded.day, kind = excluded.kind, steps = excluded.steps,
                minutes = excluded.minutes, bonus_points = excluded.bonus_points, note = excluded.note,
                updated_at = now(), deleted_at = null
              where activity_logs.user_id = ${u.id}
        returning id, kind, steps, minutes, bonus_points, note, created_at`;
      return json({ ok: true, entry: r[0] });
    }
    if (action === "activity_set_steps") {
      // Schritte sind EIN Tageswert. Health-Apps zaehlen den ganzen Tag im Hintergrund
      // (auch bei ausgeschaltetem Display); der uebernommene Wert ist die kumulierte
      // Tagessumme. Deshalb ERSETZEN wir die Schritt-Zeile(n) des Tages, statt anzuhaengen
      // -> idempotent, kein Doppeltzaehlen beim wiederholten Uebernehmen. Workouts bleiben.
      // SOFT-Delete (Grabstein) statt Hard-Delete, damit andere Geraete die alte Schritt-
      // zeile per Delta entfernen und keine veraltete behalten. Die neue Zeile traegt die
      // Client-UUID (idempotent); die zu setzende id wird vom Tombstone ausgenommen.
      const steps = clamp(num(body.steps), 0, 200000);
      const bonus = clamp(num(body.bonus_points), 0, 50);
      const cid = UUID_RE.test(String(body.id)) ? String(body.id) : (steps > 0 ? crypto.randomUUID() : null);
      const created = tsOrNull(body.created_at);
      await sql`update punkto.activity_logs set deleted_at = now(), updated_at = now()
                  where user_id = ${u.id} and day = ${day} and kind = 'steps' and deleted_at is null
                    and (${cid}::uuid is null or id <> ${cid})`;
      if (steps <= 0) return json({ ok: true, entry: null });
      const r = await sql`insert into punkto.activity_logs (id, user_id, day, kind, steps, minutes, bonus_points, note, created_at, updated_at, deleted_at)
        values (${cid}, ${u.id}, ${day}, 'steps', ${steps}, null, ${bonus},
                ${body.note ? String(body.note).slice(0, 120) : null}, coalesce(${created}::timestamptz, now()), now(), null)
        on conflict (id) do update set day = excluded.day, kind = 'steps', steps = excluded.steps,
                minutes = null, bonus_points = excluded.bonus_points, note = excluded.note,
                updated_at = now(), deleted_at = null
              where activity_logs.user_id = ${u.id}
        returning id, kind, steps, minutes, bonus_points, note, created_at`;
      return json({ ok: true, entry: r[0] });
    }
    if (action === "activity_del") {
      // SOFT-Delete (Grabstein) -> Loeschen synct auf andere Geraete.
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      await sql`update punkto.activity_logs set deleted_at = now(), updated_at = now()
                  where id = ${id} and user_id = ${u.id} and deleted_at is null`;
      return json({ ok: true });
    }

    if (action === "food_add") {
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json({ error: "bad_name" }, 400);
      const r = await sql`insert into punkto.custom_foods (user_id, name, brand, per, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, points, barcode)
        values (${u.id}, ${name}, ${body.brand ? String(body.brand).slice(0, 80) : null}, ${body.per ? String(body.per).slice(0, 30) : "100 g"},
                ${body.kcal != null ? clamp(num(body.kcal), 0, 99999) : null}, ${body.sat_fat_g != null ? clamp(num(body.sat_fat_g), 0, 1000) : null},
                ${body.sugar_g != null ? clamp(num(body.sugar_g), 0, 1000) : null}, ${body.protein_g != null ? clamp(num(body.protein_g), 0, 1000) : null},
                ${body.fiber_g != null ? clamp(num(body.fiber_g), 0, 1000) : null}, ${clamp(num(body.points), 0, 200)},
                ${body.barcode ? String(body.barcode).slice(0, 40) : null})
        returning id, name, brand, per, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, points, barcode`;
      return json({ ok: true, food: r[0] });
    }
    if (action === "food_update") {
      // Bestehendes eigenes Lebensmittel bearbeiten. Gleiche Felder/Validierung
      // wie food_add; Punkte kommen fertig berechnet vom Client (PK.pointsFor).
      // Scope per user_id -> fremde Eintraege sind unerreichbar (404 bei Miss).
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json({ error: "bad_name" }, 400);
      const r = await sql`update punkto.custom_foods set
              name = ${name},
              brand = ${body.brand ? String(body.brand).slice(0, 80) : null},
              per = ${body.per ? String(body.per).slice(0, 30) : "100 g"},
              kcal = ${body.kcal != null ? clamp(num(body.kcal), 0, 99999) : null},
              sat_fat_g = ${body.sat_fat_g != null ? clamp(num(body.sat_fat_g), 0, 1000) : null},
              sugar_g = ${body.sugar_g != null ? clamp(num(body.sugar_g), 0, 1000) : null},
              protein_g = ${body.protein_g != null ? clamp(num(body.protein_g), 0, 1000) : null},
              fiber_g = ${body.fiber_g != null ? clamp(num(body.fiber_g), 0, 1000) : null},
              points = ${clamp(num(body.points), 0, 200)},
              barcode = ${body.barcode ? String(body.barcode).slice(0, 40) : null}
            where id = ${id} and user_id = ${u.id}
          returning id, name, brand, per, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, points, barcode`;
      if (!r[0]) return json({ error: "not_found" }, 404);
      return json({ ok: true, food: r[0] });
    }
    if (action === "food_del") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      await sql`delete from punkto.custom_foods where id = ${id} and user_id = ${u.id}`;
      return json({ ok: true });
    }

    if (action === "recipe_add") {
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json({ error: "bad_name" }, 400);
      const servings = clamp(num(body.servings, 1), 1, 99);
      const items = Array.isArray(body.items) ? body.items.slice(0, 60).map((it: any) => ({
        name: String(it?.name || "").slice(0, 120), points: clamp(num(it?.points), 0, 200),
        kcal: it?.kcal != null ? clamp(num(it.kcal), 0, 99999) : null, qty: clamp(num(it?.qty, 1), 0, 9999),
        // Optional: verknüpfte DB-Zutat (Rezept-Modus) — für spätere Neuberechnung beim Bearbeiten.
        amount: it?.amount != null ? clamp(num(it.amount), 0, 999999) : null,
        unit: it?.unit != null ? String(it.unit).slice(0, 12) : null,
        ref: it?.ref != null ? String(it.ref).slice(0, 64) : null,
      })) : [];
      const total = items.reduce((a: number, it: any) => a + num(it.points), 0);
      const per = Math.round((total / servings) * 10) / 10;
      const r = await sql`insert into punkto.recipes (user_id, name, servings, items, points_total, points_per_serving)
        values (${u.id}, ${name}, ${servings}, ${JSON.stringify(items)}::jsonb, ${Math.round(total * 10) / 10}, ${per})
        returning id, name, servings, items, points_total, points_per_serving`;
      return json({ ok: true, recipe: r[0] });
    }
    if (action === "recipe_update") {
      // Bestehendes Rezept bearbeiten. Zutaten/Portionen wie recipe_add
      // normalisieren und Gesamt-/Pro-Portion-Punkte serverseitig neu berechnen.
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json({ error: "bad_name" }, 400);
      const servings = clamp(num(body.servings, 1), 1, 99);
      const items = Array.isArray(body.items) ? body.items.slice(0, 60).map((it: any) => ({
        name: String(it?.name || "").slice(0, 120), points: clamp(num(it?.points), 0, 200),
        kcal: it?.kcal != null ? clamp(num(it.kcal), 0, 99999) : null, qty: clamp(num(it?.qty, 1), 0, 9999),
        // Optional: verknüpfte DB-Zutat (Rezept-Modus) — für spätere Neuberechnung beim Bearbeiten.
        amount: it?.amount != null ? clamp(num(it.amount), 0, 999999) : null,
        unit: it?.unit != null ? String(it.unit).slice(0, 12) : null,
        ref: it?.ref != null ? String(it.ref).slice(0, 64) : null,
      })) : [];
      const total = items.reduce((a: number, it: any) => a + num(it.points), 0);
      const per = Math.round((total / servings) * 10) / 10;
      const r = await sql`update punkto.recipes set
              name = ${name},
              servings = ${servings},
              items = ${JSON.stringify(items)}::jsonb,
              points_total = ${Math.round(total * 10) / 10},
              points_per_serving = ${per}
            where id = ${id} and user_id = ${u.id}
          returning id, name, servings, items, points_total, points_per_serving`;
      if (!r[0]) return json({ error: "not_found" }, 404);
      return json({ ok: true, recipe: r[0] });
    }
    if (action === "recipe_del") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      await sql`delete from punkto.recipes where id = ${id} and user_id = ${u.id}`;
      return json({ ok: true });
    }

    if (action === "central_add") {
      // Nur der Betreiber (Admin-Konto) darf Produkte in die zentrale Datenbank
      // aufnehmen -- kein Crowdsourcing mehr. Beim Scannen/Speichern in der App
      // landet das Produkt direkt als status='approved' und ist damit sofort in
      // der Lebensmittel-Suche aller Nutzer sichtbar. Uebertragen werden AUSSCHLIESSLICH
      // Skalare (Name/Marke/Einheit/Naehrwerte/Barcode/Diaet-Flags) -> NIE selbst
      // aufgenommene Fotos, keine PII, kein "gekauft bei". Ein optionales Produktfoto
      // ist nur als oeffentliche Open-Food-Facts-URL erlaubt (kein Storage-Bucket).
      if (!u.is_admin) return json({ error: "forbidden" }, 403);
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
      // vegan impliziert vegetarisch (serverseitig erzwungen).
      const vegan = body.vegan === true || body.vegan === "true" || body.vegan === 1;
      const vegetarian = vegan || body.vegetarian === true || body.vegetarian === "true" || body.vegetarian === 1;
      // Foto NUR als oeffentliche Open-Food-Facts-URL zulassen (Whitelist), sonst leer.
      let photo_url = "";
      const pu = String(body.photo_url || "").trim();
      if (pu && /^https:\/\/[a-z0-9.-]*openfoodfacts\.org\//i.test(pu) && pu.length <= 500) photo_url = pu;
      let row: Array<{ id: string; status: string }> | undefined;
      // Vorhandenes Produkt gleicher Barcode aktualisieren (bevorzugt das freigegebene,
      // sonst das neueste), damit der Betreiber Eintraege pflegen kann statt zu duplizieren.
      if (barcode) {
        const ex = await sql`select id from punkto.community_products
                               where barcode = ${barcode}
                               order by (status = 'approved') desc, created_at desc limit 1`;
        if (ex[0]) {
          row = await sql`update punkto.community_products set
                            name = ${name}, brand = ${brand}, unit = ${unit}, base_g = ${base_g},
                            kcal = ${kcal}, sat_fat_g = ${sat}, sugar_g = ${sugar},
                            protein_g = ${protein}, fiber_g = ${fiber},
                            vegan = ${vegan}, vegetarian = ${vegetarian},
                            photo_url = case when ${photo_url} <> '' then ${photo_url} else photo_url end,
                            status = 'approved', moderated_at = now(), moderated_by = 'operator', reject_reason = ''
                          where id = ${ex[0].id}
                          returning id, status`;
        }
      }
      // Kein Barcode oder noch nicht vorhanden -> neu anlegen. submit_hash bleibt NOT NULL
      // (UNIQUE) -> Zufalls-UUID, da ohne Crowdsourcing keine Dedup-Semantik mehr noetig ist.
      if (!row || !row[0]) {
        const hash = crypto.randomUUID();
        row = await sql`insert into punkto.community_products
            (barcode, name, brand, unit, base_g, kcal, sat_fat_g, sugar_g, protein_g, fiber_g,
             vegan, vegetarian, photo_url, submitted_by, submit_hash, status, moderated_at, moderated_by)
          values (${barcode}, ${name}, ${brand}, ${unit}, ${base_g}, ${kcal}, ${sat}, ${sugar}, ${protein}, ${fiber},
             ${vegan}, ${vegetarian}, ${photo_url}, ${u.id}, ${hash}, 'approved', now(), 'operator')
          returning id, status`;
      }
      return json({ ok: true, id: row[0]?.id || null, status: row[0]?.status || "approved" });
    }

    if (action === "central_update") {
      // Einen bestehenden zentralen Eintrag NACHTRAEGLICH per id aendern (nur der
      // Betreiber/Admin, vom Smartphone aus). Nur Skalare + Diaet-Flags; ein evtl.
      // vorhandenes Open-Food-Facts-Foto bleibt erhalten und wird nur ueberschrieben,
      // wenn wieder eine gueltige oeffentliche OFF-URL mitkommt.
      if (!u.is_admin) return json({ error: "forbidden" }, 403);
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
      // vegan impliziert vegetarisch (serverseitig erzwungen).
      const vegan = body.vegan === true || body.vegan === "true" || body.vegan === 1;
      const vegetarian = vegan || body.vegetarian === true || body.vegetarian === "true" || body.vegetarian === 1;
      let photo_url = "";
      const pu = String(body.photo_url || "").trim();
      if (pu && /^https:\/\/[a-z0-9.-]*openfoodfacts\.org\//i.test(pu) && pu.length <= 500) photo_url = pu;
      const r = await sql`update punkto.community_products set
            barcode = ${barcode}, name = ${name}, brand = ${brand}, unit = ${unit}, base_g = ${base_g},
            kcal = ${kcal}, sat_fat_g = ${sat}, sugar_g = ${sugar}, protein_g = ${protein}, fiber_g = ${fiber},
            vegan = ${vegan}, vegetarian = ${vegetarian},
            photo_url = case when ${photo_url} <> '' then ${photo_url} else photo_url end,
            status = 'approved', moderated_at = now(), moderated_by = 'operator'
          where id = ${id}
          returning id, barcode, name, brand, unit, base_g, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, vegan, vegetarian, photo_url`;
      if (!r[0]) return json({ error: "not_found" }, 404);
      return json({ ok: true, product: r[0] });
    }

    if (action === "central_delete") {
      // Einen zentralen Eintrag per id entfernen (nur der Betreiber/Admin, vom
      // Smartphone aus). Harte Loeschung -- die Tabelle enthaelt nur Skalare/
      // oeffentliche URLs, keine PII/Fotos im Storage.
      if (!u.is_admin) return json({ error: "forbidden" }, 403);
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const r = await sql`delete from punkto.community_products where id = ${id} returning id`;
      if (!r.length) return json({ error: "not_found" }, 404);
      return json({ ok: true, id: r[0].id });
    }

    if (action === "product_list") {
      // Freigegebene Community-Produkte fuer die Lebensmittel-Suche (Merge im
      // Client). Bewusst schlank und OHNE submitted_by (keine PII nach aussen).
      const rows = await sql`
        select id, barcode, name, brand, unit, base_g, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, vegan, vegetarian, photo_url
          from punkto.community_products where status = 'approved'
          order by name limit 3000`;
      return json({ ok: true, products: rows, count: rows.length });
    }

    if (action === "export_all") {
      // Vollstaendige Tagebuch-Historie EINES Kontos (ALLE Tage) fuer die einmalige
      // Server->Lokal-Wiederherstellung nach der Offline-Umstellung (v39): der Client
      // spielt sie in seine lokale IndexedDB (PKDiary) ein — siehe app.html
      // migrateServerDiaryOnce(). Bewusst READ-ONLY und NICHT in WRITE -> auch bei
      // abgelaufenem/pausiertem Abo abrufbar, damit niemand von seinen EIGENEN
      // Alt-Daten ausgesperrt wird. Feld-Shapes exakt wie PKDiary.importAll erwartet
      // (day::text als YYYY-MM-DD, sonst spaltengleich zu diary_add/weight_set/activity_add).
      const [entries, weights, activities, foods, recipes] = await Promise.all([
        sql`select id, day::text as day, meal, name, points, qty, unit, kcal, source, ref_code, created_at
              from punkto.diary_entries where user_id = ${u.id} and deleted_at is null order by day, created_at`,
        sql`select day::text as day, weight_kg
              from punkto.weight_logs where user_id = ${u.id} and deleted_at is null order by day`,
        sql`select id, day::text as day, kind, steps, minutes, bonus_points, note, created_at
              from punkto.activity_logs where user_id = ${u.id} and deleted_at is null order by day, created_at`,
        sql`select id, name, brand, per, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, points, barcode, created_at
              from punkto.custom_foods where user_id = ${u.id} order by created_at`,
        sql`select id, name, servings, items, points_total, points_per_serving, created_at
              from punkto.recipes where user_id = ${u.id} order by created_at`,
      ]);
      // Vollstaendige Auskunft (DSGVO Art. 15/20): Profil, Abo, Zahlungen, eigene
      // Lebensmittel und Rezepte zusaetzlich zur Tagebuch-Historie. Zusatzfelder sind
      // optional -> aeltere Clients (importAll) ignorieren sie.
      const pays = await sql`select amount_cents, method, months, created_at from punkto.payments where user_id = ${u.id} order by created_at`;
      return json({
        ok: true,
        exported_at: new Date().toISOString(),
        counts: { entries: entries.length, weights: weights.length, activities: activities.length, foods: foods.length, recipes: recipes.length },
        entries, weights, activities,
        profile: pubUser(u), subscription: subView(u), payments: pays, custom_foods: foods, recipes,
      });
    }

    if (action === "sync_push") {
      // Dual-Write-Batch: spiegelt lokale Schreibvorgaenge (Outbox) idempotent auf den
      // Server. Alles in EINER Transaktion -> entweder ganzer Batch oder nichts (der
      // Client loescht die Outbox-Eintraege erst nach {ok:true}). Jede Operation ist
      // user-scoped und per Client-UUID / (user,day) idempotent (erneutes Senden = gleicher
      // Endstand). Unbekannte/ungueltige Ops werden still uebersprungen (nie werfen ->
      // ein Muell-Eintrag darf den ganzen Batch nicht zuruecksetzen). Cap 500 je Aufruf.
      const ops = Array.isArray(body.ops) ? body.ops.slice(0, 500) : [];
      if (!ops.length) return json({ ok: true, now: new Date().toISOString(), applied: 0 });
      let applied = 0;
      await sql.begin(async (tx) => {
        for (const raw of ops) {
          const op = String(raw?.op || "");
          const p = (raw && typeof raw.payload === "object" && raw.payload) ? raw.payload : {};
          if (op === "entry_up") {
            const id = String(p.id || ""); if (!UUID_RE.test(id)) continue;
            const eDay = DATE_RE.test(String(p.day)) ? String(p.day) : today;
            const name = String(p.name || "").trim().slice(0, 120); if (!name) continue;
            const meal = ["breakfast", "lunch", "dinner", "snack", "other"].includes(String(p.meal)) ? String(p.meal) : "other";
            const created = tsOrNull(p.created_at);
            await tx`insert into punkto.diary_entries (id, user_id, day, meal, name, points, qty, unit, kcal, source, ref_code, created_at, updated_at, deleted_at)
              values (${id}, ${u.id}, ${eDay}, ${meal}, ${name}, ${clamp(num(p.points), 0, 200)}, ${clamp(num(p.qty, 1), 0, 9999)},
                      ${p.unit ? String(p.unit).slice(0, 20) : null}, ${p.kcal != null ? clamp(num(p.kcal), 0, 99999) : null},
                      ${p.source ? String(p.source).slice(0, 20) : "manual"}, ${p.ref_code ? String(p.ref_code).slice(0, 40) : null},
                      coalesce(${created}::timestamptz, now()), now(), null)
              on conflict (id) do update set day = excluded.day, meal = excluded.meal, name = excluded.name,
                      points = excluded.points, qty = excluded.qty, unit = excluded.unit, kcal = excluded.kcal,
                      source = excluded.source, ref_code = excluded.ref_code, updated_at = now(), deleted_at = null
                    where diary_entries.user_id = ${u.id}`;
            applied++;
          } else if (op === "entry_del") {
            const id = String(p.id || ""); if (!UUID_RE.test(id)) continue;
            await tx`update punkto.diary_entries set deleted_at = now(), updated_at = now()
                       where id = ${id} and user_id = ${u.id} and deleted_at is null`;
            applied++;
          } else if (op === "act_up") {
            const id = String(p.id || ""); if (!UUID_RE.test(id)) continue;
            const aDay = DATE_RE.test(String(p.day)) ? String(p.day) : today;
            const kind = ["steps", "workout"].includes(String(p.kind)) ? String(p.kind) : "steps";
            const created = tsOrNull(p.created_at);
            await tx`insert into punkto.activity_logs (id, user_id, day, kind, steps, minutes, bonus_points, note, created_at, updated_at, deleted_at)
              values (${id}, ${u.id}, ${aDay}, ${kind}, ${p.steps != null ? clamp(num(p.steps), 0, 200000) : null},
                      ${p.minutes != null ? clamp(num(p.minutes), 0, 1440) : null}, ${clamp(num(p.bonus_points), 0, 50)},
                      ${p.note ? String(p.note).slice(0, 120) : null}, coalesce(${created}::timestamptz, now()), now(), null)
              on conflict (id) do update set day = excluded.day, kind = excluded.kind, steps = excluded.steps,
                      minutes = excluded.minutes, bonus_points = excluded.bonus_points, note = excluded.note,
                      updated_at = now(), deleted_at = null
                    where activity_logs.user_id = ${u.id}`;
            applied++;
          } else if (op === "act_del") {
            const id = String(p.id || ""); if (!UUID_RE.test(id)) continue;
            await tx`update punkto.activity_logs set deleted_at = now(), updated_at = now()
                       where id = ${id} and user_id = ${u.id} and deleted_at is null`;
            applied++;
          } else if (op === "act_steps") {
            // Schritte = EIN Tageswert: alle lebenden steps-Zeilen des Tages tombsteinen
            // (ausser der zu setzenden id), dann die eine Zeile per Client-UUID upserten.
            const aDay = DATE_RE.test(String(p.day)) ? String(p.day) : today;
            const steps = clamp(num(p.steps), 0, 200000);
            const bonus = clamp(num(p.bonus_points), 0, 50);
            const cid = UUID_RE.test(String(p.id)) ? String(p.id) : (steps > 0 ? crypto.randomUUID() : null);
            const created = tsOrNull(p.created_at);
            await tx`update punkto.activity_logs set deleted_at = now(), updated_at = now()
                       where user_id = ${u.id} and day = ${aDay} and kind = 'steps' and deleted_at is null
                         and (${cid}::uuid is null or id <> ${cid})`;
            if (steps > 0 && cid) {
              await tx`insert into punkto.activity_logs (id, user_id, day, kind, steps, minutes, bonus_points, note, created_at, updated_at, deleted_at)
                values (${cid}, ${u.id}, ${aDay}, 'steps', ${steps}, null, ${bonus},
                        ${p.note ? String(p.note).slice(0, 120) : null}, coalesce(${created}::timestamptz, now()), now(), null)
                on conflict (id) do update set day = excluded.day, kind = 'steps', steps = excluded.steps,
                        minutes = null, bonus_points = excluded.bonus_points, note = excluded.note,
                        updated_at = now(), deleted_at = null
                      where activity_logs.user_id = ${u.id}`;
            }
            applied++;
          } else if (op === "weight_up") {
            const wDay = DATE_RE.test(String(p.day)) ? String(p.day) : today;
            const w = clamp(num(p.weight_kg), 30, 400); if (!w) continue;
            await tx`insert into punkto.weight_logs (user_id, day, weight_kg, updated_at, deleted_at)
                values (${u.id}, ${wDay}, ${w}, now(), null)
              on conflict (user_id, day) do update set weight_kg = excluded.weight_kg, updated_at = now(), deleted_at = null`;
            applied++;
          } else if (op === "weight_del") {
            const wDay = DATE_RE.test(String(p.day)) ? String(p.day) : today;
            await tx`update punkto.weight_logs set deleted_at = now(), updated_at = now()
                       where user_id = ${u.id} and day = ${wDay} and deleted_at is null`;
            applied++;
          }
          // andere op-Werte: still ueberspringen (Vorwaertskompatibilitaet)
        }
      });
      await touchActive(u); // opportunistisch: Push passiert nur online
      return json({ ok: true, now: new Date().toISOString(), applied });
    }

    if (action === "sync_pull") {
      // Read-only Delta fuer den Mehrgeraete-Abgleich. Liefert ALLE seit „since"
      // geaenderten Zeilen je Tabelle — auch Grabsteine (deleted=true) — plus einen
      // Cursor „now" fuer den naechsten Aufruf. NICHT in WRITE -> auch ohne aktiven
      // Zugang abrufbar (niemand wird von EIGENEN Daten ausgesperrt). since=null => voll
      // (Erstbefuellung). updated_at wird als kanonischer UTC-ISO-Text geliefert
      // (fixe Breite, lexikografisch sortierbar, direkt als naechstes „since" nutzbar).
      const since = tsOrNull(body.since);
      const LIM = 10000;
      const [rawE, rawW, rawA, nowRow] = await Promise.all([
        sql`select id, day::text as day, meal, name, points, qty, unit, kcal, source, ref_code, created_at,
                   to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
                   (deleted_at is not null) as deleted
              from punkto.diary_entries
             where user_id = ${u.id} and (${since}::timestamptz is null or updated_at > ${since}::timestamptz)
             order by updated_at asc limit ${LIM}`,
        sql`select day::text as day, weight_kg,
                   to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
                   (deleted_at is not null) as deleted
              from punkto.weight_logs
             where user_id = ${u.id} and (${since}::timestamptz is null or updated_at > ${since}::timestamptz)
             order by updated_at asc limit ${LIM}`,
        sql`select id, day::text as day, kind, steps, minutes, bonus_points, note, created_at,
                   to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
                   (deleted_at is not null) as deleted
              from punkto.activity_logs
             where user_id = ${u.id} and (${since}::timestamptz is null or updated_at > ${since}::timestamptz)
             order by updated_at asc limit ${LIM}`,
        // Cursor mit Sicherheitsabstand: updated_at = now() ist die STARTzeit der schreibenden
        // Transaktion. Ein Push, der vor diesem Pull begann, aber erst danach committet, traegt
        // einen aelteren Zeitstempel und fiele sonst dauerhaft durchs Raster. 15 s Ueberlappung;
        // doppelt gelieferte Zeilen sind clientseitig idempotent (Upsert per id/Tag).
        sql`select to_char((now() - interval '15 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`,
      ]);
      const serverNow = nowRow[0].now;
      // Tie-sichere Cursor-Bestimmung: fuellt eine Tabelle die Seite (== LIM), koennten
      // Zeilen mit exakt gleichem updated_at ueber die Seitengrenze fallen. Wir schneiden
      // die letzte updated_at-Gruppe ab (kommt auf der naechsten Seite) und setzen den
      // Cursor NIE ueber eine nicht ausgelieferte Zeile. (Praktisch nie erreicht — der
      // Push-Cap von 500 << LIM verhindert Zeitstempel-Cluster, die eine Seite fuellen.)
      const trimTrunc = (rows: any[]): { rows: any[]; covered: string | null } => {
        if (rows.length < LIM) return { rows, covered: null };
        const boundary = String(rows[rows.length - 1].updated_at);
        let cut = rows.length;
        while (cut > 0 && String(rows[cut - 1].updated_at) === boundary) cut--;
        if (cut === 0) return { rows, covered: boundary }; // ganze Seite ein Zeitstempel -> Fortschritt erzwingen
        const trimmed = rows.slice(0, cut);
        return { rows: trimmed, covered: String(trimmed[trimmed.length - 1].updated_at) };
      };
      const e = trimTrunc(rawE), w = trimTrunc(rawW), a = trimTrunc(rawA);
      const covereds = [e.covered, w.covered, a.covered].filter((x): x is string => x !== null);
      const done = covereds.length === 0;
      // Cursor: nichts abgeschnitten -> Server-now; sonst der frueheste abgedeckte
      // Zeitstempel (garantiert <= jede noch nicht ausgelieferte Zeile). done=false ->
      // der Client wiederholt pull, bis alle Seiten geholt sind.
      const cursor = done ? serverNow : covereds.reduce((m, x) => (x < m ? x : m));
      return json({
        ok: true,
        now: cursor,
        done,
        counts: { entries: e.rows.length, weights: w.rows.length, activities: a.rows.length },
        entries: e.rows, weights: w.rows, activities: a.rows,
      });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    try { console.error("punkto-data", action, String((e as Error)?.message || e)); } catch (_e) { /* ignore */ }
    return json({ error: "server_error" }, 500);
  }
};
Deno.serve(async (req: Request) => withCors(req, await handler(req)));
