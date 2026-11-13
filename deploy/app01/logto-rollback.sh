#!/usr/bin/env bash
# Rollback: Logto zurück auf Legacy (Bauplan §6.6). Dry-Run by default.
#
#   ./logto-rollback.sh           # zeigt, was passieren würde
#   ./logto-rollback.sh --apply   # Alias-Swap zurück + Env-Backup + Restart
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${POSTBOTE_APP01_ENV:-$SCRIPT_DIR/app01.env}"
DO_APPLY=0
[[ "${1:-}" == "--apply" ]] && DO_APPLY=1

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

LOGTO_ENV="${LOGTO_ENV_FILE:-/opt/logto/.env}"
RESTART_CMD="${LOGTO_RESTART_CMD:-docker restart logto}"

echo "logto-rollback — apply=$DO_APPLY"
echo "  env file   : $LOGTO_ENV"
echo "  restart    : $RESTART_CMD"
echo "  cutover    : $SCRIPT_DIR/cutover.sh --rollback --apply"

if [[ "$DO_APPLY" -eq 0 ]]; then
  echo "DRY RUN — nichts geändert. Mit --apply ausführen."
  exit 0
fi

backup="$(ls -1t "$LOGTO_ENV".postbote-backup.* 2>/dev/null | head -1 || true)"
if [[ -n "$backup" ]]; then
  cp "$backup" "$LOGTO_ENV"
  echo "Env wiederhergestellt aus $backup"
else
  echo "WARN: kein Env-Backup gefunden — POSTMARK_API_URL bleibt unverändert." >&2
fi

bash "$SCRIPT_DIR/cutover.sh" --rollback --apply --env-file "$ENV_FILE"
bash -c "$RESTART_CMD"
echo "Rollback abgeschlossen."
