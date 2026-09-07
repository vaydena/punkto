/* ============================================================================
   Punkto — Punkte-Engine (eigenständige Formel, KEINE WW-Marke/-Formel).
   Rechnet aus Nährwerten je Portion einen ganzzahligen Punktwert und leitet
   aus Körperdaten ein Tagesbudget + Wochenextra ab.

   Läuft im Browser (window.PK) UND unter Node (module.exports) für Smoke-Tests.
   Reine Funktionen, kein State, keine DOM-/Netz-Zugriffe.
   ============================================================================ */
(function (root) {
  "use strict";

  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
  var num = function (v) { var n = Number(v); return Number.isFinite(n) ? n : 0; };

  /* --------------------------------------------------------------------------
     PUNKTE JE PORTION
     Idee: Kalorien tragen die Grundlast, gesättigte Fette & Zucker treiben den
     Wert hoch, Eiweiß & Ballaststoffe senken ihn (sättigend/gesund).
     Gewichte bewusst anders als bei bekannten Systemen -> eigene Kennzahl.
       kcal      : Kilokalorien der Portion
       sat_fat_g : gesättigte Fettsäuren (g)
       sugar_g   : Zucker (g)
       protein_g : Eiweiß (g)
       fiber_g   : Ballaststoffe (g)
     Ergebnis: ganze Zahl >= 0.
     -------------------------------------------------------------------------- */
  function pointsFor(n) {
    n = n || {};
    var raw =
      num(n.kcal) / 35 +
      num(n.sat_fat_g) * 0.7 +
      num(n.sugar_g) * 0.08 -
      num(n.protein_g) * 0.10 -
      num(n.fiber_g) * 0.25;
    var p = Math.round(raw);
    return p < 0 ? 0 : p;
  }

  /* Punkte für eine beliebige Menge (Portionswerte sind je "base_g" Gramm bzw.
     je Stück angegeben). menge in derselben Einheit wie base. */
  function pointsForAmount(food, amount) {
    if (!food) return 0;
    if (food.free) return 0;
    var base = num(food.base_g) || 100;
    var factor = num(amount) / base;
    if (!Number.isFinite(factor) || factor <= 0) factor = 1;
    var scaled = {
      kcal: num(food.kcal) * factor,
      sat_fat_g: num(food.sat_fat_g) * factor,
      sugar_g: num(food.sugar_g) * factor,
      protein_g: num(food.protein_g) * factor,
      fiber_g: num(food.fiber_g) * factor
    };
    return pointsFor(scaled);
  }

  /* Ist ein Lebensmittel ein 0-Punkte-Lebensmittel? (explizit markiert ODER
     die Formel ergibt je Basisportion 0 — z. B. Gemüse). */
  function isFree(food) {
    if (!food) return false;
    if (food.free) return true;
    return pointsFor(food) === 0;
  }

  /* --------------------------------------------------------------------------
     GRUNDUMSATZ (Mifflin-St Jeor) + Zielkalorien
     sex: 'f' | 'm' | 'd' (divers -> Mittelwert)
     -------------------------------------------------------------------------- */
  function bmr(sex, weightKg, heightCm, age) {
    var w = num(weightKg), h = num(heightCm), a = num(age);
    var male = 10 * w + 6.25 * h - 5 * a + 5;
    var female = 10 * w + 6.25 * h - 5 * a - 161;
    if (sex === "m") return male;
    if (sex === "f" || sex === "w") return female; // 'w' = weiblich (DB-Kodierung)
    return (male + female) / 2; // divers
  }

  var ACT = { low: 1.3, med: 1.45, high: 1.6 };

  /* Zielkalorien pro Tag = Erhaltungsbedarf minus 500 kcal Defizit,
     aber nie unter einem sicheren Minimum. */
  function targetKcal(profile) {
    profile = profile || {};
    var age = profile.age != null
      ? num(profile.age)
      : (profile.birth_year ? (new Date().getFullYear() - num(profile.birth_year)) : 35);
    var base = bmr(profile.sex, profile.weight_kg, profile.height_cm, age);
    var mult = ACT[profile.activity_level] || ACT.med;
    var maint = base * mult;
    var goal = profile.goal_weight_kg, cur = profile.weight_kg;
    var deficit = 500;
    // Wer schon am/unter Ziel ist -> Erhaltung statt Defizit.
    if (goal && cur && num(goal) >= num(cur)) deficit = 0;
    var minFloor = profile.sex === "m" ? 1500 : 1200;
    return Math.max(minFloor, Math.round(maint - deficit));
  }

  /* --------------------------------------------------------------------------
     TAGESBUDGET + WOCHENEXTRA (aus Zielkalorien abgeleitet)
     -------------------------------------------------------------------------- */
  function dailyBudget(profile) {
    var tk = targetKcal(profile);
    return clamp(Math.round((tk / 35) * 0.6), 18, 34);
  }
  function weeklyExtra(budget) {
    return clamp(Math.round(num(budget) * 0.9), 21, 35);
  }

  /* Komplettes Budget-Paket für die App/Onboarding. */
  function budgetPlan(profile) {
    var tk = targetKcal(profile);
    var db = dailyBudget(profile);
    return {
      target_kcal: tk,
      daily_budget: db,
      weekly_extra: weeklyExtra(db)
    };
  }

  /* --------------------------------------------------------------------------
     TAGES-/WOCHEN-AUSWERTUNG
     entries: [{points, day:'YYYY-MM-DD'}], activities: [{points_earned}]
     -------------------------------------------------------------------------- */
  function sumPoints(entries) {
    return (entries || []).reduce(function (s, e) { return s + num(e.points); }, 0);
  }

  /* Aktivität kann ein paar Bonuspunkte einbringen (sanft gedeckelt). */
  function activityPoints(kind, minutes) {
    var perMin = { walk: 0.06, run: 0.12, bike: 0.09, swim: 0.11, gym: 0.09, other: 0.07 };
    var p = Math.round(num(minutes) * (perMin[kind] || perMin.other));
    return clamp(p, 0, 8);
  }
  function activityPointsFromSteps(steps) {
    return clamp(Math.round(num(steps) / 2500), 0, 6);
  }

  var API = {
    pointsFor: pointsFor,
    pointsForAmount: pointsForAmount,
    isFree: isFree,
    bmr: bmr,
    targetKcal: targetKcal,
    dailyBudget: dailyBudget,
    weeklyExtra: weeklyExtra,
    budgetPlan: budgetPlan,
    sumPoints: sumPoints,
    activityPoints: activityPoints,
    activityPointsFromSteps: activityPointsFromSteps,
    clamp: clamp,
    ACT: ACT
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.PK = API;
})(typeof window !== "undefined" ? window : globalThis);
