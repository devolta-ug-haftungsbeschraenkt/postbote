import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/api/app.js'
import { RateLimiter, checkPreflight, checkSenderAllowed, payloadSize } from '../src/api/policy.js'
import { MemoryMessageStore } from '../src/core/memory-store.js'
import { decryptSecret, encryptSecret, isEncrypted } from '../src/core/secret.js'
import { hashToken } from '../src/core/store.js'

const TOKEN = 'harden-token'

async function setup() {
  const store = new MemoryMessageStore()
  const server = await store.createServer('Harden', 'harden')
  await store.addToken(server.id, TOKEN, 'primary')
  const app = await buildApp({ store, version: 'test' })
  return { app, store, serverId: server.id }
}

const email = (overrides: Record<string, unknown> = {}) => ({
  From: 'sender@example.com',
  To: 'recipient@example.com',
  Subject: 'x',
  TextBody: 'x',
  ...overrides,
})

describe('Secrets at rest (AES-256-GCM)', () => {
  it('Roundtrip, Prefix und Manipulationsschutz', () => {
    const stored = encryptSecret('super-secret', 'test-key')
    expect(isEncrypted(stored)).toBe(true)
    expect(stored).not.toContain('super-secret')
    expect(decryptSecret(stored, 'test-key')).toBe('super-secret')

    const tampered = `${stored.slice(0, -3)}AAA`
    expect(() => decryptSecret(tampered, 'test-key')).toThrow()
    expect(() => decryptSecret(stored, 'wrong-key')).toThrow()
    expect(() => decryptSecret(stored, '')).toThrow(/POSTBOTE_SECRET_KEY/)
  })

  it('Klartext-Fallback und Legacy-Modus ohne Key', () => {
    expect(encryptSecret('plain', '')).toBe('plain')
    expect(decryptSecret('plain', 'any-key')).toBe('plain')
  })
})

describe('Policy-Helfer', () => {
  it('allowedFrom: exakt, Wildcard, leer, Ablehnung 1480', () => {
    const token = { serverId: 's', tokenHash: 'h', name: 'n', sandbox: false }
    expect(checkSenderAllowed(token, 'a@b.de')).toBeNull()
    expect(checkSenderAllowed({ ...token, allowedFrom: ['a@b.de'] }, 'A@B.DE')).toBeNull()
    expect(
      checkSenderAllowed({ ...token, allowedFrom: ['*@devolta.de'] }, 'Max <max@devolta.de>'),
    ).toBeNull()
    const denied = checkSenderAllowed({ ...token, allowedFrom: ['*@devolta.de'] }, 'x@example.com')
    expect(denied?.ErrorCode).toBe(1480)
  })

  it('RateLimiter: Limit, Retry-After, Deaktivierung', () => {
    const limiter = new RateLimiter(2)
    expect(limiter.check('t').allowed).toBe(true)
    expect(limiter.check('t').allowed).toBe(true)
    const blocked = limiter.check('t')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBeGreaterThan(0)
    expect(limiter.check('other').allowed).toBe(true)
    expect(new RateLimiter(0).check('t').allowed).toBe(true)
    expect(
      checkPreflight({}, { serverId: 's', tokenHash: 't', name: 'n', sandbox: false }, limiter)
        ?.statusCode,
    ).toBe(429)
  })

  it('10-MB-Limit: Überschreitung wird abgewiesen, Skip für Batch', () => {
    const huge = { TextBody: 'x'.repeat(10 * 1024 * 1024 + 1) }
    expect(payloadSize(huge)).toBeGreaterThan(10 * 1024 * 1024)
    const limiter = new RateLimiter(0)
    const rejection = checkPreflight(huge, null, limiter)
    expect(rejection?.statusCode).toBe(422)
    expect(rejection?.body.ErrorCode).toBe(300)
    expect(checkPreflight(huge, null, limiter, { skipPayloadLimit: true })).toBeNull()
  })
})

describe('API-Härtung', () => {
  it('HTTP 429 pro Token mit Retry-After', async () => {
    vi.stubEnv('POSTBOTE_RATE_LIMIT_PER_MIN', '2')
    try {
      const { app } = await setup()
      const headers = { 'x-postmark-server-token': TOKEN, 'content-type': 'application/json' }
      const first = await app.inject({ method: 'POST', url: '/email', headers, payload: email() })
      const second = await app.inject({ method: 'POST', url: '/email', headers, payload: email() })
      const third = await app.inject({ method: 'POST', url: '/email', headers, payload: email() })
      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(third.statusCode).toBe(429)
      expect(third.json().ErrorCode).toBe(429)
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0)
      await app.close()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('allowedFrom → ErrorCode 1480', async () => {
    const { app, store } = await setup()
    const record = store.tokens.get(hashToken(TOKEN))
    if (record) record.allowedFrom = ['*@devolta.de']
    const headers = { 'x-postmark-server-token': TOKEN, 'content-type': 'application/json' }

    const denied = await app.inject({ method: 'POST', url: '/email', headers, payload: email() })
    expect(denied.statusCode).toBe(422)
    expect(denied.json().ErrorCode).toBe(1480)

    const allowed = await app.inject({
      method: 'POST',
      url: '/email',
      headers,
      payload: email({ From: 'Max <max@devolta.de>' }),
    })
    expect(allowed.json().ErrorCode).toBe(0)
    await app.close()
  })

  it('10-MB-Einzelmail → 422/300, Batch pro-Item', async () => {
    const { app } = await setup()
    const headers = { 'x-postmark-server-token': TOKEN, 'content-type': 'application/json' }
    const huge = 'x'.repeat(10 * 1024 * 1024 + 1)

    const single = await app.inject({
      method: 'POST',
      url: '/email',
      headers,
      payload: email({ TextBody: huge }),
    })
    expect(single.statusCode).toBe(422)
    expect(single.json().ErrorCode).toBe(300)

    const batch = await app.inject({
      method: 'POST',
      url: '/email/batch',
      headers,
      payload: [email(), email({ TextBody: huge })],
    })
    expect(batch.statusCode).toBe(200)
    expect(batch.json()[0].ErrorCode).toBe(0)
    expect(batch.json()[1].ErrorCode).toBe(300)
    await app.close()
  })
})
