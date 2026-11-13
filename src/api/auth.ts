import type { FastifyReply, FastifyRequest } from 'fastify'
import { loadConfig } from '../config/env.js'
import type { MessageStore, TokenRecord } from '../core/store.js'
import { ErrorCodes } from './errors.js'
import { getOidcVerifier } from './oidc.js'

export const SANDBOX_TOKEN = 'POSTMARK_API_TEST'

export const TOKEN_HEADER = 'x-postmark-server-token'

export interface AuthResult {
  token: TokenRecord | null
  sandbox: boolean
  /** true = OIDC-Bearer-Principal (docs/OIDC.md) */
  oidc: boolean
}

/**
 * Zwei Auth-Pfade (Bauplan-Ergänzung: OIDC mit Logto, docs/OIDC.md):
 *  - `Authorization: Bearer <JWT>` → Logto-Access-Token, via JWKS geprüft
 *  - `X-Postmark-Server-Token` → statischer Token (Postmark-kompatibel)
 *
 * `POSTBOTE_AUTH_MODE`: both (Default) | oidc | token.
 * Fehler → HTTP 401 mit ErrorCode 10, ohne Details zum Token.
 */
export async function authenticateStaticToken(
  request: FastifyRequest,
  store: MessageStore,
): Promise<TokenRecord | null> {
  const headerValue = request.headers[TOKEN_HEADER]
  const authHeader = request.headers.authorization
  const bearer =
    typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : ''
  const raw = typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : bearer
  if (!raw) return null
  return store.findServerByToken(raw)
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  store: MessageStore,
): Promise<AuthResult> {
  const config = loadConfig()
  const authHeader = request.headers.authorization
  const bearer =
    typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : ''

  if (bearer && config.authMode !== 'token') {
    if (!config.oidcIssuer) return unauthorized(reply, 'OIDC is not configured.')
    try {
      const claims = await getOidcVerifier(config).verify(bearer)
      const server = await store.findServerBySlug(config.oidcServerSlug)
      if (!server) return unauthorized(reply, 'OIDC server scope not found.')
      // Synthetischer Token-Record: bestehende Routen nutzen unverändert
      // `auth.token.serverId`; allowedFrom gilt für OIDC-Principals nicht.
      return {
        token: {
          serverId: server.id,
          tokenHash: `oidc:${claims.sub}`,
          name: `oidc:${claims.sub}`,
          sandbox: false,
        },
        sandbox: false,
        oidc: true,
      }
    } catch {
      return unauthorized(reply, 'Invalid OIDC token.')
    }
  }

  if (config.authMode === 'oidc') {
    return unauthorized(reply, 'OIDC bearer token required.')
  }

  const headerValue = request.headers[TOKEN_HEADER]
  const raw = typeof headerValue === 'string' ? headerValue : undefined

  if (!raw) {
    return unauthorized(reply, 'Requires a valid server token.')
  }

  if (raw === SANDBOX_TOKEN) {
    return { token: null, sandbox: true, oidc: false }
  }

  const token = await store.findServerByToken(raw)
  if (!token) {
    return unauthorized(reply, 'Requires a valid server token.')
  }

  return { token, sandbox: false, oidc: false }
}

function unauthorized(reply: FastifyReply, message: string): AuthResult {
  reply.status(401).send({
    ErrorCode: ErrorCodes.Auth,
    Message: message,
  })
  return { token: null, sandbox: false, oidc: false }
}
