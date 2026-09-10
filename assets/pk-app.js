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
    diaryUpdate(entry) { return call("data", "diary_update", entry); },
    diaryDel(id) { return call("data", "diary_del", { id: id }); },
    weightSet(kg, day) { return call("data", "weight_set", { weight_kg: kg, day: day }); },
    weightDel(day) { return call("data", "weight_del", { day: day }); },
    activityAdd(a) { return call("data", "activity_add", a); },
    activityDel(id) { return call("data", "activity_del", { id: id }); },
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
    extend(key, id, months, amount_cents, method, ref, note) {
      return call("admin", "extend", { id: id, months: months, amount_cents: amount_cents, method: method, ref: ref, note: note }, { token: null, adminKey: key });
    },
    setStatus(key, id, status, clear_period) { return call("admin", "set_status", { id: id, status: status, clear_period: !!clear_period }, { token: null, adminKey: key }); },
    addNote(key, id, notes) { return call("admin", "add_note", { id: id, notes: notes }, { token: null, adminKey: key }); },
    export(key) { return call("admin", "export", {}, { token: null, adminKey: key }); },
    setKey(key, new_key) { return call("admin", "set_key", { new_key: new_key }, { token: null, adminKey: key }); },
    productsPending(key, limit) { return call("admin", "products_pending", { limit: limit || 200 }, { token: null, adminKey: key }); },
    productModerate(key, id, decision, patch, reason) {
      return call("admin", "product_moderate", { id: id, decision: decision, patch: patch || null, reason: reason || "" }, { token: null, adminKey: key });
    },
    photosPending(key, limit) { return call("admin", "photos_pending", { limit: limit || 100 }, { token: null, adminKey: key }); },
    photoModerate(key, id, decision, reason) {
      return call("admin", "photo_moderate", { id: id, decision: decision, reason: reason || "" }, { token: null, adminKey: key });
    }
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

  /* ------------------------------------------------------------ COMMUNITY --- */
  /* Gemeinschafts-Produktdatenbank: geraetelokal erfasste Produkte koennen (nur
     mit ausdruecklichem Opt-in) VORGESCHLAGEN werden. Uebertragen werden nur
     Name/Marke/Naehrwerte/Barcode — NIE Fotos, nie sonstige Record-Interna.
     Freigegebene Produkte werden geladen und geraetelokal gecacht (Suche/Scan
     funktionieren dann auch offline). */
  var COMMUNITY_CACHE_KEY = "pk_community_cache_v1";
  // Whitelist: die EINZIGEN Felder, die je an den Server gehen. Auch wenn der
  // Aufrufer ein ganzes PKStore-Produkt (inkl. Foto-Blobs) uebergibt, verlaesst
  // nichts anderes das Geraet.
  function submitPayload(p) {
    p = p || {};
    var n = function (v) { var x = Number(v); return Number.isFinite(x) ? x : 0; };
    return {
      name: String(p.name || ""), brand: String(p.brand || ""),
      barcode: String(p.barcode || ""), unit: p.unit === "ml" ? "ml" : "g",
      base_g: n(p.base_g) || 100,
      kcal: n(p.kcal), sat_fat_g: n(p.sat_fat_g), sugar_g: n(p.sugar_g),
      protein_g: n(p.protein_g), fiber_g: n(p.fiber_g),
      // Diaet-Flags mitteilen (vegan impliziert vegetarisch). "gekauft bei" bleibt
      // bewusst geraetelokal -> wird NICHT an die Gemeinschaft uebergeben.
      vegan: !!p.vegan, vegetarian: !!p.vegetarian || !!p.vegan
    };
  }
  /* Einen (bereits geraetelokal als JPEG gespeicherten) Foto-Blob fuer den
     Community-Vorschlag aufbereiten: ueber ein Canvas klein rechnen (streift zugleich
     EXIF/GPS) und als JPEG-DataURL liefern. Bleibt klar unter der 800-KB-Grenze der
     Edge-Function. Nur fuer syncPending() (die App selbst nutzt ihren eigenen Weg). */
  function blobToJpegDataUrl(blob, maxDim, quality) {
    maxDim = maxDim || 1000; quality = quality || 0.8;
    return new Promise(function (resolve) {
      if (!blob || typeof document === "undefined" || typeof createImageBitmap === "undefined") return resolve("");
      createImageBitmap(blob).then(function (bmp) {
        try {
          var w = bmp.width, h = bmp.height;
          var scale = Math.min(1, maxDim / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
          cv.getContext("2d").drawImage(bmp, 0, 0, cw, ch);
          try { bmp.close && bmp.close(); } catch (e) { /* egal */ }
          var url = cv.toDataURL("image/jpeg", quality);
          resolve(url && url.indexOf("data:image/jpeg") === 0 ? url : "");
        } catch (e) { resolve(""); }
      }).catch(function () { resolve(""); });
    });
  }

  var community = {
    /* Ein Produkt der Gemeinschaft vorschlagen (verlangt aktiven Zugang). */
    submit(product) { return call("data", "product_submit", submitPayload(product)); },
    /* Optionales Produktfoto zu einem Gemeinschaftsprodukt vorschlagen (zweites
       Opt-in). photo = JPEG-DataURL oder Base64. Landet als "pending" im privaten
       Bucket und wird erst nach Betreiber-Freigabe am Artikel gezeigt. */
    submitPhoto(community_product_id, photo) {
      return call("data", "product_photo_submit", { community_product_id: community_product_id, photo: photo });
    },
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
    },
    /* Als "shared" markierte, noch nicht synchronisierte Produkte nachreichen
       (z. B. Erfassung war offline oder der Zugang war gerade abgelaufen). Aendert
       NIE Werte, schickt nur die Whitelist. Fehler werden geschluckt -> der
       Datensatz bleibt "pending" und wird beim naechsten Online-Start erneut
       versucht. Kein Token / kein PKStore -> nichts zu tun. */
    async syncPending() {
      if (!root.PKStore || !getToken()) return { synced: 0, photos: 0 };
      var all;
      try { all = await root.PKStore.all(); } catch (e) { return { synced: 0, photos: 0 }; }
      var stop = false, synced = 0, photos = 0;

      // 1) Produkt-Vorschlaege (nur Skalare) nachreichen. Die zurueckgegebene id wird
      //    am Datensatz gemerkt -> ein optionales Foto kann danach zugeordnet werden.
      var pending = (all || []).filter(function (r) { return r && r.shared && r.sync_status !== "synced"; });
      for (var i = 0; i < pending.length; i++) {
        var r = pending[i];
        try {
          var d = await community.submit(r);
          r.sync_status = "synced"; r.synced_at = Date.now();
          if (d && d.id) r.community_id = d.id;
          try { await root.PKStore.put(r); } catch (e) { /* egal */ }
          synced++;
        } catch (e) {
          // Offline oder (noch) kein aktiver Zugang -> spaeter erneut versuchen.
          if (e && (e.code === "no_access" || e.code === "unauthorized" || e.status === 401 || e.status === 402)) { stop = true; break; }
        }
      }

      // 2) Optionale Produktfotos nachreichen — nur mit zweitem Opt-in (share_photo),
      //    vorhandener community_id und noch nicht uebertragenem Foto. Das Bild selbst
      //    verlaesst das Geraet nur hier. "failed" = dauerhaft untauglich (kein Retry).
      if (!stop) {
        var photoPending = (all || []).filter(function (r) {
          return r && r.share_photo && r.community_id &&
                 r.photo_sync_status !== "synced" && r.photo_sync_status !== "failed" &&
                 r.photos && r.photos.product && (r.photos.product instanceof Blob);
        });
        for (var k = 0; k < photoPending.length; k++) {
          var pr = photoPending[k];
          try {
            var url = await blobToJpegDataUrl(pr.photos.product, 1000, 0.8);
            if (!url) { pr.photo_sync_status = "error"; try { await root.PKStore.put(pr); } catch (e2) { /* egal */ } continue; }
            await community.submitPhoto(pr.community_id, url);
            pr.photo_sync_status = "synced"; pr.photo_synced_at = Date.now();
            try { await root.PKStore.put(pr); } catch (e3) { /* egal */ }
            photos++;
          } catch (e) {
            var code = (e && e.status) || 0;
            // Zugang abgelaufen / offline -> abbrechen, beim naechsten Start erneut.
            if (e && (e.code === "no_access" || e.code === "unauthorized" || code === 401 || code === 402)) break;
            // Bild dauerhaft untauglich (ungueltig / zu gross / kein JPEG) -> aufgeben.
            pr.photo_sync_status = (code === 400 || code === 413 || code === 415) ? "failed" : "error";
            try { await root.PKStore.put(pr); } catch (e4) { /* egal */ }
          }
        }
      }

      return { synced: synced, photos: photos };
    }
  };

  var API = {
    cfg: CFG, getToken: getToken, setToken: setToken, clearToken: clearToken,
    call: call, auth: auth, data: data, admin: admin, foods: foods, community: community
  };
  root.PKApi = API;
})(typeof window !== "undefined" ? window : globalThis);
