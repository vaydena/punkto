/* ============================================================================
   Punkto — Lokales Tagebuch (IndexedDB, geraetelokal, OFFLINE-FIRST).
   Haelt Tagebuch-Eintraege, Gewicht und Aktivitaeten AUSSCHLIESSLICH auf dem
   Geraet. Damit kann der Kunde seine Mahlzeiten jederzeit speichern — auch
   voellig ohne Netz. Keine Server-Synchronisation (bewusste Entscheidung).

   Die Methoden liefern EXAKT dieselben Shapes wie die Edge-Function punkto-data
   (action "state"/"diary_add"/…), damit Render- und Schreib-Ebene der App
   unveraendert bleiben:
     dayState(day) -> { day, week_start, diary, activity, weight_today,
                        weights, week, week_bonus }
       diary[]    : { id, meal, name, points, qty, unit, kcal, source, ref_code, created_at }  (nach created_at aufsteigend)
       activity[] : { id, kind, steps, minutes, bonus_points, note, created_at }               (nach created_at aufsteigend)
       weights[]  : { day, weight_kg }  (nach Tag aufsteigend, letzte 200)
       week[]     : { day, points }     (Mo–So der Woche von day, je Tag mit Eintraegen)
       week_bonus[]: { day, bonus }     (Mo–So, je Tag mit Aktivitaeten)
     entryAdd/entryUpdate/entryDel, weightSet/weightDel,
     activityAdd/activitySetSteps/activityDel  -> { ok:true, entry|weight }

   „Heute" und die Woche (Mo–So) werden im LOKALEN Kalender gerechnet — passend
   zu isoOf() der App (nicht UTC wie serverseitig), damit der Tageswechsel um
   Mitternacht des Nutzers stimmt.

   Global: window.PKDiary  (alle Methoden liefern Promises).
   ============================================================================ */
