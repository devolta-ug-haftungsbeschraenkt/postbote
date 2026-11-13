#!/usr/bin/env bash
# Postfix-Kontrolle: status=sent für die Testmails (Bauplan §6.4).
#
#   ./postfix-check.sh smoke-logto@example.com smoke-aar@example.com
#   POSTFIX_LOG_CMD='docker logs postfix --tail 1000' ./postfix-check.sh <recipients...>
set -euo pipefail

LOG_CMD="${POSTFIX_LOG_CMD:-docker logs postfix --tail 500}"
RECIPIENTS=("$@")

echo "postfix-check — log: $LOG_CMD"
if [[ ${#RECIPIENTS[@]} -eq 0 ]]; then
  echo "Keine Empfänger übergeben — zeige die letzten status=sent-Zeilen:"
  bash -c "$LOG_CMD" 2>&1 | grep 'status=sent' | tail -20 || true
  exit 0
fi

log="$(bash -c "$LOG_CMD" 2>&1 || true)"
failed=0
for recipient in "${RECIPIENTS[@]}"; do
  if printf '%s' "$log" | grep -F "$recipient" | grep -q 'status=sent'; then
    echo "  ✓ $recipient → status=sent"
  else
    echo "  ✗ $recipient → kein status=sent gefunden"
    failed=$((failed + 1))
  fi
done

echo
if [[ "$failed" -gt 0 ]]; then
  echo "$failed Empfänger ohne status=sent — Upstream/Relay prüfen."
  exit 1
fi
echo "Postfix-Check OK"
