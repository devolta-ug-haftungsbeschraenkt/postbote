import type { FastifyInstance } from 'fastify'
import type { MessageInput } from '../../core/store.js'
import { authenticateStaticToken } from '../auth.js'
import { ErrorCodes } from '../errors.js'
import { RateLimiter, checkPreflight, checkSenderAllowed } from '../policy.js'
import { renderTemplate } from '../render-template.js'

/**
 * POST /logto — Logto-HTTP-Email-Connector (Bauplan §4, app01-Migration).
 *
 * Vertrag des Legacy-Systems (`/opt/postbote/server.mjs`):
 *   { to, type, payload }  →  TemplateAlias aus logtoConfig.templates[type],
 *   From = logtoConfig.from, Tag = `logto-${type}`, TemplateModel = payload.
 *
 * Auth: `Authorization: Bearer <token>` oder `X-Postmark-Server-Token`
 * (statischer Client-Token, bewusst KEIN OIDC-JWT — der Connector ist eine
 * Maschine). Ohne Logto-Config am Token → 403 / ErrorCode 10.
 */
export function registerLogtoRoutes(app: FastifyInstance): void {
  const rateLimiter = new RateLimiter()

  app.post('/logto', async (request, reply) => {
    const token = await authenticateStaticToken(request, app.postbote.store)
    if (!token) {
      return reply
        .status(401)
        .send({ ErrorCode: ErrorCodes.Auth, Message: 'No valid API token provided.' })
    }

    const body = (request.body ?? {}) as Record<string, unknown>
    const preflight = checkPreflight(body, token, rateLimiter)
    if (preflight) {
      if (preflight.retryAfter !== undefined) {
        reply.header('Retry-After', String(preflight.retryAfter))
      }
      return reply.status(preflight.statusCode).send(preflight.body)
    }

    const to = typeof body.to === 'string' ? body.to.trim() : ''
    const type = typeof body.type === 'string' ? body.type.trim() : ''
    const config = token.logtoConfig
    if (!config) {
      return reply.status(403).send({
        ErrorCode: ErrorCodes.Auth,
        Message: 'Client is not configured for Logto.',
      })
    }
    const alias = config.templates[type]
    if (!alias) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.TemplateNotFound,
        Message: `No template for Logto type '${type}'.`,
      })
    }
    if (!to) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: "Invalid request field(s): 'to'.",
      })
    }

    const sender = checkSenderAllowed(token, config.from)
    if (sender) return reply.status(422).send(sender)

    const suppressed = await app.postbote.store.suppressedEmails(token.serverId, 'outbound', [to])
    if (suppressed.length > 0) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.InactiveRecipient,
        Message: `Inactive recipient: ${suppressed.join(', ')}.`,
      })
    }

    const template = await app.postbote.store.findTemplate(token.serverId, alias)
    if (!template) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.TemplateNotFound,
        Message: 'The template you requested could not be found.',
      })
    }
    const model =
      body.payload !== null && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload
        : {}
    const rendered = await renderTemplate(app.postbote.store, token.serverId, template, model)
    if (rendered.errors.length > 0) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.TemplateRenderingFailed,
        Message: rendered.errors[0]?.message ?? 'Template rendering failed.',
      })
    }

    const input: MessageInput = {
      from: config.from,
      to: [to],
      subject: rendered.subject,
      ...(rendered.htmlBody !== undefined && { htmlBody: rendered.htmlBody }),
      ...(rendered.textBody !== undefined && { textBody: rendered.textBody }),
      tag: `logto-${type}`,
      messageStream: 'outbound',
    }
    const record = await app.postbote.store.insertMessage(input, token.serverId, 'outbound')
    app.postbote.enqueue({ type: 'send_email', payload: { messageId: record.id } })
    return reply.send({
      To: to,
      SubmittedAt: record.submittedAt,
      MessageID: record.id,
      ErrorCode: 0,
      Message: 'OK',
    })
  })
}
