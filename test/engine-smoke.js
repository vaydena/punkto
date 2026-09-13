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

console.log("\n" + (fail === 0 ? "ALLE GRÜN" : fail + " FEHLGESCHLAGEN") + "  (" + pass + " ok, " + fail + " fail)");
process.exit(fail === 0 ? 0 : 1);
