/* Node-Smoke-Test der Punkte-Engine (pk-engine.js) + der Basis-Lebensmittel-DB.
 * Ausführen:  node test/engine-smoke.js
 *
 * Deckt ab:
 *   A) Punkte-Formel (pointsFor): exakter Wert, Rundung, Untergrenze 0.
 *   B) Mengen-Skalierung (pointsForAmount): free-Kurzschluss, lineare Skalierung,
 *      Guard gegen amount<=0/NaN.
 *   C) REGRESSION „gekochte Eier = 0 Punkte" (2026-09-13, v28): das Ei war
 *      fälschlich free=true -> jede Menge ergab 0. Muss jetzt Punkte liefern,
 *      auch (und gerade) bei 50 Eiern.
 *   D) Daten-Integrität aller Basis-Lebensmittel + v29-Audit-Invarianten
 *      (Kategorie „Eier & Eiweiß" nur echte, nicht-freie Ei-Produkte;
 *      auditierte Umsortierungen liegen in der korrigierten Kategorie).
 *
 * Kein Browser, keine Netz-Zugriffe: pk-engine.js exportiert module.exports.
 */
const fs = require("fs");
const path = require("path");

const PK = require(path.join(__dirname, "..", "assets", "pk-engine.js"));
const FOODS_PATH = path.join(__dirname, "..", "assets", "data", "punkto-foods.json");
const db = JSON.parse(fs.readFileSync(FOODS_PATH, "utf8"));
const foods = db.foods || [];
const byId = {};
foods.forEach(f => { byId[f.id] = f; });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra != null ? "  -> " + extra : "")); }
}

console.log("DB:", db.version, "| Lebensmittel:", foods.length);

/* ---------------------------------------------------------------------------
   A) PUNKTE-FORMEL
   raw = kcal/35 + sat*0.7 + sugar*0.08 - protein*0.10 - fiber*0.25, gerundet, >=0
   --------------------------------------------------------------------------- */
ok("pointsFor: 35 kcal = 1 Punkt", PK.pointsFor({ kcal: 35 }) === 1, PK.pointsFor({ kcal: 35 }));
ok("pointsFor rundet ab (52 kcal -> 1)", PK.pointsFor({ kcal: 52 }) === 1, PK.pointsFor({ kcal: 52 }));
ok("pointsFor rundet auf (88 kcal -> 3)", PK.pointsFor({ kcal: 88 }) === 3, PK.pointsFor({ kcal: 88 }));
ok("pointsFor: Eiweiß & Ballaststoffe senken, nie < 0",
  PK.pointsFor({ kcal: 20, protein_g: 30, fiber_g: 10 }) === 0,
  PK.pointsFor({ kcal: 20, protein_g: 30, fiber_g: 10 }));
// Ei-Portion (60 g): 84/35 + 2*0.7 + 0.6*0.08 - 7.5*0.10 = 3.098 -> 3
ok("pointsFor: Ei-Portionswerte = 3",
  PK.pointsFor({ kcal: 84, sat_fat_g: 2, sugar_g: 0.6, protein_g: 7.5, fiber_g: 0 }) === 3,
  PK.pointsFor({ kcal: 84, sat_fat_g: 2, sugar_g: 0.6, protein_g: 7.5, fiber_g: 0 }));
ok("pointsFor: leeres/undefiniertes Objekt = 0", PK.pointsFor() === 0 && PK.pointsFor({}) === 0);

/* ---------------------------------------------------------------------------
   B) MENGEN-SKALIERUNG
   --------------------------------------------------------------------------- */
const freeVeg = { free: true, base_g: 100, kcal: 300, sat_fat_g: 5, sugar_g: 10 };
ok("pointsForAmount: free-Lebensmittel bleibt 0 (auch bei 5000 g)",
  PK.pointsForAmount(freeVeg, 5000) === 0, PK.pointsForAmount(freeVeg, 5000));
