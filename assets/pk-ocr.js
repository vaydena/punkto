/* ============================================================================
   Punkto — OCR fuer Naehrwert-Etiketten (lokal gehostetes Tesseract.js 5.1.1).
   Liest das Foto der Naehrwerttabelle und versucht, die fuer die Punkte
   relevanten Werte je 100 g/ml auszulesen: kcal, gesaettigte Fettsaeuren,
   Zucker, Eiweiss, Ballaststoffe. Reine Autofill-Hilfe — die Felder bleiben
   im Formular editierbar, damit die Punktzahl notfalls exakt von Hand stimmt.

   Alle Ressourcen liegen unter assets/ocr/ (kein CDN), werden LAZY beim ersten
   Gebrauch geladen und danach vom Service Worker gecached -> offline nutzbar,
   sobald sie einmal (online) geladen wurden.

   Robustheit (v14): an echten Handyfotos validiert (dunkle, gewoelbte Aldi-Dose,
   kleine Tabelle im Bild, danebenstehender Zutatentext). Erkenntnisse aus dem
   realen Fehlerfall:
     (1) TABELLE ZUERST FINDEN. Auf einer dunklen Dose ist die Naehrwerttabelle
         der helle Block. Eine grobe Helligkeitskarte lokalisiert ihn, wir
         schneiden ihn frei und rechnen ihn hoch -> Tesseract liest die Tabelle
         isoliert statt am groesseren Zutaten-Absatz „haengenzubleiben".
     (2) MEHRERE AUFBEREITUNGEN + FELD-MERGE. Kontrast-Stretch, Graustufe (PSM 6),
         adaptive Schwelle … je Variante wird geparst und JEDES Feld aus der
         ERSTEN Variante uebernommen, die einen plausiblen Wert liefert. So muss
         nicht eine Variante alles koennen — kcal kommt aus der einen, die
         gesaettigten Fettsaeuren aus der anderen.
     (3) EINHEIT-„g"-KORREKTUR. OCR klebt das Einheiten-g oft als „9" an die Zahl
         („0,8 g" -> „0,89", „8,2 g" -> „8,29"). Eine abschliessende 9 nach einer
         Dezimalstelle wird wieder abgeschnitten.
     (4) UNSCHARFE STICHWOERTER + FOLGEZEILE. „Zucker" auch als „ucker"/„lucker",
         „gesaettigte" auch als „…attigt…"; Werte notfalls aus der Folgezeile
         (Spalten-Layout, das die OCR in getrennte Zeilen zerlegt).

   Global: window.PKOcr = { recognize(blob,onProgress), parseNutrition(text),
                            scanNutrition(blob,onProgress), ready, warmup() }.
   ============================================================================ */
