import type { FastifyInstance } from 'fastify'
import type { MessageStatus } from '../../core/store.js'
import { authenticate } from '../auth.js'

/**
 * Query-APIs (MVP-Ausschnitt aus Bauplan §4): /messages/outbound und
 * /deliverystats — die Datengrundlage für die Admin-UI.
 */

const STATUSES: MessageStatus[] = ['queued', 'sent', 'failed', 'bounced']

export function registerQueryRoutes(app: FastifyInstance): void {
  app.get('/messages/outbound', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const query = request.query as Record<string, string | undefined>
    const limit = Math.min(Number.parseInt(query.count ?? '100', 10) || 100, 500)
    const offset = Number.parseInt(query.offset ?? '0', 10) || 0
    const status = STATUSES.includes(query.status as MessageStatus)
      ? (query.status as MessageStatus)
      : undefined

    const messages = await app.postbote.store.listMessages({
      serverId: auth.token?.serverId ?? '',
      ...(status !== undefined && { status }),
      ...(query.tag !== undefined && { tag: query.tag }),
      limit,
      offset,
    })

    return reply.send({
      TotalCount: messages.length,
      Messages: messages.map((m) => ({
        MessageID: m.id,
        From: m.from,
        To: m.to.join(', '),
        Subject: m.subject,
        Tag: m.tag ?? null,
        Status: m.status,
        MessageStream: m.streamId,
        SubmittedAt: m.submittedAt,
      })),
    })
  })

  app.get('/deliverystats', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const counts = await app.postbote.store.countMessages(auth.token?.serverId ?? '')
    return reply.send({
      Sent: counts.sent,
      Queued: counts.queued,
      Failed: counts.failed,
      Bounced: counts.bounced,
    })
  })

  // Health/readiness — used by compose healthchecks.
  app.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', version: app.postbote.version })
  })

  // GET /server — Server-Token scope info (Postmark /server parity, MVP-Ausschnitt).
  app.get('/server', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const server = await app.postbote.store.getServer(auth.token?.serverId ?? '')
    if (!server) {
      return reply.send({
        ID: null,
        Name: '(sandbox)',
        MessageStreamDefault: 'outbound',
      })
    }
    return reply.send({
      ID: server.id,
      Name: server.name,
      Slug: server.slug,
      MessageStreamDefault: 'outbound',
    })
  })
}
