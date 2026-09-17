/* ============================================================================
   Punkto — BLS-Katalog OFFLINE (Bundeslebensmittelschlüssel 4.0, CC BY 4.0).
   Der komplette Katalog (~7.090 Einträge, dedupliziert gegen die kuratierte
   Basis) liegt gebündelt in assets/punkto-bls.json und wird EINMAL geladen und
   im Speicher durchsucht — dieselbe Substring-/Präfix-Logik wie zuvor serverseitig,
   nur jetzt vollständig OFFLINE. Werte je 100 g; die Punkte berechnet der Client
   aus den Nährwerten (kein points-Feld -> keine Staleness bei Formeländerung).

   Zeilenformat im Bündel (kompakt): [name, kcal, sat_fat_g, sugar_g, protein_g, fiber_g, bls].
   search() liefert Objekte { bls, name, kcal, sat_fat_g, sugar_g, protein_g, fiber_g },
   also exakt die Form, die app.html/blsToFood erwartet (Server-Parität).

   Global: window.PKBls  — load(), search(q, limit), attribution(), ready().
   ============================================================================ */
(function (root) {
  "use strict";

  var URL_ = "assets/punkto-bls.json";
  var _rows = null;     // aufbereitete Zeilen inkl. normalisiertem Namen (_n)
  var _load = null;     // memoisiertes Lade-Promise
  var _attr = "";

  /* Namensnormalisierung — MUSS blsNorm() in app.html entsprechen (Umlaute falten). */
  function norm(s) {
    return String(s || "").toLowerCase()
      .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss").trim();
  }

  /* Katalog einmal laden (offline-fähig: der Service Worker cached die Datei als
     statisches Shell-Asset). Fehlschlag vergiftet den Cache NICHT -> Retry bleibt. */
  function load() {
    if (_load) return _load;
    _load = fetch(URL_)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        _attr = (j && j.attribution) || "";
        var f = (j && j.foods) || [];
        var out = new Array(f.length);
        for (var i = 0; i < f.length; i++) {
          var t = f[i];
          out[i] = {
            bls: t[6], name: t[0],
            kcal: t[1], sat_fat_g: t[2], sugar_g: t[3], protein_g: t[4], fiber_g: t[5],
            _n: norm(t[0])
          };
        }
        _rows = out;
        return _rows;
      })
      .catch(function () { _load = null; _rows = null; return []; });
    return _load;
  }

  function attribution() {
    return _attr ||
      "Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 – Deutsche Nährstoffdatenbank. Karlsruhe. Lizenz: CC BY 4.0.";
  }
  function ready() { return !!(_rows && _rows.length); }

  /* Suche: Substring über den normalisierten Namen; Präfixtreffer zuerst, dann
     kürzere Namen, dann alphabetisch — Parität zur bisherigen Server-Sortierung. */
  function search(q, limit) {
    q = String(q || "").trim();
    if (q.length < 2) return Promise.resolve([]);
    var lim = Math.min(Math.max(+limit || 30, 1), 50);
    var run = function (rows) {
      if (!rows || !rows.length) return [];
      var nq = norm(q);
      if (nq.length < 2) return [];
      var hits = [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i]._n.indexOf(nq) >= 0) hits.push(rows[i]);
      }
      hits.sort(function (a, b) {
        var ap = a._n.indexOf(nq) === 0 ? 0 : 1, bp = b._n.indexOf(nq) === 0 ? 0 : 1;
        if (ap !== bp) return ap - bp;
        if (a.name.length !== b.name.length) return a.name.length - b.name.length;
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
      });
      return hits.slice(0, lim).map(function (r) {
        return {
          bls: r.bls, name: r.name, kcal: r.kcal, sat_fat_g: r.sat_fat_g,
          sugar_g: r.sugar_g, protein_g: r.protein_g, fiber_g: r.fiber_g
        };
      });
    };
    return _rows ? Promise.resolve(run(_rows)) : load().then(run);
  }

  root.PKBls = { load: load, search: search, attribution: attribution, ready: ready };
})(typeof window !== "undefined" ? window : globalThis);
