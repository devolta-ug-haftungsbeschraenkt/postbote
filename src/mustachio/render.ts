/**
 * mustachio — Postmark-kompatibles Template-Rendering (Bauplan §4, Portierung
 * von render.mjs). Eigenschaften gemäß Analyse/Umsstellungsdokument:
 *
 * 1. `{{#each Array}}` → Mustache-Section-Übersetzung; innerhalb des Loops
 *    sind die Item-Properties direkt erreichbar.
 * 2. Parent-Refs mit `../../` — jede Section-Ebene ist ein Kontext-Frame.
 * 3. Layouts mit `{{{content}}}` (auch `{{@content}}`).
 * 4. Postmark-Escaping: nur `& < > " '` → Entities; alles andere bleibt roh.
 * 5. Subject/Text werden NICHT escaped (roh gerendert).
 * 6. Fehlt TextBody, wird er aus HTML abgeleitet.
 */

export interface RenderedPart {
  value: string
  /** Syntax errors found while parsing (unclosed sections, bad paths). */
  errors: RenderError[]
}

export interface RenderError {
  message: string
  /** 1-based line number in the template source. */
  line: number
}

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'var'; path: string; escape: boolean; line: number }
  | { kind: 'open'; name: string; path: string; inverted: boolean; line: number }
  | { kind: 'close'; name: string; line: number }
  | { kind: 'else'; line: number }

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Postmark escaping: only & < > " ' — not the full HTML entity table. */
export function escapePostmark(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

/** Tokenize template source into text/vars/sections. */
export function tokenize(source: string): { tokens: Token[]; errors: RenderError[] } {
  const tokens: Token[] = []
  const errors: RenderError[] = []
  const stack: { name: string; line: number }[] = []
  const re = /\{\{\s*(\{?)\s*([#/^]?)([^}]*?)\s*\}?\s*\}\}/g

  let lastIndex = 0

  const lineAt = (index: number): number => source.slice(0, index).split('\n').length

  for (;;) {
    const match = re.exec(source)
    if (match === null) break
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', value: source.slice(lastIndex, match.index) })
    }
    const triple = match[1] === '{'
    const sigil = match[2]
    const name = (match[3] ?? '').trim()
    const line = lineAt(match.index)

    if (name === '') {
      errors.push({ message: 'Empty template tag', line })
    } else if (sigil === '#' || sigil === '^') {
      // Postmark section operators: `{{#each X}}`, `{{#if X}}`, `{{#unless X}}`,
      // plus plain Mustache sections `{{#X}}`. The canonical name (used for
      // matching the closing tag) is the operator; the path is the argument.
      const [operator = '', ...rest] = name.split(/\s+/)
      const KNOWN = ['each', 'if', 'unless']
      const canonical =
        sigil === '#' && KNOWN.includes(operator) && rest.length > 0 ? operator : name
      const path = canonical === name ? name : rest.join(' ')
      tokens.push({ kind: 'open', name: canonical, path, inverted: sigil === '^', line })
      stack.push({ name: canonical, line })
    } else if (sigil === '/' || name.startsWith('/')) {
      const closeName = sigil === '/' ? name : name.slice(1).trim()
      const top = stack.pop()
      if (!top) {
        errors.push({
          message: `Unexpected closing tag '{{/${closeName}}}' — no open section`,
          line,
        })
      } else if (top.name !== closeName) {
        errors.push({
          message: `Mismatched closing tag '{{/${closeName}}}' — expected '{{/${top.name}}}' (opened at line ${top.line})`,
          line,
        })
      }
      tokens.push({ kind: 'close', name: closeName, line })
    } else if (name === 'else') {
      tokens.push({ kind: 'else', line })
    } else {
      tokens.push({ kind: 'var', path: name, escape: !triple, line })
    }

    // The regex consumed either the double or the triple-close; when a triple
    // was opened, the extra `}` is part of `[^}]*?` handling above — account
    // for the trailing brace explicitly:
    if (triple && source[re.lastIndex] === '}') re.lastIndex++
    lastIndex = re.lastIndex
  }

  if (lastIndex < source.length) {
    tokens.push({ kind: 'text', value: source.slice(lastIndex) })
  }
  for (const unclosed of stack.reverse()) {
    errors.push({
      message: `Unclosed section '{{#${unclosed.name}}}'`,
      line: unclosed.line,
    })
  }
  return { tokens, errors }
}

type Segment = { kind: 'name'; value: string } | { kind: 'parent' }

/** Parse a lookup path: `../../A.B` → [parent, parent, name A, name B]. */
function parsePath(path: string): Segment[] {
  const segments: Segment[] = []
  let rest = path
  while (rest.startsWith('../')) {
    segments.push({ kind: 'parent' })
    rest = rest.slice(3)
  }
  if (rest.startsWith('./')) rest = rest.slice(2)
  for (const part of rest.split('.')) {
    if (part !== '') segments.push({ kind: 'name', value: part })
  }
  return segments
}

/** Resolve a path against the context stack (frames: innermost last). */
function lookup(contexts: unknown[], path: string): unknown {
  const segments = parsePath(path)
  let frameCount = contexts.length
  let index = 0

  // Consume parent hops against the frame stack.
  while (index < segments.length && segments[index]?.kind === 'parent') {
    frameCount--
    if (frameCount < 0) return undefined
    index++
  }
  let current: unknown = contexts[Math.max(0, frameCount - 1)]
  for (; index < segments.length; index++) {
    const segment = segments[index]
    if (segment === undefined || segment.kind !== 'name') return undefined
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment.value]
  }
  return current
}

/** Truthiness per Mustache: empty arrays and empty strings are falsy. */
function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.length > 0
  return Boolean(value)
}

function renderTokens(tokens: Token[], contexts: unknown[], escapeVariables: boolean): string {
  let out = ''
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    i++
    if (token === undefined) break
    switch (token.kind) {
      case 'text':
        out += token.value
        break
      case 'var': {
        const value = lookup(contexts, token.path)
        const str = value === null || value === undefined ? '' : String(value)
        // Part-level escape decides the default (HTML parts escape, Subject/Text
        // are raw); `{{{Var}}}` always overrides to raw.
        out += escapeVariables && token.escape ? escapePostmark(str) : str
        break
      }
      case 'open': {
        const value = lookup(contexts, token.path)
        const body = collectSection(tokens, i)
        i = body.end
        if (token.inverted || token.name === 'unless') {
          if (!isTruthy(value))
            out += renderTokens(body.elseTokens ?? body.tokens, contexts, escapeVariables)
        } else if (token.name === 'if') {
          if (isTruthy(value)) {
            out += renderTokens(body.tokens, contexts, escapeVariables)
          } else if (body.elseTokens !== undefined) {
            out += renderTokens(body.elseTokens, contexts, escapeVariables)
          }
        } else if (token.name === 'each') {
          if (Array.isArray(value)) {
            for (const item of value) {
              out += renderTokens(body.tokens, [...contexts, item], escapeVariables)
            }
          } else if (body.elseTokens !== undefined) {
            out += renderTokens(body.elseTokens, contexts, escapeVariables)
          }
        } else if (Array.isArray(value)) {
          // Plain Mustache section over an array.
          for (const item of value) {
            out += renderTokens(body.tokens, [...contexts, item], escapeVariables)
          }
        } else if (isTruthy(value)) {
          out += renderTokens(body.tokens, [...contexts, value], escapeVariables)
        } else if (body.elseTokens !== undefined) {
          out += renderTokens(body.elseTokens, contexts, escapeVariables)
        }
        break
      }
      default:
        break
    }
  }
  return out
}

interface SectionBody {
  tokens: Token[]
  /** Tokens after the top-level {{else}} (undefined when absent). */
  elseTokens?: Token[]
  /** Index of the token after the closing tag. */
  end: number
}

/** Collect tokens of a section body (handles nesting + else). */
function collectSection(tokens: Token[], start: number): SectionBody {
  const body: Token[] = []
  let elseTokens: Token[] | undefined
  let depth = 1
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    i++
    if (token === undefined) break
    if (token.kind === 'open') depth++
    if (token.kind === 'close') {
      depth--
      if (depth === 0)
        return { tokens: body, ...(elseTokens !== undefined && { elseTokens }), end: i }
    }
    if (token.kind === 'else' && depth === 1) {
      elseTokens = []
      continue
    }
    if (elseTokens !== undefined) elseTokens.push(token)
    else body.push(token)
  }
  return { tokens: body, ...(elseTokens !== undefined && { elseTokens }), end: i } // unclosed — tokenizer already reported
}

/** Render one template part. `escapeVariables` = Postmark variable escaping (HTML only). */
export function renderPart(source: string, model: unknown, escapeVariables: boolean): RenderedPart {
  const { tokens, errors } = tokenize(source)
  const value = renderTokens(tokens, [model ?? {}], escapeVariables)
  return { value, errors }
}

/** Layout support: insert rendered content into `{{{content}}}` / `{{@content}}`
 * AND render the layout itself with the same model (app01 layouts contain
 * `{{#application}}`, `{{^logoUrl}}`, `{{../../name}}`, `{{{.}}}` etc.).
 * Sentinels keep the already-rendered content out of the second render pass.
 */
const RAW_CONTENT = '\u0000PB_CONTENT_RAW\u0000'
const ESC_CONTENT = '\u0000PB_CONTENT_ESC\u0000'

export function applyLayout(
  layoutSource: string,
  content: string,
  model: unknown = {},
  escapeVariables = true,
): RenderedPart {
  const source = layoutSource
    .replace(/\{\{\{\s*@?content\s*\}\}\}/g, RAW_CONTENT)
    .replace(/\{\{\s*@?content\s*\}\}/g, ESC_CONTENT)
  const rendered = renderPart(source, model, escapeVariables)
  return {
    value: rendered.value
      .split(RAW_CONTENT)
      .join(content)
      .split(ESC_CONTENT)
      .join(escapePostmark(content)),
    errors: rendered.errors,
  }
}

/**
 * HTML → Text derivation (Bauplan §4): used when a template has no TextBody.
 * Block tags become line breaks; entities are decoded; tags stripped.
 */
export function deriveTextFromHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/table|\/blockquote|\/pre)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}