const testFood = { free: false, base_g: 100, kcal: 350, sat_fat_g: 0, sugar_g: 0, protein_g: 0, fiber_g: 0 };
ok("pointsForAmount: 100 g von 350-kcal-Food = 10", PK.pointsForAmount(testFood, 100) === 10, PK.pointsForAmount(testFood, 100));
ok("pointsForAmount: 200 g davon = 20 (lineare Skalierung)", PK.pointsForAmount(testFood, 200) === 20, PK.pointsForAmount(testFood, 200));
ok("pointsForAmount: amount<=0 fällt auf Basisportion zurück (Guard)",
  PK.pointsForAmount(testFood, 0) === 10 && PK.pointsForAmount(testFood, -50) === 10,
  PK.pointsForAmount(testFood, 0) + "/" + PK.pointsForAmount(testFood, -50));
ok("pointsForAmount: NaN-amount fällt auf Basisportion zurück",
  PK.pointsForAmount(testFood, "abc") === 10, PK.pointsForAmount(testFood, "abc"));
ok("pointsForAmount: null-Food = 0", PK.pointsForAmount(null, 100) === 0);

/* ---------------------------------------------------------------------------
   C) REGRESSION: gekochte Eier dürfen NIE 0 Punkte ergeben (v28-Fix)
   --------------------------------------------------------------------------- */
const ei = byId["ei"];
ok("Ei existiert in der DB", !!ei, "id 'ei' fehlt");
if (ei) {
  ok("Ei ist NICHT free (Kern des Bugs war free=true)", ei.free === false, "free=" + ei.free);
  ok("Ei: 1 Portion ergibt Punkte (> 0)", PK.pointsForAmount(ei, ei.base_g) > 0, PK.pointsForAmount(ei, ei.base_g));
  ok("Ei: 1 Portion = 3 Punkte", PK.pointsForAmount(ei, ei.base_g) === 3, PK.pointsForAmount(ei, ei.base_g));
  // Der wörtliche Nutzerfall: „auch wenn man 50 Eier essen sollte hat man keinen Punkt"
  const fifty = PK.pointsForAmount(ei, ei.base_g * 50);
  ok("Ei: 50 Eier ergeben deutlich Punkte (>= 100), nie 0", fifty >= 100, fifty);
  ok("Ei: isFree() = false", PK.isFree(ei) === false, PK.isFree(ei));
}

/* ---------------------------------------------------------------------------
   D) DATEN-INTEGRITÄT aller Basis-Lebensmittel + v29-Audit-Invarianten
   --------------------------------------------------------------------------- */
// keine doppelten IDs
const seen = {}; const dupIds = [];
foods.forEach(f => { if (seen[f.id]) dupIds.push(f.id); else seen[f.id] = 1; });
ok("keine doppelten Lebensmittel-IDs", dupIds.length === 0, dupIds.slice(0, 5).join(","));

// Pflichtfelder + Nährwerte endlich und >= 0, base_g > 0
const NUT = ["kcal", "sat_fat_g", "sugar_g", "protein_g", "fiber_g"];
const badNut = foods.filter(f =>
  !(Number(f.base_g) > 0) ||
  NUT.some(k => !Number.isFinite(Number(f[k])) || Number(f[k]) < 0));
ok("alle Nährwerte endlich & >= 0, base_g > 0", badNut.length === 0,
  badNut.slice(0, 5).map(f => f.id).join(","));

// keine unplausibel hohen kcal (je base_g; nichts Reales über ~900 kcal/100 g,
// hier großzügig 950 auf die Basisportion bezogen wie im Audit)
const kcalHi = foods.filter(f => Number(f.kcal) / Number(f.base_g) * 100 > 950);
ok("keine unplausiblen kcal (<= 950 / 100 g)", kcalHi.length === 0,
  kcalHi.slice(0, 5).map(f => f.id + "=" + Math.round(f.kcal / f.base_g * 100)).join(","));

