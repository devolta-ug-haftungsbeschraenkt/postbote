import { createHash } from 'node:crypto'
import type { MessageRecord, MessageStore, WebhookRecord } from '../core/store.js'

/**
 * Webhook-Dispatcher (Bauplan §4): Delivery-/Bounce-Events POSTen, Basic Auth
 * + Custom Headers, Retry mit Backoff, Idempotenz via Trace-Id
 * (Analyse 2.4: keine Signaturen — Empfänger müssen idempotent sein).
 */

export interface DeliveryEvent {
  RecordType: 'Delivery' | 'Bounce' | 'Open' | 'Click'
  MessageID: string
  Recipient: string
  MessageStream: string
  DeliveredAt?: string
  BouncedAt?: string
  ReceivedAt?: string
  Type?: string
  TypeCode?: number
  Description?: string
  Details?: string
  UserAgent?: string
  OriginalLink?: string
  ClickLocation?: 'HTML' | 'Text'
  PostFirstOpenOnly?: boolean
  Tag?: string
  Metadata?: Record<string, string>
}

export interface PostOutcome {
  ok: boolean
  status: number | null
  error?: string
}

/** Single attempt POST with timeout + auth/headers; caller handles retries. */
export async function postWebhook(
  webhook: WebhookRecord,
  payload: DeliveryEvent,
  traceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PostOutcome> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-PM-Webhook-Trace-Id': traceId,
    ...Object.fromEntries((webhook.httpHeaders ?? []).map((h) => [h.name, h.value])),
  }
  if (webhook.httpAuth) {
    const basic = Buffer.from(`${webhook.httpAuth.username}:${webhook.httpAuth.password}`).toString(
      'base64',
    )
    headers.Authorization = `Basic ${basic}`
  }

  try {
    const res = await fetchImpl(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    return { ok: res.status >= 200 && res.status < 300, status: res.status }
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Trace id: stable per (message, event, recipient) — receiver's idempotency key. */
export function traceIdFor(message: MessageRecord, recipient: string, recordType: string): string {
  return createHash('sha256')
    .update(`${message.id}:${recipient}:${recordType}`)
    .digest('hex')
    .slice(0, 32)
}

export async function dispatchEvent(
  store: MessageStore,
  message: MessageRecord,
  event: DeliveryEvent,
  maxAttempts = 5,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const recipient = event.Recipient
  const webhooks = await store.listWebhooks(message.serverId, event.RecordType)
  await Promise.all(
    webhooks.map(async (webhook) => {
      const traceId = traceIdFor(message, recipient, event.RecordType)
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const outcome = await postWebhook(webhook, event, traceId, fetchImpl)
        await store.recordWebhookDelivery({
          webhookId: webhook.id,
          messageId: message.id,
          traceId,
          attempt,
          responseStatus: outcome.status,
          ...(outcome.error !== undefined && { error: outcome.error }),
        })
        if (outcome.ok) {
          await store.appendEvent(message.id, 'webhook_delivered', `webhook ${webhook.id} ok`)
          return
        }
        if (attempt < maxAttempts) {
          // Same backoff ladder as the send queue.
          await new Promise((resolve) => setTimeout(resolve, backoffQuick(attempt)))
        }
      }
    }),
  )
}

function backoffQuick(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 60_000)
}

export function deliveryEvent(message: MessageRecord, response: string): DeliveryEvent {
  return {
    RecordType: 'Delivery',
    MessageID: message.id,
    Recipient: message.to[0] ?? '',
    MessageStream: message.streamId,
    DeliveredAt: new Date().toISOString(),
    Details: response,
    ...(message.tag !== undefined && { Tag: message.tag }),
    ...(message.metadata !== undefined && { Metadata: message.metadata }),
  }
}

export function bounceEvent(
  message: MessageRecord,
  type: string,
  typeCode: number,
  description: string,
): DeliveryEvent {
  return {
    RecordType: 'Bounce',
    MessageID: message.id,
    Recipient: message.to[0] ?? '',
    MessageStream: message.streamId,
    BouncedAt: new Date().toISOString(),
    Type: type,
    TypeCode: typeCode,
    Description: description,
    ...(message.tag !== undefined && { Tag: message.tag }),
    ...(message.metadata !== undefined && { Metadata: message.metadata }),
  }
}

/** Phase 2 (M8): Open-Event (Tracking-Pixel). */
export function openEvent(
  message: MessageRecord,
  userAgent?: string,
  postFirstOpenOnly?: boolean,
): DeliveryEvent {
  return {
    RecordType: 'Open',
    MessageID: message.id,
    Recipient: message.to[0] ?? '',
    MessageStream: message.streamId,
    ReceivedAt: new Date().toISOString(),
    ...(userAgent !== undefined && { UserAgent: userAgent }),
    ...(postFirstOpenOnly !== undefined && { PostFirstOpenOnly: postFirstOpenOnly }),
    ...(message.tag !== undefined && { Tag: message.tag }),
    ...(message.metadata !== undefined && { Metadata: message.metadata }),
  }
}

/** Phase 2 (M8): Click-Event (Link-Rewrite). */
export function clickEvent(
  message: MessageRecord,
  originalLink: string,
  clickLocation: 'HTML' | 'Text',
  userAgent?: string,
): DeliveryEvent {
  return {
    RecordType: 'Click',
    MessageID: message.id,
    Recipient: message.to[0] ?? '',
    MessageStream: message.streamId,
    ReceivedAt: new Date().toISOString(),
    OriginalLink: originalLink,
    ClickLocation: clickLocation,
    ...(userAgent !== undefined && { UserAgent: userAgent }),
    ...(message.tag !== undefined && { Tag: message.tag }),
    ...(message.metadata !== undefined && { Metadata: message.metadata }),
  }
}
