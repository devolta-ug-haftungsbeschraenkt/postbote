import { type JsonWebKey, type KeyObject, createSign, generateKeyPairSync } from 'node:crypto'
import { type Server, createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/api/app.js'
import { resetOidcVerifier } from '../src/api/oidc.js'
import { MemoryMessageStore } from '../src/core/memory-store.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const baseJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey

let httpServer: Server
let issuer: string
let serverId: string
let store: MemoryMessageStore
let jwksKeys: JsonWebKey[]

function makeJwk(kid: string): JsonWebKey {
  return { ...baseJwk, kid, alg: 'RS256', use: 'sig' }
}

function signJwt(
  payload: Record<string, unknown>,
  options: { kid?: string; alg?: string; key?: KeyObject } = {},
): string {
  const header = {
    alg: options.alg ?? 'RS256',
    typ: 'JWT',
    ...(options.kid ? { kid: options.kid } : {}),
  }
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  const signature = signer.sign(options.key ?? privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub: 'user-42',
    iss: issuer,
    aud: 'postbote-api',
    iat: now,
    nbf: now,
    exp: now + 3600,
    scope: 'openid profile postbote:admin',
    ...overrides,
  }
}

function configure(overrides: Record<string, string> = {}) {
  vi.stubEnv('POSTBOTE_OIDC_ISSUER', issuer)
  vi.stubEnv('POSTBOTE_OIDC_AUDIENCE', 'postbote-api')
  vi.stubEnv('POSTBOTE_OIDC_SERVER_SLUG', 'oidc-server')
  vi.stubEnv('POSTBOTE_OIDC_JWKS_TTL_MS', '3600000')
  vi.stubEnv('POSTBOTE_AUTH_MODE', 'both')
  vi.stubEnv('POSTBOTE_OIDC_REQUIRED_SCOPE', '')
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value)
  resetOidcVerifier()
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` }
}

beforeAll(async () => {
  jwksKeys = [makeJwk('key-1')]
  httpServer = createHttpServer((req, res) => {
    const url = req.url ?? ''
    if (url.startsWith('/.well-known/openid-configuration')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }))
      return
    }
    if (url.startsWith('/jwks')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ keys: jwksKeys }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = (httpServer.address() as AddressInfo).port
  issuer = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

beforeEach(async () => {
  store = new MemoryMessageStore()
  const server = await store.createServer('OIDC', 'oidc-server')
  serverId = server.id
  await store.addToken(server.id, 'static-token', 'machine')
  jwksKeys = [makeJwk('key-1')]
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetOidcVerifier()
})

describe('OIDC / Logto Auth (docs/OIDC.md)', () => {
  it('gültiges Bearer-Token → 200 mit Server-Scope', async () => {
    configure()
    const app = await buildApp({ store, version: 'test' })
    const res = await app.inject({
      method: 'GET',
      url: '/server',
      headers: bearer(signJwt(validClaims())),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ID).toBe(serverId)
    await app.close()
  })

  it('CORS-Preflight erlaubt den Authorization-Header', async () => {
    configure()
    const app = await buildApp({ store, version: 'test' })
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/server',
      headers: {
        origin: 'https://ui.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    expect(res.statusCode).toBe(204)
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    )
    await app.close()
  })

  it('statischer Token funktioniert im Modus both weiterhin', async () => {
    configure()
    const app = await buildApp({ store, version: 'test' })
    const res = await app.inject({
      method: 'GET',
      url: '/server',
      headers: { 'x-postmark-server-token': 'static-token' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('ohne Auth → 401 / ErrorCode 10', async () => {
    configure()
    const app = await buildApp({ store, version: 'test' })
    const res = await app.inject({ method: 'GET', url: '/server' })
    expect(res.statusCode).toBe(401)
    expect(res.json().ErrorCode).toBe(10)
    await app.close()
  })

  it.each([
    [
      'falsche Signatur',
      () =>
        signJwt(validClaims(), {
          key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
        }),
    ],
    ['abgelaufen', () => signJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }))],
    ['falscher Issuer', () => signJwt(validClaims({ iss: 'https://evil.example.com' }))],
    ['falsche Audience', () => signJwt(validClaims({ aud: 'other-api' }))],
    [
      'nbf in der Zukunft',
      () => signJwt(validClaims({ nbf: Math.floor(Date.now() / 1000) + 600 })),
    ],
    ['alg none', () => signJwt(validClaims(), { alg: 'none' })],
    ['unbekannte kid', () => signJwt(validClaims(), { kid: 'does-not-exist' })],
  ])('%s → 401', async (_label, makeToken) => {
    configure()
    const app = await buildApp({ store, version: 'test' })
    const res = await app.inject({ method: 'GET', url: '/server', headers: bearer(makeToken()) })
    expect(res.statusCode).toBe(401)
    expect(res.json().ErrorCode).toBe(10)
    await app.close()
  })

  it('Pflicht-Scope wird geprüft (scope + roles)', async () => {
    configure({ POSTBOTE_OIDC_REQUIRED_SCOPE: 'postbote:admin' })
    const app = await buildApp({ store, version: 'test' })
    const missing = await app.inject({
      method: 'GET',
      url: '/server',
      headers: bearer(signJwt(validClaims({ scope: 'openid' }))),
    })
    expect(missing.statusCode).toBe(401)

    const viaRoles = await app.inject({
      method: 'GET',
      url: '/server',
      headers: bearer(signJwt(validClaims({ scope: 'openid', roles: ['postbote:admin'] }))),
    })
    expect(viaRoles.statusCode).toBe(200)
    await app.close()
  })

  it('Key-Rotation: unbekannte kid triggert JWKS-Refresh', async () => {
    configure()
    const app = await buildApp({ store, version: 'test' })
    const first = await app.inject({
      method: 'GET',
      url: '/server',
      headers: bearer(signJwt(validClaims(), { kid: 'key-1' })),
    })
    expect(first.statusCode).toBe(200)

    jwksKeys = [makeJwk('key-2')]
    const rotated = await app.inject({
      method: 'GET',
      url: '/server',
      headers: bearer(signJwt(validClaims(), { kid: 'key-2' })),
    })
    expect(rotated.statusCode).toBe(200)
    await app.close()
  })

  it('Modus oidc: statischer Token abgelehnt, Bearer akzeptiert', async () => {
    configure({ POSTBOTE_AUTH_MODE: 'oidc' })
    const app = await buildApp({ store, version: 'test' })
    const staticRes = await app.inject({
      method: 'GET',
      url: '/server',
      headers: { 'x-postmark-server-token': 'static-token' },
    })
    expect(staticRes.statusCode).toBe(401)
    const oidcRes = await app.inject({
      method: 'GET',
      url: '/server',
      headers: bearer(signJwt(validClaims())),
    })
    expect(oidcRes.statusCode).toBe(200)
    await app.close()
  })

  it('Modus token: Bearer abgelehnt, statischer Token akzeptiert', async () => {
    configure({ POSTBOTE_AUTH_MODE: 'token' })
    const app = await buildApp({ store, version: 'test' })
    const oidcRes = await app.inject({
      method: 'GET',
      url: '/server',
      headers: bearer(signJwt(validClaims())),
    })
    expect(oidcRes.statusCode).toBe(401)
    const staticRes = await app.inject({
      method: 'GET',
      url: '/server',
      headers: { 'x-postmark-server-token': 'static-token' },
    })
    expect(staticRes.statusCode).toBe(200)
    await app.close()
  })

  it('OIDC nicht konfiguriert → Bearer 401 ohne Absturz', async () => {
    vi.stubEnv('POSTBOTE_OIDC_ISSUER', '')
    vi.stubEnv('POSTBOTE_AUTH_MODE', 'both')
    vi.stubEnv('POSTBOTE_OIDC_SERVER_SLUG', 'oidc-server')
    resetOidcVerifier()
    const app = await buildApp({ store, version: 'test' })
    const res = await app.inject({
      method: 'GET',
      url: '/server',
      headers: bearer(signJwt(validClaims())),
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