// Invariante vegan => vegetarisch
const veganNotVeg = foods.filter(f => f.vegan === true && f.vegetarian !== true);
ok("Invariante: vegan => vegetarisch", veganNotVeg.length === 0,
  veganNotVeg.slice(0, 5).map(f => f.id).join(","));

// Makro-Energie-Plausibilität: Eiweiß(4 kcal/g) + gesätt. Fett(9 kcal/g) darf die
// Gesamt-kcal nicht übersteigen (sat_fat <= Gesamtfett, also untere Schranke der
// Energie) — großzügige Toleranz gegen gerundete Werte.
const macroBad = foods.filter(f => {
  const e = Number(f.protein_g) * 4 + Number(f.sat_fat_g) * 9;
  return e > Number(f.kcal) + 15 + 0.15 * Number(f.kcal);
});
ok("Makro-Energie plausibel (Eiweiß+ges.Fett <= kcal + Toleranz)", macroBad.length === 0,
  macroBad.slice(0, 5).map(f => f.id).join(","));

// v29-Audit: „Eier & Eiweiß" enthält NUR echte, nicht-freie Ei-Produkte
const eierCat = foods.filter(f => f.cat === "Eier & Eiweiß");
const eierFree = eierCat.filter(f => f.free === true);
ok("Kategorie 'Eier & Eiweiß' vorhanden", eierCat.length >= 1, "n=" + eierCat.length);
ok("Kategorie 'Eier & Eiweiß' enthält kein free=true (kein fälschlich freies Eiweiß)",
  eierFree.length === 0, eierFree.map(f => f.id).join(","));

// v29-Audit: die vier umsortierten Einträge liegen in der korrigierten Kategorie
const auditMoves = {
  linsen: "Hülsenfrüchte",
  kichererbsen: "Hülsenfrüchte",
  bohnen: "Hülsenfrüchte",     // Kidneybohnen (Dose)
  tofu: "Fleischersatz & Tofu"
};
Object.keys(auditMoves).forEach(id => {
  const f = byId[id];
  ok("v29-Audit: '" + id + "' -> " + auditMoves[id],
    !!f && f.cat === auditMoves[id], f ? f.cat : "id fehlt");
});

/* ---------------------------------------------------------------------------
   E) BUDGET-KERN (Sanity — Formeln liefern plausible Bänder)
   --------------------------------------------------------------------------- */
const plan = PK.budgetPlan({ sex: "f", weight_kg: 75, height_cm: 168, age: 35, activity_level: "med", goal_weight_kg: 65 });
ok("budgetPlan: Tagesbudget im Band 18..34", plan.daily_budget >= 18 && plan.daily_budget <= 34, plan.daily_budget);
ok("budgetPlan: Wochenextra im Band 21..35", plan.weekly_extra >= 21 && plan.weekly_extra <= 35, plan.weekly_extra);
ok("budgetPlan: Zielkalorien > sicheres Minimum", plan.target_kcal >= 1200, plan.target_kcal);

/* ---------------------------------------------------------------------------
   F) ZUTATENRECHNER-INVARIANTEN (v32)
   Der Zutatenrechner filtert die DB auf zutat===true und gruppiert nach zg.
   Die anklickbaren Kategorie-Chips kommen aus ZC_GROUPS in app.html. Diese
   Invarianten halten Daten (punkto-foods.json) und UI (ZC_GROUPS) synchron und
   sichern die Nutzer-Vorgabe „Flüssigkeiten in Millilitern".
   --------------------------------------------------------------------------- */
const zutaten = foods.filter(f => f.zutat === true);
ok("Zutaten vorhanden (>= 200 markiert)", zutaten.length >= 200, "n=" + zutaten.length);

// ZC_GROUPS-Schlüssel direkt aus app.html ziehen (Quelle der Kategorie-Chips)
const appHtml = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
const zcBlock = appHtml.slice(appHtml.indexOf("var ZC_GROUPS = ["),
                            appHtml.indexOf("];", appHtml.indexOf("var ZC_GROUPS = [")));
