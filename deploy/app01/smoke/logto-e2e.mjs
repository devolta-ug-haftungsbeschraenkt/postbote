#!/usr/bin/env node
/**
 * Logto-E2E-Probe (Bauplan §6.4): löst den Forgot-Password-Flow aus und prüft,
 * dass postbote eine Nachricht an den konfigurierten Empfänger akzeptiert hat.
 * Die Prüfung des tatsächlichen Postfachs bleibt manuell (Checkliste im Runbook).
 *
 *   LOGTO_FORGOT_PASSWORD_URL=https://logto.example.com/api/forgot-password \
 *   LOGTO_E2E_RECIPIENT=smoke-logto@example.com \
 *   node deploy/app01/smoke/logto-e2e.mjs
 */
const URL = process.env.LOGTO_FORGOT_PASSWORD_URL ?? ''
const RECIPIENT = process.env.LOGTO_E2E_RECIPIENT ?? ''
const API_BASE = (process.env.POSTBOTE_API_BASE ?? 'http://localhost:3001').replace(/\/+$/, '')
const TOKEN = process.env.POSTBOTE_ADMIN_TOKEN ?? ''
const PAYLOAD = process.env.LOGTO_E2E_PAYLOAD ?? JSON.stringify({ email: RECIPIENT })

if (!URL || !RECIPIENT) {
  console.log('logto-e2e: LOGTO_FORGOT_PASSWORD_URL und LOGTO_E2E_RECIPIENT fehlen.')
  console.log('Nur manuelle Prüfung möglich — siehe deploy/app01/README.md.')
  process.exit(0)
}

const response = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: PAYLOAD,
  signal: AbortSignal.timeout(10000),
})
console.log(`Forgot-Password-Request → HTTP ${response.status}`)
if (!response.ok) {
  console.log('FEHLER: Logto-Endpoint nicht erreichbar/erfolgreich.')
  process.exit(1)
}

const list = await fetch(`${API_BASE}/messages/outbound?count=100`, {
  headers: TOKEN ? { 'X-Postmark-Server-Token': TOKEN } : {},
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json())

const found = list.Messages?.find((m) => m.To?.includes(RECIPIENT))
if (found) {
  console.log(`✓ Nachricht an ${RECIPIENT}: ${found.MessageID} [${found.Status}]`)
  console.log('MANUELL: Postfach öffnen, Mail vorhanden? Link funktioniert?')
} else {
  console.log(`✗ Keine Nachricht an ${RECIPIENT} in postbote gefunden.`)
  process.exit(1)
}
