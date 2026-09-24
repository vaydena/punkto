/* ============================================================================
   Punkto — Sicherung (Backup/Restore) des GERAETELOKALEN Bestands.
   Buendelt die beiden lokalen Datenquellen in EINE versionierte JSON-Datei:
     - PKDiary : Tagebuch / Gewicht / Aktivitaeten  (rein lokal)
     - PKStore : selbst angelegte Produkte inkl. der 3 Fotos (rein lokal)
   Zweck: manuelle Sicherung und der Umzug auf ein neues Geraet (bewusst manuell,
   da keine Server-Synchronisation stattfindet). Fotos sind Blobs -> im Export
   als data:-URL (Base64) eingebettet, beim Import zurueck zu Blobs.

   Format (selbstbeschreibend, versioniert):
     { format:"punkto-backup", version:1, app:"punkto", exported_at:ISO,
       diary:{ entries:[], weights:[], activities:[] },
       products:[ { …, photos:{ product,nutrition,barcode : dataURL|null } } ] }

   Global: window.PKBackup  (build()/apply() liefern Promises).
   ============================================================================ */
(function (root) {
  "use strict";

  var FORMAT = "punkto-backup";
  var VERSION = 1;

  /* --- Blob <-> data:-URL (Base64) ----------------------------------------- */
  function blobToDataURL(blob) {
    return new Promise(function (resolve) {
      if (!blob) return resolve(null);
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { resolve(null); };
        fr.readAsDataURL(blob);
      } catch (e) { resolve(null); }
    });
  }
  function dataURLToBlob(url) {
    if (!url || typeof url !== "string" || url.indexOf("data:") !== 0) return null;
    try {
      var comma = url.indexOf(",");
      if (comma < 0) return null;
      var header = url.slice(5, comma), b64 = url.slice(comma + 1);
      var mime = (header.split(";")[0]) || "application/octet-stream";
      var bin = atob(b64), len = bin.length, arr = new Uint8Array(len);
      for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch (e) { return null; }
  }

  /* --- Produkt (PKStore) <-> reine JSON-Form ------------------------------- */
  function productToPlain(p) {
    var ph = p.photos || {};
    return Promise.all([
      blobToDataURL(ph.product), blobToDataURL(ph.nutrition), blobToDataURL(ph.barcode)
    ]).then(function (imgs) {
      return {
        barcode: p.barcode, name: p.name, brand: p.brand || "",
        unit: p.unit || "g", base_g: p.base_g || 100,
        kcal: p.kcal, sat_fat_g: p.sat_fat_g, sugar_g: p.sugar_g,
        protein_g: p.protein_g, fiber_g: p.fiber_g,
        free: !!p.free, source: p.source || "local", points: p.points,
        vegan: !!p.vegan, vegetarian: !!p.vegetarian, bought_at: p.bought_at || "",
        created_at: p.created_at, updated_at: p.updated_at,
        photos: { product: imgs[0], nutrition: imgs[1], barcode: imgs[2] }
      };
    });
  }
  /* Werte aus einer (fremden) Datei nie ungeprueft uebernehmen: nur endliche Zahlen. */
  function safeNum(v) { var n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }
  function safePts(v) {
    if (v == null || v === "") return null;
    var n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(200, n)) : null;
  }
  function safeStr(v, n) { return String(v == null ? "" : v).slice(0, n); }
  function plainToProduct(p) {
    p = p || {};
    var ph = p.photos || {};
    return {
      barcode: safeStr(p.barcode, 40), name: safeStr(p.name, 120), brand: safeStr(p.brand, 80),
      unit: safeStr(p.unit || "g", 20), base_g: safeNum(p.base_g) || 100,
      kcal: safeNum(p.kcal), sat_fat_g: safeNum(p.sat_fat_g), sugar_g: safeNum(p.sugar_g),
      protein_g: safeNum(p.protein_g), fiber_g: safeNum(p.fiber_g),
      free: !!p.free, source: safeStr(p.source || "local", 20), points: safePts(p.points),
      vegan: !!p.vegan, vegetarian: !!p.vegetarian, bought_at: safeStr(p.bought_at, 80),
      created_at: p.created_at, updated_at: p.updated_at,
      photos: {
        product: dataURLToBlob(ph.product),
        nutrition: dataURLToBlob(ph.nutrition),
        barcode: dataURLToBlob(ph.barcode)
      }
    };
  }

  /* --- Geraetelokale Extras (localStorage): Koerpermasse, gespeicherte
     Mahlzeiten, „Meine Portion". Optionales Feld `local` — aeltere Sicherungen
     ohne es bleiben gueltig, aeltere App-Versionen ignorieren es. --- */
  var LOCAL_KEYS = { measures: "pk_measure_v1", meals: "pk_meals_v1", portions: "pk_portions_v1" };
  function lsRead(k, dflt) { try { var v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? dflt : v; } catch (e) { return dflt; } }
  function lsWrite(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function buildLocal() {
    return { measures: lsRead(LOCAL_KEYS.measures, []), meals: lsRead(LOCAL_KEYS.meals, []), portions: lsRead(LOCAL_KEYS.portions, {}) };
  }
  /* Zusammenfuehren: Vorhandenes bleibt, Fehlendes wird ergaenzt (idempotent). */
  function applyLocal(loc) {
    var n = 0;
    if (!loc || typeof loc !== "object") return n;
    var DAY = /^\d{4}-\d{2}-\d{2}$/;
    if (Array.isArray(loc.measures)) {
      var cur = lsRead(LOCAL_KEYS.measures, []), have = {};
      if (!Array.isArray(cur)) cur = [];
      cur.forEach(function (m) { have[m.day] = 1; });
      loc.measures.forEach(function (m) {
        if (!m || !DAY.test(String(m.day)) || have[m.day]) return;
        var w = +m.waist_cm, h = +m.hip_cm;
        w = (w >= 30 && w <= 300) ? w : null; h = (h >= 30 && h <= 300) ? h : null;
        if (w == null && h == null) return;
        cur.push({ day: String(m.day), waist_cm: w, hip_cm: h }); have[m.day] = 1; n++;
      });
      cur.sort(function (a, b) { return a.day < b.day ? -1 : 1; });
      lsWrite(LOCAL_KEYS.measures, cur);
    }
    if (Array.isArray(loc.meals)) {
      var ml = lsRead(LOCAL_KEYS.meals, []), ids = {};
      if (!Array.isArray(ml)) ml = [];
      ml.forEach(function (t) { ids[t.id] = 1; });
      loc.meals.forEach(function (t) {
        if (!t || !t.id || ids[t.id] || !Array.isArray(t.items) || ml.length >= 30) return;
        ml.push(t); ids[t.id] = 1; n++;
      });
      lsWrite(LOCAL_KEYS.meals, ml);
    }
    if (loc.portions && typeof loc.portions === "object" && !Array.isArray(loc.portions)) {
      var pm = lsRead(LOCAL_KEYS.portions, {});
      if (!pm || typeof pm !== "object" || Array.isArray(pm)) pm = {};
      Object.keys(loc.portions).forEach(function (k) {
        var v = loc.portions[k];
        if (pm[k] || !v || !(+v.v > 0)) return;
        pm[k] = { v: +v.v, unit: String(v.unit || "g").slice(0, 20) }; n++;
      });
      lsWrite(LOCAL_KEYS.portions, pm);
    }
    return n;
  }

  /* --- Aufbauen der Sicherung ---------------------------------------------- */
  async function build() {
    var diary = root.PKDiary
      ? await root.PKDiary.exportAll()
      : { entries: [], weights: [], activities: [] };
    var products = [];
    if (root.PKStore) {
      var raw = await root.PKStore.all();
      for (var i = 0; i < raw.length; i++) products.push(await productToPlain(raw[i]));
    }
    return {
      format: FORMAT, version: VERSION, app: "punkto",
      exported_at: new Date().toISOString(),
      diary: diary, products: products, local: buildLocal()
    };
  }

  /* --- Einspielen einer Sicherung ------------------------------------------ */
  async function apply(obj, opts) {
    if (!obj || typeof obj !== "object" || obj.format !== FORMAT) throw new Error("bad_format");
    if (+obj.version > VERSION) throw new Error("newer_version");
    var diaryRes = root.PKDiary
      ? await root.PKDiary.importAll(obj.diary || {}, opts)
      : { counts: { entries: 0, weights: 0, activities: 0 } };
    var prodN = 0;
    if (root.PKStore && Array.isArray(obj.products)) {
      for (var i = 0; i < obj.products.length; i++) {
        try {
          var rec = plainToProduct(obj.products[i]);
          if (rec.barcode) { await root.PKStore.put(rec); prodN++; }
        } catch (e) { /* einzelnes Produkt ueberspringen */ }
      }
    }
    var localN = 0;
    try { localN = applyLocal(obj.local); } catch (e) { /* Extras sind optional */ }
    return {
      ok: true,
      records: diaryRes.records || null,
      counts: {
        entries: diaryRes.counts.entries,
        weights: diaryRes.counts.weights,
        activities: diaryRes.counts.activities,
        products: prodN,
        local: localN
      }
    };
  }

  root.PKBackup = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    build: build,
    apply: apply,
    _blobToDataURL: blobToDataURL,
    _dataURLToBlob: dataURLToBlob
  };
})(typeof window !== "undefined" ? window : globalThis);
