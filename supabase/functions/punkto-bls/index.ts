// Punkto - BLS-Naehrwertsuche (Bundeslebensmittelschluessel, Version 4.0).
// Datenquelle: Max Rubner-Institut (2025), Bundeslebensmittelschluessel (BLS),
// Version 4.0 - Deutsche Naehrstoffdatenbank, Karlsruhe. Lizenz: CC BY 4.0.
// Werte je 100 g. Die Punkte werden AUSSCHLIESSLICH im Client aus den
// Naehrwerten berechnet (PK.pointsForAmount) -> kein points-Feld in der DB,
// damit keine Staleness entsteht, wenn sich die Formel aendert.
// verify_jwt=false; eigene, schlanke Session-Pruefung ueber punkto.sessions
// (Parität zu den uebrigen Lese-Aktionen: nur angemeldete Nutzer).
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
const num = (v: any, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Attribution (CC BY 4.0) -- wird mit jeder Antwort mitgeliefert, damit der
// Client die Quelle in der UI anzeigen kann.
const ATTRIBUTION =
  "Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 – Deutsche Nährstoffdatenbank. Karlsruhe. Lizenz: CC BY 4.0.";

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function authUserId(req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const th = await sha256hex(token);
  const r = await sql`select user_id from punkto.sessions where token_hash = ${th} and expires_at > now() limit 1`;
  return r[0]?.user_id ?? null;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body?.action ?? "").trim();

  try {
    if (action === "bls_search") {
      const uid = await authUserId(req);
      if (!uid) return json({ error: "unauthorized" }, 401);
      const q = String(body.q ?? "").trim().slice(0, 60);
      if (q.length < 2) return json({ ok: true, foods: [], count: 0, attribution: ATTRIBUTION });
      const lim = clamp(num(body.limit, 30), 1, 50);
      // %, _ und \ im Suchbegriff entschaerfen (ILIKE-Metazeichen). Backslash ist
      // in Postgres der Default-Escape von LIKE/ILIKE -> kein ESCAPE noetig.
      const esc = q.replace(/[\\%_]/g, (m) => "\\" + m);
      const like = "%" + esc + "%";
      const pre = esc + "%";
      const rows = await sql`
        select bls, name, kcal, sat_fat_g, sugar_g, protein_g, fiber_g
          from punkto.bls_foods
         where name ilike ${like}
         order by (name ilike ${pre}) desc, length(name) asc, name asc
         limit ${lim}`;
      return json({ ok: true, foods: rows, count: rows.length, source: "bls", attribution: ATTRIBUTION });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    try { console.error("punkto-bls", action, String((e as Error)?.message || e)); } catch (_e) { /* ignore */ }
    return json({ error: "server_error" }, 500);
  }
};
Deno.serve(async (req: Request) => withCors(req, await handler(req)));
