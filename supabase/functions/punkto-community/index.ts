// Punkto - Community/Connect-Feed: ENTFERNT (Grabstein).
// Die Community-Funktion wurde am 2026-09-08 vollstaendig entfernt: Frontend-Ansicht
// und Tab, Betreiber-Moderation sowie die Tabellen punkto.community_posts und
// punkto.community_likes wurden geloescht. Diese Function bleibt nur bestehen, weil
// sie ueber die MCP-Werkzeuge nicht geloescht werden kann; sie referenziert keine
// Datenbank mehr und antwortet auf jeden Aufruf mit 410 Gone, damit veraltete Clients
// einen klaren, stabilen Fehler bekommen statt eines 500ers.
// Kann im Supabase-Dashboard (Edge Functions) gefahrlos ganz geloescht werden.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  return new Response(
    JSON.stringify({ error: "gone", message: "Die Community-Funktion wurde entfernt." }),
    { status: 410, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
