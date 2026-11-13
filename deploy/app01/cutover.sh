#!/usr/bin/env bash
# postbote app01 Cut-Over (Bauplan §6 / M7)
#
# Clients sprechen den Service-Namen `postbote` auf den gemeinsamen Docker-
# Netzen. Der Cut-Over verschiebt diesen Netz-Alias vom Legacy-Container auf
# den v2-API-Container; Legacy behält `postbote-legacy` als Rollback.
#
#   ./cutover.sh                    # DRY RUN: zeigt exakt die Kommandos
#   ./cutover.sh --verify           # zeigt aktuelle Aliase je Netz
#   ./cutover.sh --apply            # führt den Cut-Over aus
#   ./cutover.sh --rollback --apply # führt den Rollback aus
#
# Sicherheit: ohne --apply wird nie etwas verändert. Alle Netz-/
# Containernamen kommen aus app01.env (keine hartcodierten Produktionswerte).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${POSTBOTE_APP01_ENV:-$SCRIPT_DIR/app01.env}"
STATE_FILE="$SCRIPT_DIR/.cutover-state"
MODE="cutover"
DO_APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) DO_APPLY=1; shift ;;
    --rollback) MODE="rollback"; shift ;;
    --verify) MODE="verify"; shift ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
elif [[ "$MODE" != "verify" ]]; then
  echo "WARN: $ENV_FILE fehlt — es gelten die Umgebungsvariablen/Defaults." >&2
fi

V2="${POSTBOTE_V2_CONTAINER:-postbote-v2-api-1}"
LEGACY="${POSTBOTE_LEGACY_CONTAINER:-postbote}"
ACTIVE_ALIAS="${POSTBOTE_ACTIVE_ALIAS:-postbote}"
V2_ALIAS="${POSTBOTE_V2_ALIAS:-postbote-v2}"
LEGACY_ALIAS="${POSTBOTE_LEGACY_ALIAS:-postbote-legacy}"
NETWORKS_CSV="${POSTBOTE_CLIENT_NETWORKS:-coolify}"

IFS=',' read -r -a NETWORKS <<< "$NETWORKS_CSV"

run() {
  echo "  $*"
  if [[ "$DO_APPLY" -eq 1 ]]; then "$@"; fi
}

container_running() {
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true
}

show_aliases() {
  docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.Aliases}} {{end}}' "$1" 2>/dev/null || echo "(nicht verbunden)"
}

echo "postbote cutover — mode=$MODE apply=$DO_APPLY"
echo "  v2 container     : $V2"
echo "  legacy container : $LEGACY"
echo "  netze            : ${NETWORKS[*]}"
echo "  aliases          : active=$ACTIVE_ALIAS v2=$V2_ALIAS legacy=$LEGACY_ALIAS"
echo

if [[ "$MODE" == "verify" ]]; then
  echo "Aktuelle Netz-Aliase:"
  echo "  $V2     : $(show_aliases "$V2")"
  echo "  $LEGACY : $(show_aliases "$LEGACY")"
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "FEHLER: kein Cut-Over-State ($STATE_FILE) — Rollback nicht möglich." >&2
    exit 1
  fi
  echo "Rollback gemäss $STATE_FILE:"
  sed 's/^/  /' "$STATE_FILE"
  echo "Kommandos:"
  for net in "${NETWORKS[@]}"; do
    run docker network disconnect -f "$net" "$V2"
    run docker network connect --alias "$V2_ALIAS" "$net" "$V2"
    run docker network disconnect -f "$net" "$LEGACY"
    run docker network connect --alias "$ACTIVE_ALIAS" "$net" "$LEGACY"
  done
  if [[ "$DO_APPLY" -eq 1 ]]; then
    mv "$STATE_FILE" "$STATE_FILE.rolled-back.$(date +%Y%m%d-%H%M%S)"
    echo "Rollback ausgeführt."
  else
    echo "DRY RUN — nichts geändert."
  fi
  exit 0
fi

# --- Cut-Over ---------------------------------------------------------------
if [[ -f "$STATE_FILE" ]]; then
  echo "FEHLER: $STATE_FILE existiert bereits — erst rollback oder State prüfen." >&2
  exit 1
fi

if [[ "$DO_APPLY" -eq 1 ]]; then
  for container in "$V2" "$LEGACY"; do
    if ! container_running "$container"; then
      echo "FEHLER: Container '$container' läuft nicht." >&2
      exit 1
    fi
  done
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$V2")"
  if [[ "$health" != "healthy" && "$health" != "none" ]]; then
    echo "FEHLER: v2-Container ist nicht healthy ($health)." >&2
    exit 1
  fi
fi

echo "Kommandos (Reihenfolge: Legacy-Alias zuerst weg, dann v2 übernimmt):"
for net in "${NETWORKS[@]}"; do
  run docker network disconnect -f "$net" "$LEGACY"
  run docker network connect --alias "$LEGACY_ALIAS" "$net" "$LEGACY"
  run docker network disconnect -f "$net" "$V2"
  run docker network connect --alias "$ACTIVE_ALIAS" "$net" "$V2"
done

if [[ "$DO_APPLY" -eq 1 ]]; then
  {
    echo "mode=cutover"
    echo "applied_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "v2_container=$V2"
    echo "legacy_container=$LEGACY"
    echo "networks=$NETWORKS_CSV"
    echo "active_alias=$ACTIVE_ALIAS"
    echo "v2_alias=$V2_ALIAS"
    echo "legacy_alias=$LEGACY_ALIAS"
  } > "$STATE_FILE"
  echo "Cut-Over ausgeführt. State: $STATE_FILE"
  echo "NÄCHSTER SCHRITT: Smoke-Tests (deploy/app01/smoke/) und 2 Wochen beobachten."
else
  echo
  echo "DRY RUN — nichts geändert. Mit --apply ausführen."
fi
