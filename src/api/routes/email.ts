import type { FastifyInstance } from 'fastify'
import type { MessageInput, TrackLinksMode } from '../../core/store.js'
import { authenticate } from '../auth.js'
import { ErrorCodes } from '../errors.js'
import { renderTemplate } from '../render-template.js'

const MAX_BATCH = 500
const MAX_RECIPIENTS = 50
const MAX_ADDRESS_LENGTH = 254

interface SendSuccess {
  To: string
  SubmittedAt: string
  MessageID: string
  ErrorCode: number
  Message: string
}

interface SendFailure {
  ErrorCode: number
  Message: string
}

const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+$/
const TRACK_LINKS_MODES: TrackLinksMode[] = ['None', 'HtmlAndText', 'HtmlOnly', 'TextOnly']

/** Phase 2 (M8): TrackOpens/TrackLinks in das MessageInput übernehmen. */
function parseTracking(body: Record<string, unknown>): {
  trackOpens?: boolean
  trackLinks?: TrackLinksMode
} {
  const trackOpens = body.TrackOpens === true
  const raw = typeof body.TrackLinks === 'string' ? body.TrackLinks : undefined
  const trackLinks =
    raw !== undefined && TRACK_LINKS_MODES.includes(raw as TrackLinksMode)
      ? (raw as TrackLinksMode)
      : undefined
  return {
    ...(trackOpens && { trackOpens: true }),
    ...(trackLinks !== undefined && { trackLinks }),
  }
}

/** Adresse aus "Name <a@b.de>" extrahieren (Suppression-Vergleich). */
function extractEmail(value: string): string {
  const match = /<([^>]+)>/.exec(value)
  return (match?.[1] ?? value).trim().toLowerCase()
}

/**
 * Phase 2 (M8): Send-Policy — unbekannter/archivierter Stream → ErrorCode 1235,
 * unterdrückte Empfänger → ErrorCode 406 (Analyse 2.5).
 */
async function checkSendPolicy(
  app: FastifyInstance,
  serverId: string,
  input: Pick<MessageInput, 'to' | 'cc' | 'bcc' | 'messageStream'>,
): Promise<SendFailure | null> {
  const streamId = input.messageStream ?? 'outbound'
  if (streamId !== 'outbound') {
    const stream = await app.postbote.store.getStream(serverId, streamId)
    if (!stream || stream.archived) {
      return {
        ErrorCode: ErrorCodes.StreamNotFound,
        Message: `The message stream '${streamId}' does not exist or is archived.`,
      }
    }
  }
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map(extractEmail)
  const suppressed = await app.postbote.store.suppressedEmails(serverId, streamId, recipients)
  if (suppressed.length > 0) {
    return {
      ErrorCode: ErrorCodes.InactiveRecipient,
      Message: `Inactive recipient: ${suppressed.join(', ')}. The address is suppressed for this message stream.`,
    }
  }
  return null
}

