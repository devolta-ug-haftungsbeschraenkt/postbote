import type { FastifyInstance } from 'fastify'
import { authenticate } from '../auth.js'
import { ErrorCodes } from '../errors.js'

/** Bounce-Query-APIs (Bauplan §4: /bounces, /bounces/{id}, /dump, /activate). */
export function registerBounceRoutes(app: FastifyInstance): void {
  app.get('/bounces', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const query = request.query as Record<string, string | undefined>
    const count = Math.min(Number.parseInt(query.count ?? '100', 10) || 100, 500)
    const offset = Number.parseInt(query.offset ?? '0', 10) || 0
    const { total, bounces } = await app.postbote.store.listBounces({
      serverId: auth.token?.serverId ?? '',
      ...(query.type !== undefined && { type: query.type }),
      limit: count,
      offset,
    })

    return reply.send({
      TotalCount: total,
      Bounces: bounces.map((b) => ({
        ID: b.id,
        Type: b.type,
        TypeCode: b.typeCode,
        Description: b.description,
        Email: b.email,
        BouncedAt: b.bouncedAt,
        MessageID: b.messageId,
      })),
    })
  })

  app.get('/bounces/:id', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { id } = request.params as { id: string }
    const bounce = await app.postbote.store.getBounce(auth.token?.serverId ?? '', id)
    if (!bounce) {
      return reply.status(404).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: 'The bounce was not found.',
      })
    }
    return reply.send({
      ID: bounce.id,
      Type: bounce.type,
      TypeCode: bounce.typeCode,
      Description: bounce.description,
      Email: bounce.email,
      BouncedAt: bounce.bouncedAt,
      MessageID: bounce.messageId,
    })
  })

  // Raw source of the bounced message (Postmark: 30-Tage-Retention).
  app.get('/bounces/:id/dump', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { id } = request.params as { id: string }
    const bounce = await app.postbote.store.getBounce(auth.token?.serverId ?? '', id)
    if (!bounce) {
      return reply.status(404).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: 'The bounce was not found.',
      })
    }
    const message = await app.postbote.store.getMessage(bounce.messageId)
    return reply.send({
      Body: message?.htmlBody ?? message?.textBody ?? '(content not retained)',
    })
  })

  // Activate: entfernt die Suppression, die durch den HardBounce entstanden
  // ist (Phase 2, Analyse 2.5) — weitere Sends an die Adresse sind wieder
  // erlaubt (ErrorCode 406 entfällt).
  app.put('/bounces/:id/activate', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { id } = request.params as { id: string }
    const bounce = await app.postbote.store.getBounce(auth.token?.serverId ?? '', id)
    if (!bounce) {
      return reply.status(404).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: 'The bounce was not found.',
      })
    }
    if (!auth.sandbox) {
      const message = await app.postbote.store.getMessage(bounce.messageId)
      await app.postbote.store.removeSuppression(
        auth.token?.serverId ?? '',
        message?.streamId ?? 'outbound',
        bounce.email,
      )
    }
    return reply.send({
      ID: bounce.id,
      Type: bounce.type,
      TypeCode: bounce.typeCode,
      Email: bounce.email,
      BouncedAt: bounce.bouncedAt,
      MessageID: bounce.messageId,
      Message: 'OK',
    })
  })
}
