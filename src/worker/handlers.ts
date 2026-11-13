import { loadConfig } from '../config/env.js'
import type { MessageStore, RelayRecord } from '../core/store.js'
import { classifySmtpResponse } from './bounce.js'
import type { Job, JobHandler, JobQueue } from './queue.js'
import type { MailSender } from './sender.js'
import { bounceEvent, deliveryEvent, dispatchEvent } from './webhooks.js'

export interface WorkerOptions {
  store: MessageStore
  sender: MailSender
  /** Relay lookup falls back to null (demo mode / no upstream configured). */
  getRelay: (serverId: string, streamId: string) => Promise<RelayRecord | null>
  log?: (msg: string) => void
  /** Injectable fetch for webhook dispatch (tests). */
  fetchImpl?: typeof fetch
}

/** Wire the send_email handler (queue → SMTP → status/events/bounce/webhook). */
export function registerJobHandlers(queue: JobQueue, options: WorkerOptions): void {
  const log = options.log ?? (() => {})
  const fetchImpl = options.fetchImpl ?? fetch
  const handler: JobHandler = async (job: Job) => {
    const messageId = job.payload.messageId
    if (typeof messageId !== 'string') {
      return { retry: false, error: 'payload.messageId missing' }
    }
    const message = await options.store.getMessage(messageId)
    if (!message) {
      return { retry: false, error: `message ${messageId} not found` }
    }
    if (message.status !== 'queued') {
      return { retry: false } // already processed (idempotent worker)
    }

    let relay: RelayRecord | null
    let outcome: { code: number; response: string }
    const trackingBaseUrl = loadConfig().trackingBaseUrl
    try {
      relay = await options.getRelay(message.serverId, message.streamId)
      outcome = await options.sender.send(message, relay, { trackingBaseUrl })
    } catch (err) {
      // Asynchrone Fehler nach der Annahme (v. a. SMTP-Ingress, Bauplan §4 M5):
      // können dem SMTP-Client nicht mehr synchron gemeldet werden → SMTPApiError-
      // Bounce (TypeCode 100007, Analyse 2.5) + Bounce-Webhook.
      const description = err instanceof Error ? err.message : String(err)
      const bouncedAt = new Date()
      await options.store.updateMessageStatus(message.id, 'bounced', bouncedAt)
      await options.store.addBounce({
        messageId: message.id,
        type: 'SMTPApiError',
        typeCode: 100007,
        description,
        email: message.to[0] ?? '',
        bouncedAt: bouncedAt.toISOString(),
      })
      await options.store.appendEvent(message.id, 'bounced', `SMTPApiError ${description}`)
      await dispatchEvent(
        options.store,
        message,
        bounceEvent(message, 'SMTPApiError', 100007, description),
        undefined,
        fetchImpl,
      )
      log(`message ${message.id} failed asynchronously: ${description}`)
      return { retry: false }
    }
    const classification = classifySmtpResponse(outcome.code, outcome.response)

    if (classification.type === null) {
      // 2xx — delivered.
      const sentAt = new Date()
      await options.store.updateMessageStatus(message.id, 'sent', sentAt)
      await options.store.appendEvent(message.id, 'sent', outcome.response)
      await dispatchEvent(
        options.store,
        message,
        deliveryEvent(message, outcome.response),
        undefined,
        fetchImpl,
      )
      return { retry: false }
    }

    if (classification.retry) {
      // 4xx / SoftBounce / DnsError — deferred, queue retries with backoff.
      await options.store.appendEvent(message.id, 'deferred', `${outcome.code} ${outcome.response}`)
      return { retry: true, error: `${outcome.code} ${classification.type}` }
    }

    // Permanent 5xx — bounce with TypeCode mapping (Analyse 2.5).
    const bouncedAt = new Date()
    await options.store.updateMessageStatus(message.id, 'bounced', bouncedAt)
    await options.store.addBounce({
      messageId: message.id,
      type: classification.type,
      typeCode: classification.typeCode,
      description: outcome.response,
      email: message.to[0] ?? '',
      bouncedAt: bouncedAt.toISOString(),
    })
    await options.store.appendEvent(message.id, 'bounced', `${outcome.code} ${outcome.response}`)
    // Hard Bounce deaktiviert den Empfänger (Analyse 2.5, ErrorCode 406 bei
    // weiteren Sends). Nur HardBounce — SoftBounce/Transient werden retried.
    if (classification.type === 'HardBounce') {
      const recipient = message.to[0]
      if (recipient) {
        await options.store.addSuppression(message.serverId, message.streamId, {
          email: recipient,
          reason: 'HardBounce',
        })
      }
    }
    await dispatchEvent(
      options.store,
      message,
      bounceEvent(message, classification.type, classification.typeCode, outcome.response),
      undefined,
      fetchImpl,
    )
    log(`message ${message.id} bounced: ${classification.type} (${outcome.code})`)
    return { retry: false }
  }

  queue.registerHandler('send_email', handler)
}