const groupKeys = (zcBlock.match(/key:\s*"([^"]+)"/g) || []).map(s => s.match(/"([^"]+)"/)[1]);
ok("ZC_GROUPS aus app.html gelesen (14 Gruppen)", groupKeys.length === 14, groupKeys.length + ": " + groupKeys.join(","));

// Jede Zutat hat eine nicht-leere Gruppe zg
const noGroup = zutaten.filter(f => typeof f.zg !== "string" || !f.zg.trim());
ok("jede Zutat hat eine Gruppe (zg gesetzt)", noGroup.length === 0,
  noGroup.slice(0, 5).map(f => f.id).join(","));

// Kein Waisenkind: jede zg-Gruppe existiert auch als Chip in ZC_GROUPS
const gset = new Set(groupKeys);
const orphan = zutaten.filter(f => f.zg && !gset.has(f.zg));
ok("keine Zutat mit unbekannter Gruppe (zg ⊆ ZC_GROUPS)", orphan.length === 0,
  orphan.slice(0, 5).map(f => f.id + "=" + f.zg).join(","));

// Keine leere Registerkarte: jede ZC_GROUPS-Gruppe hat >= 1 Zutat
const counts = {};
zutaten.forEach(f => { counts[f.zg] = (counts[f.zg] || 0) + 1; });
const emptyGroups = groupKeys.filter(k => !counts[k]);
ok("keine leere Kategorie (jede ZC_GROUPS-Gruppe hat Zutaten)", emptyGroups.length === 0,
  emptyGroups.join(","));

// Nutzer-Vorgabe: flüssige Öle in Millilitern (Olivenöl war bis v32 fälschlich "EL").
// Feste Fette (Butter, Margarine, Ghee, Schmalz, Kokosöl) bleiben bewusst "g".
const LIQUID_OILS = ["olivenoel", "rapsoel", "sonnenblumenoel", "leinoel", "sesamoel", "walnussoel", "erdnussoel"];
const oilNotMl = LIQUID_OILS.filter(id => byId[id] && byId[id].unit !== "ml");
ok("alle flüssigen Öle sind in ml", oilNotMl.length === 0,
  oilNotMl.map(id => id + "=" + byId[id].unit).join(","));
// v32-Regression konkret: Olivenöl ml + 100er-Basis (war EL/base_g 10)
ok("v32: Olivenöl ist ml (war EL)", !!byId["olivenoel"] && byId["olivenoel"].unit === "ml",
  byId["olivenoel"] ? byId["olivenoel"].unit : "id fehlt");
ok("v32: Olivenöl base_g = 100 (100er-Basis wie andere Öle)",
  !!byId["olivenoel"] && byId["olivenoel"].base_g === 100,
  byId["olivenoel"] ? byId["olivenoel"].base_g : "id fehlt");

// Getränke-Gruppe „wein" (Wein/Sekt/Säfte) komplett in ml
const weinNotMl = zutaten.filter(f => f.zg === "wein" && f.unit !== "ml");
ok("Gruppe 'wein' (Koch-Flüssigkeiten) komplett in ml", weinNotMl.length === 0,
  weinNotMl.map(f => f.id + "=" + f.unit).join(","));

/* ---------------------------------------------------------------------------
   G) REZEPT-MODUS-INVARIANTEN (v33)
   Der Rezept-Modus (openRecipeCalcSheet) addiert die Punkte mehrerer DB-Zutaten
   und teilt durch die Portionenzahl -> „Punkte pro Portion". Diese Tests spiegeln
   exakt die Client-Rechnung: amount -> Gramm (Stück/Scheibe/Riegel/EL: amount*base_g;
   g/ml: amount 1:1) -> PK.pointsForAmount, Summe, Rundung. Sie verankern die
   verifizierten Werte des Referenz-Rezepts als Regressionsschutz.
   --------------------------------------------------------------------------- */
