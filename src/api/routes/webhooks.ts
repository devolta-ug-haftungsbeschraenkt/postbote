import type { FastifyInstance } from 'fastify'
import { postWebhook } from '../../worker/webhooks.js'
import { authenticate } from '../auth.js'
import { ErrorCodes } from '../errors.js'

/**
 * Webhooks-CRUD + Verify-Flow (Analyse 2.4):
 * - Beim Anlegen/Editieren wird jeder aktivierte Trigger gegen die URL getestet
 *   (muss 200 liefern), sonst 422 + ErrorCode 1364 und nichts wird gespeichert.
 * - `Verify: false` erlaubt unverified-Anlage; unverified Webhooks bekommen
 *   keine Events (der Dispatcher filtert).
 */

interface WebhookBody {
  Url: string
  MessageStream?: string
  Triggers?: {
    Delivery?: { Enabled?: boolean }
    Bounce?: { Enabled?: boolean }
    Open?: { Enabled?: boolean }
    Click?: { Enabled?: boolean }
  }
  HttpAuth?: { Username?: string; Password?: string }
  HttpHeaders?: { Name: string; Value: string }[]
  Verify?: boolean
}

const SUPPORTED_EVENTS = ['Delivery', 'Bounce', 'Open', 'Click']

function parseBody(body: Record<string, unknown>): {
  url: string
  events: string[]
  httpAuth?: { username: string; password: string }
  httpHeaders?: { name: string; value: string }[]
  verify: boolean
} {
  const url = typeof body.Url === 'string' ? body.Url.trim() : ''
  const triggers = (body.Triggers ?? {}) as WebhookBody['Triggers']
  const events: string[] = SUPPORTED_EVENTS.filter(
    (event) => triggers?.[event as keyof NonNullable<WebhookBody['Triggers']>]?.Enabled === true,
  )
  if (events.length === 0) {
    // Fallback: einfaches Events-Array akzeptieren (postbote-Extension).
    if (Array.isArray(body.Events)) {
      for (const event of body.Events) {
        if (typeof event === 'string' && SUPPORTED_EVENTS.includes(event as never)) {
          events.push(event)
        }
      }
    }
  }
  const httpAuth =
    body.HttpAuth !== null &&
    typeof body.HttpAuth === 'object' &&
    typeof (body.HttpAuth as { Username?: unknown }).Username === 'string'
      ? {
          username: String((body.HttpAuth as { Username: string }).Username),
          password: String((body.HttpAuth as { Password?: unknown }).Password ?? ''),
        }
      : undefined
  const httpHeaders = Array.isArray(body.HttpHeaders)
    ? body.HttpHeaders.filter(
        (h): h is { Name: string; Value: string } =>
          typeof h === 'object' &&
          h !== null &&
          typeof (h as Record<string, unknown>).Name === 'string',
      )
    : undefined
  const verify = body.Verify !== false
  return {
    url,
    events,
    ...(httpAuth !== undefined && { httpAuth }),
    ...(httpHeaders !== undefined && {
      httpHeaders: httpHeaders.map((h) => ({ name: h.Name, value: h.Value })),
    }),
    verify,
  }
}

function toRepresentation(w: {
  id: string
  url: string
  events: string[]
  httpAuth?: { username: string; password: string }
  httpHeaders?: { name: string; value: string }[]
  verified: boolean
}) {
  return {
    ID: w.id,
    Url: w.url,
    MessageStream: 'outbound',
    Triggers: {
      Delivery: { Enabled: w.events.includes('Delivery') },
      Bounce: { Enabled: w.events.includes('Bounce') },
      Open: { Enabled: w.events.includes('Open') },
      Click: { Enabled: w.events.includes('Click') },
    },
    ...(w.httpAuth !== undefined && {
      HttpAuth: { Username: w.httpAuth.username, Password: 'REDACTED' },
    }),
    ...(w.httpHeaders !== undefined && {
      HttpHeaders: w.httpHeaders.map((h) => ({ Name: h.name, Value: h.value })),
    }),
    Verified: w.verified,
  }
}

/** POST a verification probe; must answer 2xx (Postmark 1364 flow). */
async function verifyUrl(
  webhook: {
    url: string
    httpAuth?: { username: string; password: string }
    httpHeaders?: { name: string; value: string }[]
  },
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const outcome = await postWebhook(
    { ...webhook, id: 'verify', serverId: '', events: [], verified: false },
    {
      RecordType: 'Delivery',
      MessageID: '00000000-0000-0000-0000-000000000000',
      Recipient: 'verify@postbote.local',
      MessageStream: 'outbound',
      DeliveredAt: new Date().toISOString(),
      Details: 'postbote webhook verification probe',
    },
    `verify-${Date.now()}`,
    fetchImpl,
  )
  return outcome.ok
}

