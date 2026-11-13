import type { MessageRecord } from '../core/store.js'

/**
 * Phase 2 (M8): Open-/Click-Tracking. Wird beim Versand angewendet — der
 * gespeicherte Nachrichteninhalt bleibt unverändert (Original bleibt abrufbar).
 */

export interface TrackedBodies {
  html?: string
  text?: string
}

export function openPixelUrl(baseUrl: string, messageId: string): string {
  return `${baseUrl}/track/open/${encodeURIComponent(messageId)}`
}

export function clickUrl(
  baseUrl: string,
  messageId: string,
  target: string,
  location: 'HTML' | 'Text',
): string {
  const params = new URLSearchParams({ url: target, location })
  return `${baseUrl}/track/click/${encodeURIComponent(messageId)}?${params.toString()}`
}

/** Rewrite http(s)-Links in href-Attributen auf den Tracking-Endpunkt. */
export function rewriteHtmlLinks(html: string, messageId: string, baseUrl: string): string {
  return html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*)(["']?)(https?:\/\/[^"'\s>]+)\2/gi,
    (_match, prefix: string, _quote: string, target: string) =>
      `${prefix}"${clickUrl(baseUrl, messageId, target, 'HTML')}"`,
  )
}

/** Rewrite nackte URLs im Textpart. */
export function rewriteTextLinks(text: string, messageId: string, baseUrl: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (target) =>
    clickUrl(baseUrl, messageId, target, 'Text'),
  )
}

/** 1x1-Pixel vor </body> (oder am Ende), falls noch keines vorhanden ist. */
export function injectOpenPixel(html: string, baseUrl: string, messageId: string): string {
  const pixel = `<img src="${openPixelUrl(baseUrl, messageId)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0" />`
  if (html.includes('/track/open/')) return html
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${pixel}</body>`)
  return `${html}${pixel}`
}

/**
 * Liefert die für den Versand transformierten Bodies oder null, wenn für die
 * Nachricht kein Tracking aktiv ist.
 */
export function transformForTracking(
  message: MessageRecord,
  baseUrl: string,
): TrackedBodies | null {
  const mode = message.trackLinks ?? 'None'
  if (!message.trackOpens && mode === 'None') return null
  const htmlEnabled = mode === 'HtmlAndText' || mode === 'HtmlOnly'
  const textEnabled = mode === 'HtmlAndText' || mode === 'TextOnly'
  const result: TrackedBodies = {}
  if (message.htmlBody !== undefined) {
    let html = htmlEnabled
      ? rewriteHtmlLinks(message.htmlBody, message.id, baseUrl)
      : message.htmlBody
    if (message.trackOpens) html = injectOpenPixel(html, baseUrl, message.id)
    result.html = html
  }
  if (message.textBody !== undefined) {
    const base = textEnabled
      ? rewriteTextLinks(message.textBody, message.id, baseUrl)
      : message.textBody
    // Ohne HTML-Part kann kein Pixel eingebettet werden: Tracking-Link anhängen.
    result.text =
      message.trackOpens && message.htmlBody === undefined
        ? `${base}\n${openPixelUrl(baseUrl, message.id)}`
        : base
  }
  return result
}
