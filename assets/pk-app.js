/* ============================================================================
   Punkto — API-Client + Sync (Browser).
   Spricht die Edge Functions punkto-auth / -data an, verwaltet den
   Session-Token geraetelokal und kapselt die Barcode-Suche (Open Food Facts).
   Kein Framework, kein Build. Global: window.PKApi.
   ============================================================================ */
(function (root) {
  "use strict";

  var CFG = {
    SUPABASE_URL: "https://xeuexovdipdiiuzjpzkj.supabase.co",
    ANON_KEY: "sb_publishable_3dLuQ2PfEsjavJyl0fmkaA_DXB8ZS6f",
    FN: "https://xeuexovdipdiiuzjpzkj.supabase.co/functions/v1/punkto-"
  };

  // Session-Token: EIN Schluessel, den auch die PWA-Deep-Link-Logik nutzt.
  var TOKEN_KEY = "hf_saved_token";

  // Fuer die Sync-Ebene (Dual-Write): Tag- und UUID-Form pruefen, bevor ein
  // Outbox-Schluessel gebildet oder eine Server-Zeile lokal angewendet wird.
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }
  function clearToken() { setToken(""); }

  /* Kern-Aufruf: POST {action, ...body} an punkto-<fn>. Wirft bei !ok ein
     Error-Objekt mit .code (Server-Fehlercode) und .status (HTTP). */
  async function call(fn, action, body, opts) {
    opts = opts || {};
    var headers = {
      "Content-Type": "application/json",
      "apikey": CFG.ANON_KEY
    };
    var tok = opts.token !== undefined ? opts.token : getToken();
    if (tok) headers["Authorization"] = "Bearer " + tok;
    if (opts.adminKey) headers["x-admin-key"] = opts.adminKey;

    var payload = Object.assign({ action: action }, body || {});
    var res, data;

    // Timeout via AbortController: ein Server, der die Verbindung annimmt aber
    // nie antwortet, darf NIE zu einem ewigen await werden (sonst haengt der
    // Ladeschirm auf „Laedt …" ohne Ende). Nach timeoutMs brechen wir ab und
    // werfen denselben network-Fehler wie ein echter Verbindungsabbruch -> die
    // Aufrufer zeigen den Offline-Cache bzw. einen „Neu laden"-Knopf.
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 15000) : null;
    try {
      try {
        res = await fetch(CFG.FN + fn, {
          method: "POST", headers: headers, body: JSON.stringify(payload),
          signal: ctrl ? ctrl.signal : undefined
        });
      } catch (e) {
        var ne = new Error("network"); ne.code = "network"; ne.status = 0; throw ne;
      }
      try { data = await res.json(); }
      catch (e) {
        // Abbruch waehrend des Body-Lesens zaehlt ebenfalls als network.
        if (ctrl && ctrl.signal.aborted) { var na = new Error("network"); na.code = "network"; na.status = 0; throw na; }
        data = {};
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok || data.error) {
      var err = new Error(data.error || ("http_" + res.status));
      err.code = data.error || ("http_" + res.status);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ---------------------------------------------------------------- AUTH ---- */
  var auth = {
    async register(payload) {
      var d = await call("auth", "register", payload, { token: null });
      if (d.token) setToken(d.token);
      return d;
    },
    async login(email, password) {
      var d = await call("auth", "login", { email: email, password: password }, { token: null });
      if (d.token) setToken(d.token);
      return d;
    },
    async me() { return call("auth", "me"); },
    async logout() {
      try { await call("auth", "logout"); } catch (e) { /* egal */ }
      clearToken();
    },
    updateProfile(patch) { return call("auth", "update_profile", patch); },
    changePassword(current, password) {
      return call("auth", "change_password", { current: current, password: password });
    },
    requestReset(email) { return call("auth", "request_reset", { email: email }, { token: null }); },
    reset(token, password) { return call("auth", "reset", { token: token, password: password }, { token: null }); }
  };

  /* ---------------------------------------------------------------- SYNC ----
     Server-Dual-Write + Mehrgeraete-Abgleich fuer das (geraetelokale) Tagebuch.
     Jeder lokale Schreibvorgang legt zusaetzlich einen Vorgang in die PKDiary-
     OUTBOX; diese Ebene spiegelt sie opportunistisch zum Server (sync_push) und
     liest per Delta die Aenderungen ANDERER Geraete wieder ein (sync_pull).

     Leitplanken (bewusst konservativ — der lokale Schreibweg bleibt Quelle der
     Wahrheit und darf durch Sync NIE leiden, „fail-open"):
       - Kein Token / offline / Abo inaktiv (402) -> Outbox bleibt erhalten, kein
         Datenverlust; der naechste kick/online/Sichtbarkeitswechsel versucht es erneut.
       - Push loescht nur die TATSAECHLICH gespiegelten Schluessel und nur, wenn ihr
         „ts" unveraendert ist (eine Bearbeitung WAEHREND des Push bleibt erhalten).
       - Beim Einlesen werden lokal noch nicht gespiegelte Ziele („pending") NICHT
         von einem Server-Delta ueberschrieben (der eigene Schreibweg gewinnt).
       - Cursor je Nutzer (pk_sync_cursor_<uid>); erster Lauf ohne Cursor = Voll-
         Backfill (Flag pk_sync_backfill_v1_<uid>); Nachlaeufe nur das Delta. */
  var SYNC_CURSOR_KEY = "pk_sync_cursor_";
  var SYNC_BACKFILL_KEY = "pk_sync_backfill_v1_";
  var _syncUid = "";       // aktueller Nutzer (fuer die Cursor-/Backfill-Schluessel)
  var _flushing = false;   // Push-Reentrancy-Sperre
  var _pulling = false;    // Pull-Reentrancy-Sperre
  var _kickTimer = null;   // Debounce-Timer fuer den Push-Anstoss

  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* voll/gesperrt -> egal */ } }

  var sync = {
    /* Nutzer setzen (uid = users.id) — bestimmt die geraetelokalen Cursor-Schluessel. */
    setUid: function (uid) { _syncUid = uid ? String(uid) : ""; },

    /* Einen Vorgang in die lokale Outbox legen. Fail-open: ein Fehler hier darf
       den bereits erfolgten lokalen Schreibvorgang NIE kippen. */
    enqueue: function (key, op, payload) {
      if (!root.PKDiary || !root.PKDiary.outboxPut) return Promise.resolve();
      return root.PKDiary.outboxPut({ key: key, op: op, payload: payload }).catch(function () {});
    },

    /* Debounced Push-Anstoss: buendelt schnelle Mehrfach-Schreibvorgaenge zu
       EINEM Push (~1,5 s nach der letzten lokalen Aenderung). */
    kick: function () {
      try {
        if (_kickTimer) clearTimeout(_kickTimer);
        _kickTimer = setTimeout(function () { _kickTimer = null; sync.flush(); }, 1500);
      } catch (e) { /* setTimeout nicht verfuegbar -> egal, naechster Anlass zieht */ }
    },

    /* Outbox -> Server spiegeln (sync_push). In 200er-Bloecken (Server-Cap 500).
       Wirft NICHT nach aussen: bei 402/Netz/Server bleibt die Outbox erhalten. */
    flush: async function () {
      if (_flushing) return;
      if (!getToken()) return;                       // nicht eingeloggt -> spaeter
      if (!root.PKDiary || !root.PKDiary.outboxAll) return;
      _flushing = true;
      try {
        var recs = await root.PKDiary.outboxAll();
        var passes = 0;
        while (recs && recs.length && passes < 50) {
          passes++;
          var chunk = recs.slice(0, 200);
          var ops = chunk.map(function (r) { return { op: r.op, payload: r.payload }; });
          // Wirft bei 402 (Abo inaktiv) / Netzfehler -> Outbox bleibt, wir brechen ab.
          await call("data", "sync_push", { ops: ops });
          // Nur die gespiegelten Schluessel entfernen, und nur bei unveraendertem ts
          // (eine parallele Bearbeitung desselben Ziels bleibt so in der Outbox).
          await root.PKDiary.outboxDeleteIfUnchanged(chunk.map(function (r) { return { key: r.key, ts: r.ts }; }));
          if (chunk.length < 200) break;             // war der letzte (Teil-)Block
          recs = await root.PKDiary.outboxAll();      // frisch lesen (koennte Neues geben)
        }
      } catch (e) {
        // 402/Netz/Server -> stiller Rueckzug; Outbox bleibt fuer den naechsten Versuch.
      } finally {
        _flushing = false;
      }
    },

    /* Server-Delta einlesen (sync_pull) und lokal anwenden. opts.uid setzt den
       Nutzer; opts.forceFull erzwingt einen Voll-Backfill (since=null). */
    pull: async function (opts) {
      opts = opts || {};
      if (opts.uid) _syncUid = String(opts.uid);
      if (!getToken()) return;
      if (_pulling) return;
      if (!root.PKDiary || !root.PKDiary.importAll) return;
      _pulling = true;
      try {
        var uid = _syncUid || "anon";
        var cursorKey = SYNC_CURSOR_KEY + uid, backfillKey = SYNC_BACKFILL_KEY + uid;
        var haveBackfill = lsGet(backfillKey) === "1";
        var since = (opts.forceFull || !haveBackfill) ? null : (lsGet(cursorKey) || null);
        var changed = false, guard = 0;
        while (guard < 200) {
          guard++;
          var d = await call("data", "sync_pull", since ? { since: since } : {});

          // Aktuelle „pending"-Ziele: lokal noch nicht gespiegelte Schreibvorgaenge
          // duerfen NICHT von einem (aelteren) Server-Delta ueberschrieben werden.
          var pend = {};
          try {
            var keys = await root.PKDiary.outboxKeys();
            for (var i = 0; i < keys.length; i++) pend[keys[i]] = 1;
          } catch (e) { /* Outbox nicht lesbar -> ohne Schutz weiter (best effort) */ }

          var liveEntries = [], liveWeights = [], liveActs = [];
          var delEntries = [], delWeights = [], delActs = [];

          (d.entries || []).forEach(function (r) {
            if (!r || !r.id) return;
            if (pend["entry:" + r.id]) return;
            if (r.deleted) delEntries.push(r.id); else liveEntries.push(r);
          });
          (d.weights || []).forEach(function (r) {
            if (!r || !r.day) return;
            if (pend["weight:" + r.day]) return;
            if (r.deleted) delWeights.push(r.day); else liveWeights.push(r);
          });
          (d.activities || []).forEach(function (r) {
            if (!r || !r.id) return;
            if (pend["act:" + r.id]) return;
            // Schritt-Zeilen zusaetzlich per steps:<day> schuetzen (dort ersetzt der
            // lokale Schreibweg den GANZEN Tag -> ein Delta darf ihn nicht kippen).
            if (r.kind === "steps" && pend["steps:" + r.day]) return;
            if (r.deleted) delActs.push(r.id); else liveActs.push(r);
          });

          if (liveEntries.length || liveWeights.length || liveActs.length) {
            await root.PKDiary.importAll({ entries: liveEntries, weights: liveWeights, activities: liveActs });
            changed = true;
          }
          // Grabsteine lokal anwenden (der Server haelt sie; das Geraet blendet aus).
          for (var a = 0; a < delEntries.length; a++) { try { await root.PKDiary.entryDel(delEntries[a]); changed = true; } catch (e) {} }
          for (var b = 0; b < delWeights.length; b++) { try { await root.PKDiary.weightDel(delWeights[b]); changed = true; } catch (e) {} }
          for (var c = 0; c < delActs.length; c++) { try { await root.PKDiary.activityDel(delActs[c]); changed = true; } catch (e) {} }

          var prev = since;
          since = d.now || since;
          if (since) lsSet(cursorKey, since);
          if (d.done) break;
          if (!since || since === prev) break;        // kein Fortschritt -> Abbruch (Sicherung)
        }
        lsSet(backfillKey, "1");
        if (changed) { try { root.dispatchEvent(new CustomEvent("pk-sync-changed")); } catch (e) {} }
      } catch (e) {
        // Netz/Auth/Server -> stiller Rueckzug; der lokale Stand bleibt unveraendert.
      } finally {
        _pulling = false;
      }
    },

    /* Beim Start / online / Sichtbarkeitswechsel: erst lokale Aenderungen hoch,
       dann fremde Aenderungen herunter (Server-LWW entscheidet Konflikte). */
    bootstrap: async function (opts) {
      opts = opts || {};
      await sync.flush();
      await sync.pull(opts);
    }
  };

  /* ---------------------------------------------------------------- DATA ---- */
  var data = {
    state(day) { return call("data", "state", day ? { day: day } : {}); },
    billing() { return call("data", "billing", {}); },
    // Nur den frisch signierten Abo-Token (Ed25519) holen — leichtgewichtige
    // Auffrischung, wenn wieder online (kein voller State-Roundtrip noetig).
    token() { return call("data", "token", {}); },
    // Vollstaendige SERVER-Tagebuchhistorie (alle Tage) — ausschliesslich fuer die
    // EINMALIGE Wiederherstellung nach der Offline-Umstellung (siehe app.html
    // migrateServerDiaryOnce). Read-only; liefert { entries, weights, activities }.
    exportAll() { return call("data", "export_all", {}); },
    // Server-Dual-Write + Mehrgeraete-Abgleich (siehe SYNC oben). app.html ruft
    // data.sync.bootstrap({uid}) beim Start / online / Sichtbarkeitswechsel.
    sync: sync,
    // --- Tagebuch / Gewicht / Aktivitaet: GERAETELOKAL (IndexedDB via PKDiary) ---
    //     Damit kann der Kunde seine Mahlzeiten JEDERZEIT speichern, auch voellig
    //     offline. Rueckgabe-Shapes sind identisch zum Server (siehe pk-diary.js).
    //     Jeder Schreibvorgang spiegelt sich zusaetzlich in die Sync-Outbox (Dual-
    //     Write); der lokale Rueckgabewert bleibt dabei unveraendert (fail-open).
    //     PKDiary wird zur Aufrufzeit aufgeloest (Ladereihenfolge unkritisch).
    async diaryAdd(entry) {
      var r = await root.PKDiary.entryAdd(entry);
      try { if (r && r.entry && r.entry.id) { await sync.enqueue("entry:" + r.entry.id, "entry_up", r.entry); sync.kick(); } } catch (e) {}
      return r;
    },
    async diaryUpdate(entry) {
      var r = await root.PKDiary.entryUpdate(entry);
      try { if (r && r.entry && r.entry.id) { await sync.enqueue("entry:" + r.entry.id, "entry_up", r.entry); sync.kick(); } } catch (e) {}
      return r;
    },
    async diaryDel(id) {
      var r = await root.PKDiary.entryDel(id);
      try { await sync.enqueue("entry:" + String(id), "entry_del", { id: String(id) }); sync.kick(); } catch (e) {}
      return r;
    },
    async weightSet(kg, day) {
      var r = await root.PKDiary.weightSet(kg, day);
      try { if (r && r.weight && r.weight.day) { await sync.enqueue("weight:" + r.weight.day, "weight_up", { day: r.weight.day, weight_kg: r.weight.weight_kg }); sync.kick(); } } catch (e) {}
      return r;
    },
    async weightDel(day) {
      var r = await root.PKDiary.weightDel(day);
      try { var d = (day && DATE_RE.test(day)) ? day : root.PKDiary.today(); await sync.enqueue("weight:" + d, "weight_del", { day: d }); sync.kick(); } catch (e) {}
      return r;
    },
    async activityAdd(a) {
      var r = await root.PKDiary.activityAdd(a);
      try { if (r && r.entry && r.entry.id) { await sync.enqueue("act:" + r.entry.id, "act_up", r.entry); sync.kick(); } } catch (e) {}
      return r;
    },
    // Schritte als EINEN Tageswert setzen (ersetzt heutige Schritte; idempotent, kein Doppeltzaehlen).
    async activitySetSteps(steps, bonus_points, day) {
      var r = await root.PKDiary.activitySetSteps(steps, bonus_points, day);
      try {
        var d = (day && DATE_RE.test(day)) ? day : root.PKDiary.today();
        var rec = r && r.entry;
        await sync.enqueue("steps:" + d, "act_steps", { id: rec ? rec.id : null, day: d, steps: rec ? rec.steps : 0, bonus_points: rec ? rec.bonus_points : 0, created_at: rec ? rec.created_at : new Date().toISOString(), note: rec ? rec.note : null });
        sync.kick();
      } catch (e) {}
      return r;
    },
    async activityDel(id) {
      var r = await root.PKDiary.activityDel(id);
      try { await sync.enqueue("act:" + String(id), "act_del", { id: String(id) }); sync.kick(); } catch (e) {}
      return r;
    },
    // --- Eigene Produkte & Rezepte bleiben serverseitig (bewusste Phase-1-Grenze) ---
    foodAdd(food) { return call("data", "food_add", food); },
    foodUpdate(food) { return call("data", "food_update", food); },
    foodDel(id) { return call("data", "food_del", { id: id }); },
    recipeAdd(recipe) { return call("data", "recipe_add", recipe); },
    recipeUpdate(recipe) { return call("data", "recipe_update", recipe); },
    recipeDel(id) { return call("data", "recipe_del", { id: id }); }
  };

  /* ---------------------------------------------------------------- ADMIN --- */
  var admin = {
    login(key) { return call("admin", "login", {}, { token: null, adminKey: key }); },
    stats(key) { return call("admin", "stats", {}, { token: null, adminKey: key }); },
    users(key, q, offset, limit) { return call("admin", "users", { q: q || "", offset: offset || 0, limit: limit || 50 }, { token: null, adminKey: key }); },
    user(key, id) { return call("admin", "user", { id: id }, { token: null, adminKey: key }); },
    extend(key, id, months, amount_cents, method, ref, note, plan) {
      return call("admin", "extend", { id: id, months: months, amount_cents: amount_cents, method: method, ref: ref, note: note, plan: plan || "monthly" }, { token: null, adminKey: key });
    },
    // Dauerhaft kostenlos freischalten (Freund/Tester) — ohne Zahlung zu verbuchen.
    grantFree(key, id, note) { return call("admin", "grant_free", { id: id, note: note || "" }, { token: null, adminKey: key }); },
    setStatus(key, id, status, clear_period) { return call("admin", "set_status", { id: id, status: status, clear_period: !!clear_period }, { token: null, adminKey: key }); },
    addNote(key, id, notes) { return call("admin", "add_note", { id: id, notes: notes }, { token: null, adminKey: key }); },
    export(key) { return call("admin", "export", {}, { token: null, adminKey: key }); },
    setKey(key, new_key) { return call("admin", "set_key", { new_key: new_key }, { token: null, adminKey: key }); },
    // Zentrale Datenbank im Betreiber-Bereich: ansehen, per id bearbeiten, entfernen.
    centralList(key, limit) { return call("admin", "central_list", { limit: limit || 500 }, { token: null, adminKey: key }); },
    centralUpdate(key, id, p) {
      p = p || {};
      var n = function (v) { var x = Number(v); return Number.isFinite(x) ? x : 0; };
      return call("admin", "central_update", {
        id: id, name: String(p.name || ""), brand: String(p.brand || ""),
        barcode: String(p.barcode || ""), unit: p.unit === "ml" ? "ml" : "g", base_g: n(p.base_g) || 100,
        kcal: n(p.kcal), sat_fat_g: n(p.sat_fat_g), sugar_g: n(p.sugar_g),
        protein_g: n(p.protein_g), fiber_g: n(p.fiber_g),
        vegan: !!p.vegan, vegetarian: !!p.vegetarian || !!p.vegan
      }, { token: null, adminKey: key });
    },
    centralDelete(key, id) { return call("admin", "central_delete", { id: id }, { token: null, adminKey: key }); }
  };

  /* ---------------------------------------------------------------- FOODS --- */
  var _localFoods = null;
  var foods = {
    /* Laedt die lokale Lebensmittel-DB. WICHTIG: Es wird NUR ein nicht-leeres
       Ergebnis gemerkt – ein fehlgeschlagener/leerer Ladevorgang vergiftet den
       Cache nicht mehr (frueher blieb ein einmaliges [] fuer die ganze Session
       haengen -> Zutatenrechner/Rezept-Modus zeigten ewig „werden geladen").
       opts.force umgeht den Speicher und haengt einen Cache-Buster an, um einen
       hartnaeckigen Service-Worker-/CDN-Altbestand sicher zu ueberspringen. */
    async loadLocal(opts) {
      opts = opts || {};
      if (_localFoods && _localFoods.length && !opts.force) return _localFoods;
      var url = "assets/data/punkto-foods.json" + (opts.force ? "?v=" + Date.now() : "");
      try {
        var res = await fetch(url, { cache: opts.force ? "reload" : "no-cache" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        var j = await res.json();
        var list = Array.isArray(j && j.foods) ? j.foods : [];
        if (list.length) _localFoods = list;   // nur ein echtes Ergebnis behalten
        return list;
      } catch (e) {
        return _localFoods || [];   // Cache NICHT mit [] vergiften -> Retry bleibt moeglich
      }
    },
    async search(q) {
      var list = await foods.loadLocal();
      q = (q || "").trim().toLowerCase();
      if (!q) return list.slice(0, 40);
      var norm = function (s) { return s.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss"); };
      var nq = norm(q);
      return list.filter(function (f) { return norm(f.name).indexOf(nq) >= 0 || (f.cat && norm(f.cat).indexOf(nq) >= 0); }).slice(0, 40);
    },
    /* Barcode -> Open Food Facts. Liefert ein Food-Objekt im Punkto-Schema
       (Werte je 100 g) oder null, wenn nicht gefunden.
       Erkennt zusaetzlich Einheit (g/ml), Diaet-Flags (nur wenn SICHER) und die
       OFF-Produktfotos (Front/Zutaten/Naehrwerte/Verpackung) fuer die Auto-Erfassung. */
    async byBarcode(code) {
      code = String(code || "").replace(/\D/g, "");
      if (!code) return null;
      var url = "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) +
        ".json?fields=product_name,product_name_de,brands,nutriments,serving_quantity," +
        "product_quantity_unit,quantity,categories_tags,labels_tags,ingredients_analysis_tags," +
        "image_front_url,image_ingredients_url,image_nutrition_url,image_packaging_url";
      var j;
      try {
        var res = await fetch(url, { headers: { "Accept": "application/json" } });
        j = await res.json();
      } catch (e) { return null; }
      if (!j || j.status !== 1 || !j.product) return null;
      var p = j.product, n = p.nutriments || {};
      var num = function (v) { var x = Number(v); return Number.isFinite(x) ? x : 0; };
      var kcal = num(n["energy-kcal_100g"]);
      if (!kcal && n["energy_100g"]) kcal = num(n["energy_100g"]) / 4.184; // kJ -> kcal

      // --- Marke (erste aus der Komma-Liste) und reiner Produktname ---
      var brand = p.brands ? String(p.brands).split(",")[0].trim() : "";
      var name = p.product_name_de || p.product_name || "Produkt";

      // --- Einheit: primaer product_quantity_unit, sonst "ml"/"l" in quantity,
      //     sonst Getraenke-Kategorie -> ml; ansonsten g. ---
      var unit = "g";
      var pqu = String(p.product_quantity_unit || "").toLowerCase();
      var qty = String(p.quantity || "").toLowerCase();
      var cats = (p.categories_tags || []).join(" ").toLowerCase();
      if (pqu === "ml" || pqu === "l") unit = "ml";
      else if (/\d\s*m?l\b/.test(qty)) unit = "ml";
      else if (/beverage|drink|getr[aä]nke|juice|soda|water|wasser|limonad/.test(cats)) unit = "ml";

      // --- Diaet-Flags: NUR bei ausdruecklichem "en:vegan"/"en:vegetarian"
      //     (in labels_tags ODER ingredients_analysis_tags). "maybe-*" = unsicher
      //     -> gar nichts setzen (Ehrlichkeit; z. B. Cola = maybe-vegan). ---
      var tags = [].concat(p.labels_tags || [], p.ingredients_analysis_tags || [])
        .map(function (t) { return String(t).toLowerCase(); });
      var isVegan = tags.indexOf("en:vegan") >= 0;
      var isVegetarian = isVegan || tags.indexOf("en:vegetarian") >= 0;

      var img = function (u) { return (typeof u === "string" && /^https?:\/\//.test(u)) ? u : ""; };
      var imgFront = img(p.image_front_url);
      var imgNutri = img(p.image_nutrition_url);
      var imgIngr  = img(p.image_ingredients_url);
      var imgPack  = img(p.image_packaging_url);

      return {
        id: "off-" + code,
        barcode: code,
        name: name,
        brand: brand,
        cat: "Barcode",
        unit: unit,
        base_g: 100,
        kcal: Math.round(kcal),
        sat_fat_g: num(n["saturated-fat_100g"]),
        sugar_g: num(n["sugars_100g"]),
        protein_g: num(n["proteins_100g"]),
        fiber_g: num(n["fiber_100g"]),
        vegan: isVegan,
        vegetarian: isVegetarian,
        // Produktfotos aus der OFF-Datenbank (Auto-Erfassung laedt sie best-effort herunter)
        image_front: imgFront,
        image_nutrition: imgNutri,
        image_ingredients: imgIngr,
        image_packaging: imgPack,
        photo_url: imgFront,
        free: false,
        source: "openfoodfacts"
      };
    }
  };

  /* ------------------------------------------------------------ COMMUNITY --- */
  /* Gemeinschafts-Produktdatenbank: geraetelokal erfasste Produkte koennen (nur
     mit ausdruecklichem Opt-in) VORGESCHLAGEN werden. Uebertragen werden nur
     Name/Marke/Naehrwerte/Barcode — NIE Fotos, nie sonstige Record-Interna.
     Freigegebene Produkte werden geladen und geraetelokal gecacht (Suche/Scan
     funktionieren dann auch offline). */
  var COMMUNITY_CACHE_KEY = "pk_community_cache_v1";
  // Whitelist: die EINZIGEN Felder, die je an den Server gehen. Auch wenn der
  // Aufrufer ein ganzes PKStore-Produkt (inkl. Foto-Blobs) uebergibt, verlaesst
  // nichts anderes das Geraet. photo_url ist ausschliesslich eine OEFFENTLICHE
  // Open-Food-Facts-URL (der Server prueft die Herkunft erneut) -- niemals ein
  // selbst aufgenommenes Foto und keine sonstigen personenbezogenen Daten
  // ("gekauft bei" bleibt bewusst geraetelokal).
  function centralPayload(p) {
    p = p || {};
    var n = function (v) { var x = Number(v); return Number.isFinite(x) ? x : 0; };
    return {
      name: String(p.name || ""), brand: String(p.brand || ""),
      barcode: String(p.barcode || ""), unit: p.unit === "ml" ? "ml" : "g",
      base_g: n(p.base_g) || 100,
      kcal: n(p.kcal), sat_fat_g: n(p.sat_fat_g), sugar_g: n(p.sugar_g),
      protein_g: n(p.protein_g), fiber_g: n(p.fiber_g),
      // Diaet-Flags mitteilen (vegan impliziert vegetarisch).
      vegan: !!p.vegan, vegetarian: !!p.vegetarian || !!p.vegan,
      // Optionale oeffentliche OFF-Foto-URL (Server prueft die Herkunft).
      photo_url: String(p.photo_url || "")
    };
  }

  var community = {
    /* Ein Produkt in die zentrale Datenbank aufnehmen. NUR fuer das Betreiber-/Admin-
       Konto erlaubt (der Server prueft is_admin und lehnt sonst mit 403 ab). Uebertragen
       werden ausschliesslich die Whitelist-Skalare + optionale oeffentliche OFF-Foto-URL.
       Der Eintrag ist danach sofort fuer alle in der Lebensmittel-Suche sichtbar. */
    centralAdd(product) { return call("data", "central_add", centralPayload(product)); },
    /* Einen bestehenden zentralen Eintrag per id bearbeiten (nur Betreiber/Admin —
       der Server prueft is_admin). Uebertragen wird dieselbe Whitelist wie bei
       centralAdd; photo_url bleibt serverseitig erhalten, wenn keine neue OFF-URL kommt. */
    centralUpdate(id, product) {
      var p = centralPayload(product); p.id = String(id);
      return call("data", "central_update", p);
    },
    /* Einen zentralen Eintrag per id entfernen (nur Betreiber/Admin). */
    centralDelete(id) { return call("data", "central_delete", { id: String(id) }); },
    /* Freigegebene Produkte laden und geraetelokal cachen (fuer Offline-Suche). */
    async list() {
      var d = await call("data", "product_list", {});
      try {
        localStorage.setItem(COMMUNITY_CACHE_KEY, JSON.stringify({ at: Date.now(), products: d.products || [] }));
      } catch (e) { /* Speicher voll/gesperrt -> egal */ }
      return d;
    },
    /* Zuletzt gecachte, freigegebene Produkte (instant, offline). */
    cached() {
      try {
        var raw = localStorage.getItem(COMMUNITY_CACHE_KEY);
        if (!raw) return [];
        var j = JSON.parse(raw);
        return (j && j.products) || [];
      } catch (e) { return []; }
    }
  };

  /* ---------------------------------------------------------------- BLS ----- */
  /* Bundeslebensmittelschluessel (BLS) 4.0 — amtliche Naehrwert-Datenbank des
     Max Rubner-Instituts (CC BY 4.0), serverseitig in punkto.bls_foods (je 100 g).
     Reine LESE-Suche ueber die Edge-Function punkto-bls (Session-Token noetig).
     Punkte werden NICHT vom Server geliefert, sondern im Client aus den
     Naehrwerten berechnet (PK.pointsForAmount) — wie bei allen anderen Quellen. */
  var bls = {
    /* Freitext-Suche. Liefert { ok, foods:[{bls,name,kcal,sat_fat_g,sugar_g,
       protein_g,fiber_g}], count, source, attribution }. Wirft bei Netz-/Auth-
       Fehler (Aufrufer behandeln BLS als optionale Ergaenzung -> best effort). */
    async search(q, limit) {
      q = String(q || "").trim();
      if (q.length < 2) return { ok: true, foods: [], count: 0 };
      return call("bls", "bls_search", { q: q, limit: limit || 30 });
    }
  };

  var API = {
    cfg: CFG, getToken: getToken, setToken: setToken, clearToken: clearToken,
    call: call, auth: auth, data: data, admin: admin, foods: foods, community: community, bls: bls
  };
  root.PKApi = API;
})(typeof window !== "undefined" ? window : globalThis);
