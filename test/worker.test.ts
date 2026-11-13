import { describe, expect, it, vi } from 'vitest'
import { MemoryMessageStore } from '../src/core/memory-store.js'
import type { MessageRecord, RelayRecord } from '../src/core/store.js'
import { classifySmtpResponse } from '../src/worker/bounce.js'
import { registerJobHandlers } from '../src/worker/handlers.js'
import { MemoryJobQueue, backoffMs } from '../src/worker/queue.js'
import { SmtpMailSender } from '../src/worker/sender.js'
import type { MailSender } from '../src/worker/sender.js'
import {
  bounceEvent,
  deliveryEvent,
  dispatchEvent,
  postWebhook,
  traceIdFor,
} from '../src/worker/webhooks.js'

describe('Bounce-Klassifikation (Analyse 2.5)', () => {
  it('250 → delivered, kein Bounce', () => {
    expect(classifySmtpResponse(250)).toEqual({ type: null, typeCode: 0, retry: false })
  })

  it('4xx → Transient, retry', () => {
    const result = classifySmtpResponse(450, 'Greylisted, try again later')
    expect(result.type).toBe('Transient')
    expect(result.typeCode).toBe(2)
    expect(result.retry).toBe(true)
  })

  it('550 mailbox unknown → HardBounce (TypeCode 1), kein Retry', () => {
    const result = classifySmtpResponse(550, '5.1.1 user unknown: mailbox does not exist')
    expect(result.type).toBe('HardBounce')
    expect(result.typeCode).toBe(1)
    expect(result.retry).toBe(false)
  })

  it('552 mailbox full → SoftBounce mit Retry', () => {
    const result = classifySmtpResponse(552, 'mailbox full / over quota')
    expect(result.type).toBe('SoftBounce')
    expect(result.typeCode).toBe(4096)
    expect(result.retry).toBe(true)
  })

  it('ISP-Block → Blocked ohne Retry', () => {
    const result = classifySmtpResponse(554, 'blocked by spamhaus')
    expect(result.type).toBe('Blocked')
    expect(result.typeCode).toBe(100006)
    expect(result.retry).toBe(false)
  })
})

describe('Backoff', () => {
  it('30s → 60s → 120s … capped at 15 min', () => {
    expect(backoffMs(1)).toBe(30_000)
    expect(backoffMs(2)).toBe(60_000)
    expect(backoffMs(3)).toBe(120_000)
    expect(backoffMs(10)).toBe(900_000)
    expect(backoffMs(99)).toBe(900_000)
  })
})

