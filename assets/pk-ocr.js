/* ============================================================================
   Punkto — OCR fuer Naehrwert-Etiketten (lokal gehostetes Tesseract.js 5.1.1).
   Liest das Foto der Naehrwerttabelle und liefert die Werte je 100 g/ml:
   kcal, gesaettigte Fettsaeuren, Zucker, Eiweiss, Ballaststoffe (+ Fett,
   Kohlenhydrate, Salz als Kontrollwerte). Reine Autofill-Hilfe — die Felder
   bleiben im Formular editierbar.

   Alle Ressourcen liegen unter assets/ocr/ (kein CDN), werden LAZY beim ersten
   Gebrauch geladen und danach vom Service Worker gecached -> offline nutzbar.

   v2 (zweistufig, an echten Handyfotos validiert — Milchkarton mit farbigen
   Zeilen, Nudeltuete, Kaffeebecher mit dunklem Grund und 3 Spalten):
     (1) TABELLE PER STICHWORT FINDEN. Das ganze Foto wird adaptiv binarisiert
         (lokale Schwelle -> farbige Zeilenhintergruende verschwinden) und mit
         PSM 11 gelesen. Die Positionen der Stichwoerter (Brennwert, Fett,
         Zucker, Eiweiss …) ergeben den Tabellenkasten und die Schrifthoehe.
     (2) AUSSCHNITT GEZIELT HOCHRECHNEN. Der Kasten wird aus dem Original so
         skaliert, dass die Schrift ~54 px hoch ist (Komma bleibt lesbar), und in
         mehreren Aufbereitungen/Segmentierungen gelesen.
     (3) GEOMETRISCHER ZEILEN-PARSER. Woerter werden ueber ihre y-Position zu
         Tabellenzeilen gruppiert; je Zeile zaehlt die erste Zahl nach dem
         Stichwort (= Spalte „100 g/ml"), %-Angaben werden uebersprungen.
         Zweizeilige Beschriftungen („davon gesaettigte / Fettsaeuren 0,4 g")
         holen den Wert aus der Folgezeile.
     (4) KANDIDATEN + ABSTIMMUNG + PLAUSIBILITAET. Typische OCR-Fehler
         („g" als 9, verlorenes Komma: „829" = 8,2 g) erzeugen gewichtete
         Kandidaten. Die Varianten stimmen ab; gewaehlt wird die Kombination,
         die zusaetzlich die Naehrwertlogik erfuellt (ges. Fett <= Fett,
         Zucker <= Kohlenhydrate, 9·Fett + 4·KH + 4·Eiweiss + 2·Ballast ≈ kcal).
         Unsichere Felder bleiben LEER statt geraten.
     (5) WERTESPALTE ALS STREIFEN (v3, Kaffeebecher-Foto 721x1280, gewoelbt):
         Schraege/versetzte Beschriftungen machen die Zeilenzuordnung unsicher,
         die Spalte „je 100 g/ml" allein liest Tesseract aber fast fehlerfrei.
         Die linke Zahlenspalte wird freigestellt, einzeln gelesen und ueber die
         feste EU-Reihenfolge (Energie, Fett, ges. FS, KH, Zucker, [Ballast],
         Eiweiss, Salz) zugeordnet — nur wenn die Anzahl passt und die
         Naehrwertlogik stimmt. Findet Stufe 1 keine Stichwoerter, ortet eine
         Zahlenspalten-Suche die Tabelle.
   BEWUSST KEINE tessedit_char_whitelist (zwingt „g" zu „9", verschlechtert).

   Global: window.PKOcr = { recognize(blob,onProgress), parseNutrition(text),
                            scanNutrition(blob,onProgress), ready, warmup() }.
   ============================================================================ */
