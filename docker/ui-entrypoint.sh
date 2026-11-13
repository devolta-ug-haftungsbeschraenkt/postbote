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

cat > "$CONFIG_PATH" <<EOF
window.__POSTBOTE_CONFIG__ = {
  apiBase: "$(escape_js "$API")",
  token: "$(escape_js "$TOKEN")",
};
EOF

echo "postbote UI config: apiBase=$API (token ${TOKEN:+set}${TOKEN:-empty})"
