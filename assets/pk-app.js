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

  /* ---------------------------------------------------------------- DATA ---- */
  var data = {
    state(day) { return call("data", "state", day ? { day: day } : {}); },
    billing() { return call("data", "billing", {}); },
    diaryAdd(entry) { return call("data", "diary_add", entry); },
    diaryDel(id) { return call("data", "diary_del", { id: id }); },
    weightSet(kg, day) { return call("data", "weight_set", { weight_kg: kg, day: day }); },
    weightDel(day) { return call("data", "weight_del", { day: day }); },
    activityAdd(a) { return call("data", "activity_add", a); },
    activityDel(id) { return call("data", "activity_del", { id: id }); },
    foodAdd(food) { return call("data", "food_add", food); },
    foodDel(id) { return call("data", "food_del", { id: id }); },
    recipeAdd(recipe) { return call("data", "recipe_add", recipe); },
    recipeDel(id) { return call("data", "recipe_del", { id: id }); }
  };

  /* ---------------------------------------------------------------- ADMIN --- */
  var admin = {
    login(key) { return call("admin", "login", {}, { token: null, adminKey: key }); },
    stats(key) { return call("admin", "stats", {}, { token: null, adminKey: key }); },
    users(key, q, offset, limit) { return call("admin", "users", { q: q || "", offset: offset || 0, limit: limit || 50 }, { token: null, adminKey: key }); },
    user(key, id) { return call("admin", "user", { id: id }, { token: null, adminKey: key }); },
    extend(key, id, months, amount_cents, method, ref, note) {
      return call("admin", "extend", { id: id, months: months, amount_cents: amount_cents, method: method, ref: ref, note: note }, { token: null, adminKey: key });
    },
    setStatus(key, id, status, clear_period) { return call("admin", "set_status", { id: id, status: status, clear_period: !!clear_period }, { token: null, adminKey: key }); },
    addNote(key, id, notes) { return call("admin", "add_note", { id: id, notes: notes }, { token: null, adminKey: key }); },
    export(key) { return call("admin", "export", {}, { token: null, adminKey: key }); },
    setKey(key, new_key) { return call("admin", "set_key", { new_key: new_key }, { token: null, adminKey: key }); }
  };

  /* ---------------------------------------------------------------- FOODS --- */
  var _localFoods = null;
  var foods = {
    async loadLocal() {
      if (_localFoods) return _localFoods;
      try {
        var res = await fetch("assets/data/punkto-foods.json", { cache: "force-cache" });
        var j = await res.json();
        _localFoods = j.foods || [];
      } catch (e) { _localFoods = []; }
      return _localFoods;
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
       (Werte je 100 g) oder null, wenn nicht gefunden. */
    async byBarcode(code) {
      code = String(code || "").replace(/\D/g, "");
      if (!code) return null;
      var url = "https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) +
        ".json?fields=product_name,product_name_de,brands,nutriments,serving_quantity";
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
      return {
        id: "off-" + code,
        barcode: code,
        name: (p.product_name_de || p.product_name || "Produkt") + (p.brands ? " (" + String(p.brands).split(",")[0].trim() + ")" : ""),
        cat: "Barcode",
        unit: "g",
        base_g: 100,
        kcal: Math.round(kcal),
        sat_fat_g: num(n["saturated-fat_100g"]),
        sugar_g: num(n["sugars_100g"]),
        protein_g: num(n["proteins_100g"]),
        fiber_g: num(n["fiber_100g"]),
        free: false,
        source: "openfoodfacts"
      };
    }
  };

  var API = {
    cfg: CFG, getToken: getToken, setToken: setToken, clearToken: clearToken,
    call: call, auth: auth, data: data, admin: admin, foods: foods
  };
  root.PKApi = API;
})(typeof window !== "undefined" ? window : globalThis);
