import type { PostboteRole } from './role.js'

export interface PostboteConfig {
  role: PostboteRole
  port: number
  host: string
  databaseUrl: string
  /** Initial bootstrap token for the default server, if the DB is empty. */
  bootstrapToken: string
  logLevel: string
  /** SMTP ingress ports (Bauplan M5: 2525/587). Empty string disables SMTP. */
  smtpPorts: number[]
  /** TLS key/cert for STARTTLS; without them SMTP runs plain (logged warning). */
  smtpTlsKey: string
  smtpTlsCert: string
  /** Public base URL used for tracking pixel/click links (M8). */
  trackingBaseUrl: string
  /** Requests per minute per server token; 0 disables rate limiting. */
  rateLimitPerMinute: number
  /** AES-256-GCM key for secrets at rest; empty = plaintext legacy mode. */
  secretKey: string
  /** Auth mode: both (OIDC + static tokens), oidc (OIDC only), token (static only). */
  authMode: 'both' | 'oidc' | 'token'
  oidcIssuer: string
  oidcAudience: string
  oidcRequiredScope: string
  oidcServerSlug: string
  oidcJwksTtlMs: number
}

function str(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value : fallback
}

function intList(value: string | undefined, fallback: number[]): number[] {
  if (value === undefined) return fallback
  // Explicit empty value disables the SMTP ingress entirely.
  if (value.trim().length === 0) return []
  return value
    .split(',')
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((p) => Number.isFinite(p) && p > 0)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PostboteConfig {
  return {
    role: str(env.POSTBOTE_ROLE, 'all') as PostboteRole,
    port: Number.parseInt(str(env.POSTBOTE_PORT, '3000'), 10),
    host: str(env.POSTBOTE_HOST, '0.0.0.0'),
    databaseUrl: str(
      env.POSTBOTE_DATABASE_URL,
      'postgres://postbote:postbote@localhost:5432/postbote',
    ),
    bootstrapToken: str(env.POSTBOTE_BOOTSTRAP_TOKEN, 'postbote-bootstrap-token'),
    logLevel: str(env.POSTBOTE_LOG_LEVEL, 'info'),
    smtpPorts: intList(env.POSTBOTE_SMTP_PORTS, [2525, 587]),
    smtpTlsKey: str(env.POSTBOTE_SMTP_TLS_KEY, ''),
    smtpTlsCert: str(env.POSTBOTE_SMTP_TLS_CERT, ''),
    trackingBaseUrl: str(env.POSTBOTE_TRACKING_BASE_URL, 'http://localhost:3000').replace(
      /\/+$/,
      '',
    ),
    rateLimitPerMinute: Number.parseInt(str(env.POSTBOTE_RATE_LIMIT_PER_MIN, '600'), 10),
    secretKey: str(env.POSTBOTE_SECRET_KEY, ''),
    authMode: (['both', 'oidc', 'token'].includes(str(env.POSTBOTE_AUTH_MODE, 'both'))
      ? str(env.POSTBOTE_AUTH_MODE, 'both')
      : 'both') as PostboteConfig['authMode'],
    oidcIssuer: str(env.POSTBOTE_OIDC_ISSUER, '').replace(/\/+$/, ''),
    oidcAudience: str(env.POSTBOTE_OIDC_AUDIENCE, ''),
    oidcRequiredScope: str(env.POSTBOTE_OIDC_REQUIRED_SCOPE, ''),
    oidcServerSlug: str(env.POSTBOTE_OIDC_SERVER_SLUG, 'default'),
    oidcJwksTtlMs: Number.parseInt(str(env.POSTBOTE_OIDC_JWKS_TTL_MS, '3600000'), 10),
  }
}
