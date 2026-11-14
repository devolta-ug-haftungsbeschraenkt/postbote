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

    // Layout (Postmark-Parität: Template erbt von LayoutTemplate). Das Layout
    // ist selbst ein Mustache-Template und wird mit demselben Modell gerendert.
    if (template.layoutAlias) {
      const layout = await store.findLayout(serverId, template.layoutAlias)
      if (layout) {
        const layoutHtml = applyLayout(layout.htmlBody, htmlBody ?? '', model, true)
        for (const e of layoutHtml.errors) {
          errors.push({ part: 'layout', message: e.message, line: e.line })
        }
        htmlBody = layoutHtml.value

        if (textBody === undefined && layout.textBody !== undefined) {
          const innerText = deriveTextFromHtml(html.value)
          const layoutText = applyLayout(layout.textBody, innerText, model, false)
          for (const e of layoutText.errors) {
            errors.push({ part: 'layout-text', message: e.message, line: e.line })
          }
          textBody = layoutText.value
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
