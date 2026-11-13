import type { FastifyInstance } from 'fastify'
import { authenticate } from '../auth.js'
import { ErrorCodes } from '../errors.js'

const REASONS = ['HardBounce', 'SpamComplaint', 'ManualSuppression']

/**
 * Phase 2 (M8): Suppressions (Analyse 2.5). Unterdrückte Adressen führen bei
 * POST /email zu ErrorCode 406. Postmark-Adressen: /suppressions/{stream},
 * /suppressions/{stream}/delete.
 */
export function registerSuppressionRoutes(app: FastifyInstance): void {
  const representation = (s: {
    email: string
    streamId: string
    reason: string
    createdAt: string
  }) => ({
    EmailAddress: s.email,
    SuppressionReason: s.reason,
    CreatedAt: s.createdAt,
    MessageStream: s.streamId,
  })

  app.get('/suppressions/:stream', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { stream } = request.params as { stream: string }
    const list = await app.postbote.store.listSuppressions(auth.token?.serverId ?? '', stream)
    return reply.send({ TotalCount: list.length, Suppressions: list.map(representation) })
  })

  app.post('/suppressions/:stream', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { stream } = request.params as { stream: string }
    const body = request.body as Record<string, unknown>
    const entries: { EmailAddress: string; SuppressionReason?: string }[] = Array.isArray(
      body.Suppressions,
    )
      ? (body.Suppressions as Record<string, unknown>[]).map((entry) => ({
          EmailAddress: String(entry.EmailAddress ?? ''),
          ...(typeof entry.SuppressionReason === 'string' && {
            SuppressionReason: entry.SuppressionReason,
          }),
        }))
      : [
          {
            EmailAddress: String(body.EmailAddress ?? ''),
            ...(typeof body.SuppressionReason === 'string' && {
              SuppressionReason: body.SuppressionReason,
            }),
          },
        ]

    const valid = entries.filter((entry) => {
      const email = entry.EmailAddress.trim()
      return (
        email.includes('@') &&
        (entry.SuppressionReason === undefined || REASONS.includes(entry.SuppressionReason))
      )
    })
    if (valid.length === 0) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: "Invalid request field(s): a valid 'EmailAddress' is required.",
      })
    }
    if (auth.sandbox)
      return reply.send({
        Suppressions: valid.map((_, i) => ({
          EmailAddress: entries[i]?.EmailAddress ?? '',
          SuppressionReason: 'ManualSuppression',
        })),
      })

    const stored = []
    for (const entry of valid) {
      stored.push(
        await app.postbote.store.addSuppression(auth.token?.serverId ?? '', stream, {
          email: entry.EmailAddress,
          ...(entry.SuppressionReason !== undefined && { reason: entry.SuppressionReason }),
        }),
      )
    }
    return reply.send({ Suppressions: stored.map(representation) })
  })

  app.post('/suppressions/:stream/delete', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { stream } = request.params as { stream: string }
    const body = request.body as Record<string, unknown>
    const email = typeof body.EmailAddress === 'string' ? body.EmailAddress : ''
    if (!email) {
      return reply
        .status(422)
        .send({ ErrorCode: ErrorCodes.SendValidation, Message: "'EmailAddress' is required." })
    }
    const removed = auth.sandbox
      ? true
      : await app.postbote.store.removeSuppression(auth.token?.serverId ?? '', stream, email)
    return reply.send({
      ErrorCode: 0,
      Message: removed ? 'Suppression removed' : 'Suppression not found',
    })
  })

  // Alias für Clients, die DELETE statt /delete verwenden.
  app.delete('/suppressions/:stream', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { stream } = request.params as { stream: string }
    const body = request.body as Record<string, unknown>
    const email = typeof body?.EmailAddress === 'string' ? body.EmailAddress : ''
    if (!email) {
      return reply
        .status(422)
        .send({ ErrorCode: ErrorCodes.SendValidation, Message: "'EmailAddress' is required." })
    }
    const removed = auth.sandbox
      ? true
      : await app.postbote.store.removeSuppression(auth.token?.serverId ?? '', stream, email)
    return reply.send({
      ErrorCode: 0,
      Message: removed ? 'Suppression removed' : 'Suppression not found',
    })
  })
}
