import type { MessageStore, TemplateRecord } from '../core/store.js'
import { applyLayout, deriveTextFromHtml, renderPart } from '../mustachio/render.js'

export interface RenderedTemplate {
  subject: string
  htmlBody?: string
  textBody?: string
  errors: { part: string; message: string; line: number }[]
}

/**
 * Render a template's three parts per Postmark semantics:
 * Subject/Text raw, HTML escaped, layout applied to HTML, Text derived from
 * HTML when absent.
 */
export async function renderTemplate(
  store: MessageStore,
  serverId: string,
  template: TemplateRecord,
  model: unknown,
): Promise<RenderedTemplate> {
  const errors: RenderedTemplate['errors'] = []

  // Subject + TextBody: raw (never escaped — Bauplan §4).
  const subject = renderPart(template.subject, model, false)
  for (const e of subject.errors) errors.push({ part: 'subject', message: e.message, line: e.line })

  let textBody = template.textBody
  if (textBody !== undefined) {
    const text = renderPart(textBody, model, false)
    for (const e of text.errors) errors.push({ part: 'textbody', message: e.message, line: e.line })
    textBody = text.value
  }

  let htmlBody: string | undefined
  if (template.htmlBody !== undefined) {
    const html = renderPart(template.htmlBody, model, true)
    for (const e of html.errors) errors.push({ part: 'htmlbody', message: e.message, line: e.line })
    htmlBody = html.value

    // Layout (Postmark-Parität: Template erbt von LayoutTemplate).
    if (template.layoutAlias) {
      const layout = await store.findLayout(serverId, template.layoutAlias)
      if (layout) {
        htmlBody = applyLayout(layout.htmlBody, htmlBody ?? '').value
        if (textBody === undefined && layout.textBody) {
          const layoutText = renderPart(layout.textBody, model, false)
          textBody = layoutText.value.replace(/\{\{\s*@content\s*\}\}/g, '')
        }
      }
    }
  }

  // HTML → Text derivation when the template has no TextBody.
  if (textBody === undefined && htmlBody !== undefined) {
    textBody = deriveTextFromHtml(htmlBody)
  }

  return {
    subject: subject.value,
    ...(htmlBody !== undefined && { htmlBody }),
    ...(textBody !== undefined && { textBody }),
    errors,
  }
}
