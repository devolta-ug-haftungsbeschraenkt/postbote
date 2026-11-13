#!/usr/bin/env bash
# Logto auf postbote umstellen (Bauplan §6.6). Dry-Run by default.
#
#   ./logto-switch.sh             # zeigt, was passieren würde
#   ./logto-switch.sh --apply     # setzt POSTMARK_API_URL, Cut-Over, Restart
#
# Voraussetzung: app01.env (LOGTO_ENV_FILE, LOGTO_RESTART_CMD, …).
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
NEW_URL="${POSTMARK_API_URL_NEW:-http://postbote:3000/email}"

echo "logto-switch — apply=$DO_APPLY"
echo "  env file   : $LOGTO_ENV"
echo "  neue URL   : $NEW_URL"
echo "  restart    : $RESTART_CMD"
echo "  cutover    : $SCRIPT_DIR/cutover.sh --apply"

if [[ "$DO_APPLY" -eq 0 ]]; then
  echo "DRY RUN — nichts geändert. Mit --apply ausführen."
  exit 0
fi

if [[ ! -f "$LOGTO_ENV" ]]; then
  echo "FEHLER: $LOGTO_ENV nicht gefunden." >&2
  exit 1
fi

cp "$LOGTO_ENV" "$LOGTO_ENV.postbote-backup.$(date +%Y%m%d-%H%M%S)"
if grep -q '^POSTMARK_API_URL=' "$LOGTO_ENV"; then
  sed -i.bak "s|^POSTMARK_API_URL=.*|POSTMARK_API_URL=$NEW_URL|" "$LOGTO_ENV"
  rm -f "$LOGTO_ENV.bak"
else
  printf '\nPOSTMARK_API_URL=%s\n' "$NEW_URL" >> "$LOGTO_ENV"
fi

bash "$SCRIPT_DIR/cutover.sh" --apply --env-file "$ENV_FILE"
echo "Logto-Neustart: $RESTART_CMD"
bash -c "$RESTART_CMD"
echo "Fertig. Smoke-Tests ausführen: deploy/app01/smoke/"