function recipeGrams(food, amount) {          // wie amtGrams() im Builder
  const u = food.unit;
  if (u === "g" || u === "ml") return amount; // ml ~ 1 g
  return amount * (Number(food.base_g) || 1); // Stück/Scheibe/Riegel/EL
}
function itemPoints(food, amount) {           // wie im Builder: free -> 0
  return food.free ? 0 : PK.pointsForAmount(food, recipeGrams(food, amount));
}

// Einheiten-Umrechnung: Stück nutzt base_g, g/ml bleiben 1:1
const eiFood = byId["ei"];
ok("Rezept: Stück-Menge nutzt base_g (3 Ei = 3*base_g Gramm)",
  !!eiFood && recipeGrams(eiFood, 3) === 3 * eiFood.base_g,
  eiFood ? recipeGrams(eiFood, 3) + " g" : "id 'ei' fehlt");
const milchFood = byId["milch-vollfett"];
ok("Rezept: ml zählt 1:1 als Gramm (100 ml = 100 g)",
  !!milchFood && recipeGrams(milchFood, 100) === 100,
  milchFood ? recipeGrams(milchFood, 100) + " g" : "id 'milch-vollfett' fehlt");

// Referenz-Rezept „Rührkuchen" (headless verifiziert): [id, Menge, erwartete Punkte]
const REF_RECIPE = [
  ["weizenmehl", 300, 25],
  ["zucker", 200, 39],
  ["butter", 250, 140],
  ["ei", 3, 9],
  ["milch-vollfett", 100, 4],
  ["z-backpulver", 15, 0],
];
const missingRef = REF_RECIPE.filter(r => !byId[r[0]]);
ok("Rezept: alle Referenz-Zutaten existieren in der DB", missingRef.length === 0,
  missingRef.map(r => r[0]).join(","));
const allRefZutat = REF_RECIPE.every(r => byId[r[0]] && byId[r[0]].zutat === true);
ok("Rezept: alle Referenz-Zutaten sind als zutat markiert (ref auflösbar)", allRefZutat);

let refTotal = 0, itemsOk = true;
REF_RECIPE.forEach(r => {
  const f = byId[r[0]]; if (!f) { itemsOk = false; return; }
  const p = itemPoints(f, r[1]); refTotal += p;
  if (p !== r[2]) { itemsOk = false; ok("Rezept: " + r[0] + " " + r[1] + " -> " + r[2] + " P", false, "ist " + p); }
});
ok("Rezept: jede Zutat ergibt die verifizierten Punkte", itemsOk, "Summe=" + refTotal);
ok("Rezept: Gesamtpunkte = 217 (Summe der Zutaten)", refTotal === 217, refTotal);

// Pro-Portion: Client zeigt Math.round(total/serv); Server speichert round(total/serv*10)/10
const servings = 12;
ok("Rezept: Punkte pro Portion (Anzeige) = 18 bei 12 Portionen",
  Math.round(refTotal / servings) === 18, Math.round(refTotal / servings));
ok("Rezept: points_per_serving (Server-Rundung) = 18.1",
  Math.round((refTotal / servings) * 10) / 10 === 18.1, Math.round((refTotal / servings) * 10) / 10);

// Guard: 0-Punkte-Zutat (Backpulver, vernachlässigbare kcal) trägt real 0 bei
ok("Rezept: kcal-arme Zutat trägt 0 Punkte bei (kein Aufrunden)",
  itemPoints(byId["z-backpulver"], 15) === 0,
  byId["z-backpulver"] ? itemPoints(byId["z-backpulver"], 15) : "id fehlt");

console.log("\n" + (fail === 0 ? "ALLE GRÜN" : fail + " FEHLGESCHLAGEN") + "  (" + pass + " ok, " + fail + " fail)");
process.exit(fail === 0 ? 0 : 1);
