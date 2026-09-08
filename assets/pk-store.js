/* ============================================================================
   Punkto — Lokaler Produkt-Speicher (IndexedDB, geraetelokal, OFFLINE).
   Haelt selbst angelegte Produkte (3-Foto-Erfassung) ausschliesslich auf dem
   Geraet: Barcode = Schluessel, Naehrwerte je 100 g/ml, plus die 3 Fotos als
   Blobs. Keine Server-Synchronisation (bewusste Entscheidung des Betreibers).

   Datensatz-Schema (kompatibel mit normFood()/openFoodDetail() der App):
     {
       barcode, name, brand, unit ("g"|"ml"), base_g (i. d. R. 100),
       kcal, sat_fat_g, sugar_g, protein_g, fiber_g,
       free:false, source:"local", points (PK.pointsFor je base),
       photos: { product:Blob|null, nutrition:Blob|null, barcode:Blob|null },
       created_at, updated_at
     }

   Global: window.PKStore  (alle Methoden liefern Promises).
   ============================================================================ */
(function (root) {
  "use strict";

  var DB_NAME = "punkto-local";
  var DB_VER = 1;
  var STORE = "products";
  var _db = null;

  var supported = (function () {
    try { return typeof indexedDB !== "undefined" && !!indexedDB; } catch (e) { return false; }
  })();

  function open() {
    return new Promise(function (resolve, reject) {
      if (_db) return resolve(_db);
      if (!supported) return reject(new Error("indexeddb_unsupported"));
      var rq;
      try { rq = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { return reject(e); }
      rq.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: "barcode" });
          os.createIndex("created_at", "created_at", { unique: false });
        }
      };
      rq.onsuccess = function () {
        _db = rq.result;
        _db.onversionchange = function () { try { _db.close(); } catch (e) {} _db = null; };
        resolve(_db);
      };
      rq.onerror = function () { reject(rq.error || new Error("indexeddb_open_failed")); };
      rq.onblocked = function () { reject(new Error("indexeddb_blocked")); };
    });
  }

  function objStore(mode) {
    return open().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function reqP(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function normCode(code) { return String(code == null ? "" : code).replace(/\s+/g, "").replace(/\D/g, ""); }

  var PKStore = {
    supported: supported,

    /* Produkt anlegen/aktualisieren (put = upsert, Barcode ist der Schluessel). */
    async put(rec) {
      rec = rec || {};
      rec.barcode = normCode(rec.barcode);
      if (!rec.barcode) throw new Error("barcode_required");
      var now = Date.now();
      if (!rec.created_at) rec.created_at = now;
      rec.updated_at = now;
      if (rec.source == null) rec.source = "local";
      var os = await objStore("readwrite");
      await reqP(os.put(rec));
      return rec;
    },

    /* Ein Produkt per Barcode (offline). null, wenn nicht vorhanden. */
    async get(code) {
      code = normCode(code);
      if (!code || !supported) return null;
      try {
        var os = await objStore("readonly");
        return (await reqP(os.get(code))) || null;
      } catch (e) { return null; }
    },

    /* Alle Produkte, neueste zuerst. Bei Fehler/Support-Mangel: []. */
    async all() {
      if (!supported) return [];
      try {
        var os = await objStore("readonly");
        var list;
        if (os.getAll) { list = await reqP(os.getAll()); }
        else {
          list = [];
          await new Promise(function (resolve, reject) {
            var cur = os.openCursor();
            cur.onsuccess = function () { var c = cur.result; if (c) { list.push(c.value); c.continue(); } else resolve(); };
            cur.onerror = function () { reject(cur.error); };
          });
        }
        return (list || []).sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
      } catch (e) { return []; }
    },

    /* Produkt loeschen. */
    async del(code) {
      code = normCode(code);
      if (!code) return false;
      var os = await objStore("readwrite");
      await reqP(os.delete(code));
      return true;
    },

    /* Freitext-Suche ueber Name/Marke/Barcode (offline). */
    async search(q) {
      var list = await PKStore.all();
      q = String(q || "").trim().toLowerCase();
      if (!q) return list;
      return list.filter(function (f) {
        return (f.name || "").toLowerCase().indexOf(q) >= 0 ||
               (f.brand || "").toLowerCase().indexOf(q) >= 0 ||
               (f.barcode || "").indexOf(q) >= 0;
      });
    },

    /* Anzahl gespeicherter Produkte. */
    async count() {
      if (!supported) return 0;
      try {
        var os = await objStore("readonly");
        if (os.count) return await reqP(os.count());
        return (await PKStore.all()).length;
      } catch (e) { return 0; }
    }
  };

  root.PKStore = PKStore;
})(typeof window !== "undefined" ? window : globalThis);
