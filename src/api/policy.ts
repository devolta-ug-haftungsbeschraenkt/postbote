import { loadConfig } from '../config/env.js'
import type { TokenRecord } from '../core/store.js'
import { ErrorCodes } from './errors.js'

/** Bauplan §4: 10 MB pro Nachricht, 50 MB pro Batch-Payload. */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024

export function extractEmail(value: string): string {
  const match = /<([^>]+)>/.exec(value)
  return (match?.[1] ?? value).trim().toLowerCase()
}

/**
 * `allowedFrom`-Allowlist des Tokens (Bauplan §4, ErrorCode 1480).
 * Einträge: exakte Adresse oder `*@domain.tld`. Leere Allowlist = alle.
 */
export function checkSenderAllowed(
  token: TokenRecord | null,
  from: string,
): { ErrorCode: number; Message: string } | null {
  const allowlist = token?.allowedFrom
  if (!allowlist || allowlist.length === 0) return null
  const address = extractEmail(from)
  const allowed = allowlist.some((entry) => {
    const pattern = entry.trim().toLowerCase()
    if (pattern.startsWith('*@')) return address.endsWith(pattern.slice(1))
    return address === pattern
  })
  if (allowed) return null
  return {
    ErrorCode: ErrorCodes.SenderNotAllowed,
    Message: `The sender '${from}' is not allowed for this server token.`,
  }
}

/** Fixed-window Rate-Limit pro Token (Bauplan §4: HTTP 429). */
export class RateLimiter {
  private readonly counters = new Map<string, { windowStart: number; count: number }>()

  constructor(private readonly limitPerMinute: number = loadConfig().rateLimitPerMinute) {}

  check(key: string): { allowed: boolean; retryAfter: number } {
    if (this.limitPerMinute <= 0) return { allowed: true, retryAfter: 0 }
    const now = Date.now()
    const entry = this.counters.get(key)
    if (!entry || now - entry.windowStart >= 60_000) {
      this.counters.set(key, { windowStart: now, count: 1 })
      return { allowed: true, retryAfter: 0 }
    }
    if (entry.count >= this.limitPerMinute) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((60_000 - (now - entry.windowStart)) / 1000)),
      }
    }
    entry.count++
    return { allowed: true, retryAfter: 0 }
  }
}

/** Serialisierte Grösse eines Payloads (Näherung an die Postmark-Grenze). */
export function payloadSize(body: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8')
  } catch {
    return 0
  }
}

export interface Rejection {
  statusCode: number
  body: { ErrorCode: number; Message: string }
  retryAfter?: number
}

/** Gemeinsame Vorprüfung: Rate-Limit + (optional) 10-MB-Limit. */
export function checkPreflight(
  body: unknown,
  token: TokenRecord | null,
  rateLimiter: RateLimiter,
  options: { skipPayloadLimit?: boolean } = {},
): Rejection | null {
  const rate = rateLimiter.check(token?.tokenHash ?? 'sandbox')
  if (!rate.allowed) {
    return {
      statusCode: 429,
      body: { ErrorCode: 429, Message: 'Rate limit exceeded. Please retry later.' },
      retryAfter: rate.retryAfter,
    }
  }
  if (!options.skipPayloadLimit && payloadSize(body) > MAX_MESSAGE_BYTES) {
    return {
      statusCode: 422,
      body: { ErrorCode: ErrorCodes.SendValidation, Message: 'Message exceeds the 10 MB limit.' },
    }
  }
  return null
}
