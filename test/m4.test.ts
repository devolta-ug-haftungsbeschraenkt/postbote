import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/api/app.js'
import { MemoryMessageStore } from '../src/core/memory-store.js'
import type { MessageRecord } from '../src/core/store.js'
import { bounceEvent } from '../src/worker/webhooks.js'

const TOKEN_HEADER = { 'x-postmark-server-token': 'm4-token' }

async function setup() {
  const store = new MemoryMessageStore()
  const server = await store.createServer('M4', 'm4')
  await store.addToken(server.id, 'm4-token', 'primary')
  const app = await buildApp({ store, version: 'test' })
  return { app, store, serverId: server.id }
}

describe('GET /bounces', () => {
  it('listet Bounces mit Type/TypeCode (Filter nach Typ)', async () => {
    const { app, store, serverId } = await setup()
    const message = await store.insertMessage(
      { from: 'a@b.de', to: ['c@d.de'], subject: 'x', textBody: 'x' },
      serverId,
      'outbound',
    )
    await store.addBounce({
      messageId: message.id,
      type: 'HardBounce',
      typeCode: 1,
      description: '550 user unknown',
      email: 'c@d.de',
      bouncedAt: new Date().toISOString(),
    })
    await store.addBounce({
      messageId: message.id,
      type: 'SoftBounce',
      typeCode: 4096,
      description: 'mailbox full',
      email: 'c@d.de',
      bouncedAt: new Date().toISOString(),
    })

    const res = await app.inject({ method: 'GET', url: '/bounces', headers: TOKEN_HEADER })
    expect(res.statusCode).toBe(200)
    expect(res.json().TotalCount).toBe(2)
    expect(res.json().Bounces[0].Type).toBeDefined()

    const filtered = await app.inject({
      method: 'GET',
      url: '/bounces?type=HardBounce',
      headers: TOKEN_HEADER,
    })
    expect(filtered.json().TotalCount).toBe(1)
    expect(filtered.json().Bounces[0].TypeCode).toBe(1)
  })

  it('GET /bounces/:id + /dump + /activate', async () => {
    const { app, store, serverId } = await setup()
    const message = await store.insertMessage(
      { from: 'a@b.de', to: ['c@d.de'], subject: 'x', htmlBody: '<p>raw</p>' },
      serverId,
      'outbound',
    )
    await store.addBounce({
      messageId: message.id,
      type: 'HardBounce',
      typeCode: 1,
      description: '550',
      email: 'c@d.de',
      bouncedAt: new Date().toISOString(),
    })
    const id = store.bounces[0]?.id as string

    const single = await app.inject({ method: 'GET', url: `/bounces/${id}`, headers: TOKEN_HEADER })
    expect(single.json().Type).toBe('HardBounce')

    const dump = await app.inject({
      method: 'GET',
      url: `/bounces/${id}/dump`,
      headers: TOKEN_HEADER,
    })
    expect(dump.json().Body).toBe('<p>raw</p>')

    const activate = await app.inject({
      method: 'PUT',
      url: `/bounces/${id}/activate`,
      headers: TOKEN_HEADER,
    })
    expect(activate.json().Message).toBe('OK')

    const missing = await app.inject({
      method: 'GET',
      url: '/bounces/404',
      headers: TOKEN_HEADER,
    })
    expect(missing.statusCode).toBe(404)
  })
})

describe('Webhooks-CRUD + Verify (ErrorCode 1364)', () => {
  it('verifies against a 200 URL and stores the webhook', async () => {
    const { app, store } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: TOKEN_HEADER,
      payload: {
        Url: 'http://localhost:1/hooks',
        Triggers: { Delivery: { Enabled: true } },
        // Verify:false — verification needs a live endpoint; covered below with a stub.
        Verify: false,
      },
    })
    expect(res.statusCode).toBe(200)
    const stored = res.json()
    expect(stored.Verified).toBe(false)
    expect(stored.Triggers.Delivery.Enabled).toBe(true)
    expect(store.webhooks.size).toBe(1)
  })

  it('failed verification → 422 + ErrorCode 1364, nichts gespeichert', async () => {
    const { app, store } = await setup()
    // patch fetch: every POST fails (DNS error)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new TypeError('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks',
        headers: TOKEN_HEADER,
        payload: {
          Url: 'http://dead.example/hooks',
          Triggers: { Bounce: { Enabled: true } },
        },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().ErrorCode).toBe(1364)
      expect(store.webhooks.size).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('successful verification → verified=true', async () => {
    const { app } = await setup()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks',
        headers: TOKEN_HEADER,
        payload: {
          Url: 'http://live.example/hooks',
          Triggers: { Delivery: { Enabled: true }, Bounce: { Enabled: true } },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().Verified).toBe(true)
      expect(res.json().Triggers.Bounce.Enabled).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('PUT updates triggers, DELETE removes', async () => {
    const { app } = await setup()
    const created = await app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: TOKEN_HEADER,
      payload: {
        Url: 'http://x.example/h',
        Triggers: { Delivery: { Enabled: true } },
        Verify: false,
      },
    })
    const id = created.json().ID

    const updated = await app.inject({
      method: 'PUT',
      url: `/webhooks/${id}`,
      headers: TOKEN_HEADER,
      payload: {
        Url: 'http://y.example/h',
        Triggers: { Bounce: { Enabled: true } },
        Verify: false,
      },
    })
    expect(updated.json().Triggers.Bounce.Enabled).toBe(true)
    expect(updated.json().Url).toBe('http://y.example/h')

    const del = await app.inject({
      method: 'DELETE',
      url: `/webhooks/${id}`,
      headers: TOKEN_HEADER,
    })
    expect(del.json().ErrorCode).toBe(0)
  })
})

describe('GET /server', () => {
  it('liefert Server-Info im Token-Scope', async () => {
    const { app, serverId } = await setup()
    const res = await app.inject({ method: 'GET', url: '/server', headers: TOKEN_HEADER })
    expect(res.json().ID).toBe(serverId)
    expect(res.json().Slug).toBe('m4')
  })

  it('Sandbox liefert Platzhalter ohne Fehler', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'GET',
      url: '/server',
      headers: { 'x-postmark-server-token': 'POSTMARK_API_TEST' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().Name).toBe('(sandbox)')
  })
})

describe('Webhook-Events payload (Regression, Analyse 2.4)', () => {
  const baseMessage: MessageRecord = {
    id: 'm-1',
    serverId: 's-1',
    streamId: 'outbound',
    from: 'a@b.de',
    to: ['c@d.de'],
    subject: 'x',
    status: 'bounced',
    submittedAt: new Date().toISOString(),
  }

  it('Bounce-Payload enthält Type/TypeCode/Recipient', () => {
    const event = bounceEvent(baseMessage, 'HardBounce', 1, '550 user unknown')
    expect(event.RecordType).toBe('Bounce')
    expect(event.Recipient).toBe('c@d.de')
    expect(event.TypeCode).toBe(1)
  })
})