(function (root) {
  "use strict";

  var BASE = "assets/ocr/";
  var LANG = "deu";
  var _worker = null;
  var _loading = null;
  var _psm = null;
  var _progress = null;          // aktueller Fortschritts-Callback (Logger ist nur einmal bindbar)

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

  function emit(m) { if (_progress) { try { _progress(m); } catch (e) {} } }

  /* Tesseract-Worker (lazy, einmalig). Der Logger leitet an _progress weiter,
     damit auch spaetere Scans (mit neuem Callback) Fortschritt melden. */
  function getWorker(onProgress) {
    if (onProgress) _progress = onProgress;
    if (_worker) return Promise.resolve(_worker);
    if (_loading) return _loading;
    _loading = (async function () {
      await loadScript(BASE + "tesseract.min.js");
      var T = root.Tesseract;
      if (!T || !T.createWorker) throw new Error("ocr_unavailable");
      var w = await T.createWorker(LANG, 1, {
        workerPath: BASE + "worker.min.js",
        corePath: BASE,
        langPath: BASE,
        gzip: true,
        logger: function (m) { if (_stepHook) _stepHook(m); else emit(m); }
      });
      try { await w.setParameters({ preserve_interword_spaces: "1" }); } catch (e) {}
      _worker = w;
      return w;
    })();
    _loading.catch(function () { _loading = null; });
    return _loading;
  }

  // Waehrend scanNutrition: Tesseract-Teilfortschritt -> Gesamtfortschritt.
  var _stepHook = null;

  async function setPsm(worker, psm) {
    var p = String(psm || 3);
    if (p === _psm) return;
    try { await worker.setParameters({ tessedit_pageseg_mode: p }); _psm = p; } catch (e) {}
  }

  /* ---- Bildaufbereitung ---------------------------------------------------- */
  var MAXDIM = 3200;             // Originalraster (Obergrenze fuer Speicher)
  var LOCATE_DIM = 2400;         // Stufe 1: lange Seite
  var TARGET_H = 54;             // Stufe 2: Ziel-Schrifthoehe in px
  var CROP_MAX = 2400;           // Stufe 2: max. lange Seite des Ausschnitts

  function mkCanvas(w, h) { var c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

  /* Foto dekodieren (EXIF-Drehung beachten) -> Farb-Canvas. */
  async function loadImage(blob) {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    var bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
    catch (e) { try { bmp = await createImageBitmap(blob); } catch (e2) { return null; } }
    var w = bmp.width, h = bmp.height;
    if (!w || !h) { try { bmp.close && bmp.close(); } catch (e) {} return null; }
    var s = Math.min(1, MAXDIM / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    var cv = mkCanvas(cw, ch), cx = cv.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(bmp, 0, 0, cw, ch);
    try { bmp.close && bmp.close(); } catch (e) {}
    return cv;
  }

  /* Ausschnitt (Quellkoordinaten) skaliert in neues Canvas zeichnen. */
  function region(src, sx, sy, sw, sh, scale) {
    sx = Math.max(0, Math.round(sx)); sy = Math.max(0, Math.round(sy));
    sw = Math.max(1, Math.min(src.width - sx, Math.round(sw)));
    sh = Math.max(1, Math.min(src.height - sy, Math.round(sh)));
    var tw = Math.max(1, Math.round(sw * scale)), th = Math.max(1, Math.round(sh * scale));
    var cv = mkCanvas(tw, th), cx = cv.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(src, sx, sy, sw, sh, 0, 0, tw, th);
    return cv;
  }

  /* Canvas -> Graustufen. mode "lum" (Rec. 601) oder "min" (dunkelster Kanal:
     trennt farbige Zeilenhintergruende besser von schwarzer Schrift). */
  function grayOf(cv, mode) {
    var d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    var n = cv.width * cv.height, g = new Uint8ClampedArray(n);
    for (var i = 0, j = 0; j < n; j++, i += 4) {
      g[j] = mode === "min" ? Math.min(d[i], d[i + 1], d[i + 2]) : (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
    return g;
  }

  function bufToCanvas(w, h, buf) {
    var cv = mkCanvas(w, h), cx = cv.getContext("2d");
    var img = cx.createImageData(w, h), d = img.data;
    for (var i = 0, j = 0; j < buf.length; j++, i += 4) { var v = buf[j]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    cx.putImageData(img, 0, 0);
    return cv;
  }

  /* Adaptive lokale Schwelle (Bradley, Integralbild). invert: ueberwiegt danach
     Tinte (helle Schrift auf dunklem Grund), wird invertiert. */
  function adaptiveBuf(w, h, gray, rad, C, invert) {
    var n = w * h, W1 = w + 1, integ = new Float64Array(W1 * (h + 1));
    for (var y = 0; y < h; y++) {
      var rs = 0, row = y * w, irow = (y + 1) * W1, prow = y * W1;
      for (var x = 0; x < w; x++) { rs += gray[row + x]; integ[irow + x + 1] = integ[prow + x + 1] + rs; }
    }
    var out = new Uint8ClampedArray(n), black = 0;
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
    if (invert && black > n * 0.5) { for (var m = 0; m < n; m++) out[m] = 255 - out[m]; }
    return out;
  }

  /* Kontrast-Stretch; invertiert bei ueberwiegend dunklem Bild. */
  function stretchBuf(gray) {
    var out = new Uint8ClampedArray(gray.length), sum = 0;
    for (var j = 0; j < gray.length; j++) {
      var v = (gray[j] - 128) * 1.7 + 134;
      out[j] = v < 0 ? 0 : v > 255 ? 255 : v; sum += out[j];
    }
    if (sum / out.length < 110) { for (var k = 0; k < out.length; k++) out[k] = 255 - out[k]; }
    return out;
  }

  /* Canvas + Aufbereitung -> Eingabe-Canvas fuer Tesseract. */
  function prep(cv, kind, rad) {
    var w = cv.width, h = cv.height;
    if (kind === "gray") return bufToCanvas(w, h, grayOf(cv, "lum"));
    if (kind === "stretch") return bufToCanvas(w, h, stretchBuf(grayOf(cv, "lum")));
    if (kind === "adaptMin") return bufToCanvas(w, h, adaptiveBuf(w, h, grayOf(cv, "min"), rad, 12, true));
    return bufToCanvas(w, h, adaptiveBuf(w, h, grayOf(cv, "lum"), rad, 12, true)); // "adapt"
  }

  /* OCR mit Wort-Boxen. Liefert { text, words:[{t,x0,y0,x1,y1}] }. */
  async function ocrWords(worker, input, psm) {
    await setPsm(worker, psm);
    var res = await worker.recognize(input, {}, { text: true, blocks: true });
    var d = (res && res.data) || {}, words = [];
    (d.blocks || []).forEach(function (b) {
      (b.paragraphs || []).forEach(function (p) {
        (p.lines || []).forEach(function (l) {
          (l.words || []).forEach(function (wd) {
            var t = String(wd.text || "").trim();
            if (t && wd.bbox) words.push({ t: t, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 });
          });
        });
      });
    });
    return { text: d.text || "", words: words };
  }

  /* Rohtext (Rueckwaerts-Kompatibilitaet): einfache Ein-Pass-Erkennung. */
  async function recognize(blob, onProgress) {
    var worker = await getWorker(onProgress);
    await setPsm(worker, 3);
    var res = await worker.recognize(blob);
    return (res && res.data && res.data.text) || "";
  }

  /* ---- Text-Helfer ---------------------------------------------------------- */
  function fold(s) {
    return String(s).toLowerCase()
      .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss")
      .replace(/\s+/g, " ");
  }

  // Stichwoerter zur Tabellen-Lokalisierung (Stufe 1) -> Art.
  function kwKind(t) {
    var f = fold(t);
    if (/brennw|energie/.test(f)) return "energy";
    if (/kcal|^kj/.test(f)) return "energy";
    if (/gesatt|attigt|fettsaur/.test(f)) return "sat";
    if (/zucker|ucker/.test(f)) return "sugar";
    if (/kohlenh|ohlenhy|hydrat/.test(f)) return "carbs";
    if (/ballast/.test(f)) return "fiber";
    if (/eiwei|iweis|protein/.test(f)) return "protein";
    if (/salz/.test(f)) return "salt";
    if (/^fett/.test(f)) return "fat";
    if (/nahrwert|durchschnitt/.test(f)) return "head";
    return null;
  }

  /* Zeilen-Art (Beschriftung) einer Tabellenzeile; Reihenfolge wichtig. */
  function rowKind(f) {
    if (/ungesatt|einfach|mehrfach|trans/.test(f)) return "other";
    if (/gesatt|gesat|attigt|fettsaur|ettsaur|ges\.\s*f/.test(f)) return "sat";
    if (/zucker|ucker/.test(f)) return "sugar";
    if (/kohlenh|ohlenh|hydrat/.test(f)) return "carbs";
    if (/ballast/.test(f)) return "fiber";
    if (/eiwei|iweis|protein/.test(f)) return "protein";
    if (/salz/.test(f)) return "salt";
    if (/natrium|calcium|kalzium|vitamin|starke|mehrwert|alkohol|magnes|eisen|zink|jod|kalium|folsa|omega|chlorid/.test(f)) return "other";
    if (/(^|[^a-z])fett/.test(f)) return "fat";
    if (/brennw|energie|kcal|\bkj\b|[0-9]\s*kj/.test(f)) return "energy";
    return null;
  }

  /* ---- Zahlen-Kandidaten ------------------------------------------------------
     Aus einem Zahl-Token (+ ob ein „g" folgte) werden gewichtete Lesarten:
       „1,5 g" / „11,9g" -> 1,5 / 11,9 (sicher, Gewicht 2)
       „0,99"            -> 0,9 (angeklebtes g) | 0,99 (schwach)
       „0,139"           -> 0,13
       „829" / „7249"    -> 8,2 / 72,4 (Komma verloren + g als 9)
     Plausibilitaet (<= 100 g) filtert den Rest. */
  function numCands(tok, hasG, field) {
    var out = [];
    function add(v, w) { if (v != null && isFinite(v) && v >= 0 && v <= 100) out.push({ v: Math.round(v * 100) / 100, w: w }); }
    var m;
    if ((m = tok.match(/^(\d{1,3})[.,](\d+)$/))) {
      var ip = m[1], dp = m[2], val = parseFloat(ip + "." + dp);
      if (hasG) { add(val, 2); return out; }
      if (dp.length === 1) { add(val, 1.5); return out; }
      if (dp.length === 2 && dp[1] === "9") {
        var cut = parseFloat(ip + "." + dp[0]);
        if (field === "salt") { add(cut, 0.8); add(val, 0.6); } else { add(cut, 1); add(val, 0.3); }
        return out;
      }
      if (dp.length === 3 && dp[2] === "9") { add(parseFloat(ip + "." + dp.slice(0, 2)), 1); return out; }
      add(val, field === "salt" ? 1 : 0.6);
      return out;
    }
    if ((m = tok.match(/^\d{1,5}$/))) {
      var D = m[0];
      if (hasG) {
        add(parseInt(D, 10), 1.5);
        if (D.length >= 2) add(parseFloat(D.slice(0, -1) + "." + D.slice(-1)), 0.4);
        return out;
      }
      if (D.length >= 2 && D[D.length - 1] === "9") {
        var E = D.slice(0, -1);
        add(parseInt(E, 10), 0.6);
        if (E.length >= 2) add(parseFloat(E.slice(0, -1) + "." + E.slice(-1)), 0.6);
        add(parseInt(D, 10), 0.3);
        return out;
      }
      add(parseInt(D, 10), 1);
      if (D.length >= 2) add(parseFloat(D.slice(0, -1) + "." + D.slice(-1)), 0.3);
      return out;
    }
    return out;
  }

  /* Zahlen einer Zeile (nach der Beschriftung). Liefert [{tok, hasG, unit}],
     unit: "pct" | "mg" | "kj" | "kcal" | "g" | "". Verwechslungen am Zahlanfang
     (d,18 / o,5 / l,5) werden korrigiert. */
  function numsIn(s) {
    s = String(s)
      .replace(/(^|[^a-z0-9])[oOdDQ](?=[.,]\d)/g, "$10")
      .replace(/(^|[^a-z0-9])[lI|](?=[.,]\d)/g, "$11");
    var re = /(\d+(?:[.,]\d+)?)\s*(%|mg|µg|ug|kj|k\)|kl\b|k1\b|kcal|kca[l1i]?|keal|kcai|kal\b|g\b|g(?=[^a-z])|g$)?/gi, m, out = [];
    while ((m = re.exec(s))) {
      var u = (m[2] || "").toLowerCase(), unit = "";
      if (u === "%") unit = "pct";
      else if (/^(mg|µg|ug)$/.test(u)) unit = "mg";
      else if (/^(kj|k\)|kl|k1)$/.test(u)) unit = "kj";
      else if (/^k/.test(u)) unit = "kcal";
      else if (u === "g") unit = "g";
      // „15%*" hinter einer Zahl in derselben Spalte
      out.push({ tok: m[1], hasG: unit === "g", unit: unit, idx: m.index });
    }
    return out;
  }

  /* ---- Zeilen-Parser ---------------------------------------------------------
     rows: [string] in Lesereihenfolge (eine Tabellenzeile je Eintrag).
     Liefert { cands:{feld:[{v,w}]}, unit, base }. */
  var FIELDS = ["kcal", "fat", "sat", "carbs", "sugar", "fiber", "protein", "salt"];

  function parseRows(rows) {
    var res = { cands: {}, unit: null, base: null };
    FIELDS.forEach(function (f) { res.cands[f] = []; });
    var R = rows.map(function (r) { var f = fold(r); return { raw: r, f: f, kind: rowKind(f) }; });
    var all = R.map(function (r) { return r.f; }).join(" ");

    var mb = all.match(/(?:pro|je|per)\s*(\d{2,4})\s*(g|ml|m1|mi)\b/);
    if (mb) { res.base = parseInt(mb[1], 10); res.unit = /^m/.test(mb[2]) ? "ml" : "g"; }
    if (!res.unit && /\b100\s*(ml|m1)\b/.test(all)) res.unit = "ml";
    if (!res.unit && /\b100\s*g\b/.test(all)) res.unit = "g";

    var used = {};
    for (var i = 0; i < R.length; i++) {
      var r = R[i], k = r.kind;
      if (!k || k === "other") continue;
      var label = k === "energy" ? r.raw : afterLabel(r.raw, k);
      if (k === "energy") { energyRow(res, r.raw, R, i); continue; }
      if (used[k]) continue;
      var nums = valueNums(label);
      // Beschriftung ohne Zahl -> bis zu 2 Folgezeilen ohne andere Beschriftung
      for (var j = i + 1; !nums.length && j <= i + 2 && j < R.length; j++) {
        var kk = R[j].kind;
        if (kk && kk !== k && !(k === "sat" && kk === "fat")) break;
        nums = valueNums(kk ? afterLabel(R[j].raw, kk) : R[j].raw);
      }
      if (!nums.length) continue;
      used[k] = true;
      var n = nums[0];
      numCands(n.tok, n.hasG, k).forEach(function (c) { res.cands[k].push(c); });
    }
    positional(res, R, used);
    return res;
  }

  // Reihenfolge-Schluss fuer Zeilen mit Werten, deren Beschriftung die OCR
  // verloren hat (z. B. dunkle/farbige Beschriftungsspalte): In der EU-Tabelle
  // folgen die Zeilen fest aufeinander. Nur zwischen/nach sicher erkannten
  // Zeilen, mit geringem Gewicht; die Energiebilanz in select() prueft mit.
  // Ballaststoffe sind optional und werden daher nie so erschlossen.
  var ORDER = ["energy", "fat", "sat", "carbs", "sugar", "protein", "salt"];
  function positional(res, R, used) {
    var labelled = {};
    R.forEach(function (r) { if (r.kind) labelled[r.kind] = 1; });
    var prev = null, skipKcal = false;
    for (var i = 0; i < R.length; i++) {
      var r = R[i];
      if (r.kind) {
        prev = r.kind === "fiber" ? "sugar" : r.kind;
        // kcal in eigener Zeile unter dem Brennwert -> diese Zeile ueberspringen
        skipKcal = r.kind === "energy" && !/k\s*c?a[l1i]|keal|kcai/.test(r.f);
        continue;
      }
      if (!prev || prev === "other") continue;
      var all = numsIn(r.raw);
      if (all.some(function (n) { return n.unit === "kj" || n.unit === "kcal"; })) { skipKcal = false; continue; }
      var nums = valueNums(r.raw);
      if (!nums.length) continue;
      if (skipKcal) { skipKcal = false; continue; }
      var pi = ORDER.indexOf(prev), k = null;
      for (var q = pi + 1; q < ORDER.length; q++) {
        if (labelled[ORDER[q]] || used[ORDER[q]]) continue;
        k = ORDER[q]; break;
      }
      if (!k) continue;
      // die naechste sicher beschriftete Zeile darf nicht vor k stehen
      for (var j = i + 1; j < R.length; j++) {
        if (R[j].kind && R[j].kind !== "other") { if (ORDER.indexOf(R[j].kind) >= 0 && ORDER.indexOf(R[j].kind) < ORDER.indexOf(k)) k = null; break; }
      }
      if (!k) continue;
      used[k] = true; prev = k;
      numCands(nums[0].tok, nums[0].hasG, k).forEach(function (c) { res.cands[k].push({ v: c.v, w: c.w * 0.7 }); });
    }
  }

  // Text hinter dem Stichwort der Zeile (Zahlen in der Beschriftung ignorieren).
  function afterLabel(raw, kind) {
    var f = fold(raw);
    var re = { sat: /(gesatt\S*|gesat\S*|\S*attigt\S*|\S*fettsaur\S*|\S*ettsaur\S*|ges\.\s*f\S*)/,
      sugar: /\S*ucker\S*/, carbs: /\S*(ohlenh|hydrat)\S*/, fiber: /\S*ballast\S*/,
      protein: /\S*(eiwei|iweis|protein)\S*/, salt: /\S*salz\S*/, fat: /\S*fett\S*/ }[kind];
    var m = re ? f.match(re) : null;
    // fold() erhaelt die Laenge bis auf ß->ss und Leerzeichen-Kollaps; die
    // Position im gefalteten Text reicht als Naeherung fuer den Schnitt.
    if (!m) return raw;
    var cut = m.index + m[0].length;
    var ff = fold(raw), pos = 0, acc = 0;
    // Position im Rohtext zur gefalteten Position suchen
    for (pos = 0; pos < raw.length && acc < cut; pos++) acc = fold(raw.slice(0, pos + 1)).length;
    return raw.slice(pos);
  }

  // Werte-Zahlen einer Zeile: %, mg, kJ/kcal ueberspringen.
  function valueNums(s) {
    return numsIn(s).filter(function (n) { return n.unit !== "pct" && n.unit !== "mg" && n.unit !== "kj" && n.unit !== "kcal"; });
  }

  // „S6 kcal" -> „56 kcal": fuehrendes S/s vor einer Ziffer ist fast immer eine 5
  function fixS5(f) { return f.replace(/(^|[^a-z0-9])s(\d)/g, "$15$2"); }

  function energyRow(res, raw, R, i) {
    var f = fixS5(fold(raw)), m;
    var reK = /(\d{1,4})\s*(?:\)|\/|\|)?\s*\(?\s*(?:kcal|kca[l1i]?|kaal|keal|kcai|kcel|kc[l1]|kal)\b/g;
    var got = false;
    while ((m = reK.exec(f))) { var v = parseInt(m[1], 10); if (v >= 1 && v <= 900) { res.cands.kcal.push({ v: v, w: 2 }); got = true; break; } }
    // kcal in eigener Folgezeile ohne Beschriftung („56 kcal")
    if (!got && R[i + 1] && (!R[i + 1].kind || R[i + 1].kind === "energy")) {
      var f2 = fixS5(R[i + 1].f); reK.lastIndex = 0;
      if ((m = reK.exec(f2))) { var v2 = parseInt(m[1], 10); if (v2 >= 1 && v2 <= 900) { res.cands.kcal.push({ v: v2, w: 2 }); got = true; } }
    }
    var mj = f.match(/(\d{2,4})\s*(?:kj|k\)|kl\b|k1\b)/);
    if (mj) { var kj = parseInt(mj[1], 10); if (kj >= 20 && kj <= 3800) res.cands.kcal.push({ v: Math.round(kj / 4.184), w: got ? 0.2 : 0.7, kj: true }); }
  }

  /* Woerter -> Tabellenzeilen (y-Cluster), je Zeile nach x sortiert. */
  function wordsToRows(words) {
    var ws = words.slice().map(function (w) { return { t: w.t, x0: w.x0, x1: w.x1, cy: (w.y0 + w.y1) / 2, h: Math.max(1, w.y1 - w.y0) }; });
    // sehr hohe/flache Rauschbloecke raus
    var hs = ws.map(function (w) { return w.h; }).sort(function (a, b) { return a - b; });
    var medH = hs.length ? hs[hs.length >> 1] : 20;
    ws = ws.filter(function (w) { return w.h < medH * 3; });
    ws.sort(function (a, b) { return a.cy - b.cy; });
    var rows = [];
    ws.forEach(function (w) {
      var best = null, bd = 1e9;
      for (var k = Math.max(0, rows.length - 4); k < rows.length; k++) {
        var r = rows[k], d = Math.abs(w.cy - r.cy);
        if (d < 0.45 * Math.max(w.h, r.h) && d < bd) { bd = d; best = r; }
      }
      if (best) { best.ws.push(w); best.cy = (best.cy * (best.ws.length - 1) + w.cy) / best.ws.length; best.h = Math.max(best.h, w.h); }
      else rows.push({ cy: w.cy, h: w.h, ws: [w] });
    });
    rows.sort(function (a, b) { return a.cy - b.cy; });
    return rows.map(function (r) {
      r.ws.sort(function (a, b) { return a.x0 - b.x0; });
      return r.ws.map(function (w) { return w.t; }).join(" ");
    });
  }

  /* ---- Auswahl: Abstimmung + Naehrwertlogik ---------------------------------- */
  function tally(list) {
    var m = {};
    list.forEach(function (c) { var k = String(c.v); m[k] = (m[k] || 0) + c.w; });
    return Object.keys(m).map(function (k) { return { v: parseFloat(k), w: m[k] }; })
      .sort(function (a, b) { return b.w - a.w; });
  }

  function energyOk(s) {
    if (s.kcal == null || s.fat == null || s.carbs == null || s.protein == null) return null;
    var e = 9 * s.fat + 4 * s.carbs + 4 * s.protein + 2 * (s.fiber || 0);
    return Math.abs(e - s.kcal) <= Math.max(8, 0.12 * s.kcal);
  }

  function select(pool) {
    var opts = {};
    FIELDS.forEach(function (f) { opts[f] = tally(pool[f]).slice(0, 4).concat([{ v: null, w: 0 }]); });
    var best = null, bestSc = -1e9, cur = {}, curW = {};
    function score() {
      var sc = 0;
      FIELDS.forEach(function (f) { sc += curW[f]; });
      if (cur.sat != null && cur.fat != null && cur.sat > cur.fat + 0.05) sc -= 3;
      if (cur.sugar != null && cur.carbs != null && cur.sugar > cur.carbs + 0.05) sc -= 3;
      var ok = energyOk(cur);
      if (ok === false) sc -= 2.5; else if (ok === true) sc += 1;
      return sc;
    }
    (function rec(i) {
      if (i === FIELDS.length) {
        var sc = score();
        if (sc > bestSc) { bestSc = sc; best = {}; FIELDS.forEach(function (f) { best[f] = { v: cur[f], w: curW[f] }; }); }
        return;
      }
      var f = FIELDS[i];
      opts[f].forEach(function (o) { cur[f] = o.v; curW[f] = o.w; rec(i + 1); });
    })(0);
    var vals = {}; FIELDS.forEach(function (f) { vals[f] = best[f].v; });
    best._energy = energyOk(vals);
    return best;
  }

  /* ---- Oeffentlicher Text-Parser (Rueckwaerts-Kompatibilitaet) --------------- */
  function finish(sel, meta) {
    var out = { base_g: meta.base || 100, unit: meta.unit || "g", kcal: null, sat_fat_g: null, sugar_g: null, protein_g: null, fiber_g: null,
      fat_g: null, carbs_g: null, salt_g: null, _found: {} };
    var map = { kcal: "kcal", sat: "sat_fat_g", sugar: "sugar_g", protein: "protein_g", fiber: "fiber_g", fat: "fat_g", carbs: "carbs_g", salt: "salt_g" };
    var APP = { kcal: 1, sat_fat_g: 1, sugar_g: 1, protein_g: 1, fiber_g: 1 };
    FIELDS.forEach(function (f) {
      var s = sel[f]; if (!s || s.v == null) return;
      // nur ausreichend gestuetzte Werte (oder durch die Energiebilanz bestaetigte)
      var energyField = f === "kcal" || f === "fat" || f === "carbs" || f === "protein";
      if (s.w >= 1 || (s.w >= 0.5 && energyField && sel._energy === true)) {
        out[map[f]] = s.v;
        if (APP[map[f]]) out._found[map[f]] = true;
      }
    });
    return out;
  }

  function parseNutrition(text) {
    var rows = String(text || "").split(/\r?\n/).filter(function (l) { return l.trim(); });
    var p = parseRows(rows);
    return finish(select(p.cands), p);
  }

  /* ---- Stufe 1: Tabelle lokalisieren ------------------------------------------ */
  function locateBox(words, W, H) {
    var kw = [];
    words.forEach(function (w) {
      var k = kwKind(w.t);
      if (k && (w.y1 - w.y0) > 4) kw.push({ k: k, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, cy: (w.y0 + w.y1) / 2, h: w.y1 - w.y0 });
    });
    if (kw.length < 3) return null;
    var hs = kw.map(function (w) { return w.h; }).sort(function (a, b) { return a - b; });
    var h = hs[hs.length >> 1];
    // dichteste vertikale Gruppe (Abstand < 6 Zeilenhoehen) mit den meisten Arten
    kw.sort(function (a, b) { return a.cy - b.cy; });
    var groups = [], g = [kw[0]];
    for (var i = 1; i < kw.length; i++) {
      if (kw[i].cy - kw[i - 1].cy < 6 * h) g.push(kw[i]); else { groups.push(g); g = [kw[i]]; }
    }
    groups.push(g);
    var best = null, bestN = 0;
    groups.forEach(function (gr) {
      var kinds = {}; gr.forEach(function (w) { if (w.k !== "head") kinds[w.k] = 1; });
      var n = Object.keys(kinds).length;
      if (n > bestN) { bestN = n; best = gr; }
    });
    if (!best || bestN < 3) return null;
    var hs2 = best.map(function (w) { return w.h; }).sort(function (a, b) { return a - b; });
    h = hs2[hs2.length >> 1];
    var minX = Math.min.apply(null, best.map(function (w) { return w.x0; }));
    var minY = Math.min.apply(null, best.map(function (w) { return w.y0; }));
    var maxY = Math.max.apply(null, best.map(function (w) { return w.y1; }));
    var maxX = Math.max.apply(null, best.map(function (w) { return w.x1; }));
    words.forEach(function (w) {
      var cy = (w.y0 + w.y1) / 2;
      if (/\d/.test(w.t) && cy > minY - h && cy < maxY + h && w.x0 > minX && w.x0 < minX + 22 * h) maxX = Math.max(maxX, w.x1);
    });
    // Wenige erkannte Arten = Box vermutlich unvollstaendig (z. B. Salz/Eiweiss
    // unten, Beschriftungsspalte links) -> grosszuegiger auffuellen.
    var miss = Math.max(0, 6 - bestN);
    var x0 = Math.max(0, minX - (2 + miss) * h), x1 = Math.min(W, maxX + 2 * h);
    var y0 = Math.max(0, minY - (2.5 + miss) * h), y1 = Math.min(H, maxY + (2 + 1.5 * miss) * h);
    return { x0: x0, y0: y0, x1: x1, y1: y1, h: h, kinds: bestN };
  }

  /* Rueckfall fuer Stufe 1: Tabelle ueber ihre Zahlenspalten orten, wenn die
     Stichwoerter unlesbar sind. Sucht die dichteste senkrechte Folge von
     Zahl-Woertern (Werte, %-Angaben, kJ/kcal) ueber >= 5 Zeilen. Die
     Beschriftungen stehen links davon -> grosszuegig nach links erweitern. */
  function isNumWord(t) {
    return /^[(\[]?\d[\d.,]{0,5}\s*(g|9|%|mg|kj|k\)|kcal|kca.?|ml)?[)*°“”"']*$/i.test(t);
  }
  function locateByNumbers(words, W, H) {
    var nw = words.filter(function (w) { return isNumWord(w.t) && (w.y1 - w.y0) > 4; })
      .map(function (w) { return { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, cy: (w.y0 + w.y1) / 2, h: w.y1 - w.y0 }; });
    if (nw.length < 6) return null;
    var hs = nw.map(function (w) { return w.h; }).sort(function (a, b) { return a - b; });
    var h = hs[hs.length >> 1];
    nw = nw.filter(function (w) { return w.h < 2 * h && w.h > 0.5 * h; });
    nw.sort(function (a, b) { return a.cy - b.cy; });
    var groups = [], g = [];
    nw.forEach(function (w) {
      if (g.length && w.cy - g[g.length - 1].cy > 2.5 * h) { groups.push(g); g = []; }
      g.push(w);
    });
    if (g.length) groups.push(g);
    var best = null, bestN = 0;
    groups.forEach(function (gr) {
      var rows = {}; gr.forEach(function (w) { rows[Math.round(w.cy / (1.1 * h))] = 1; });
      var n = Object.keys(rows).length;
      if (n > bestN) { bestN = n; best = gr; }
    });
    if (!best || bestN < 5) return null;
    var minX = Math.min.apply(null, best.map(function (w) { return w.x0; }));
    var maxX = Math.max.apply(null, best.map(function (w) { return w.x1; }));
    var minY = Math.min.apply(null, best.map(function (w) { return w.y0; }));
    var maxY = Math.max.apply(null, best.map(function (w) { return w.y1; }));
    return { x0: Math.max(0, minX - 9 * h), y0: Math.max(0, minY - 2.5 * h),
      x1: Math.min(W, maxX + 1.5 * h), y1: Math.min(H, maxY + 1.5 * h), h: h, kinds: 0 };
  }

  /* Linke Zahlenspalte (= „je 100 g/ml") in Wort-Boxen finden. Liefert
     { x0, x1 } in denselben Koordinaten oder null. */
  function valueColumn(words) {
    var nw = words.filter(function (w) {
      return /\d/.test(w.t) && !/%/.test(w.t) && isNumWord(w.t);
    }).map(function (w) { return { t: w.t, x0: w.x0, x1: w.x1, cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2, h: w.y1 - w.y0 }; });
    if (nw.length < 4) return null;
    var hs = nw.map(function (w) { return w.h; }).sort(function (a, b) { return a - b; });
    var h = hs[hs.length >> 1];
    // Rauschboxen (viel breiter als ihre Zeichenzahl) verbinden sonst Spalten
    nw = nw.filter(function (w) { return w.x1 - w.x0 <= (w.t.length + 1) * 0.8 * h; });
    nw.sort(function (a, b) { return a.cx - b.cx; });
    var cols = [], c = [];
    nw.forEach(function (w) {
      if (c.length && w.cx - c[c.length - 1].cx > 1.5 * h) { cols.push(c); c = []; }
      c.push(w);
    });
    if (c.length) cols.push(c);
    for (var i = 0; i < cols.length; i++) {
      var rows = {}; cols[i].forEach(function (w) { rows[Math.round(w.cy / (1.1 * h))] = 1; });
      var nr = Object.keys(rows).length;
      if (nr < 2) continue;
      // links steht eine nur teilweise gelesene Spalte -> nicht die Portionsspalte nehmen
      if (nr < 4) return null;
      var x0 = Math.min.apply(null, cols[i].map(function (w) { return w.x0; })) - 0.7 * h;
      var x1 = Math.max.apply(null, cols[i].map(function (w) { return w.x1; })) + 0.7 * h;
      if (cols[i + 1]) x1 = Math.min(x1, Math.min.apply(null, cols[i + 1].map(function (w) { return w.x0; })) - 0.2 * h);
      if (x1 - x0 < 1.5 * h) return null;
      return { x0: x0, x1: x1, h: h };
    }
    return null;
  }

  /* Wertespalte in Lesereihenfolge -> Kandidaten ueber die EU-Reihenfolge.
     Anker ist die Energiezeile (kcal/kJ); danach zaehlen nur Zeilen mit einer
     Zahl. 6 Werte = ohne, 7 = mit Ballaststoffen; bei mehr (Fehllesungen)
     werden beide Reihenfolgen probiert. kcal zaehlt auch ohne Zuordnung. */
  var SEQ6 = ["fat", "sat", "carbs", "sugar", "protein", "salt"];
  var SEQ7 = ["fat", "sat", "carbs", "sugar", "fiber", "protein", "salt"];
  var EN_RE = /k\s*c?a[l1i]|kaal|keal|kcai|kcel|\bk\s*[j)]|[0-9]\s*kj|kl\b|k1\b/;
  function parseColumn(rows, fiberSeen) {
    var cands = {}; FIELDS.forEach(function (f) { cands[f] = []; });
    var R = rows.map(function (r) { return fixS5(fold(r)); });
    var anchor = -1;
    for (var i = 0; i < R.length; i++) if (EN_RE.test(R[i])) anchor = i;
    if (anchor < 0) return cands;
    var kc = null;
    for (var a = 0; a <= anchor; a++) {
      var m = R[a].match(/(\d{1,4})\s*(?:\)|\/|\|)?\s*\(?\s*(?:kcal|kca[l1i]?|kaal|keal|kcai|kcel|kc[l1]|kal)\b/);
      if (m) { var v = parseInt(m[1], 10); if (v >= 1 && v <= 900) kc = v; }
    }
    if (kc != null) cands.kcal.push({ v: kc, w: 1 });
    var vals = [];
    for (var j = anchor + 1; j < R.length; j++) {
      if (/referenz|erwachs|portion|packung|enthalt/.test(R[j])) break; // Fussnote
      var nums = valueNums(R[j]);
      if (!nums.length) continue;
      if (/^\d{6,}$/.test(nums[0].tok)) break; // Barcode
      vals.push(nums[0]);
    }
    // 6 Werte = ohne, 7 = mit Ballaststoffen; bei mehr Zeilen beide Deutungen pruefen
    var seqs = [];
    if (vals.length === 6 || vals.length > 7) seqs.push(SEQ6);
    if (vals.length >= 7) seqs.push(SEQ7);
    var best = null, bestSc = -1e9;
    seqs.forEach(function (seq) {
      // Lesarten je Wert; eine fuehrende „1" ist oft der Strich von „- davon"
      var opts = seq.map(function (k, n) {
        var t = vals[n].tok, o = numCands(t, vals[n].hasG, k).slice(0, 3);
        if (/^1\d{2,3}$/.test(t)) numCands(t.slice(1), vals[n].hasG, k).slice(0, 2).forEach(function (c) { o.push({ v: c.v, w: c.w * 0.7 }); });
        return o.length ? o : [{ v: null, w: -1 }];
      });
      var pen = seq === SEQ7 && !fiberSeen ? -1.5 : 0, cur = {};
      // Kombination waehlen, die die Naehrwertlogik erfuellt
      // (ges. FS <= Fett, Zucker <= KH, Energiebilanz)
      (function rec(n, sc) {
        if (n === seq.length) {
          if (cur.sat > cur.fat + 0.05) sc -= 3;
          if (cur.sugar > cur.carbs + 0.05) sc -= 3;
          var ok = energyOk({ kcal: kc, fat: cur.fat, carbs: cur.carbs, protein: cur.protein, fiber: cur.fiber });
          if (ok === true) sc += 3; else if (ok === false) sc -= 2;
          if (sc > bestSc) { bestSc = sc; best = { ok: ok, seq: seq, v: JSON.parse(JSON.stringify(cur)) }; }
          return;
        }
        opts[n].forEach(function (c) { cur[seq[n]] = c.v; rec(n + 1, sc + c.w); });
      })(0, pen);
    });
    if (!best) return cands;
    var w = best.ok === true ? 1.5 : 0.5, bv = best.v;
    if (bv.sat > bv.fat + 0.05 || bv.sugar > bv.carbs + 0.05) w = 0.3;
    if (best.seq === SEQ7 && !fiberSeen) w *= 0.6;
    best.seq.forEach(function (k) { if (bv[k] != null) cands[k].push({ v: bv[k], w: w }); });
    return cands;
  }

  /* ---- Hauptablauf -------------------------------------------------------------- */
  async function scanNutrition(blob, onProgress) {
    var worker = await getWorker(onProgress);
    var cv = await loadImage(blob);
    var texts = [], used = [];
    var pool = {}; FIELDS.forEach(function (f) { pool[f] = []; });
    var meta = { unit: null, base: null };
    var box = null, s1 = 0, crop = null, geo = null;

    if (!cv) { // kein Canvas (sehr alte Umgebung) -> einfacher Textpfad
      await setPsm(worker, 6);
      var r0 = await worker.recognize(blob);
      var t0 = (r0 && r0.data && r0.data.text) || "";
      var p0 = parseNutrition(t0); p0._text = t0; p0._variant = "orig/psm6"; return p0;
    }

    var TOTAL = 8, step = 0;
    function hook(m) {
      if (m && /recogniz/i.test(m.status || "")) emit({ status: "recognizing text", progress: Math.min(1, (step + (m.progress || 0)) / TOTAL) });
      else emit(m);
    }
    _stepHook = hook;
    try {
      // Stufe 1: Tabelle suchen (ganzes Foto, lange Seite ~2400 px)
      s1 = LOCATE_DIM / Math.max(cv.width, cv.height);
      var full = region(cv, 0, 0, cv.width, cv.height, s1);
      box = null; var locWords = [];
      var tries = [["adapt", 11], ["gray", 11], ["stretch", 11]];
      for (var t = 0; t < tries.length && !box; t++) {
        var rad1 = Math.max(10, Math.round(20 * LOCATE_DIM / 2560));
        var r1 = await ocrWords(worker, prep(full, tries[t][0], rad1), tries[t][1]);
        locWords = locWords.concat(r1.words);
        box = locateBox(r1.words, full.width, full.height);
        if (t === 0) step = 1;
        if (!box) { var q = parseRows(wordsToRows(r1.words)); mergeMeta(meta, q); addPool(pool, q.cands, 0.5); }
      }
      // Stichwoerter unlesbar -> Tabelle ueber die Zahlenspalten orten
      if (!box) box = locateByNumbers(locWords, full.width, full.height);
      step = 1;

      // Stufe 2: Ausschnitt aus dem Original auf Ziel-Schrifthoehe
      if (box) {
        var sx = box.x0 / s1, sy = box.y0 / s1, sw = (box.x1 - box.x0) / s1, sh = (box.y1 - box.y0) / s1;
        var hOrig = box.h / s1;
        var sc = TARGET_H / hOrig;
        sc = Math.min(sc, CROP_MAX / Math.max(sw, sh), 4);
        crop = region(cv, sx, sy, sw, sh, sc);
        geo = { cv: cv, sx: Math.max(0, Math.round(sx)), sy: Math.max(0, Math.round(sy)), sc: sc };
      } else {
        crop = full; // Tabelle nicht gefunden -> ganzes Bild
      }
      var textH = box ? Math.min(TARGET_H, box.h / s1 * (crop.width / ((box.x1 - box.x0) / s1))) : 40;
      var rad = Math.max(10, Math.round(textH * 0.4));
      var variants = [["adapt", 6], ["adapt", 11], ["gray", 6], ["adaptMin", 6], ["stretch", 4]];
      var cropWords = [], colDone = false;
      for (var v = 0; v < variants.length; v++) {
        step = 1 + v + (colDone ? 2 : 0);
        var r = await ocrWords(worker, prep(crop, variants[v][0], rad), variants[v][1]);
        cropWords = cropWords.concat(r.words);
        var rows = wordsToRows(r.words);
        texts.push(rows.join("\n"));
        used.push(variants[v][0] + "/psm" + variants[v][1]);
        var p = parseRows(rows);
        mergeMeta(meta, p);
        addPool(pool, p.cands, 1);
        if (v === 1 && box) { colDone = true; await columnPass(worker, crop, geo, cropWords, pool, used, rad, function (k) { step = 3 + k; }); }
        if (v >= 2 && confident(pool)) break;
      }
    } finally { _stepHook = null; }

    if (!meta.unit && /\b\d{2,4}\s*m[l1i|](?![a-z])/.test(fold(texts.join(" ") + " " + ""))) meta.unit = "ml";
    var sel = select(pool);
    var out = finish(sel, meta);
    out._text = texts[0] || "";
    out._variant = used.join("+");
    return out;
  }

  function mergeMeta(meta, p) {
    if (p.unit && !meta.unit) meta.unit = p.unit;
    if (p.unit === "ml") meta.unit = "ml";
    if (p.base && !meta.base && p.base >= 1 && p.base <= 1000) meta.base = p.base;
  }
  /* Stufe 3: linke Zahlenspalte als eigenen Streifen lesen (2 Aufbereitungen). */
  async function columnPass(worker, crop, geo, words, pool, used, rad, onStep) {
    var col = valueColumn(words);
    if (!col) return;
    var fiberSeen = pool.fiber.length > 0;
    // aus dem Original schneiden, Schrift auf ~TARGET_H*1.3 (Streifen ist schmal)
    var k = geo.sc, x0 = geo.sx + Math.max(0, col.x0) / k, x1 = geo.sx + Math.min(crop.width, col.x1) / k;
    var scS = Math.min(6, geo.sc * TARGET_H * 1.3 / col.h);
    var strip = region(geo.cv, x0, geo.sy, x1 - x0, crop.height / k, scS);
    rad = Math.max(10, Math.round(col.h / k * scS * 0.4));
    var kinds = [["gray", 6], ["adapt", 6]];
    for (var i = 0; i < kinds.length; i++) {
      if (onStep) onStep(i);
      var r = await ocrWords(worker, prep(strip, kinds[i][0], rad), kinds[i][1]);
      addPool(pool, parseColumn(wordsToRows(r.words), fiberSeen), 1);
      used.push("col-" + kinds[i][0] + "/psm" + kinds[i][1]);
    }
  }
  function addPool(pool, cands, k) {
    FIELDS.forEach(function (f) { cands[f].forEach(function (c) { pool[f].push({ v: c.v, w: c.w * k }); }); });
  }

  /* Genug gelesen? Jedes gefundene Feld hat eine klare Mehrheit (>= 2, deutlich
     vor der zweiten Lesart), Kernfelder vorhanden, Energiebilanz stimmt. */
  function confident(pool) {
    var need = ["kcal", "sat", "sugar", "protein", "fat", "carbs"];
    for (var i = 0; i < FIELDS.length; i++) {
      var t = tally(pool[FIELDS[i]]);
      if (!t.length) { if (need.indexOf(FIELDS[i]) >= 0) return false; continue; }
      if (t[0].w < 3 || (t[1] && t[1].w > t[0].w * 0.5)) return false;
    }
    var sel = select(pool);
    return sel._energy === true;
  }

  function warmup() { getWorker().catch(function () {}); }

  root.PKOcr = {
    recognize: recognize,
    parseNutrition: parseNutrition,
    scanNutrition: scanNutrition,
    warmup: warmup,
    get ready() { return !!_worker; }
  };
})(typeof window !== "undefined" ? window : globalThis);
