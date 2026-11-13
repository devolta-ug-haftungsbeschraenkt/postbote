import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/api/app.js'
import { MemoryMessageStore } from '../src/core/memory-store.js'
import { hashToken } from '../src/core/store.js'

async function setup() {
  const store = new MemoryMessageStore()
  const server = await store.createServer('Devolta', 'devolta')
  await store.addToken(server.id, 'test-token-123', 'primary')
  const app = await buildApp({ store, version: 'test' })
  return { app, store, serverId: server.id }
}

const TOKEN_HEADER = { 'x-postmark-server-token': 'test-token-123' }

describe('POST /email (Postmark-Parität)', () => {
  it('accepts a valid message and returns MessageID + ErrorCode 0', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email',
      headers: TOKEN_HEADER,
      payload: {
        From: 'sender@devolta.de',
        To: 'receiver@example.com',
        Subject: 'Password Reset',
        TextBody: 'Your code is 123456',
        Tag: 'welcome',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ErrorCode).toBe(0)
    expect(body.Message).toBe('OK')
    expect(body.MessageID).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.To).toBe('receiver@example.com')
  })

  it('returns 401 with ErrorCode 10 when the token is missing', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email',
      payload: { From: 'a@b.de', To: 'c@d.de', TextBody: 'hi' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({
      ErrorCode: 10,
      Message: 'Requires a valid server token.',
    })
  })

  it('returns 401 with ErrorCode 10 for an unknown token', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email',
      headers: { 'x-postmark-server-token': 'wrong' },
      payload: { From: 'a@b.de', To: 'c@d.de', TextBody: 'hi' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().ErrorCode).toBe(10)
  })

  it('rejects missing body with ErrorCode 300', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email',
      headers: TOKEN_HEADER,
      payload: { From: 'a@b.de', To: 'c@d.de' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().ErrorCode).toBe(300)
  })

  it('rejects an invalid From with ErrorCode 300', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email',
      headers: TOKEN_HEADER,
      payload: { From: 'nope', To: 'c@d.de', TextBody: 'hi' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().ErrorCode).toBe(300)
    expect(res.json().Message).toContain('From')
  })
})

describe('Sandbox (POSTMARK_API_TEST)', () => {
  it('validates without a real token and without persisting', async () => {
    const { app, store } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email',
      headers: { 'x-postmark-server-token': 'POSTMARK_API_TEST' },
      payload: {
        From: 'sender@devolta.de',
        To: 'receiver@example.com',
        Subject: 'Test',
        HtmlBody: '<b>Test</b>',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ErrorCode).toBe(0)
    expect(store.messages).toHaveLength(0)
  })

  it('validates in sandbox mode too (missing body → 422)', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email',
      headers: { 'x-postmark-server-token': 'POSTMARK_API_TEST' },
      payload: { From: 'a@b.de', To: 'c@d.de' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().ErrorCode).toBe(300)
  })
})

describe('POST /email/batch (HTTP 200 + pro-Item-Errors)', () => {
  it('returns per-item ErrorCode, HTTP stays 200', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email/batch',
      headers: TOKEN_HEADER,
      payload: [
        { From: 'a@b.de', To: 'c@d.de', TextBody: 'ok' },
        { From: 'a@b.de', To: 'c@d.de' }, // invalid: no body
      ],
    })
    expect(res.statusCode).toBe(200)
    const results = res.json()
    expect(Array.isArray(results)).toBe(true)
    expect(results[0].ErrorCode).toBe(0)
    expect(results[0].MessageID).toMatch(/^[0-9a-f-]{36}$/)
    expect(results[1].ErrorCode).toBe(300)
    expect(results[1].MessageID).toBeUndefined()
  })

  it('rejects more than 500 messages with ErrorCode 410', async () => {
    const { app } = await setup()
    const batch = Array.from({ length: 501 }, () => ({
      From: 'a@b.de',
      To: 'c@d.de',
      TextBody: 'x',
    }))
    const res = await app.inject({
      method: 'POST',
      url: '/email/batch',
      headers: TOKEN_HEADER,
      payload: batch,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().ErrorCode).toBe(410)
  })
})

describe('Token-Handling', () => {
  it('stores tokens hashed, never in plaintext', async () => {
    const { store } = await setup()
    expect([...store.tokens.keys()]).toEqual([hashToken('test-token-123')])
  })
})
