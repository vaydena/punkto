-- Punkto — Phase 4 „Aktivitätssignal" (Offline-Umstellung).
-- Datensparsames Signal: NUR ein Datum „zuletzt aktiv" je Nutzer — kein Zähler,
-- keine Ereignishistorie. Wird von der Edge Function punkto-data opportunistisch
-- (bei ohnehin stattfindenden Online-Aufrufen: state-Boot / token-Refresh) auf
-- current_date gesetzt, höchstens einmal je Kalendertag. Getrennt von
-- last_login_at (nur Login) — „aktiv" meint jede Online-Nutzung.
-- Additiv, nullable, idempotent: kein Rückbau nötig, kein Lockout-Risiko.
alter table punkto.users
  add column if not exists last_active_on date;

comment on column punkto.users.last_active_on is
  'Zuletzt aktiv (Datum, opportunistisch gesetzt). Kein Zähler, kein Verlauf — nur der Betreiber-Überblick „zuletzt aktiv am".';
