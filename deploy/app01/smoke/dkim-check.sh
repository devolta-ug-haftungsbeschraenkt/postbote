#!/usr/bin/env bash
# DKIM-Check je Domain (Bauplan §6.4, inkl. aar strikte Ausrichtung).
#
#   DKIM_SELECTOR=default ./dkim-check.sh deploy/app01/smoke/domains.example.txt
#
# Prüft, ob der DKIM-TXT-Record existiert. Die tatsächliche Signatur/Alignment
# muss zusätzlich an einer empfangenen Testmail geprüft werden (z. B. mit
# opendkim-testmsg oder dem Authentication-Results-Header).
set -euo pipefail

DOMAINS_FILE="${1:-${DKIM_DOMAINS_FILE:-deploy/app01/smoke/domains.example.txt}}"
SELECTOR="${DKIM_SELECTOR:-default}"

if [[ ! -f "$DOMAINS_FILE" ]]; then
  echo "FEHLER: $DOMAINS_FILE nicht gefunden." >&2
  exit 1
fi

echo "dkim-check — selector=$SELECTOR, datei=$DOMAINS_FILE"
failed=0
while IFS= read -r line || [[ -n "$line" ]]; do
  domain="$(printf '%s' "$line" | tr -d '[:space:]')"
  [[ -z "$domain" || "$domain" == \#* ]] && continue
  record="$(dig +short TXT "${SELECTOR}._domainkey.${domain}" 2>/dev/null || true)"
  if [[ -n "$record" ]]; then
    echo "  ✓ $domain → ${record:0:100}"
  else
    echo "  ✗ $domain → kein TXT-Record für ${SELECTOR}._domainkey.$domain"
    failed=$((failed + 1))
  fi
done < "$DOMAINS_FILE"

echo
echo "Hinweis: Bei aar gilt STRIKTE DMARC-Ausrichtung — Header-From, Envelope-From"
echo "und DKIM-d= müssen exakt dieselbe Domain sein (postbote setzt den Envelope"
echo "immer auf From). Authentication-Results einer echten Testmail prüfen."
if [[ "$failed" -gt 0 ]]; then
  echo "$failed Domain(s) ohne DKIM-Record."
  exit 1
fi
echo "DKIM-Records OK (Signatur/Alignment manuell verifizieren)."
