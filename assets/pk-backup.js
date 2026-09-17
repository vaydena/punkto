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
  function plainToProduct(p) {
    var ph = p.photos || {};
    return {
      barcode: p.barcode, name: p.name, brand: p.brand || "",
      unit: p.unit || "g", base_g: p.base_g || 100,
      kcal: p.kcal, sat_fat_g: p.sat_fat_g, sugar_g: p.sugar_g,
      protein_g: p.protein_g, fiber_g: p.fiber_g,
      free: !!p.free, source: p.source || "local", points: p.points,
      vegan: !!p.vegan, vegetarian: !!p.vegetarian, bought_at: p.bought_at || "",
      created_at: p.created_at, updated_at: p.updated_at,
      photos: {
        product: dataURLToBlob(ph.product),
        nutrition: dataURLToBlob(ph.nutrition),
        barcode: dataURLToBlob(ph.barcode)
      }
    };
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
      diary: diary, products: products
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
    return {
      ok: true,
      counts: {
        entries: diaryRes.counts.entries,
        weights: diaryRes.counts.weights,
        activities: diaryRes.counts.activities,
        products: prodN
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
