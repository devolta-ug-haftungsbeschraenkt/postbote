import type { FastifyInstance } from 'fastify'
import { renderPart } from '../../mustachio/render.js'
import { authenticate } from '../auth.js'
import { ErrorCodes } from '../errors.js'

/**
 * Templates-CRUD + /templates/validate (Bauplan §4, M3).
 * Feldnamen sind Postmark-kompatibel: Name, Alias, Subject, HtmlBody, TextBody,
 * LayoutTemplate.
 */

interface TemplateRepresentation {
  TemplateId: string
  Name: string
  Alias: string
  Subject: string
  Active: boolean
  LayoutTemplate: string | null
  HtmlBody?: string
  TextBody?: string
}

function toRepresentation(t: {
  id: string
  name: string
  alias: string
  subject: string
  htmlBody?: string
  textBody?: string
  layoutAlias?: string
}): TemplateRepresentation {
  return {
    TemplateId: t.id,
    Name: t.name,
    Alias: t.alias,
    Subject: t.subject,
    Active: true,
    LayoutTemplate: t.layoutAlias ?? null,
    ...(t.htmlBody !== undefined && { HtmlBody: t.htmlBody }),
    ...(t.textBody !== undefined && { TextBody: t.textBody }),
  }
}

function extractTemplateFields(body: Record<string, unknown>):
  | {
      ok: true
      fields: {
        name: string
        alias: string
        subject: string
        htmlBody?: string
        textBody?: string
        layoutAlias?: string
      }
    }
  | { ok: false; missing: string } {
  const name = typeof body.Name === 'string' ? body.Name.trim() : ''
  const subject = typeof body.Subject === 'string' ? body.Subject : ''
  const htmlBody = typeof body.HtmlBody === 'string' ? body.HtmlBody : undefined
  const textBody = typeof body.TextBody === 'string' ? body.TextBody : undefined
  const layoutAlias = typeof body.LayoutTemplate === 'string' ? body.LayoutTemplate : undefined

  if (!name) return { ok: false, missing: 'Name' }
  if (!htmlBody && !textBody) return { ok: false, missing: 'HtmlBody' }
  return {
    ok: true,
    fields: {
      name,
      // Alias optional in Postmark; we synthesize one from the name so the
      // primary key stays stable.
      alias: typeof body.Alias === 'string' && body.Alias.trim() ? body.Alias.trim() : name,
      subject,
      ...(htmlBody !== undefined && { htmlBody }),
      ...(textBody !== undefined && { textBody }),
      ...(layoutAlias !== undefined && { layoutAlias }),
    },
  }
}

export function registerTemplateRoutes(app: FastifyInstance): void {
  app.post('/templates', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    if (auth.sandbox) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.Auth,
        Message: 'Sandbox tokens cannot modify templates.',
      })
    }

    const check = extractTemplateFields(request.body as Record<string, unknown>)
    if (!check.ok) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: `Invalid request field(s): missing '${check.missing}'.`,
      })
    }

    const record = await app.postbote.store.upsertTemplate(auth.token?.serverId ?? '', check.fields)
    return reply.send(toRepresentation(record))
  })

  app.get('/templates', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const query = request.query as Record<string, string | undefined>
    const count = Math.min(Number.parseInt(query.count ?? '100', 10) || 100, 500)
    const offset = Number.parseInt(query.offset ?? '0', 10) || 0
    const { total, templates } = await app.postbote.store.listTemplates(
      auth.token?.serverId ?? '',
      count,
      offset,
    )
    return reply.send({
      TotalCount: total,
      Templates: templates.map(toRepresentation),
    })
  })

  app.get('/templates/:key', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { key } = request.params as { key: string }
    const template = await app.postbote.store.findTemplate(auth.token?.serverId ?? '', key)
    if (!template) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.TemplateNotFound,
        Message: 'The template you requested could not be found.',
      })
    }
    return reply.send(toRepresentation(template))
  })

  app.put('/templates/:key', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { key } = request.params as { key: string }
    const existing = await app.postbote.store.findTemplate(auth.token?.serverId ?? '', key)
    if (!existing) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.TemplateNotFound,
        Message: 'The template you requested could not be found.',
      })
    }
    const body = request.body as Record<string, unknown>
    const alias =
      typeof body.Alias === 'string' && body.Alias.trim() ? body.Alias.trim() : existing.alias
    const record = await app.postbote.store.upsertTemplate(auth.token?.serverId ?? '', {
      alias,
      name: typeof body.Name === 'string' && body.Name.trim() ? body.Name.trim() : existing.name,
      subject: typeof body.Subject === 'string' ? body.Subject : existing.subject,
      ...(typeof body.HtmlBody === 'string'
        ? { htmlBody: body.HtmlBody }
        : existing.htmlBody !== undefined
          ? { htmlBody: existing.htmlBody }
          : {}),
      ...(typeof body.TextBody === 'string'
        ? { textBody: body.TextBody }
        : existing.textBody !== undefined
          ? { textBody: existing.textBody }
          : {}),
      ...(typeof body.LayoutTemplate === 'string'
        ? { layoutAlias: body.LayoutTemplate }
        : existing.layoutAlias !== undefined
          ? { layoutAlias: existing.layoutAlias }
          : {}),
    })
    return reply.send(toRepresentation(record))
  })

  app.delete('/templates/:key', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const { key } = request.params as { key: string }
    const deleted = await app.postbote.store.deleteTemplate(auth.token?.serverId ?? '', key)
    if (!deleted) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.TemplateNotFound,
        Message: 'The template you requested could not be found.',
      })
    }
    return reply.send({ ErrorCode: 0, Message: 'Template removed' })
  })

  // POST /templates/validate — render-test all parts with an empty model and
  // report syntax errors (the automated replacement of the manual check from
  // Umstellungsdokument Abschnitt 4).
  app.post('/templates/validate', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply

    const body = request.body as Record<string, unknown>
    const subject = typeof body.Subject === 'string' ? body.Subject : ''
    const htmlBody = typeof body.HtmlBody === 'string' ? body.HtmlBody : undefined
    const textBody = typeof body.TextBody === 'string' ? body.TextBody : undefined
    const model =
      body.TemplateModel !== null && typeof body.TemplateModel === 'object'
        ? body.TemplateModel
        : {}

    const subjectResult = renderPart(subject, model, false)
    const htmlResult = htmlBody !== undefined ? renderPart(htmlBody, model, true) : null
    const textResult = textBody !== undefined ? renderPart(textBody, model, false) : null

    const errors: { Message: string; Line: number }[] = []
    for (const e of subjectResult.errors) errors.push({ Message: e.message, Line: e.line })
    if (htmlResult)
      for (const e of htmlResult.errors) errors.push({ Message: e.message, Line: e.line })
    if (textResult)
      for (const e of textResult.errors) errors.push({ Message: e.message, Line: e.line })

    return reply.send({
      AllLayouts: null,
      SuggestedTemplateID: null,
      Subject: { Rendered: subjectResult.value, Errors: [] },
      ...(htmlResult !== null && { HtmlBody: { Rendered: htmlResult.value, Errors: [] } }),
      ...(textResult !== null && { TextBody: { Rendered: textResult.value, Errors: [] } }),
      Errors: errors,
    })
  })
}