(function (root) {
  "use strict";

  var BASE = "assets/ocr/";
  var LANG = "deu";              // deutsches Modell (Umlaute/ß); nur eng waere ungenauer
  var _worker = null;
  var _loading = null;
  var _psm = null;               // zuletzt gesetzter Page-Segmentation-Mode (redundante Sets sparen)

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

  async function setPsm(worker, psm) {
    var p = String(psm || 3);
    if (p === _psm) return;
    try { await worker.setParameters({ tessedit_pageseg_mode: p }); _psm = p; } catch (e) {}
  }

  /* ---- Bildaufbereitung ---------------------------------------------------- */
  var OCR_MAXDIM = 2600;

  /* Foto dekodieren, auf ~2600 px skalieren, in Graustufen (Rec. 601) wandeln.
     Liefert { w, h, gray:Uint8ClampedArray } oder null (keine Canvas/Decode).
     imageOrientation:"from-image" korrigiert EXIF-gedrehte Handyfotos, damit
     die OCR nie eine seitwaerts liegende Tabelle bekommt. */
  async function rasterizeGray(blob) {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    var bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
    catch (e) { try { bmp = await createImageBitmap(blob); } catch (e2) { return null; } }
    var w = bmp.width, h = bmp.height;
    if (!w || !h) { try { bmp.close && bmp.close(); } catch (e) {} return null; }
    var scale = Math.min(1, OCR_MAXDIM / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    var cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
    var cx = cv.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(bmp, 0, 0, cw, ch);
    try { bmp.close && bmp.close(); } catch (e) {}
    try {
      var img = cx.getImageData(0, 0, cw, ch), d = img.data;
      var gray = new Uint8ClampedArray(cw * ch);
      for (var i = 0, j = 0; j < gray.length; j++, i += 4) {
        gray[j] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      }
      return { w: cw, h: ch, gray: gray };
    } catch (e) { return null; } // getImageData kann bei Riesencanvas scheitern
  }

  /* Graustufen-Puffer (oder bereits binarisiert) -> Canvas fuer den Worker.
     Tesseract.js akzeptiert ein Canvas direkt — spart den toBlob-Umweg. */
  function bufToCanvas(w, h, buf) {
    var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    var cx = cv.getContext("2d");
    var img = cx.createImageData(w, h), d = img.data;
    for (var i = 0, j = 0; j < buf.length; j++, i += 4) {
      var v = buf[j]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    return cv;
  }

  /* Tabelle lokalisieren: groesster HELLER, zusammenhaengender Block, dessen
     Schwerpunkt zentral liegt (verwirft die helle Wand/Tischplatte am Rand).
     Auf einer dunklen Dose ist die Naehrwerttabelle genau dieser helle Block.
     Liefert {x0,y0,x1,y1,frac} in 0..1 oder null. */
  function brightBox(g) {
    var tw = 200, th = Math.max(1, Math.round(g.h * tw / g.w));
    var cv = document.createElement("canvas"); cv.width = tw; cv.height = th;
    var cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(bufToCanvas(g.w, g.h, g.gray), 0, 0, tw, th);
    var d = cx.getImageData(0, 0, tw, th).data, br = new Uint8Array(tw * th);
    for (var i = 0, j = 0; j < br.length; j++, i += 4) br[j] = d[i] > 140 ? 1 : 0;
    var lab = new Int32Array(tw * th), cur = 0, best = null;
    for (var p = 0; p < br.length; p++) {
      if (!br[p] || lab[p]) continue; cur++;
      var st = [p], minx = tw, maxx = 0, miny = th, maxy = 0, cnt = 0, sx = 0, sy = 0;
      while (st.length) {
        var q = st.pop(); if (lab[q] || !br[q]) continue; lab[q] = cur;
        var qx = q % tw, qy = (q / tw) | 0; cnt++; sx += qx; sy += qy;
        if (qx < minx) minx = qx; if (qx > maxx) maxx = qx; if (qy < miny) miny = qy; if (qy > maxy) maxy = qy;
        if (qx > 0) st.push(q - 1); if (qx < tw - 1) st.push(q + 1);
        if (qy > 0) st.push(q - tw); if (qy < th - 1) st.push(q + tw);
      }
      var cxx = sx / cnt / tw, cyy = sy / cnt / th;
      if (cxx < 0.12 || cxx > 0.88 || cyy < 0.15 || cyy > 0.85) continue; // Rand/Wand verwerfen
      if (!best || cnt > best.cnt) best = { cnt: cnt, minx: minx, maxx: maxx, miny: miny, maxy: maxy };
    }
    if (!best) return null;
    var padx = (best.maxx - best.minx) * 0.06, pady = (best.maxy - best.miny) * 0.06;
    return {
      x0: Math.max(0, (best.minx - padx) / tw), x1: Math.min(1, (best.maxx + padx) / tw),
      y0: Math.max(0, (best.miny - pady) / th), y1: Math.min(1, (best.maxy + pady) / th),
      frac: best.cnt / (tw * th)
    };
  }

  /* Kasten aus dem Graustufenbild ausschneiden und auf ~targetW hochrechnen.
     Liefert ein neues { w, h, gray } (kleine Tabelle -> lesbare Groesse). */
  function cropUpscale(g, box, targetW) {
    var sx = Math.round(box.x0 * g.w), sy = Math.round(box.y0 * g.h);
    var sw = Math.max(1, Math.round((box.x1 - box.x0) * g.w));
    var sh = Math.max(1, Math.round((box.y1 - box.y0) * g.h));
    var src = bufToCanvas(g.w, g.h, g.gray);
    var scale = Math.max(1, targetW / sw), tw = Math.round(sw * scale), th = Math.round(sh * scale);
    var cv = document.createElement("canvas"); cv.width = tw; cv.height = th;
    var cx = cv.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(src, sx, sy, sw, sh, 0, 0, tw, th);
    try {
      var d = cx.getImageData(0, 0, tw, th).data, gray = new Uint8ClampedArray(tw * th);
      for (var i = 0, j = 0; j < gray.length; j++, i += 4) gray[j] = d[i];
      return { w: tw, h: th, gray: gray };
    } catch (e) { return null; }
  }

  /* Globaler Kontrast-Stretch um 128 (×1.7) + leichte Aufhellung.
     mode "auto": ist das Bild ueberwiegend dunkel (helle Schrift auf dunkler
     Verpackung), invertieren -> dunkle Schrift auf hell. mode "no": nie
     invertieren (fuer den bereits hellen, freigeschnittenen Tabellen-Ausschnitt). */
  function stretchBuf(w, h, gray, mode) {
    var out = new Uint8ClampedArray(w * h), sum = 0;
    for (var j = 0; j < gray.length; j++) {
      var v = (gray[j] - 128) * 1.7 + 128 + 6;
      out[j] = v < 0 ? 0 : v > 255 ? 255 : v; sum += out[j];
    }
    if (mode === "auto" && sum / out.length < 115) { for (var k = 0; k < out.length; k++) out[k] = 255 - out[k]; }
    return out;
  }

  /* Adaptive lokale Schwelle (Bradley) per Integralbild: dunkler als (lokaler
     Mittelwert − C)? -> Tinte. Robust gegen ungleiche Beleuchtung/Woelbung.
     gInvert=true: wird Tinte zur Mehrheit, war das Original hell-auf-dunkel ->
     invertieren (nur fuers Vollbild sinnvoll; der Tabellen-Crop ist schon hell). */
  function adaptiveBuf(w, h, gray, gInvert) {
    var n = w * h, W1 = w + 1;
    var integ = new Float64Array(W1 * (h + 1));
    for (var y = 0; y < h; y++) {
      var rs = 0, row = y * w, irow = (y + 1) * W1, prow = y * W1;
      for (var x = 0; x < w; x++) { rs += gray[row + x]; integ[irow + x + 1] = integ[prow + x + 1] + rs; }
    }
    var rad = Math.max(8, Math.round(Math.min(w, h) / 22));
    var C = 10, out = new Uint8ClampedArray(n), black = 0;
    for (var yy = 0; yy < h; yy++) {
      var y1 = yy - rad < 0 ? 0 : yy - rad, y2 = yy + rad >= h ? h - 1 : yy + rad;
      var a1 = y1 * W1, a2 = (y2 + 1) * W1, base = yy * w;
      for (var xx = 0; xx < w; xx++) {
        var x1 = xx - rad < 0 ? 0 : xx - rad, x2 = xx + rad >= w ? w - 1 : xx + rad;
        var cnt = (x2 - x1 + 1) * (y2 - y1 + 1);
        var s = integ[a2 + x2 + 1] - integ[a1 + x2 + 1] - integ[a2 + x1] + integ[a1 + x1];
        if (gray[base + xx] < (s / cnt) - C) { out[base + xx] = 0; black++; } else out[base + xx] = 255;
      }
    }
    if (gInvert && black > n * 0.5) { for (var m = 0; m < n; m++) out[m] = 255 - out[m]; }
    return out;
  }

  /* Eine Aufbereitung erkennen. src = {w,h,gray} (oder null -> Original-Blob).
     which: "stretch"(hell, kein Invert) | "contrast"(Vollbild, Auto-Invert) |
            "adaptive"(Crop) | "adaptiveG"(Vollbild, Global-Invert) | "gray". */
  async function recognizeSource(worker, blob, src, which, psm) {
    var input;
    if (!src) { input = blob; }
    else {
      var buf;
      if (which === "adaptive") buf = adaptiveBuf(src.w, src.h, src.gray, false);
      else if (which === "adaptiveG") buf = adaptiveBuf(src.w, src.h, src.gray, true);
      else if (which === "contrast") buf = stretchBuf(src.w, src.h, src.gray, "auto");
      else if (which === "stretch") buf = stretchBuf(src.w, src.h, src.gray, "no");
      else buf = src.gray; // "gray" — Graustufe unveraendert
      input = bufToCanvas(src.w, src.h, buf);
    }
    await setPsm(worker, psm);
    var res = await worker.recognize(input);
    return (res && res.data && res.data.text) || "";
  }

  /* Rohtext (Rueckwaerts-Kompatibilitaet): einfache Ein-Pass-Erkennung (Vollbild). */
  async function recognize(blob, onProgress) {
    var worker = await getWorker(onProgress);
    var g = await rasterizeGray(blob);
    return recognizeSource(worker, blob, g, g ? "contrast" : "orig", 3);
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

  /* Einheit „g" wird von der OCR oft als „9" an die Zahl geklebt:
     „0,8 g" -> „0,89", „8,2 g" -> „8,29", „0,18 g" -> „0,189". Deutsche
     Naehrwerte je 100 g/ml haben i. d. R. hoechstens EINE Dezimalstelle — eine
     abschliessende 9, die eine zweite Dezimale erzeugt, ist darum das
     Einheiten-g und wird entfernt. */
  function cleanNum(tok) {
    var t = String(tok);
    var m = t.match(/^(\d{1,3},\d)(\d)$/);        // X,Y + Z
    if (m && m[2] === "9") t = m[1];              // 8,29 -> 8,2 ; 0,89 -> 0,8 ; 1,09 -> 1,0
    else { var m2 = t.match(/^(\d{1,3},\d\d)9$/); if (m2) t = m2[1]; } // 0,189 -> 0,18
    return toNum(t);
  }

  /* Erste Zahl in einem Text (nach optionalem Entfernen des Stichworts). */
  function firstNum(line) {
    var m = String(line).match(/(\d+(?:[.,]\d+)?)/);
    return m ? cleanNum(m[1]) : null;
  }

  /* Robustes Normalisieren fuer Stichwort-Treffer (OCR verliert oft Umlaute). */
  function fold(s) {
    return String(s).toLowerCase()
      .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
      .replace(/\s+/g, " ");
  }

  // Stichwoerter, die eine EIGENE Naehrwertzeile markieren — an ihnen bricht die
  // Folgezeilen-Suche ab, damit ein Wert nicht aus der naechsten Zeile „geklaut" wird.
  var ROW_KW = /brennwert|energie|\bfett|zucker|ucker|kohlenhydr|eiwei|iweiss|protein|ballast|\bsalz|natrium|gesatt|attigt|davon/;

  /* ---- Naehrwert-Parser -----------------------------------------------------
     Liefert best-effort { base_g, unit, kcal, sat_fat_g, sugar_g, protein_g,
     fiber_g, _found:{feld:true} }. Nicht gefundene Felder bleiben null. Nimmt
     je Zeile die ERSTE Zahl nach dem Stichwort (i. d. R. die „pro 100 g"-Spalte);
     steht die Zahl in der Folgezeile (Spalten-Layout), wird sie dort geholt. */
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

    // Zahl nach einem Stichwort innerhalb EINER Zeile holen; sonst irgendeine
    // Zahl DER Zeile (Stichwort evtl. verstuemmelt, Wert steht aber daneben).
    function valAfter(lineFold, lineRaw, kw) {
      var idx = kw ? lineFold.indexOf(kw) : -1;
      if (idx >= 0) {
        var v = firstNum(lineRaw.slice(idx + kw.length));
        if (v != null) return v;
      }
      return firstNum(lineRaw);
    }

    // Erste Zahl aus den bis zu 2 Folgezeilen (Spalten-Layout) — bricht ab,
    // sobald eine andere Naehrwertzeile beginnt.
    function nextNum(idx) {
      for (var k = idx + 1; k <= Math.min(idx + 2, lines.length - 1); k++) {
        if (ROW_KW.test(lines[k].f)) return null;
        var v = firstNum(lines[k].raw);
        if (v != null) return v;
      }
      return null;
    }

    function findIdx(pred) {
      for (var i = 0; i < lines.length; i++) if (pred(lines[i].f)) return i;
      return -1;
    }

    // Wert zu einem Stichwort: erst dieselbe Zeile (Stichwort oder erste Zahl),
    // sonst die Folgezeile.
    function valFor(idx, kw) {
      if (idx < 0) return null;
      var v = valAfter(lines[idx].f, lines[idx].raw, kw);
      if (v == null) v = nextNum(idx);
      return v;
    }

    // kcal: bevorzugt „NNN kcal" irgendwo; sonst Brennwert/Energie-Zeile; sonst kJ/4,184.
    (function () {
      var mk = allFold.match(/(\d{2,4})\s*kcal/);
      if (mk) { out.kcal = toNum(mk[1]); out._found.kcal = true; return; }
      var i = findIdx(function (f) { return /brennwert|energie/.test(f); });
      if (i >= 0) {
        var mk2 = lines[i].f.match(/(\d{2,4})\s*kcal/);
        if (mk2) { out.kcal = toNum(mk2[1]); out._found.kcal = true; return; }
      }
      var mj = allFold.match(/([\d.]+)\s*kj/); // [\d.] laesst den Tausenderpunkt (2.310 kJ) mit
      if (mj) { var kj = toNum(mj[1]); if (kj && kj >= 40) { out.kcal = Math.round(kj / 4.184); out._found.kcal = true; } }
    })();

    // Gesaettigte Fettsaeuren: „gesättigte", „…attigt…", die Abkuerzung
    // „ges. Fettsäuren" oder eine „davon … Fett"-Zeile.
    (function () {
      var i = findIdx(function (f) { return /gesatt|gesat|attigt|ges\.?\s*fett|davon.*fett/.test(f); });
      if (i < 0) i = findIdx(function (f) { return /\bfett\b/.test(f) && /davon/.test(f); });
      if (i >= 0) {
        var kw = lines[i].f.indexOf("gesatt") >= 0 ? "gesatt" : "";
        var v = valFor(i, kw);
        if (v != null) { out.sat_fat_g = v; out._found.sat_fat_g = true; }
      }
    })();

    // Zucker: „davon Zucker" (auch verstuemmelt „ucker"/„lucker").
    (function () {
      var i = findIdx(function (f) { return /zucker|ucker/.test(f); });
      if (i >= 0) {
        var kw = lines[i].f.indexOf("zucker") >= 0 ? "zucker" : "";
        var v = valFor(i, kw);
        if (v != null) { out.sugar_g = v; out._found.sugar_g = true; }
      }
    })();

    // Eiweiss / Protein (auch „…iweiss"/„weiss").
    (function () {
      var i = findIdx(function (f) { return /eiwei|iweiss|weiss|protein/.test(f); });
      if (i >= 0) {
        var kw = lines[i].f.indexOf("eiwei") >= 0 ? "eiwei" : (lines[i].f.indexOf("protein") >= 0 ? "protein" : "");
        var v = valFor(i, kw);
        if (v != null) { out.protein_g = v; out._found.protein_g = true; }
      }
    })();

    // Ballaststoffe.
    (function () {
      var i = findIdx(function (f) { return /ballaststoff|ballast/.test(f); });
      var v = valFor(i, "ballast");
      if (v != null) { out.fiber_g = v; out._found.fiber_g = true; }
    })();

    return out;
  }

  function fieldsFound(p) { return (p && p._found) ? Object.keys(p._found).length : 0; }
  // Bewertung einer Variante: Feldzahl, kcal als Anker leicht hoeher gewichtet.
  function scoreParse(p) { return fieldsFound(p) + ((p && p._found && p._found.kcal) ? 0.5 : 0); }

  // Plausible Wertebereiche je 100 g/ml — filtert offensichtlichen OCR-Muell
  // beim Zusammenfuehren mehrerer Varianten.
  var RANGES = { kcal: [1, 900], sat_fat_g: [0, 100], sugar_g: [0, 100], protein_g: [0, 100], fiber_g: [0, 100] };
  function inRange(f, v) { var r = RANGES[f]; return v != null && (!r || (v >= r[0] && v <= r[1])); }

  // Ein Parse-Ergebnis in das Sammel-Ergebnis mergen: jedes Feld nur setzen,
  // wenn es noch fehlt UND plausibel ist (erste gute Variante gewinnt).
  function mergeInto(dst, p) {
    ["kcal", "sat_fat_g", "sugar_g", "protein_g", "fiber_g"].forEach(function (f) {
      if (dst[f] == null && p._found && p._found[f] && inRange(f, p[f])) { dst[f] = p[f]; dst._found[f] = true; }
    });
    if (p.unit === "ml") dst.unit = "ml";
    if (!dst._baseSet && p._found && p._found.kcal) { dst.base_g = p.base_g; dst._baseSet = true; }
  }
  // „Kern" zum vorzeitigen Abbruch: kcal, gesaett. Fett und Zucker sind die
  // zuverlaessig lesbaren Anker (und zaehlen am staerksten fuer die Punkte).
  // Eiweiss/Ballaststoffe sind auf realen Fotos oft unlesbar -> nur best effort,
  // sie blockieren den Abbruch nicht (sonst liefe immer jede Variante = langsam).
  function coreComplete(d) { return d.kcal != null && d.sat_fat_g != null && d.sugar_g != null; }

  /* Bequemer Einzelaufruf: Foto -> geparste Naehrwerte (+ Rohtext).
     Findet zuerst die Tabelle (heller Block auf dunkler Dose), schneidet sie frei
     und rechnet sie hoch; erkennt sie in mehreren Aufbereitungen und fuehrt die
     Felder zusammen. Ein sauberes, bildfuellendes Etikett ueberspringt den Crop
     (heller Anteil zu gross) und laeuft direkt ueber die Vollbild-Varianten. */
  async function scanNutrition(blob, onProgress) {
    var worker = await getWorker(onProgress);
    var g = await rasterizeGray(blob); // einmal dekodieren
    var out = { base_g: 100, unit: "g", kcal: null, sat_fat_g: null, sugar_g: null, protein_g: null, fiber_g: null, _found: {} };

    var sources;
    if (g) {
      var box = brightBox(g);
      // Crop nur, wenn die Tabelle ein kleiner-mittlerer heller Block ist
      // (0,02..0,7). Fuellt das Etikett das ganze Bild (frac hoch), lohnt kein Crop.
      var crop = (box && box.frac >= 0.02 && box.frac <= 0.7) ? cropUpscale(g, box, 1500) : null;
      sources = [];
      if (crop) {
        // PSM 11 (sparse text) liest die gestauchte Brennwert-Zeile (kcal) am
        // besten; PSM 6 (Block) und PSM 3 (auto) fangen die uebrigen Zeilen.
        sources.push(["stretch", crop, 11]);
        sources.push(["gray", crop, 6]);
        sources.push(["stretch", crop, 3]);
        sources.push(["adaptive", crop, 11]);
        sources.push(["gray", crop, 4]);
      }
      sources.push(["contrast", g, 3]);   // Vollbild-Fallback (bildfuellende Etiketten)
      sources.push(["adaptiveG", g, 3]);
    } else {
      sources = [["orig", null, 3]];
    }

    var firstText = "", bestText = "", bestScore = -1, used = [];
    for (var i = 0; i < sources.length; i++) {
      var which = sources[i][0], src = sources[i][1], psm = sources[i][2], text = "";
      try { text = await recognizeSource(worker, blob, src, which, psm); }
      catch (e) { if (i === 0 && sources.length === 1) throw e; else continue; }
      if (i === 0) firstText = text;
      var p = parseNutrition(text);
      var sc = scoreParse(p);
      if (sc > bestScore) { bestScore = sc; bestText = text; }
      mergeInto(out, p);
      used.push(which + (psm !== 3 ? ("/psm" + psm) : ""));
      if (coreComplete(out)) break; // genug -> restliche Varianten sparen
    }
    out._text = bestText || firstText;
    out._variant = used.join("+");
    return out;
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