(function (root) {
  "use strict";

  var DB_NAME = "punkto-diary";
  var DB_VER = 1;
  var ENTRIES = "entries";     // Tagebuch (keyPath id, Index "day")
  var WEIGHTS = "weights";     // ein Gewicht je Tag (keyPath day)
  var ACTS = "activities";     // Aktivitaeten (keyPath id, Index "day")
  var _db = null;

  var supported = (function () {
    try { return typeof indexedDB !== "undefined" && !!indexedDB; } catch (e) { return false; }
  })();

  /* ------------------------------------------------------------- DB-Zugriff -- */
  function open() {
    return new Promise(function (resolve, reject) {
      if (_db) return resolve(_db);
      if (!supported) return reject(new Error("indexeddb_unsupported"));
      var rq;
      try { rq = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { return reject(e); }
      rq.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(ENTRIES)) {
          db.createObjectStore(ENTRIES, { keyPath: "id" }).createIndex("day", "day", { unique: false });
        }
        if (!db.objectStoreNames.contains(WEIGHTS)) {
          db.createObjectStore(WEIGHTS, { keyPath: "day" });
        }
        if (!db.objectStoreNames.contains(ACTS)) {
          db.createObjectStore(ACTS, { keyPath: "id" }).createIndex("day", "day", { unique: false });
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

  function store(name, mode) {
    return open().then(function (db) { return db.transaction(name, mode).objectStore(name); });
  }
  function reqP(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  /* Alle Datensaetze eines Stores; robust (leere Liste statt Ausnahme). */
  function getAll(name) {
    return store(name, "readonly").then(function (os) {
      if (os.getAll) return reqP(os.getAll());
      return new Promise(function (resolve, reject) {
        var list = [], cur = os.openCursor();
        cur.onsuccess = function () { var c = cur.result; if (c) { list.push(c.value); c.continue(); } else resolve(list); };
        cur.onerror = function () { reject(cur.error); };
      });
    }).then(function (l) { return l || []; }).catch(function () { return []; });
  }

  /* ---------------------------------------------------------- Datum/Helfer -- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function isoOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseISO(s) { var p = String(s).split("-"); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
  function addDaysD(d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  function todayISO() { return isoOf(new Date()); }
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function normDay(day) { return (day && DATE_RE.test(day)) ? day : todayISO(); }
  /* Mo–So-Woche (ISO, Mo=0) des Tages — LOKAL gerechnet, passend zu todayISO(). */
  function weekRange(dayStr) {
    var d = parseISO(dayStr), dow = (d.getDay() + 6) % 7, start = addDaysD(d, -dow);
    return { start: isoOf(start), end: isoOf(addDaysD(start, 6)) };
  }

  function num(v, dflt) { var x = Number(v); return Number.isFinite(x) ? x : (dflt || 0); }
  function clamp(v, lo, hi) { v = num(v, lo); return v < lo ? lo : (v > hi ? hi : v); }
  function str(v, max) { return (v == null) ? "" : String(v).slice(0, max); }
  function strOrNull(v, max) { return (v == null || v === "") ? null : String(v).slice(0, max); }
  function uuid() {
    try { if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); } catch (e) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16);
    });
  }

  var MEALS = { breakfast: 1, lunch: 1, dinner: 1, snack: 1, other: 1 };

  /* --------------------------------------------------------------- Schreiben */
  /* Neuen Tagebuch-Eintrag anlegen (wie diary_add). Normalisiert/clamped wie der
     Server; Einheit/kcal/ref_code duerfen null sein. */
  function entryAdd(e) {
    e = e || {};
    var rec = {
      id: uuid(),
      day: normDay(e.day),
      meal: MEALS[e.meal] ? e.meal : "other",
      name: str(e.name, 120),
      points: clamp(e.points, 0, 200),
      qty: clamp(e.qty == null ? 1 : e.qty, 0, 9999),
      unit: strOrNull(e.unit, 20),
      kcal: (e.kcal == null || e.kcal === "") ? null : clamp(e.kcal, 0, 99999),
      source: str(e.source == null ? "manual" : e.source, 20) || "manual",
      ref_code: strOrNull(e.ref_code, 40),
      created_at: new Date().toISOString()
    };
    return store(ENTRIES, "readwrite").then(function (os) { return reqP(os.put(rec)); })
      .then(function () { return { ok: true, entry: rec }; });
  }

  /* Eintrag bearbeiten (wie diary_update): nur meal/points/qty/unit/kcal;
     name/day/source bleiben fix. Get+Put in EINER Transaktion (sonst schliesst
     die Transaktion zwischen den awaits -> TransactionInactive). */
  function entryUpdate(patch) {
    patch = patch || {};
    var id = String(patch.id || "");
    if (!id) return Promise.resolve({ ok: false });
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ENTRIES, "readwrite"), os = tx.objectStore(ENTRIES), g = os.get(id), out = { ok: true };
        g.onsuccess = function () {
          var cur = g.result;
          if (!cur) { out = { ok: true, entry: null }; return; }
          if (patch.meal != null && MEALS[patch.meal]) cur.meal = patch.meal;
          if (patch.points != null) cur.points = clamp(patch.points, 0, 200);
          if (patch.qty != null) cur.qty = clamp(patch.qty, 0, 9999);
          if (patch.unit !== undefined) cur.unit = strOrNull(patch.unit, 20);
          if (patch.kcal !== undefined) cur.kcal = (patch.kcal == null || patch.kcal === "") ? null : clamp(patch.kcal, 0, 99999);
          os.put(cur);
          out = { ok: true, entry: cur };
        };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("tx_abort")); };
      });
    });
  }

  function entryDel(id) {
    return store(ENTRIES, "readwrite").then(function (os) { return reqP(os.delete(String(id))); })
      .then(function () { return { ok: true }; });
  }

  /* Gewicht je Tag setzen (Upsert, wie weight_set: on conflict(day)). */
  function weightSet(kg, day) {
    var rec = { day: normDay(day), weight_kg: clamp(kg, 30, 400), updated_at: new Date().toISOString() };
    return store(WEIGHTS, "readwrite").then(function (os) { return reqP(os.put(rec)); })
      .then(function () { return { ok: true, weight: rec }; });
  }
  function weightDel(day) {
    return store(WEIGHTS, "readwrite").then(function (os) { return reqP(os.delete(normDay(day))); })
      .then(function () { return { ok: true }; });
  }

  /* Aktivitaet anlegen (wie activity_add): kind steps|workout (Default steps). */
  function activityAdd(a) {
    a = a || {};
    var rec = {
      id: uuid(),
      day: normDay(a.day),
      kind: (a.kind === "workout") ? "workout" : "steps",
      steps: clamp(a.steps, 0, 200000),
      minutes: clamp(a.minutes, 0, 1440),
      bonus_points: clamp(a.bonus_points, 0, 50),
      note: strOrNull(a.note, 120),
      created_at: new Date().toISOString()
    };
    return store(ACTS, "readwrite").then(function (os) { return reqP(os.add(rec)); })
      .then(function () { return { ok: true, entry: rec }; });
  }

  /* Schritte als EINEN Tageswert setzen (wie activity_set_steps): erst alle
     steps-Zeilen des Tages loeschen, dann ggf. eine neue setzen (idempotent,
     Workouts bleiben). steps<=0 -> nichts einfuegen, entry:null. Alles in EINER
     readwrite-Transaktion. */
  function activitySetSteps(steps, bonus, day) {
    var d = normDay(day), s = clamp(steps, 0, 200000), b = clamp(bonus, 0, 50);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ACTS, "readwrite"), os = tx.objectStore(ACTS);
        var out = { ok: true, entry: null }, cur = os.index("day").openCursor(IDBKeyRange.only(d));
        cur.onsuccess = function () {
          var c = cur.result;
          if (c) {
            if ((c.value.kind || "steps") === "steps") os.delete(c.primaryKey);
            c.continue();
          } else if (s > 0) {
            var rec = { id: uuid(), day: d, kind: "steps", steps: s, minutes: 0, bonus_points: b, note: null, created_at: new Date().toISOString() };
            os.add(rec);
            out = { ok: true, entry: rec };
          }
        };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("tx_abort")); };
      });
    });
  }

  function activityDel(id) {
    return store(ACTS, "readwrite").then(function (os) { return reqP(os.delete(String(id))); })
      .then(function () { return { ok: true }; });
  }

  /* ------------------------------------------------------------- Tagesstand -- */
  /* Liefert den Tag im exakten state()-Shape des Servers (nur die tagesbezogenen
     Teile — Konto-Bits legt die App darueber). */
  function dayState(day) {
    var d = normDay(day), wk = weekRange(d);
    return Promise.all([getAll(ENTRIES), getAll(ACTS), getAll(WEIGHTS)]).then(function (res) {
      var entries = res[0], acts = res[1], weights = res[2];

      var byCreated = function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); };
      var diary = entries.filter(function (e) { return e.day === d; }).sort(byCreated);
      var activity = acts.filter(function (a) { return a.day === d; }).sort(byCreated);

      // Wochen-Summen (Mo–So) fuer Wochen-Ueberlauf / Bonus.
      var wpts = {}, wbon = {};
      entries.forEach(function (e) { if (e.day >= wk.start && e.day <= wk.end) wpts[e.day] = (wpts[e.day] || 0) + num(e.points); });
      acts.forEach(function (a) { if (a.day >= wk.start && a.day <= wk.end) wbon[a.day] = (wbon[a.day] || 0) + num(a.bonus_points); });
      var week = Object.keys(wpts).map(function (k) { return { day: k, points: wpts[k] }; });
      var week_bonus = Object.keys(wbon).map(function (k) { return { day: k, bonus: wbon[k] }; });

      var wsorted = weights.slice().sort(function (a, b) { return a.day < b.day ? -1 : (a.day > b.day ? 1 : 0); });
      if (wsorted.length > 200) wsorted = wsorted.slice(wsorted.length - 200);
      var weight_today = null;
      for (var i = 0; i < weights.length; i++) { if (weights[i].day === d) { weight_today = num(weights[i].weight_kg); break; } }

      return {
        day: d,
        week_start: wk.start,
        diary: diary,
        activity: activity,
        weight_today: weight_today,
        weights: wsorted.map(function (w) { return { day: w.day, weight_kg: w.weight_kg }; }),
        week: week,
        week_bonus: week_bonus
      };
    });
  }

  /* ---------------------------------------------------------- Sicherung ------
     Vollstaendiger Export/Import des lokalen Tagebuchs (fuer manuelle Sicherung
     und den Umzug auf ein neues Geraet). exportAll() liefert die ROH-Datensaetze
     aller drei Stores; importAll() schreibt sie zurueck (Upsert je Schluessel),
     nachdem jeder Datensatz wie beim normalen Anlegen normalisiert/geclamped
     wurde — so kann eine beschaedigte/handeditierte Datei nichts Ungueltiges in
     die DB bringen. Standard ist MERGE (idempotent, mehrfach importierbar);
     opts.replace=true leert die Stores vorher. */
  function exportAll() {
    return Promise.all([getAll(ENTRIES), getAll(WEIGHTS), getAll(ACTS)]).then(function (r) {
      return { entries: r[0], weights: r[1], activities: r[2] };
    });
  }

  function sanitizeEntry(e) {
    if (!e || typeof e !== "object") return null;
    return {
      id: (e.id && String(e.id)) || uuid(),
      day: normDay(e.day),
      meal: MEALS[e.meal] ? e.meal : "other",
      name: str(e.name, 120),
      points: clamp(e.points, 0, 200),
      qty: clamp(e.qty == null ? 1 : e.qty, 0, 9999),
      unit: strOrNull(e.unit, 20),
      kcal: (e.kcal == null || e.kcal === "") ? null : clamp(e.kcal, 0, 99999),
      source: str(e.source == null ? "manual" : e.source, 20) || "manual",
      ref_code: strOrNull(e.ref_code, 40),
      created_at: (typeof e.created_at === "string" && e.created_at) ? e.created_at : new Date().toISOString()
    };
  }
  function sanitizeWeight(w) {
    if (!w || typeof w !== "object" || !DATE_RE.test(String(w.day))) return null; // Schluessel muss gueltig sein
    return {
      day: String(w.day),
      weight_kg: clamp(w.weight_kg, 30, 400),
      updated_at: (typeof w.updated_at === "string" && w.updated_at) ? w.updated_at : new Date().toISOString()
    };
  }
  function sanitizeAct(a) {
    if (!a || typeof a !== "object") return null;
    return {
      id: (a.id && String(a.id)) || uuid(),
      day: normDay(a.day),
      kind: (a.kind === "workout") ? "workout" : "steps",
      steps: clamp(a.steps, 0, 200000),
      minutes: clamp(a.minutes, 0, 1440),
      bonus_points: clamp(a.bonus_points, 0, 50),
      note: strOrNull(a.note, 120),
      created_at: (typeof a.created_at === "string" && a.created_at) ? a.created_at : new Date().toISOString()
    };
  }

  function putAllTx(name, list) {
    if (!list || !list.length) return Promise.resolve(0);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, "readwrite"), os = tx.objectStore(name), n = 0;
        list.forEach(function (rec) { try { os.put(rec); n++; } catch (e) {} });
        tx.oncomplete = function () { resolve(n); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("tx_abort")); };
      });
    });
  }
  function clearStores(names) {
    return open().then(function (db) {
      return Promise.all(names.map(function (name) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(name, "readwrite");
          tx.objectStore(name).clear();
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error || new Error("tx_abort")); };
        });
      }));
    });
  }

  function importAll(payload, opts) {
    payload = payload || {};
    var replace = !!(opts && opts.replace);
    var entries = (payload.entries || []).map(sanitizeEntry).filter(Boolean);
    var weights = (payload.weights || []).map(sanitizeWeight).filter(Boolean);
    var acts = (payload.activities || []).map(sanitizeAct).filter(Boolean);
    var pre = replace ? clearStores([ENTRIES, WEIGHTS, ACTS]) : Promise.resolve();
    return pre
      .then(function () { return putAllTx(ENTRIES, entries); })
      .then(function (n1) {
        return putAllTx(WEIGHTS, weights).then(function (n2) {
          return putAllTx(ACTS, acts).then(function (n3) {
            return { ok: true, counts: { entries: n1, weights: n2, activities: n3 } };
          });
        });
      });
  }

  root.PKDiary = {
    supported: supported,
    today: todayISO,
    dayState: dayState,
    entryAdd: entryAdd, entryUpdate: entryUpdate, entryDel: entryDel,
    weightSet: weightSet, weightDel: weightDel,
    activityAdd: activityAdd, activitySetSteps: activitySetSteps, activityDel: activityDel,
    exportAll: exportAll, importAll: importAll
  };
})(typeof window !== "undefined" ? window : globalThis);
