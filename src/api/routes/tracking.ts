import type { FastifyInstance } from 'fastify'
import { clickEvent, dispatchEvent, openEvent } from '../../worker/webhooks.js'

/** 1x1 transparentes GIF (Base64). */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/**
 * Phase 2 (M8): öffentliche Tracking-Endpunkte (kein Token — Pixel/Links
 * werden von Mail-Clients aufgerufen). Jeder Aufruf erzeugt ein Event und
 * dispatcht den passenden Webhook (Open/Click).
 */
export function registerTrackingRoutes(app: FastifyInstance): void {
  app.get('/track/open/:messageId', async (request, reply) => {
    const { messageId } = request.params as { messageId: string }
    const message = await app.postbote.store.getMessage(messageId)
    reply
      .header('Content-Type', 'image/gif')
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      .header('Content-Length', String(PIXEL.length))
    if (!message) return reply.send(PIXEL)

    const userAgent = request.headers['user-agent']
    const existing = await app.postbote.store.listTrackingEvents(messageId, 'open', 1)
    await app.postbote.store.recordTrackingEvent({
      messageId,
      type: 'open',
      ...(typeof userAgent === 'string' && { userAgent }),
      ipAddress: request.ip,
    })
    await app.postbote.store.appendEvent(messageId, 'opened', 'tracking pixel')
    await dispatchEvent(
      app.postbote.store,
      message,
      openEvent(
        message,
        typeof userAgent === 'string' ? userAgent : undefined,
        existing.length > 0,
      ),
    )
    return reply.send(PIXEL)
  })

  app.get('/track/click/:messageId', async (request, reply) => {
    const { messageId } = request.params as { messageId: string }
    const query = request.query as Record<string, string | undefined>
    const target = query.url ?? ''
    const location = query.location === 'Text' ? 'Text' : 'HTML'
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      return reply.status(400).send({ ErrorCode: 300, Message: 'Invalid tracking target.' })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reply
        .status(400)
        .send({ ErrorCode: 300, Message: 'Invalid tracking target protocol.' })
    }

    const message = await app.postbote.store.getMessage(messageId)
    if (message) {
      const userAgent = request.headers['user-agent']
      await app.postbote.store.recordTrackingEvent({
        messageId,
        type: 'click',
        originalLink: target,
        clickLocation: location,
        ...(typeof userAgent === 'string' && { userAgent }),
        ipAddress: request.ip,
      })
      await app.postbote.store.appendEvent(messageId, 'clicked', target)
      await dispatchEvent(
        app.postbote.store,
        message,
        clickEvent(
          message,
          target,
          location,
          typeof userAgent === 'string' ? userAgent : undefined,
        ),
      )
    }
    return reply.code(302).header('Location', target).header('Cache-Control', 'no-store').send()
  })
}
