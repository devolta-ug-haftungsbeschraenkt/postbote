import nodemailer, { type Transporter } from 'nodemailer'
import type { MessageRecord, RelayRecord } from '../core/store.js'
import { transformForTracking } from './tracking.js'

/**
 * Versand über Upstream-SMTP (nodemailer-Pool). Gelernte Regel aus dem
 * Umstellungsdokument (Bauplan §4): der Envelope-Absender folgt dem From —
 * nie umgekehrt, sonst verliert die Mail ihre DKIM/DMARC-Ausrichtung.
 */

export interface SendOutcome {
  /** SMTP response code: 250 on success, 4xx/5xx on failure. */
  code: number
  response: string
}

export interface RelayFallback {
  host?: string
  port?: number
  username?: string
  password?: string
  tlsMode?: RelayRecord['tlsMode']
}

export interface MailSender {
  send(
    message: MessageRecord,
    relay: RelayRecord | null,
    fallback: { smtpRelay?: RelayFallback; trackingBaseUrl?: string },
  ): Promise<SendOutcome>
}

/** Build a nodemailer transport from a relay config (connection is pooled). */
export function createTransport(relay: RelayRecord): Transporter {
  return nodemailer.createTransport({
    host: relay.host,
    port: relay.port,
    secure: relay.tlsMode === 'implicit',
    ignoreTLS: relay.tlsMode === 'none',
    auth: relay.username ? { user: relay.username, pass: relay.password } : undefined,
    pool: true,
    maxConnections: 3,
  })
}

/** Send one composed message and normalize the SMTP result to a code + text. */
export class SmtpMailSender implements MailSender {
  constructor(
    private readonly transports = new Map<string, Transporter>(),
    private readonly transportFactory: (relay: RelayRecord) => Transporter = createTransport,
  ) {}

  async send(
    message: MessageRecord,
    relay: RelayRecord | null,
    fallback: { smtpRelay?: RelayFallback; trackingBaseUrl?: string },
  ): Promise<SendOutcome> {
    const relayOrFallback =
      relay ??
      (fallback.smtpRelay
        ? {
            serverId: message.serverId,
            streamId: message.streamId,
            host: fallback.smtpRelay.host ?? '',
            port: fallback.smtpRelay.port ?? 587,
            username: fallback.smtpRelay.username ?? '',
            password: fallback.smtpRelay.password ?? '',
            tlsMode: fallback.smtpRelay.tlsMode ?? 'starttls',
          }
        : null)
    if (!relayOrFallback) {
      // No relay configured (demo mode) — simulate an instant successful delivery.
      return { code: 250, response: '250 OK (demo: no relay configured)' }
    }

    const key = `${relayOrFallback.host}:${relayOrFallback.port}:${relayOrFallback.username}`
    let transport = this.transports.get(key)
    if (!transport) {
      transport = this.transportFactory(relayOrFallback)
      this.transports.set(key, transport)
    }

    try {
      const tracked =
        fallback.trackingBaseUrl !== undefined
          ? transformForTracking(message, fallback.trackingBaseUrl)
          : null
      const html = tracked?.html ?? message.htmlBody
      const text = tracked?.text ?? message.textBody
      const info = await transport.sendMail({
        from: message.from, // envelope sender follows From (DKIM/DMARC-Lektion)
        to: message.to.join(', '),
        ...(message.cc !== undefined && { cc: message.cc.join(', ') }),
        ...(message.bcc !== undefined && { bcc: message.bcc.join(', ') }),
        ...(message.replyTo !== undefined && { replyTo: message.replyTo }),
        subject: message.subject,
        ...(html !== undefined && { html }),
        ...(text !== undefined && { text }),
        ...(message.attachments !== undefined && {
          attachments: message.attachments.map((a) => ({
            filename: a.name,
            content: Buffer.from(a.content, 'base64'),
            contentType: a.contentType,
            ...(a.contentId !== undefined && { cid: a.contentId }),
          })),
        }),
        headers: (message.headers ?? []).map((h) => ({ key: h.name, value: h.value })),
      })
      return {
        code: Number.parseInt(/^(\d{3})/.exec(String(info.response))?.[1] ?? '250', 10),
        response: String(info.response),
      }
    } catch (err) {
      // nodemailer throws SMTP errors with `.response` like "550 5.1.1 ...".
      const response = (err as { response?: string }).response ?? String(err)
      const code = Number.parseInt(/^(\d{3})/.exec(response)?.[1] ?? '400', 10)
      return { code, response }
    }
  }
}
