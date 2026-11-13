#!/usr/bin/env node
/**
 * postbote app01 Smoke-Test (Bauplan §6.4): eine Testmail je Client, danach
 * Verifikation über /messages/outbound und /deliverystats.
 *
 *   node deploy/app01/smoke/smoke-test.mjs
 *
 * Env: POSTBOTE_API_BASE, POSTBOTE_ADMIN_TOKEN, SMOKE_CLIENTS,
 *      SMOKE_TIMEOUT_MS (default 15000)
 * Läuft aus dem Repo-Root (nutzt nodemailer aus node_modules).
 */
import { readFileSync } from 'node:fs'
import nodemailer from 'nodemailer'

const API_BASE = (process.env.POSTBOTE_API_BASE ?? 'http://localhost:3001').replace(/\/+$/, '')
const ADMIN_TOKEN = process.env.POSTBOTE_ADMIN_TOKEN ?? ''
const CLIENTS_FILE = process.env.SMOKE_CLIENTS ?? 'deploy/app01/smoke/clients.example.json'
const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS ?? '15000', 10)

const clients = JSON.parse(readFileSync(CLIENTS_FILE, 'utf8'))
if (!Array.isArray(clients) || clients.length === 0) throw new Error('clients file is empty')

const headers = () => ({
  Accept: 'application/json',
  ...(ADMIN_TOKEN ? { 'X-Postmark-Server-Token': ADMIN_TOKEN } : {}),
})

async function api(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
  return response.json()
}

async function findByTag(tag) {
  const data = await api('/messages/outbound?count=100')
  return data.Messages?.find((m) => m.Tag === tag)
}

async function waitForTag(tag) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const message = await findByTag(tag)
    if (message && message.Status === 'sent') return message
    await new Promise((r) => setTimeout(r, 500))
  }
  const message = await findByTag(tag)
  return message ?? null
}

const before = await api('/deliverystats')
console.log(`postbote smoke test — ${API_BASE} (${clients.length} Clients)`)
console.log(`deliverystats vorher: ${JSON.stringify(before)}\n`)

let failures = 0
for (const client of clients) {
  const tag = `smoke-${client.name}`
  try {
    let submittedId = null
    if (client.via === 'smtp') {
      const smtp = client.smtp ?? {}
      const transport = nodemailer.createTransport({
        host: smtp.host ?? process.env.POSTBOTE_SMTP_HOST ?? '127.0.0.1',
        port: smtp.port ?? Number.parseInt(process.env.POSTBOTE_SMTP_PORT ?? '2525', 10),
        secure: false,
        ignoreTLS: true,
        auth: { user: smtp.user, pass: smtp.pass },
      })
      const info = await transport.sendMail({
        from: client.from,
        to: client.to,
        subject: client.subject ?? `smoke ${client.name}`,
        text: `postbote smoke test for ${client.name}`,
        headers: [{ key: 'X-PM-Tag', value: tag }],
      })
      submittedId = info.messageId
    } else {
      const result = await api('/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': client.token },
        body: JSON.stringify({
          From: client.from,
          To: client.to,
          Subject: client.subject ?? `smoke ${client.name}`,
          TextBody: `postbote smoke test for ${client.name}`,
          Tag: tag,
          MessageStream: client.stream ?? 'outbound',
        }),
      })
      if (result.ErrorCode !== 0) throw new Error(`ErrorCode ${result.ErrorCode}: ${result.Message}`)
      submittedId = result.MessageID
    }

    const message = await waitForTag(tag)
    if (!message) throw new Error('Nachricht nicht in /messages/outbound gefunden')
    if (message.Status !== 'sent') throw new Error(`Status=${message.Status} (erwartet sent)`)
    console.log(`✓ ${client.name.padEnd(20)} ${client.via.padEnd(4)} → ${message.MessageID} [${message.Status}] (submit ${submittedId ?? '-'})`)
  } catch (err) {
    failures++
    console.log(`✗ ${client.name.padEnd(20)} ${client.via.padEnd(4)} → ${err instanceof Error ? err.message : String(err)}`)
  }
}

const after = await api('/deliverystats')
console.log(`\ndeliverystats nachher: ${JSON.stringify(after)}`)
console.log(failures === 0 ? '\nALLE SMOKE-TESTS OK' : `\n${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
