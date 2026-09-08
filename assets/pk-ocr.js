/* ============================================================================
   Punkto — OCR fuer Naehrwert-Etiketten (lokal gehostetes Tesseract.js 5.1.1).
   Liest das Foto der Naehrwerttabelle und versucht, die fuer die Punkte
   relevanten Werte je 100 g/ml auszulesen: kcal, gesaettigte Fettsaeuren,
   Zucker, Eiweiss, Ballaststoffe. Reine Autofill-Hilfe — die Felder bleiben
   im Formular editierbar, damit die Punktzahl notfalls exakt von Hand stimmt.

   Alle Ressourcen liegen unter assets/ocr/ (kein CDN), werden LAZY beim ersten
   Gebrauch geladen und danach vom Service Worker gecached -> offline nutzbar,
   sobald sie einmal (online) geladen wurden.

   Global: window.PKOcr = { recognize(blob,onProgress), parseNutrition(text),
                            scanNutrition(blob,onProgress), ready, warmup() }.
   ============================================================================ */
(function (root) {
  "use strict";

  var BASE = "assets/ocr/";
  var LANG = "deu";              // deutsches Modell (Umlaute/ß); nur eng waere ungenauer
  var _worker = null;
  var _loading = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (root.Tesseract) return resolve();
      var s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("ocr_script_failed")); };
      document.head.appendChild(s);
    });
  }

  /* Tesseract-Worker (lazy, einmalig). onProgress(m) bekommt {status, progress}. */
  function getWorker(onProgress) {
    if (_worker) return Promise.resolve(_worker);
    if (_loading) return _loading;
    _loading = (async function () {
      await loadScript(BASE + "tesseract.min.js");
      var T = root.Tesseract;
      if (!T || !T.createWorker) throw new Error("ocr_unavailable");
      var w = await T.createWorker(LANG, 1, {
        workerPath: BASE + "worker.min.js",
        corePath: BASE,            // Verzeichnis -> waehlt tesseract-core(-simd)-lstm.wasm.js (OEM 1)
        langPath: BASE,            // findet deu.traineddata.gz
        gzip: true,
        logger: function (m) { if (onProgress) { try { onProgress(m); } catch (e) {} } }
      });
      // BEWUSST KEINE tessedit_char_whitelist: A/B-Tests an realen (kleinen,
      // gewoelbten) Etiketten zeigten, dass eine Whitelist NICHT hilft — sie
      // zwingt mehrdeutige Glyphen in die erlaubte Menge (z. B. Einheit „g"
      // hinter einer Zahl -> „9", aus „2,4 g" wird „249") und die Punktzahl
      // wird falsch. Der Parser unten arbeitet ohnehin stichwort-/zahlbasiert
      // und ist gegen Rauschen robust. preserve_interword_spaces haelt Stichwort
      // und Wert (mehrere Leerzeichen als Spalte) in derselben Zeile zusammen.
      try {
        await w.setParameters({ preserve_interword_spaces: "1" });
      } catch (e) { /* Parameter ist nur Optimierung */ }
      _worker = w;
      return w;
    })();
    _loading.catch(function () { _loading = null; }); // bei Fehlschlag erneut versuchbar
    return _loading;
  }

  /* Bild fuer OCR aufbereiten — der entscheidende Hebel fuer reale Handyfotos.
     (1) Aufloesung: die App speichert das Etikettfoto klein (~1280 px JPEG),
         doch fuer OCR ist das zu wenig — die winzige Etikettschrift schrumpft
         unter Tesseracts lesbare x-Hoehe (~20 px) und die Einheit „g" wird als
         „9" gelesen (aus „2,4 g" -> „249"). Darum hier bis ~2200 px verwenden.
     (2) Kontrast: Graustufen (Rec. 601) + Kontrast-Stretch um 128 (×1.7) +
         leichte Aufhellung — rettet kontraktarme/cremefarbene Verpackungen
         (z. B. Obatzter-Deckel) und gewoelbte Etiketten.
     A/B gemessen: 1280+Whitelist -> Werte verstuemmelt (Ballaststoffe „249",
     Eiweiss „98"); 2200+Graustufen+Kontrast, ohne Whitelist -> exakt.
     Faellt bei jedem Fehler auf den Original-Blob zurueck (nie schlechter). */
  var OCR_MAXDIM = 2200;
  async function prepForOcr(blob) {
    try {
      if (typeof createImageBitmap !== "function" || typeof document === "undefined") return blob;
      var bmp = await createImageBitmap(blob);
      var w = bmp.width, h = bmp.height;
      if (!w || !h) { try { bmp.close && bmp.close(); } catch (e) {} return blob; }
      var scale = Math.min(1, OCR_MAXDIM / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
      var cx = cv.getContext("2d");
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
      cx.drawImage(bmp, 0, 0, cw, ch);
      try { bmp.close && bmp.close(); } catch (e) {}
      try {
        var img = cx.getImageData(0, 0, cw, ch), d = img.data;
        for (var i = 0; i < d.length; i += 4) {
          var v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          v = (v - 128) * 1.7 + 128 + 6;
          d[i] = d[i + 1] = d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        cx.putImageData(img, 0, 0);
      } catch (e) { /* getImageData kann bei sehr grossem Canvas scheitern -> ungefiltert weiter */ }
      var out = await new Promise(function (resolve) {
        cv.toBlob(function (b) { resolve(b || blob); }, "image/png");
      });
      return out || blob;
    } catch (e) { return blob; }
  }

  /* Rohtext aus einem Bild-Blob (mit OCR-Vorverarbeitung, s. prepForOcr). */
  async function recognize(blob, onProgress) {
    var w = await getWorker(onProgress);
    var prepped = await prepForOcr(blob);
    var res = await w.recognize(prepped);
    return (res && res.data && res.data.text) || "";
  }

  /* ---- Zahl-Parsing (deutsche Schreibweise: Komma = Dezimal) ---------------- */
  function toNum(str) {
    if (str == null) return null;
    var s = String(str).trim();
    s = s.replace(/\.(?=\d{3}(\D|$))/g, ""); // Tausenderpunkt (z. B. 1.234 kJ) entfernen
    s = s.replace(",", ".");
    s = s.replace(/[^0-9.]/g, "");
    if (!s || s === ".") return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  /* Erste Zahl in einem Text (nach optionalem Entfernen des Stichworts). */
  function firstNum(line) {
    var m = String(line).match(/(\d+(?:[.,]\d+)?)/);
    return m ? toNum(m[1]) : null;
  }

  /* Robustes Normalisieren fuer Stichwort-Treffer (OCR verliert oft Umlaute). */
  function fold(s) {
    return String(s).toLowerCase()
      .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
      .replace(/\s+/g, " ");
  }

  /* ---- Naehrwert-Parser -----------------------------------------------------
     Liefert best-effort { base_g, unit, kcal, sat_fat_g, sugar_g, protein_g,
     fiber_g, _found:{feld:true} }. Nicht gefundene Felder bleiben null. Nimmt
     je Zeile die ERSTE Zahl nach dem Stichwort (i. d. R. die „pro 100 g"-Spalte). */
  function parseNutrition(text) {
    var out = { base_g: 100, unit: "g", kcal: null, sat_fat_g: null, sugar_g: null, protein_g: null, fiber_g: null, _found: {} };
    if (!text) return out;

    var rawLines = String(text).split(/\r?\n/);
    var lines = rawLines.map(function (l) { return { raw: l, f: fold(l) }; })
      .filter(function (o) { return o.f.trim().length; });
    var allFold = lines.map(function (o) { return o.f; }).join(" ");

    // Einheit: ml, wenn im Bezug „100 ml" o. ä. vorkommt, sonst g.
    if (/100\s*ml|je\s*ml|pro\s*ml|\bml\b/.test(allFold)) out.unit = "ml";

    // Bezugsmenge: „pro 100 g/ml" ist Standard; abweichende Bezuege selten -> 100.
    var mBase = allFold.match(/(?:pro|je)\s*(\d{2,4})\s*(?:g|ml)/);
    if (mBase) { var b = toNum(mBase[1]); if (b && b >= 1 && b <= 1000) out.base_g = b; }

    // Zahl nach einem Stichwort innerhalb EINER Zeile holen.
    function valAfter(lineFold, lineRaw, kw) {
      var idx = lineFold.indexOf(kw);
      if (idx < 0) return null;
      var after = lineRaw.slice(idx + kw.length);
      var v = firstNum(after);
      if (v == null) v = firstNum(lineRaw); // Fallback: irgendeine Zahl der Zeile
      return v;
    }

    function findLine(pred) {
      for (var i = 0; i < lines.length; i++) if (pred(lines[i].f)) return lines[i];
      return null;
    }

    // kcal: bevorzugt „NNN kcal" irgendwo; sonst Brennwert/Energie-Zeile; sonst kJ/4,184.
    (function () {
      var mk = allFold.match(/(\d{2,4})\s*kcal/);
      if (mk) { out.kcal = toNum(mk[1]); out._found.kcal = true; return; }
      var ln = findLine(function (f) { return /brennwert|energie/.test(f); });
      if (ln) {
        var mk2 = ln.f.match(/(\d{2,4})\s*kcal/);
        if (mk2) { out.kcal = toNum(mk2[1]); out._found.kcal = true; return; }
      }
      var mj = allFold.match(/(\d{3,5})\s*kj/);
      if (mj) { var kj = toNum(mj[1]); if (kj) { out.kcal = Math.round(kj / 4.184); out._found.kcal = true; } }
    })();

    // Gesaettigte Fettsaeuren: Zeile mit „gesatt…" (davon gesaettigte …).
    (function () {
      var ln = findLine(function (f) { return /gesatt|gesat|davon.*fett|gesattigte/.test(f); });
      if (!ln) ln = findLine(function (f) { return /\bfett\b/.test(f) && /davon/.test(f); });
      if (ln) {
        var v = valAfter(ln.f, ln.raw, ln.f.indexOf("gesatt") >= 0 ? "gesatt" : "fett");
        if (v != null) { out.sat_fat_g = v; out._found.sat_fat_g = true; }
      }
    })();

    // Zucker: „davon Zucker".
    (function () {
      var ln = findLine(function (f) { return /zucker/.test(f); });
      if (ln) { var v = valAfter(ln.f, ln.raw, "zucker"); if (v != null) { out.sugar_g = v; out._found.sugar_g = true; } }
    })();

    // Eiweiss / Protein.
    (function () {
      var ln = findLine(function (f) { return /eiwei|protein/.test(f); });
      if (ln) {
        var kw = ln.f.indexOf("eiwei") >= 0 ? "eiwei" : "protein";
        var v = valAfter(ln.f, ln.raw, kw);
        if (v != null) { out.protein_g = v; out._found.protein_g = true; }
      }
    })();

    // Ballaststoffe.
    (function () {
      var ln = findLine(function (f) { return /ballaststoff|ballast/.test(f); });
      if (ln) { var v = valAfter(ln.f, ln.raw, "ballast"); if (v != null) { out.fiber_g = v; out._found.fiber_g = true; } }
    })();

    return out;
  }

  /* Bequemer Einzelaufruf: Foto -> geparste Naehrwerte (+ Rohtext). */
  async function scanNutrition(blob, onProgress) {
    var text = await recognize(blob, onProgress);
    var parsed = parseNutrition(text);
    parsed._text = text;
    return parsed;
  }

  /* Optionales Vorwaermen (z. B. sobald das Erfassungs-Sheet geoeffnet wird). */
  function warmup() { getWorker().catch(function () {}); }

  root.PKOcr = {
    recognize: recognize,
    parseNutrition: parseNutrition,
    scanNutrition: scanNutrition,
    warmup: warmup,
    get ready() { return !!_worker; }
  };
})(typeof window !== "undefined" ? window : globalThis);
