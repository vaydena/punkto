// Punkto - Community/Connect-Feed (posten, liken, melden, loeschen).
// Session-geschuetzt. Schreibaktionen verlangen aktiven Zugang (Testphase/Abo);
// den Feed lesen darf jede angemeldete Person (auch nach Ablauf).
import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
async function auth(req: Request) {
  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const th = await sha256hex(token);
  const r = await sql`
    select u.id, u.display_name,
           (now() < greatest(coalesce(sb.trial_ends_at,'epoch'::timestamptz), coalesce(sb.current_period_end,'epoch'::timestamptz))) as access
      from punkto.sessions s
      join punkto.users u on u.id = s.user_id
      left join punkto.subscriptions sb on sb.user_id = u.id
     where s.token_hash = ${th} and s.expires_at > now() limit 1`;
  return r[0] || null;
}

const WRITE = new Set(["post", "like", "unlike", "delete"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body?.action ?? "").trim();

  const u = await auth(req);
  if (!u) return json({ error: "unauthorized" }, 401);
  if (WRITE.has(action) && !u.access) return json({ error: "no_access" }, 402);

  try {
    if (action === "feed") {
      const limit = clamp(Number(body.limit) || 30, 1, 50);
      const before = body.before && !Number.isNaN(Date.parse(String(body.before))) ? String(body.before) : null;
      const rows = before
        ? await sql`
            select p.id, p.author_name, p.kind, p.body, p.meta, p.likes, p.created_at,
                   exists(select 1 from punkto.community_likes l where l.post_id = p.id and l.user_id = ${u.id}) as liked,
                   (p.user_id = ${u.id}) as mine
              from punkto.community_posts p
             where p.hidden = false and p.created_at < ${before}
             order by p.created_at desc limit ${limit}`
        : await sql`
            select p.id, p.author_name, p.kind, p.body, p.meta, p.likes, p.created_at,
                   exists(select 1 from punkto.community_likes l where l.post_id = p.id and l.user_id = ${u.id}) as liked,
                   (p.user_id = ${u.id}) as mine
              from punkto.community_posts p
             where p.hidden = false
             order by p.created_at desc limit ${limit}`;
      return json({ ok: true, posts: rows, next: rows.length === limit ? rows[rows.length - 1].created_at : null });
    }

    if (action === "post") {
      const bodyTxt = String(body.body || "").trim().slice(0, 800);
      const kind = ["text", "meal", "weight", "activity", "milestone"].includes(String(body.kind)) ? String(body.kind) : "text";
      if (!bodyTxt && kind === "text") return json({ error: "empty" }, 400);
      const anon = body.anon === true;
      const name = anon ? "Anonym" : (u.display_name || "Mitglied");
      const meta = (body.meta && typeof body.meta === "object") ? body.meta : {};
      // Freitext-Meta begrenzen (nur simple Werte, max ~1 KB)
      const metaStr = JSON.stringify(meta).slice(0, 1000);
      const r = await sql`
        insert into punkto.community_posts (user_id, author_name, kind, body, meta)
        values (${u.id}, ${name}, ${kind}, ${bodyTxt}, ${metaStr}::jsonb)
        returning id, author_name, kind, body, meta, likes, created_at, true as mine, false as liked`;
      return json({ ok: true, post: r[0] });
    }

    if (action === "like" || action === "unlike") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      if (action === "like") {
        const ins = await sql`insert into punkto.community_likes (post_id, user_id) values (${id}, ${u.id})
          on conflict do nothing returning post_id`;
        if (ins.length) await sql`update punkto.community_posts set likes = likes + 1 where id = ${id}`;
      } else {
        const del = await sql`delete from punkto.community_likes where post_id = ${id} and user_id = ${u.id} returning post_id`;
        if (del.length) await sql`update punkto.community_posts set likes = greatest(0, likes - 1) where id = ${id}`;
      }
      const r = await sql`select likes from punkto.community_posts where id = ${id} limit 1`;
      return json({ ok: true, likes: r[0]?.likes ?? 0, liked: action === "like" });
    }

    if (action === "delete") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      await sql`delete from punkto.community_likes where post_id = ${id}`;
      await sql`delete from punkto.community_posts where id = ${id} and user_id = ${u.id}`;
      return json({ ok: true });
    }

    if (action === "report") {
      const id = String(body.id || ""); if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      // Meldung: Post markieren; Betreiber sichtet spaeter im /betreiber-Bereich.
      await sql`update punkto.community_posts set meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('reported', true) where id = ${id}`;
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    try { console.error("punkto-community", action, String((e as Error)?.message || e)); } catch (_e) { /* ignore */ }
    return json({ error: "server_error" }, 500);
  }
});
