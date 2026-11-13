import { type ParsedMail, simpleParser } from 'mailparser'
import type { AddressObject } from 'mailparser'
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from 'smtp-server'
import type { MessageInput, MessageStore } from '../core/store.js'

export interface SmtpIngressOptions {
  store: MessageStore
  enqueue: (job: { type: string; payload: Record<string, unknown> }) => void
  log: (msg: string) => void
  /** SMTP username = access key, password = secret key (Postmark SMTP-token model). */
  verifyCredential: (
    accessKey: string,
    secretKey: string,
  ) => Promise<{ serverId: string; streamId: string } | null>
  /** TLS key/cert for STARTTLS; when absent the server runs plain (MVP). */
  tls?: { key: string; cert: string }
  name?: string
}

/**
 * SMTP-Ingress (Bauplan §4 M5): Ports 2525/587, AUTH PLAIN/LOGIN mit
 * Access/Secret-Credentials, `X-PM-MESSAGE-STREAM`/`X-PM-Tag`/`X-PM-Metadata-*`
 * Header. Accepted messages land in the same store/queue as the HTTP API.
 */
export function createSmtpIngress(options: SmtpIngressOptions) {
  const { store } = options

  const server = new SMTPServer({
    name: options.name ?? 'postbote',
    ...(options.tls !== undefined && { tls: options.tls }),
    authOptional: false,
    disabledCommands: options.tls === undefined ? ['STARTTLS'] : [],
    // Without a TLS cert (dev/demo) allow cleartext AUTH; with STARTTLS
    // configured smtp-server already refuses AUTH until the connection is secure.
    ...(options.tls === undefined && { allowInsecureAuth: true }),
    // Banner advertises AUTH mechanisms; STARTTLS only when TLS is configured.
    onAuth(auth, _session, callback) {
      options
        .verifyCredential(auth.username ?? '', auth.password ?? '')
        .then((match) => {
          if (match) {
            callback(null, { user: match })
          } else {
            const err = new Error('Invalid credentials') as Error & { responseCode?: number }
            err.responseCode = 535
            callback(err)
          }
        })
        .catch(() => callback(new Error('Internal error')))
    },
    // Submission requires AUTH before MAIL FROM (like Postmark's SMTP endpoint).
    onMailFrom(_address, session, callback) {
      if (session.user === undefined) {
        const err = new Error('Authentication required') as Error & { responseCode?: number }
        err.responseCode = 530
        return callback(err)
      }
      return callback()
    },
    onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks)
          const message = await parseMessage(raw, session)
          const record = await store.insertMessage(
            message.input,
            message.serverId,
            message.streamId,
          )
          options.enqueue({ type: 'send_email', payload: { messageId: record.id } })
          options.log(`smtp accepted ${record.id} from ${message.input.from}`)
          callback()
        } catch (err) {
          options.log(`smtp ingest failed: ${err instanceof Error ? err.message : String(err)}`)
          const e = new Error('Message rejected') as Error & { responseCode?: number }
          e.responseCode = 550
          callback(e)
        }
      })
    },
  })

  // Silence default error logging for client-side resets; ours logs the rest.
  server.on('error', (err) => options.log(`smtp server error: ${err.message}`))

  return server
}

interface IngestedMessage {
  input: MessageInput
  serverId: string
  streamId: string
}

/** Map a parsed RFC822 message to the store's MessageInput, honoring X-PM headers. */
async function parseMessage(raw: Buffer, session: SMTPServerSession): Promise<IngestedMessage> {
  const parsed: ParsedMail = await simpleParser(raw, { skipImageLinks: true })
  const user = session.user as { serverId: string; streamId: string } | undefined
  if (!user) throw new Error('unauthenticated session')

  const headers = parsed.headers
  const header = (name: string): string | undefined => {
    const value = headers.get(name)
    return value === undefined ? undefined : String(value)
  }

  // X-PM-MESSAGE-STREAM overrides the credential's default stream (Postmark parity).
  const streamId = header('x-pm-message-stream')?.trim() || user.streamId

  const metadata: Record<string, string> = {}
  for (const [name, value] of headers) {
    const lower = name.toLowerCase()
    if (lower.startsWith('x-pm-metadata-')) {
      metadata[lower.slice('x-pm-metadata-'.length)] = String(value)
    }
  }

  const attachments = (parsed.attachments ?? []).map((a) => ({
    name: a.filename ?? 'attachment',
    content: a.content.toString('base64'),
    contentType: a.contentType ?? 'application/octet-stream',
    ...(a.contentId !== undefined && { contentId: a.contentId }),
  }))

  const tag = header('x-pm-tag')
  const to = parsed.to ? addressList(parsed.to) : session.envelope.rcptTo.map((r) => r.address)
  const cc = parsed.cc ? addressList(parsed.cc) : undefined
  const bcc = parsed.bcc ? addressList(parsed.bcc) : undefined
  const html = typeof parsed.html === 'string' ? parsed.html : undefined
  const text = typeof parsed.text === 'string' ? parsed.text : undefined
  const mailFrom = session.envelope.mailFrom
  const fromAddress =
    parsed.from?.text || (typeof mailFrom === 'object' ? mailFrom.address : '') || ''

  const input: MessageInput = {
    from: fromAddress,
    to,
    ...(cc !== undefined && { cc }),
    ...(bcc !== undefined && { bcc }),
    ...(parsed.replyTo?.text !== undefined && { replyTo: parsed.replyTo.text }),
    subject: parsed.subject ?? '',
    ...(html !== undefined && { htmlBody: html }),
    ...(text !== undefined && { textBody: text }),
    ...(tag !== undefined && { tag }),
    ...(Object.keys(metadata).length > 0 && { metadata }),
    ...(parsed.headerLines.length > 0 && {
      headers: parsed.headerLines
        .filter((h) => h.key.startsWith('x-') && !h.key.startsWith('x-pm-'))
        .map((h) => ({ name: h.key, value: h.line.slice(h.line.indexOf(':') + 1).trim() })),
    }),
    ...(attachments.length > 0 && { attachments }),
  }

  return { input, serverId: user.serverId, streamId }
}

function addressList(field: AddressObject | AddressObject[]): string[] {
  const objects = Array.isArray(field) ? field : [field]
  return objects.flatMap((o) => o.value.map((v) => v.address ?? '')).filter((a) => a.length > 0)
}