function splitRecipients(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Validate one message exactly like the Postmark send API (Analyse 2.1). */
export function validateMessage(body: Record<string, unknown>):
  | {
      ok: true
      input: MessageInput
    }
  | {
      ok: false
      errorCode: number
      message: string
    } {
  const from = typeof body.From === 'string' ? body.From.trim() : ''
  if (!EMAIL_ADDRESS_RE.test(from)) {
    return {
      ok: false,
      errorCode: ErrorCodes.SendValidation,
      message: "Invalid request field(s): 'From'.",
    }
  }

  const to = splitRecipients(body.To)
  const cc = splitRecipients(body.Cc)
  const bcc = splitRecipients(body.Bcc)

  if (to.length === 0) {
    return {
      ok: false,
      errorCode: ErrorCodes.SendValidation,
      message: "Invalid request field(s): 'To'.",
    }
  }
  for (const [name, list] of [
    ['To', to],
    ['Cc', cc],
    ['Bcc', bcc],
  ] as const) {
    if (list.length > MAX_RECIPIENTS) {
      return {
        ok: false,
        errorCode: ErrorCodes.SendValidation,
        message: `Invalid request field(s): '${name}'. Maximum of ${MAX_RECIPIENTS} recipients per field.`,
      }
    }
    if (list.some((addr) => addr.length > MAX_ADDRESS_LENGTH)) {
      return {
        ok: false,
        errorCode: ErrorCodes.SendValidation,
        message: `Invalid request field(s): '${name}'. Maximum of ${MAX_ADDRESS_LENGTH} characters per address.`,
      }
    }
  }

  const htmlBody = typeof body.HtmlBody === 'string' ? body.HtmlBody : undefined
  const textBody = typeof body.TextBody === 'string' ? body.TextBody : undefined
  if (!htmlBody && !textBody) {
    return {
      ok: false,
      errorCode: ErrorCodes.SendValidation,
      message: "Provide at least one of 'TextBody' or 'HtmlBody'.",
    }
  }

  const messageStream = typeof body.MessageStream === 'string' ? body.MessageStream : 'outbound'

  const input: MessageInput = {
    from,
    to,
    ...(cc.length > 0 && { cc }),
    ...(bcc.length > 0 && { bcc }),
    ...(typeof body.ReplyTo === 'string' && { replyTo: body.ReplyTo.trim() }),
    subject: typeof body.Subject === 'string' ? body.Subject : '',
    ...(htmlBody !== undefined && { htmlBody }),
    ...(textBody !== undefined && { textBody }),
    ...(typeof body.Tag === 'string' && { tag: body.Tag.slice(0, 1000) }),
    ...(body.Metadata !== null &&
      typeof body.Metadata === 'object' &&
      !Array.isArray(body.Metadata) && {
        metadata: Object.fromEntries(
          Object.entries(body.Metadata as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        ),
      }),
    ...(Array.isArray(body.Headers) && {
      headers: body.Headers.filter(
        (h): h is { name: string; value: string } =>
          typeof h === 'object' &&
          h !== null &&
          typeof (h as Record<string, unknown>).Name === 'string',
      ).map((h) => ({
        name: String((h as Record<string, unknown>).Name),
        value: String((h as Record<string, unknown>).Value ?? ''),
      })),
    }),
    ...(Array.isArray(body.Attachments) && {
      attachments: body.Attachments.filter(
        (a): a is { name: string; content: string; contentType: string; contentId?: string } =>
          typeof a === 'object' && a !== null,
      ).map((a) => {
        const rec = a as Record<string, unknown>
        return {
          name: String(rec.Name ?? 'attachment'),
          content: String(rec.Content ?? ''),
          contentType: String(rec.ContentType ?? 'application/octet-stream'),
          ...(typeof rec.ContentID === 'string' && { contentId: rec.ContentID }),
        }
      }),
    }),
    messageStream,
    ...parseTracking(body),
  }

  return { ok: true, input }
}

/** Validate From/To/Cc/Bcc fields only (used by withTemplate routes). */
export function validateEnvelope(body: Record<string, unknown>):
  | {
      ok: true
      input: Pick<
        MessageInput,
        | 'from'
        | 'to'
        | 'cc'
        | 'bcc'
        | 'replyTo'
        | 'tag'
        | 'metadata'
        | 'headers'
        | 'attachments'
        | 'messageStream'
        | 'trackOpens'
        | 'trackLinks'
      >
    }
  | {
      ok: false
      errorCode: number
      message: string
    } {
  const from = typeof body.From === 'string' ? body.From.trim() : ''
  if (!EMAIL_ADDRESS_RE.test(from)) {
    return {
      ok: false,
      errorCode: ErrorCodes.SendValidation,
      message: "Invalid request field(s): 'From'.",
    }
  }

  const to = splitRecipients(body.To)
  const cc = splitRecipients(body.Cc)
  const bcc = splitRecipients(body.Bcc)

  if (to.length === 0) {
    return {
      ok: false,
      errorCode: ErrorCodes.SendValidation,
      message: "Invalid request field(s): 'To'.",
    }
  }
  for (const [name, list] of [
    ['To', to],
    ['Cc', cc],
    ['Bcc', bcc],
  ] as const) {
    if (list.length > MAX_RECIPIENTS) {
      return {
        ok: false,
        errorCode: ErrorCodes.SendValidation,
        message: `Invalid request field(s): '${name}'. Maximum of ${MAX_RECIPIENTS} recipients per field.`,
      }
    }
    if (list.some((addr) => addr.length > MAX_ADDRESS_LENGTH)) {
      return {
        ok: false,
        errorCode: ErrorCodes.SendValidation,
        message: `Invalid request field(s): '${name}'. Maximum of ${MAX_ADDRESS_LENGTH} characters per address.`,
      }
    }
  }

  return {
    ok: true,
    input: {
      from,
      to,
      ...(cc.length > 0 && { cc }),
      ...(bcc.length > 0 && { bcc }),
      ...(typeof body.ReplyTo === 'string' && { replyTo: body.ReplyTo.trim() }),
      ...(typeof body.Tag === 'string' && { tag: body.Tag.slice(0, 1000) }),
      ...(body.Metadata !== null &&
        typeof body.Metadata === 'object' &&
        !Array.isArray(body.Metadata) && {
          metadata: Object.fromEntries(
            Object.entries(body.Metadata as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v),
            ]),
          ),
        }),
      ...(Array.isArray(body.Headers) && {
        headers: body.Headers.filter(
          (h): h is { name: string; value: string } =>
            typeof h === 'object' &&
            h !== null &&
            typeof (h as Record<string, unknown>).Name === 'string',
        ).map((h) => ({
          name: String((h as Record<string, unknown>).Name),
          value: String((h as Record<string, unknown>).Value ?? ''),
        })),
      }),
      ...(Array.isArray(body.Attachments) && {
        attachments: body.Attachments.filter(
          (a): a is { name: string; content: string; contentType: string; contentId?: string } =>
            typeof a === 'object' && a !== null,
        ).map((a) => {
          const rec = a as Record<string, unknown>
          return {
            name: String(rec.Name ?? 'attachment'),
            content: String(rec.Content ?? ''),
            contentType: String(rec.ContentType ?? 'application/octet-stream'),
            ...(typeof rec.ContentID === 'string' && { contentId: rec.ContentID }),
          }
        }),
      }),
      messageStream: typeof body.MessageStream === 'string' ? body.MessageStream : 'outbound',
      ...parseTracking(body),
    },
  }
}

