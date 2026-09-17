#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-sync.sh  --  Pruefen VOR einem Service-Worker-Bump, ob drei Staende
#                    identisch sind: Arbeitskopie, GitHub (origin/main), Live.
#
# Aufruf (Git Bash im Projektordner):   bash tools/check-sync.sh
# Exit 0 = alles synchron (Bump sicher) | Exit 1 = erst klaeren (siehe "!!").
#
# Liegt bewusst in tools/ und wird daher NICHT nach Hostinger deployt
# (deploy.yml schliesst ./tools/* aus). Keine Secrets, nur Lese-Checks.
# ---------------------------------------------------------------------------
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SITE="https://punkto.vaydena.de"
# Browser-UA umgeht die hCDN-Bot-Challenge (sonst kommt HTML statt der Datei).
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
cb=$(date +%s)
issues=0
ahead=""   # wird in [2] gesetzt, in [3] mitbenutzt

echo "=== Punkto Sync-Check ($(date '+%Y-%m-%d %H:%M')) ==="
echo "Repo: $ROOT"
echo

# [1] Arbeitskopie sauber? -------------------------------------------------
echo "[1] Arbeitskopie vs. Git (lokal)"
branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)
echo "    Branch: ${branch:-?}"
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  echo "    !! Uncommittete Aenderungen:"
  git -C "$ROOT" status --short | sed 's/^/       /'
  issues=$((issues+1))
else
  echo "    OK  sauberer Arbeitsbaum"
fi
echo

# [2] Lokal vs. origin/main (= was der Deploy nimmt) -----------------------
echo "[2] Lokal vs. GitHub (origin/main)"
git -C "$ROOT" fetch --quiet origin 2>/dev/null
counts=$(git -C "$ROOT" rev-list --left-right --count origin/main...HEAD 2>/dev/null)
if [ -z "$counts" ]; then
  echo "    ?? Vergleich nicht moeglich (kein Netz oder origin/main fehlt)"
else
  behind=$(echo "$counts" | awk '{print $1}')
  ahead=$(echo "$counts" | awk '{print $2}')
  if [ "$behind" = "0" ] && [ "$ahead" = "0" ]; then
    echo "    OK  identisch mit origin/main"
  else
    echo "    GitHub voraus: $behind   |   lokal voraus (ungepusht): $ahead"
    if [ "$behind" != "0" ]; then
      echo "    !! erst 'git pull' -- GitHub hat Neueres (sonst ueberschreibst du es)"
      issues=$((issues+1))
    fi
    if [ "$ahead" != "0" ]; then
      echo "    -- Hinweis: ungepushte Commits (ok, wenn gewollt)"
    fi
  fi
fi
echo

# [3] Git-Stand vs. LIVE (Deploy-Marker + SW-Cache) ------------------------
echo "[3] Git-Stand vs. LIVE"
loc=$(head -n1 "$ROOT/deploy-version.txt" 2>/dev/null | tr -d '\r')
live=$(curl -s -A "$UA" -H 'Cache-Control: no-cache' "$SITE/deploy-version.txt?cb=$cb" | head -n1 | tr -d '\r')
echo "    Marker   lokal: ${loc:-<fehlt>}   live: ${live:-<keine Antwort>}"
locsw=$(grep -o 'pk-app-v[0-9]*' "$ROOT/sw.js" 2>/dev/null | head -n1)
livesw=$(curl -s -A "$UA" -H 'Cache-Control: no-cache' "$SITE/sw.js?cb=$cb" | grep -o 'pk-app-v[0-9]*' | head -n1)
echo "    SW-Cache lokal: ${locsw:-<fehlt>}   live: ${livesw:-<keine Antwort>}"
if [ -z "$live" ]; then
  echo "    ?? Live nicht erreichbar (offline?) -- Abgleich uebersprungen"
elif [ -n "$loc" ] && [ "$loc" = "$live" ]; then
  echo "    OK  Live entspricht dem lokalen Marker"
elif [ -n "$ahead" ] && [ "$ahead" != "0" ]; then
  echo "    -- Marker weicht ab, aber du hast ungepushte Commits -> erwartet"
else
  echo "    !! Live weicht ab -- letztes Deploy nicht durchgegriffen? Actions-Log pruefen"
  issues=$((issues+1))
fi
echo

# Fazit --------------------------------------------------------------------
echo "=== Fazit ==="
if [ "$issues" -eq 0 ]; then
  echo "OK: Alles synchron -> SW-Bump ist sicher."
  echo "    Danach: sw.js (pk-app-v..) hochzaehlen, deploy-version.txt-Marker neu"
  echo "    setzen, committen, 'git push origin main' (Deploy laeuft automatisch)."
  exit 0
else
  echo "STOP: $issues Punkt(e) klaeren, BEVOR du den SW hochzaehlst (siehe '!!' oben)."
  exit 1
fi
