import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/api/app.js'
import { MemoryMessageStore } from '../src/core/memory-store.js'

const TOKEN = 'logto-connector-token'

async function setup(withLogto = true) {
  const store = new MemoryMessageStore()
  const server = await store.createServer('Logto', 'logto')
  await store.addToken(server.id, TOKEN, 'logto-devolta', {
    allowedFrom: ['*@devolta.de'],
    ...(withLogto && {
      logtoConfig: {
        from: 'devolta UG <office@devolta.de>',
        templates: {
          SignIn: 'logto-sign-in',
          ForgotPassword: 'logto-forgot-password',
        },
      },
    }),
  })
  await store.upsertTemplate(server.id, {
    alias: 'logto-sign-in',
    name: 'Sign In',
    subject: 'Anmeldung {{code}}',
    htmlBody: '<p>Hallo {{name}}, Code {{code}}</p>',
    textBody: 'Hallo {{name}}, Code {{code}}',
  })
  const app = await buildApp({ store, version: 'test' })
  return { app, store, serverId: server.id }
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  to: 'user@example.com',
  type: 'SignIn',
  payload: { name: 'Max', code: '123456' },
  ...overrides,
})

describe('POST /logto (app01 Logto-HTTP-Email-Connector)', () => {
  it('Bearer-Token → Template-Render + Queue, Tag/From korrekt', async () => {
    const { app, store } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/logto',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: payload(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ErrorCode).toBe(0)
    const message = await store.getMessage(res.json().MessageID)
    expect(message?.from).toBe('devolta UG <office@devolta.de>')
    expect(message?.to).toEqual(['user@example.com'])
    expect(message?.subject).toBe('Anmeldung 123456')
    expect(message?.htmlBody).toContain('Code 123456')
    expect(message?.tag).toBe('logto-SignIn')
    expect(store.events.some((e) => e.type === 'accepted')).toBe(true)
    await app.close()
  })

  it('X-Postmark-Server-Token funktioniert ebenfalls', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/logto',
      headers: { 'x-postmark-server-token': TOKEN, 'content-type': 'application/json' },
      payload: payload(),
    })
    expect(res.json().ErrorCode).toBe(0)
    await app.close()
  })

  it('unbekannter type → 1101, fehlende Config → 403, kein Token → 401', async () => {
    const { app } = await setup()
    const unknown = await app.inject({
      method: 'POST',
      url: '/logto',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: payload({ type: 'DoesNotExist' }),
    })
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json().ErrorCode).toBe(1101)

    const noAuth = await app.inject({
      method: 'POST',
      url: '/logto',
      headers: { 'content-type': 'application/json' },
      payload: payload(),
    })
    expect(noAuth.statusCode).toBe(401)

    const plain = await setup(false)
    const noConfig = await plain.app.inject({
      method: 'POST',
      url: '/logto',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: payload(),
    })
    expect(noConfig.statusCode).toBe(403)
    expect(noConfig.json().ErrorCode).toBe(10)
    await app.close()
    await plain.app.close()
  })

  it('allowedFrom und Suppression gelten auch für /logto', async () => {
    const { app, store, serverId } = await setup()
    await store.addSuppression(serverId, 'outbound', {
      email: 'blocked@example.com',
      reason: 'HardBounce',
    })
    const suppressed = await app.inject({
      method: 'POST',
      url: '/logto',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: payload({ to: 'blocked@example.com' }),
    })
    expect(suppressed.json().ErrorCode).toBe(406)

    // Token ohne allowedFrom → anderer Absender erlaubt
    const plain = await setup(false)
    await plain.store.addToken(plain.serverId, 'plain-token', 'plain')
    const ok = await plain.app.inject({
      method: 'POST',
      url: '/logto',
      headers: { authorization: 'Bearer plain-token', 'content-type': 'application/json' },
      payload: payload(),
    })
    expect(ok.statusCode).toBe(403) // kein logtoConfig → 403, aber kein 1480
    await app.close()
    await plain.app.close()
  })
})