function success(input: MessageInput, messageId: string): SendSuccess {
  return {
    To: input.to.join(', '),
    SubmittedAt: new Date().toISOString(),
    MessageID: messageId,
    ErrorCode: 0,
    Message: 'OK',
  }
}

export function registerEmailRoutes(app: FastifyInstance): void {
  // POST /email — single send (sync accept, async delivery)
  app.post('/email', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    if (auth.sandbox) {
      // Sandbox: full validation, no persistence, no delivery.
      const check = validateMessage(request.body as Record<string, unknown>)
      if (!check.ok) {
        return reply.status(422).send({ ErrorCode: check.errorCode, Message: check.message })
      }
      return reply.send(success(check.input, crypto.randomUUID()))
    }

    const check = validateMessage(request.body as Record<string, unknown>)
    if (!check.ok) {
      return reply.status(422).send({ ErrorCode: check.errorCode, Message: check.message })
    }
    const policy = await checkSendPolicy(app, auth.token?.serverId ?? '', check.input)
    if (policy) return reply.status(422).send(policy)

    const record = await app.postbote.store.insertMessage(
      check.input,
      auth.token?.serverId ?? '',
      check.input.messageStream ?? 'outbound',
    )
    app.postbote.enqueue({ type: 'send_email', payload: { messageId: record.id } })
    return reply.send(success(check.input, record.id))
  })

  // POST /email/withTemplate — Postmark-Parität: TemplateAlias/TemplateId +
  // TemplateModel; ErrorCode 1101 bei fehlendem Template (Analyse 3.3).
  app.post('/email/withTemplate', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const body = request.body as Record<string, unknown>
    const envelope = validateEnvelope(body)
    if (!envelope.ok) {
      return reply.status(422).send({ ErrorCode: envelope.errorCode, Message: envelope.message })
    }

    const templateKey =
      typeof body.TemplateAlias === 'string'
        ? body.TemplateAlias
        : typeof body.TemplateId === 'string'
          ? body.TemplateId
          : ''
    if (!templateKey) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.SendValidation,
        message: "Invalid request field(s): 'TemplateAlias' or 'TemplateId' is required.",
      })
    }

    const template = await app.postbote.store.findTemplate(auth.token?.serverId ?? '', templateKey)
    if (!template) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.TemplateNotFound,
        Message: 'The template you requested could not be found.',
      })
    }

    const model =
      body.TemplateModel !== null && typeof body.TemplateModel === 'object'
        ? body.TemplateModel
        : {}
    const rendered = await renderTemplate(
      app.postbote.store,
      auth.token?.serverId ?? '',
      template,
      model,
    )
    if (rendered.errors.length > 0) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.TemplateRenderingFailed,
        Message: rendered.errors[0]?.message ?? 'Template rendering failed.',
      })
    }

    const input: MessageInput = {
      ...envelope.input,
      subject: rendered.subject,
      ...(rendered.htmlBody !== undefined && { htmlBody: rendered.htmlBody }),
      ...(rendered.textBody !== undefined && { textBody: rendered.textBody }),
    }

    const policy = await checkSendPolicy(app, auth.token?.serverId ?? '', input)
    if (policy && !auth.sandbox) return reply.status(422).send(policy)

    const messageId = crypto.randomUUID()
    if (!auth.sandbox) {
      const record = await app.postbote.store.insertMessage(
        input,
        auth.token?.serverId ?? '',
        input.messageStream ?? 'outbound',
      )
      app.postbote.enqueue({ type: 'send_email', payload: { messageId: record.id } })
      return reply.send(success(input, record.id))
    }
    return reply.send(success(input, messageId))
  })

  // POST /email/batchWithTemplates — { Messages: [...] }, HTTP 200 + pro-Item-Errors.
  app.post('/email/batchWithTemplates', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const body = request.body as Record<string, unknown>
    const items = Array.isArray(body?.Messages) ? body.Messages : null
    if (items === null) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.InvalidJSON,
        Message: "Request body must include a 'Messages' array.",
      })
    }
    if (items.length > MAX_BATCH) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.BatchTooLarge,
        Message: `Batch is too large. A maximum of ${MAX_BATCH} messages are allowed per batch call.`,
      })
    }

    const results: (SendSuccess | SendFailure)[] = []
    for (const item of items) {
      const record =
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
      const envelope = validateEnvelope(record)
      if (!envelope.ok) {
        results.push({ ErrorCode: envelope.errorCode, Message: envelope.message })
        continue
      }
      const templateKey =
        typeof record.TemplateAlias === 'string'
          ? record.TemplateAlias
          : typeof record.TemplateId === 'string'
            ? record.TemplateId
            : ''
      if (!templateKey) {
        results.push({
          ErrorCode: ErrorCodes.SendValidation,
          Message: "Invalid request field(s): 'TemplateAlias' or 'TemplateId' is required.",
        })
        continue
      }
      const template = await app.postbote.store.findTemplate(
        auth.token?.serverId ?? '',
        templateKey,
      )
      if (!template) {
        results.push({
          ErrorCode: ErrorCodes.TemplateNotFound,
          Message: 'The template you requested could not be found.',
        })
        continue
      }
      const model =
        record.TemplateModel !== null && typeof record.TemplateModel === 'object'
          ? record.TemplateModel
          : {}
      const rendered = await renderTemplate(
        app.postbote.store,
        auth.token?.serverId ?? '',
        template,
        model,
      )
      if (rendered.errors.length > 0) {
        results.push({
          ErrorCode: ErrorCodes.TemplateRenderingFailed,
          Message: rendered.errors[0]?.message ?? 'Template rendering failed.',
        })
        continue
      }
      const input: MessageInput = {
        ...envelope.input,
        subject: rendered.subject,
        ...(rendered.htmlBody !== undefined && { htmlBody: rendered.htmlBody }),
        ...(rendered.textBody !== undefined && { textBody: rendered.textBody }),
      }
      if (!auth.sandbox) {
        const policy = await checkSendPolicy(app, auth.token?.serverId ?? '', input)
        if (policy) {
          results.push(policy)
          continue
        }
        const stored = await app.postbote.store.insertMessage(
          input,
          auth.token?.serverId ?? '',
          input.messageStream ?? 'outbound',
        )
        app.postbote.enqueue({ type: 'send_email', payload: { messageId: stored.id } })
        results.push(success(input, stored.id))
      } else {
        results.push(success(input, crypto.randomUUID()))
      }
    }
    return reply.send(results)
  })

  // POST /email/batch — up to 500 messages; HTTP stays 200, errors come per item.
  app.post('/email/batch', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const body = request.body
    if (!Array.isArray(body)) {
      return reply
        .status(422)
        .send({ ErrorCode: ErrorCodes.InvalidJSON, Message: 'Request body must be an array.' })
    }
    if (body.length > MAX_BATCH) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.BatchTooLarge,
        Message: `Batch is too large. A maximum of ${MAX_BATCH} messages are allowed per batch call.`,
      })
    }

    const results: (SendSuccess | SendFailure)[] = []
    for (const item of body) {
      const check = validateMessage(
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {},
      )
      if (!check.ok) {
        results.push({ ErrorCode: check.errorCode, Message: check.message })
        continue
      }
      const messageId = crypto.randomUUID()
      if (!auth.sandbox) {
        const policy = await checkSendPolicy(app, auth.token?.serverId ?? '', check.input)
        if (policy) {
          results.push(policy)
          continue
        }
        const record = await app.postbote.store.insertMessage(
          check.input,
          auth.token?.serverId ?? '',
          check.input.messageStream ?? 'outbound',
        )
        app.postbote.enqueue({ type: 'send_email', payload: { messageId: record.id } })
        results.push(success(check.input, record.id))
      } else {
        results.push(success(check.input, messageId))
      }
    }
    return reply.send(results)
  })
}
