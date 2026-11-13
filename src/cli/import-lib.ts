/**
 * Pure helpers for the app01 import scripts (Bauplan §6 / M7).
 * No DB or network access here — everything is unit-testable.
 */

/** Parse a dotenv-style file. Quotes are stripped, comments/blank lines ignored. */
export function parseEnvFile(content: string): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq < 1) continue
    const key = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) entries[key] = value
  }
  return entries
}

export interface TokenPlanEntry {
  name: string
  token: string
}

/** Every non-empty entry in tokens.env is a token; `only` restricts by key name. */
export function tokenPlan(
  env: Record<string, string>,
  options: { only?: string } = {},
): TokenPlanEntry[] {
  const only = options.only?.toLowerCase()
  return Object.entries(env)
    .filter(
      ([key, value]) =>
        value.length > 0 && (only === undefined || key.toLowerCase().includes(only)),
    )
    .map(([name, token]) => ({ name, token }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface RelayPlan {
  host: string
  port: number
  username: string
  password: string
  tlsMode: 'starttls' | 'implicit' | 'none'
}

/** Map smtp.env (several common key spellings) to relay_configs values. */
export function relayPlan(env: Record<string, string>): RelayPlan {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = env[key] ?? env[key.toUpperCase()] ?? env[key.toLowerCase()]
      if (value !== undefined && value.length > 0) return value
    }
    return undefined
  }
  const host = pick('SMTP_HOST', 'HOST', 'RELAY_HOST')
  const portRaw = pick('SMTP_PORT', 'PORT', 'RELAY_PORT') ?? '587'
  const username = pick('SMTP_USER', 'SMTP_USERNAME', 'USER', 'USERNAME')
  const password = pick('SMTP_PASS', 'SMTP_PASSWORD', 'PASS', 'PASSWORD')
  const tlsRaw = (pick('TLS_MODE', 'SMTP_TLS_MODE') ?? 'starttls').toLowerCase()

  const port = Number.parseInt(portRaw, 10)
  if (!host) throw new Error('smtp.env: missing host (SMTP_HOST/HOST/RELAY_HOST)')
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`smtp.env: invalid port "${portRaw}"`)
  }
  if (!username) throw new Error('smtp.env: missing username (SMTP_USER/USER)')
  if (!password) throw new Error('smtp.env: missing password (SMTP_PASS/PASS)')
  if (!['starttls', 'implicit', 'none'].includes(tlsRaw)) {
    throw new Error(`smtp.env: invalid TLS_MODE "${tlsRaw}" (starttls|implicit|none)`)
  }
  return { host, port, username, password, tlsMode: tlsRaw as RelayPlan['tlsMode'] }
}

export interface LayoutSpec {
  alias: string
  name: string
  htmlBody?: string
  textBody?: string
  /** Relative path inside the template directory, resolved by the CLI. */
  htmlFile?: string
  textFile?: string
}

export interface TemplateSpec {
  alias: string
  name: string
  subject: string
  htmlBody?: string
  textBody?: string
  htmlFile?: string
  textFile?: string
  subjectFile?: string
  layoutAlias?: string
}

export interface TemplateManifest {
  layouts?: LayoutSpec[]
  templates?: TemplateSpec[]
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`manifest: ${field} must be a non-empty string`)
  return value
}

/** Validate a manifest.json (bodies may be inline or file references). */
export function parseManifest(content: string): TemplateManifest {
  const parsed: unknown = JSON.parse(content)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest: expected an object')
  const obj = parsed as Record<string, unknown>
  const readList = <T>(key: string, map: (raw: Record<string, unknown>) => T): T[] => {
    const value = obj[key]
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error(`manifest: "${key}" must be an array`)
    return value.map((item) => {
      if (typeof item !== 'object' || item === null)
        throw new Error(`manifest: ${key} entries must be objects`)
      return map(item as Record<string, unknown>)
    })
  }
  const optional = <K extends string>(
    raw: Record<string, unknown>,
    key: K,
  ): Partial<Record<K, string>> => {
    const value = raw[key]
    return typeof value === 'string' ? ({ [key]: value } as Partial<Record<K, string>>) : {}
  }

  return {
    layouts: readList(
      'layouts',
      (raw): LayoutSpec => ({
        alias: assertString(raw.alias, 'layouts[].alias'),
        name: typeof raw.name === 'string' ? raw.name : assertString(raw.alias, 'layouts[].alias'),
        ...optional(raw, 'htmlBody'),
        ...optional(raw, 'textBody'),
        ...optional(raw, 'htmlFile'),
        ...optional(raw, 'textFile'),
      }),
    ),
    templates: readList(
      'templates',
      (raw): TemplateSpec => ({
        alias: assertString(raw.alias, 'templates[].alias'),
        name:
          typeof raw.name === 'string' ? raw.name : assertString(raw.alias, 'templates[].alias'),
        subject: typeof raw.subject === 'string' ? raw.subject : '',
        ...optional(raw, 'htmlBody'),
        ...optional(raw, 'textBody'),
        ...optional(raw, 'htmlFile'),
        ...optional(raw, 'textFile'),
        ...optional(raw, 'subjectFile'),
        ...optional(raw, 'layoutAlias'),
      }),
    ),
  }
}

/**
 * Fallback when no manifest.json exists: convention-based discovery from a
 * list of relative file paths (as returned by readdir).
 *   layouts/<alias>.html[/.txt]  → layouts
 *   <alias>.html / <alias>.txt  → templates
 *   <alias>.subject.txt         → subject
 */
export function discoverTemplates(paths: string[]): TemplateManifest {
  const layouts = new Map<string, LayoutSpec>()
  const templates = new Map<string, TemplateSpec>()

  for (const path of paths) {
    const normalised = path.replaceAll('\\', '/')
    const isLayout = normalised.startsWith('layouts/')
    if (isLayout && (normalised.endsWith('.html') || normalised.endsWith('.txt'))) {
      const base = normalised.slice('layouts/'.length).replace(/\.(html|txt)$/, '')
      const entry = layouts.get(base) ?? { alias: base, name: base }
      if (normalised.endsWith('.html')) entry.htmlFile = normalised
      else entry.textFile = normalised
      layouts.set(base, entry)
      continue
    }
    if (!isLayout && /^[^/]+\.(html|txt|subject\.txt)$/.test(normalised)) {
      if (normalised.endsWith('.subject.txt')) {
        const alias = normalised.replace('.subject.txt', '')
        const entry = templates.get(alias) ?? { alias, name: alias, subject: '' }
        entry.subjectFile = normalised
        templates.set(alias, entry)
        continue
      }
      const alias = normalised.replace(/\.(html|txt)$/, '')
      const entry = templates.get(alias) ?? { alias, name: alias, subject: '' }
      if (normalised.endsWith('.html')) entry.htmlFile = normalised
      else entry.textFile = normalised
      templates.set(alias, entry)
    }
  }

  return {
    layouts: [...layouts.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
    templates: [...templates.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
  }
}