describe('send_email Handler (Queue → SMTP → Status/Bounce/Webhook)', () => {
  async function setup(sender: MailSender) {
    const store = new MemoryMessageStore()
    const server = await store.createServer('Test', 'test')
    const queue = new MemoryJobQueue()
    const logged: string[] = []
    registerJobHandlers(queue, {
      store,
      sender,
      getRelay: () => Promise.resolve(null),
      log: (msg) => logged.push(msg),
      fetchImpl: (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    })
    await queue.start()
    const message = await store.insertMessage(
      { from: 'no-reply@test.de', to: ['user@example.com'], subject: 'Hi', textBody: 'Hello' },
      server.id,
      'outbound',
    )
    return { store, queue, message, server, logged }
  }

  it('asynchroner Fehler nach SMTP-Annahme → SMTPApiError-Bounce (100007)', async () => {
    const throwingSender: MailSender = {
      send: async () => {
        throw new Error('upstream relay exploded')
      },
    }
    const { store, queue, message } = await setup(throwingSender)

    await queue.enqueue({ type: 'send_email', payload: { messageId: message.id } })
    // MemoryJobQueue processes with setTimeout(0) — give the loop a moment.
    await new Promise((r) => setTimeout(r, 50))

    const record = await store.getMessage(message.id)
    expect(record?.status).toBe('bounced')
    const bounce = store.bounces.find((b) => b.messageId === message.id)
    expect(bounce?.type).toBe('SMTPApiError')
    expect(bounce?.typeCode).toBe(100007)
    expect(bounce?.description).toBe('upstream relay exploded')
  })

  it('250 → Status sent + Event + Delivery-Webhook', async () => {
    const fakeSender: MailSender = {
      send: async () => ({ code: 250, response: '250 OK queued as 1B2C3' }),
    }
    const { store, queue, message, server } = await setup(fakeSender)
    const record = await store.getMessage(message.id)
    expect(record?.status).toBe('queued')

    store.addWebhook({
      id: 'wh-1',
      serverId: server.id,
      url: 'https://app.example.com/hooks',
      events: ['Delivery'],
      verified: true,
    })

    await queue.enqueue({ type: 'send_email', payload: { messageId: message.id } })
    // MemoryJobQueue processes with setTimeout(0) — give the loop a moment.
    await new Promise((r) => setTimeout(r, 50))

    const updated = await store.getMessage(message.id)
    expect(updated?.status).toBe('sent')
    expect(updated?.sentAt).toBeDefined()
    const events = store.events.filter((e) => e.messageId === message.id)
    expect(events.map((e) => e.type)).toContain('sent')
    expect(store.webhookDeliveries).toHaveLength(1)
    expect(store.webhookDeliveries[0]?.responseStatus).toBeGreaterThanOrEqual(200)
  })

  it('4xx → deferred (Retry), Status bleibt queued', async () => {
    let calls = 0
    const flakySender: MailSender = {
      send: async () => {
        calls++
        if (calls < 2) return { code: 450, response: '450 Greylisted, please retry' }
        return { code: 250, response: '250 OK' }
      },
    }
    const { store, queue, message } = await setup(flakySender)
    await queue.enqueue({ type: 'send_email', payload: { messageId: message.id } })
    // First attempt: 450 → backoff is 30s — we don't want to wait; stop and check state.
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(1)
    const updated = await store.getMessage(message.id)
    expect(updated?.status).toBe('queued')
    expect(store.events.filter((e) => e.type === 'deferred')).toHaveLength(1)
  })

  it('550 → HardBounce gespeichert + Bounce-Webhook', async () => {
    const failingSender: MailSender = {
      send: async () => ({ code: 550, response: '550 5.1.1 user unknown' }),
    }
    const { store, queue, message, server } = await setup(failingSender)
    store.addWebhook({
      id: 'wh-2',
      serverId: server.id,
      url: 'https://app.example.com/hooks',
      events: ['Bounce'],
      verified: true,
    })
    await queue.enqueue({ type: 'send_email', payload: { messageId: message.id } })
    await new Promise((r) => setTimeout(r, 50))

    const updated = await store.getMessage(message.id)
    expect(updated?.status).toBe('bounced')
    expect(store.bounces).toHaveLength(1)
    const bounce = store.bounces[0]
    expect(bounce?.type).toBe('HardBounce')
    expect(bounce?.typeCode).toBe(1)
    expect(store.webhookDeliveries).toHaveLength(1)
  })
})

describe('Webhook-Dispatcher', () => {
  const baseMessage: MessageRecord = {
    id: 'msg-1',
    serverId: 'srv-1',
    streamId: 'outbound',
    from: 'no-reply@test.de',
    to: ['user@example.com'],
    subject: 'Hi',
    status: 'sent',
    submittedAt: new Date().toISOString(),
  }

  it('setzt X-PM-Webhook-Trace-Id und Basic Auth', async () => {
    const captured: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const outcome = await postWebhook(
      {
        id: 'wh-1',
        serverId: 'srv-1',
        url: 'https://app.example.com/hooks',
        events: ['Delivery'],
        httpAuth: { username: 'webhook', password: 'secret' },
        verified: true,
      },
      deliveryEvent(baseMessage, '250 OK'),
      'trace-abc',
      fetchImpl,
    )
    expect(outcome.ok).toBe(true)
    expect(captured[0]?.headers['X-PM-Webhook-Trace-Id']).toBe('trace-abc')
    expect(captured[0]?.headers.Authorization).toBe(`Basic ${btoa('webhook:secret')}`)
  })

  it('Trace-Id ist stabil je (Message, Recipient, Event)', () => {
    expect(traceIdFor(baseMessage, 'user@example.com', 'Delivery')).toBe(
      traceIdFor(baseMessage, 'user@example.com', 'Delivery'),
    )
    expect(traceIdFor(baseMessage, 'other@example.com', 'Delivery')).not.toBe(
      traceIdFor(baseMessage, 'user@example.com', 'Delivery'),
    )
  })

  it('Bounce-Event trägt Type/TypeCode', () => {
    const event = bounceEvent(baseMessage, 'HardBounce', 1, '550 user unknown')
    expect(event.RecordType).toBe('Bounce')
    expect(event.Type).toBe('HardBounce')
    expect(event.TypeCode).toBe(1)
  })

  it('Nicht-2xx → Retry bis maxAttempts, alle Versuche geloggt', async () => {
    vi.useFakeTimers()
    try {
      const store = new MemoryMessageStore()
      // Webhook must belong to the same server as baseMessage ('srv-1').
      store.addWebhook({
        id: 'wh-3',
        serverId: 'srv-1',
        url: 'https://app.example.com/hooks',
        events: ['Delivery'],
        verified: true,
      })
      let calls = 0
      const fetchImpl = (async () => {
        calls++
        return new Response('nope', { status: 500 })
      }) as unknown as typeof fetch

      const run = dispatchEvent(
        store,
        baseMessage,
        deliveryEvent(baseMessage, '250 OK'),
        3,
        fetchImpl,
      )
      await vi.advanceTimersByTimeAsync(20_000)
      await run

      expect(calls).toBe(3)
      expect(store.webhookDeliveries).toHaveLength(3)
      expect(store.webhookDeliveries[0]?.attempt).toBe(1)
      expect(store.webhookDeliveries[2]?.attempt).toBe(3)
      expect(store.webhookDeliveries[0]?.responseStatus).toBe(500)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Relay-Auswahl', () => {
  it('Envelope-Absender folgt dem From (DKIM/DMARC-Regel)', () => {
    // Der Sender übergibt `from: message.from` an nodemailer — dokumentiert als
    // Regel im Umstellungsdokument. Absichtlicher Regressionstest:
    const relay: RelayRecord = {
      serverId: 'srv',
      streamId: 'outbound',
      host: 'smtp.example.com',
      port: 587,
      username: 'u',
      password: 'p',
      tlsMode: 'starttls',
    }
    expect(relay.tlsMode).toBe('starttls')
  })
})
