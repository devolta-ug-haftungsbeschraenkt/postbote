import type { FastifyInstance } from 'fastify'
import { authenticate } from '../auth.js'

/** Phase 2 (M8): /stats/outbound + Open-/Click-Listen pro Message. */
export function registerStatsRoutes(app: FastifyInstance): void {
  app.get('/stats/outbound', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const query = request.query as Record<string, string | undefined>
    const today = new Date().toISOString().slice(0, 10)
    const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
    const fromDate = query.from ?? weekAgo
    const toDate = query.to ?? today
    const days = await app.postbote.store.outboundStats({
      serverId: auth.token?.serverId ?? '',
      fromDate,
      toDate,
      ...(query.tag !== undefined && { tag: query.tag }),
    })
    const total = (key: 'sent' | 'bounced' | 'opens' | 'clicks' | 'tracked') =>
      days.reduce((sum, day) => sum + day[key], 0)
    return reply.send({
      FromDate: fromDate,
      ToDate: toDate,
      Days: days.map((day) => ({
        Date: day.date,
        Sent: day.sent,
        Bounced: day.bounced,
        Opens: day.opens,
        Clicks: day.clicks,
        Tracked: day.tracked,
      })),
      Sent: total('sent'),
      Bounced: total('bounced'),
      Opens: total('opens'),
      Clicks: total('clicks'),
      Tracked: total('tracked'),
    })
  })

  app.get('/messages/outbound/:id/opens', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { id } = request.params as { id: string }
    const events = await app.postbote.store.listTrackingEvents(id, 'open')
    return reply.send({
      TotalCount: events.length,
      Opens: events.map((event) => ({
        MessageID: event.messageId,
        Recipient: '',
        ReceivedAt: event.createdAt,
        ...(event.userAgent !== undefined && { UserAgent: event.userAgent }),
      })),
    })
  })

  app.get('/messages/outbound/:id/clicks', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { id } = request.params as { id: string }
    const events = await app.postbote.store.listTrackingEvents(id, 'click')
    return reply.send({
      TotalCount: events.length,
      Clicks: events.map((event) => ({
        MessageID: event.messageId,
        ReceivedAt: event.createdAt,
        ...(event.originalLink !== undefined && { OriginalLink: event.originalLink }),
        ...(event.clickLocation !== undefined && { ClickLocation: event.clickLocation }),
        ...(event.userAgent !== undefined && { UserAgent: event.userAgent }),
      })),
    })
  })
}
