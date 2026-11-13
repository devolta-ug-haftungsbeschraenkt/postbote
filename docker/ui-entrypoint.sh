#!/bin/sh
# nginx-entrypoint hook: inject runtime config into the built SPA.
set -eu

API="${POSTBOTE_UI_API:-http://localhost:3000}"
TOKEN="${POSTBOTE_UI_TOKEN:-}"
CONFIG_PATH="${POSTBOTE_UI_CONFIG_PATH:-/usr/share/nginx/html/config.js}"

# Escape backslashes and quotes for safe JS string embedding.
escape_js() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

OIDC_BLOCK=""
if [ -n "${POSTBOTE_UI_OIDC_ISSUER:-}" ] && [ -n "${POSTBOTE_UI_OIDC_CLIENT_ID:-}" ]; then
  SCOPES_CSV="${POSTBOTE_UI_OIDC_SCOPES:-openid,profile,postbote:admin}"
  SCOPES_JSON=""
  OLD_IFS="$IFS"
  IFS=','
  for scope in $SCOPES_CSV; do
    cleaned="$(printf '%s' "$scope" | tr -d '[:space:]')"
    [ -z "$cleaned" ] && continue
    if [ -z "$SCOPES_JSON" ]; then
      SCOPES_JSON="\"$(escape_js "$cleaned")\""
    else
      SCOPES_JSON="$SCOPES_JSON, \"$(escape_js "$cleaned")\""
    fi
  done
  IFS="$OLD_IFS"
  RESOURCE_LINE=""
  if [ -n "${POSTBOTE_UI_OIDC_RESOURCE:-}" ]; then
    RESOURCE_LINE="    resource: \"$(escape_js "$POSTBOTE_UI_OIDC_RESOURCE")\",
"
  fi
  OIDC_BLOCK=",
  oidc: {
    issuer: \"$(escape_js "$POSTBOTE_UI_OIDC_ISSUER")\",
    clientId: \"$(escape_js "$POSTBOTE_UI_OIDC_CLIENT_ID")\",
${RESOURCE_LINE}    scopes: [$SCOPES_JSON]
  }"
fi

cat > "$CONFIG_PATH" <<EOF
window.__POSTBOTE_CONFIG__ = {
  apiBase: "$(escape_js "$API")",
  token: "$(escape_js "$TOKEN")"${OIDC_BLOCK}
};
EOF

if [ -n "$OIDC_BLOCK" ]; then OIDC_STATUS=enabled; else OIDC_STATUS=disabled; fi

echo "postbote UI config: apiBase=$API (token ${TOKEN:+set}${TOKEN:-empty}, oidc $OIDC_STATUS)"
