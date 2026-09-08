# Punkto — Abnehmen mit Punkten

Statische PWA-SaaS: Ernährungstagebuch mit einem **eigenen** Punktesystem (keine Kopie
eines fremden Programms), Tagesbudget & Wochenextra, Barcode-Scanner (Open Food Facts),
eigene Lebensmittel/Rezepte, Gewichtsverlauf und Aktivität.

- **Live:** https://punkto.vaydena.de
- **Anbieter:** Vaydena – Softwarelösungen, Karl-Heinz Bicker, Freising
- **Kein Medizinprodukt** — Näherungswerte, ersetzt keine ärztliche/ernährungsmedizinische Beratung.

## Architektur

- **Frontend:** statisches HTML/CSS/Vanilla-JS (kein Build, kein Framework, kein `supabase-js`).
  Der Client ruft ausschließlich **Supabase Edge Functions** per `fetch` auf
  (`assets/pk-app.js` → `window.PKApi`). Rechen-Engine in `assets/pk-engine.js`.
- **Backend:** Supabase-Projekt `xeuexovdipdiiuzjpzkj` (eu-central-1), Schema **`punkto`**
  (bewusst **nicht** über PostgREST exponiert — nur Edge Functions greifen zu).
  Drei Functions (`verify_jwt=false`, eigene Auth):
  - `punkto-auth` — Registrierung/Login (bcrypt via pgcrypto, opake Tokens SHA-256-gehasht).
  - `punkto-data` — Tagebuch, Lebensmittel, Rezepte, Gewicht, Aktivität, Billing/GiroCode.
  - `punkto-admin` — Betreiber-Bereich, per `x-admin-key` gegatet (unabhängig vom Nutzer-Token).
- **PWA:** `manifest.webmanifest` + `sw.js` (network-first für Dokumente, cache-first für
  Assets; POST/fremde Herkunft unangetastet). Installierbar, Direktstart über
  `anmelden.html?app=1` (Variante B, token-gated, Muster `pwa-installation`-Skill).

### Zahlung — bewusst manuell (kein Stripe/keine Karten)

Zugang ist **zeitlich begrenzt** und läuft einfach ab. Nutzer zahlt im Voraus per
**Banküberweisung (GiroCode-QR)** oder **PayPal**; der Betreiber verlängert das Konto
über den Admin-Bereich um N Monate. Keine automatische Verlängerung, keine gespeicherten
Zahlungsmittel. 14 Tage kostenlose Testphase, danach 2,99 €/Monat.

## Seiten

| Datei | Zweck |
|---|---|
| `index.html` | Öffentliche Verkaufsseite |
| `anmelden.html` | Login/Registrierung + PWA-Direktstart (`?app=1`) |
| `app.html` | Die App (Tagebuch, Scanner, Rezepte, Gewicht …) |
| `konto.html` | Abo & Zahlung (GiroCode/PayPal) |
| `betreiber.html` | Betreiber-/Admin-Bereich (`x-admin-key`, **network-first, nicht im SW-Cache**) |
| `impressum/datenschutz/agb.html` | Rechtstexte |

## ⛔ Sicherheit / niemals deployen

- **`OPERATOR-KEY.local.txt`** enthält den Betreiber-Schlüssel im **Klartext** und lebt
  **nur lokal**. Er ist in `.gitignore` (`*.local.txt`) und aus beiden Deploy-Wegen
  ausgeschlossen. Käme er in den Web-Root, wäre der Admin-Bereich offen.
- **`supabase/`** (Edge Functions) wird **separat** über Supabase deployt, nicht statisch.
- Neue Tabellen im Schema `punkto` brauchen explizit `grant … to service_role`
  (BYPASSRLS umgeht nur Policies, nicht Tabellen-GRANTs).

## Deploy

Standardweg: **git push → GitHub Actions → curl-FTPS** zu Hostinger `/punkto/`.

1. Repo-Secret **`FTP_PASSWORD`** setzen (Settings → Secrets and variables → Actions →
   Tab **Secrets**, *nicht* Variables) — das reine Passwort des Deploy-FTP-Kontos
   `u424339903.deploy`.
2. Hostinger-Subdomain `punkto.vaydena.de` muss auf `/punkto/` zeigen.
3. Push auf `main` löst `.github/workflows/deploy.yml` aus (fast-fail bei 530, gebündelte
   Uploads, HTTPS-Verify inkl. Marker `deploy-version.txt`).

**Sofort-/Notweg (lokal, Windows):**

```powershell
powershell -ExecutionPolicy Bypass -File "deploy-local.ps1"
```

Passwort wird interaktiv abgefragt (nie auf Platte/History). Nutzt `--tlsv1.2 --tls-max 1.2`
(Windows-Schannel-Bug) mit vier Transport-Ausweichwegen.

**Bei jedem App-Deploy:** `CACHE`-Version in `sw.js` **und** Marker in
`deploy-version.txt` erhöhen (sonst liefert der Offline-Cache alten Code aus).
`betreiber.html` wird bewusst **nicht** vorgecacht (network-first).
