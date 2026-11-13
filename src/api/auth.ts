import type { FastifyReply, FastifyRequest } from 'fastify'
import type { MessageStore, TokenRecord } from '../core/store.js'
import { ErrorCodes } from './errors.js'

export const SANDBOX_TOKEN = 'POSTMARK_API_TEST'

export const TOKEN_HEADER = 'x-postmark-server-token'

/**
 * Postmark-Auth-Modell: `X-Postmark-Server-Token` Header. Fehlende/falsche
 * Auth → HTTP 401 mit ErrorCode 10. Der Token-Wert `POSTMARK_API_TEST`
 * aktiviert die Sandbox (Validierung ohne Versand) — der Token muss dafür
 * nicht existieren.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  store: MessageStore,
): Promise<{ token: TokenRecord | null; sandbox: boolean }> {
  const headerValue = request.headers[TOKEN_HEADER]
  const raw = typeof headerValue === 'string' ? headerValue : undefined

  if (!raw) {
    reply.status(401).send({
      ErrorCode: ErrorCodes.Auth,
      Message: 'Requires a valid server token.',
    })
    return { token: null, sandbox: false }
  }

  if (raw === SANDBOX_TOKEN) {
    return { token: null, sandbox: true }
  }

  const token = await store.findServerByToken(raw)
  if (!token) {
    reply.status(401).send({
      ErrorCode: ErrorCodes.Auth,
      Message: 'Requires a valid server token.',
    })
    return { token: null, sandbox: false }
  }

  return { token, sandbox: false }
}

/** Echo the error code in the `X-PM-ApiErrorCode` response header. */
export function withErrorHeader(reply: FastifyReply, errorCode: number): void {
  reply.header('X-PM-ApiErrorCode', String(errorCode))
}