export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post('/webhooks', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const parsed = parseBody(request.body as Record<string, unknown>)
    if (!parsed.url || parsed.events.length === 0) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: "Invalid request field(s): 'Url' and at least one enabled Trigger are required.",
      })
    }

    const webhookInput = {
      url: parsed.url,
      events: parsed.events,
      ...(parsed.httpAuth !== undefined && { httpAuth: parsed.httpAuth }),
      ...(parsed.httpHeaders !== undefined && { httpHeaders: parsed.httpHeaders }),
    }

    let verified = false
    if (parsed.verify) {
      const ok = await verifyUrl(webhookInput, fetch)
      if (!ok) {
        return reply.status(422).send({
          ErrorCode: ErrorCodes.WebhookVerificationFailed,
          Message:
            'Webhook verification failed — the URL did not respond with 200. Nothing was saved.',
        })
      }
      verified = true
    }

    const stored = await app.postbote.store.upsertWebhook(auth.token?.serverId ?? '', {
      ...webhookInput,
      verified,
    })
    return reply.send(toRepresentation(stored))
  })

  app.get('/webhooks', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const serverId = auth.token?.serverId ?? ''
    const all: Awaited<ReturnType<typeof app.postbote.store.listWebhooks>> = []
    for (const event of SUPPORTED_EVENTS) {
      for (const webhook of await app.postbote.store.listWebhooks(serverId, event)) {
        if (!all.some((w) => w.id === webhook.id)) all.push(webhook)
      }
    }
    return reply.send({ Webhooks: all.map(toRepresentation) })
  })

  app.get('/webhooks/:id', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { id } = request.params as { id: string }
    const webhook = await app.postbote.store.getWebhook(auth.token?.serverId ?? '', id)
    if (!webhook) {
      return reply
        .status(404)
        .send({ ErrorCode: ErrorCodes.SendValidation, Message: 'Webhook not found.' })
    }
    return reply.send(toRepresentation(webhook))
  })

  app.put('/webhooks/:id', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { id } = request.params as { id: string }
    const existing = await app.postbote.store.getWebhook(auth.token?.serverId ?? '', id)
    if (!existing) {
      return reply
        .status(404)
        .send({ ErrorCode: ErrorCodes.SendValidation, Message: 'Webhook not found.' })
    }

    const parsed = parseBody(request.body as Record<string, unknown>)
    const webhookInput = {
      id,
      url: parsed.url || existing.url,
      events: parsed.events.length > 0 ? parsed.events : existing.events,
      ...(parsed.httpAuth !== undefined
        ? { httpAuth: parsed.httpAuth }
        : existing.httpAuth !== undefined
          ? { httpAuth: existing.httpAuth }
          : {}),
      ...(parsed.httpHeaders !== undefined
        ? { httpHeaders: parsed.httpHeaders }
        : existing.httpHeaders !== undefined
          ? { httpHeaders: existing.httpHeaders }
          : {}),
    }

    let verified = existing.verified
    if (parsed.verify) {
      const ok = await verifyUrl(webhookInput, fetch)
      if (!ok) {
        return reply.status(422).send({
          ErrorCode: ErrorCodes.WebhookVerificationFailed,
          Message: 'Webhook verification failed — changes were not applied.',
        })
      }
      verified = true
    }

    const stored = await app.postbote.store.upsertWebhook(auth.token?.serverId ?? '', {
      ...webhookInput,
      verified,
    })
    return reply.send(toRepresentation(stored))
  })

  app.delete('/webhooks/:id', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { id } = request.params as { id: string }
    const deleted = await app.postbote.store.deleteWebhook(auth.token?.serverId ?? '', id)
    if (!deleted) {
      return reply
        .status(404)
        .send({ ErrorCode: ErrorCodes.SendValidation, Message: 'Webhook not found.' })
    }
    return reply.send({ ErrorCode: 0, Message: 'Webhook removed' })
  })

  // POST /webhooks/{id}/verify — re-test an existing webhook.
  app.post('/webhooks/:id/verify', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { id } = request.params as { id: string }
    const existing = await app.postbote.store.getWebhook(auth.token?.serverId ?? '', id)
    if (!existing) {
      return reply
        .status(404)
        .send({ ErrorCode: ErrorCodes.SendValidation, Message: 'Webhook not found.' })
    }
    const ok = await verifyUrl(existing, fetch)
    if (!ok) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.WebhookVerificationFailed,
        Message: 'Webhook verification failed.',
      })
    }
    const stored = await app.postbote.store.upsertWebhook(auth.token?.serverId ?? '', {
      id: existing.id,
      url: existing.url,
      events: existing.events,
      ...(existing.httpAuth !== undefined && { httpAuth: existing.httpAuth }),
      ...(existing.httpHeaders !== undefined && { httpHeaders: existing.httpHeaders }),
      verified: true,
    })
    return reply.send(toRepresentation(stored))
  })
}
