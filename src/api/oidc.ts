import { type JsonWebKey, createPublicKey, createVerify } from 'node:crypto'
import { type PostboteConfig, loadConfig } from '../config/env.js'

/**
 * OIDC/JWT-Verifikation für Logto (docs/OIDC.md). Ohne externe Dependency:
 * Discovery + JWKS über fetch, Signaturprüfung über node:crypto (JWK).
 */
export interface OidcClaims {
  sub: string
  iss: string
  aud?: string | string[]
  exp?: number
  iat?: number
  nbf?: number
  scope?: string
  scopes?: string | string[]
  roles?: string | string[]
  [key: string]: unknown
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcError'
  }
}

export interface OidcVerifierOptions {
  issuer: string
  audience: string
  requiredScope: string
  jwksTtlMs: number
}

const SUPPORTED_ALGS = new Set(['RS256', 'RS384', 'RS512', 'ES256'])
const CLOCK_SKEW_SECONDS = 5
const FETCH_TIMEOUT_MS = 5000

export class OidcVerifier {
  private jwks: JsonWebKey[] = []
  private jwksUri: string | null = null
  private expectedIssuers = new Set<string>()
  private fetchedAt = 0
  private inflight: Promise<void> | null = null

  constructor(
    private readonly options: OidcVerifierOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async discover(): Promise<string> {
    const base = this.options.issuer
    const candidates = [
      `${base}/.well-known/openid-configuration`,
      `${base}/oidc/.well-known/openid-configuration`,
    ]
    let lastError: unknown
    for (const url of candidates) {
      try {
        const response = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!response.ok) {
          lastError = new OidcError(`OIDC discovery failed: HTTP ${response.status}`)
          continue
        }
        const doc = (await response.json()) as { jwks_uri?: string; issuer?: string }
        if (typeof doc.jwks_uri !== 'string') {
          lastError = new OidcError('OIDC discovery has no jwks_uri')
          continue
        }
        this.jwksUri = doc.jwks_uri
        this.expectedIssuers = new Set(
          [doc.issuer, base, `${base}/oidc`].filter((v): v is string => typeof v === 'string'),
        )
        return doc.jwks_uri
      } catch (err) {
        lastError = err
      }
    }
    throw lastError instanceof Error ? lastError : new OidcError('OIDC discovery failed')
  }

  private async loadJwks(force: boolean): Promise<JsonWebKey[]> {
    const fresh = Date.now() - this.fetchedAt < this.options.jwksTtlMs
    if (!force && this.jwks.length > 0 && fresh) return this.jwks
    if (this.inflight) {
      await this.inflight
      return this.jwks
    }
    this.inflight = (async () => {
      const uri = this.jwksUri ?? (await this.discover())
      const response = await this.fetchImpl(uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) throw new OidcError(`JWKS fetch failed: HTTP ${response.status}`)
      const data = (await response.json()) as { keys?: JsonWebKey[] }
      if (!Array.isArray(data.keys) || data.keys.length === 0) {
        throw new OidcError('JWKS has no keys')
      }
      this.jwks = data.keys
      this.fetchedAt = Date.now()
    })()
    try {
      await this.inflight
    } finally {
      this.inflight = null
    }
    return this.jwks
  }

  async verify(token: string): Promise<OidcClaims> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new OidcError('malformed JWT')
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    let header: { alg?: string; kid?: string }
    let claims: OidcClaims
    try {
      header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as typeof header
      claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as OidcClaims
    } catch {
      throw new OidcError('malformed JWT payload')
    }
    const alg = header.alg
    if (!alg || !SUPPORTED_ALGS.has(alg)) throw new OidcError(`unsupported alg: ${alg ?? 'none'}`)

    let jwks = await this.loadJwks(false)
    let jwk = header.kid ? jwks.find((key) => key.kid === header.kid) : jwks[0]
    if (!jwk && header.kid) {
      // Key-Rotation: unbekannte kid → JWKS verwerfen und neu laden.
      jwks = await this.loadJwks(true)
      jwk = jwks.find((key) => key.kid === header.kid)
    }
    if (!jwk) throw new OidcError('no matching JWKS key')

    let key
    try {
      key = createPublicKey({ key: jwk, format: 'jwk' })
    } catch {
      throw new OidcError('invalid JWKS key')
    }
    const digest = alg === 'ES256' ? 'SHA256' : `RSA-SHA${alg.slice(2)}`
    const verifier = createVerify(digest)
    verifier.update(`${headerPart}.${payloadPart}`)
    const signature = Buffer.from(signaturePart, 'base64url')
    const valid =
      alg === 'ES256'
        ? verifier.verify({ key, dsaEncoding: 'ieee-p1363' }, signature)
        : verifier.verify(key, signature)
    if (!valid) throw new OidcError('invalid signature')

    const now = Math.floor(Date.now() / 1000)
    if (this.expectedIssuers.size > 0 && !this.expectedIssuers.has(claims.iss)) {
      throw new OidcError('invalid issuer')
    }
    if (this.options.audience && !audienceMatches(claims.aud, this.options.audience)) {
      throw new OidcError('invalid audience')
    }
    if (typeof claims.exp !== 'number' || claims.exp <= now - CLOCK_SKEW_SECONDS) {
      throw new OidcError('token expired or missing exp')
    }
    if (claims.nbf !== undefined && claims.nbf > now + CLOCK_SKEW_SECONDS) {
      throw new OidcError('token not yet valid')
    }
    if (claims.iat !== undefined && claims.iat > now + CLOCK_SKEW_SECONDS) {
      throw new OidcError('token issued in the future')
    }
    if (this.options.requiredScope && !hasScope(claims, this.options.requiredScope)) {
      throw new OidcError(`missing required scope: ${this.options.requiredScope}`)
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new OidcError('missing sub')
    }
    return claims
  }
}

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected
  if (Array.isArray(aud)) return aud.includes(expected)
  return false
}

function hasScope(claims: OidcClaims, required: string): boolean {
  const candidates: string[] = []
  if (typeof claims.scope === 'string') candidates.push(...claims.scope.split(' '))
  for (const key of ['scopes', 'roles'] as const) {
    const value = claims[key]
    if (typeof value === 'string') candidates.push(...value.split(' '))
    else if (Array.isArray(value))
      candidates.push(...value.filter((v): v is string => typeof v === 'string'))
  }
  return candidates.includes(required)
}

let cached: { signature: string; verifier: OidcVerifier } | null = null

/** Singleton mit Config-Signatur: bei Env-Änderungen wird neu gebaut. */
export function getOidcVerifier(config: PostboteConfig = loadConfig()): OidcVerifier {
  const signature = [
    config.oidcIssuer,
    config.oidcAudience,
    config.oidcRequiredScope,
    config.oidcJwksTtlMs,
  ].join('|')
  if (!cached || cached.signature !== signature) {
    cached = {
      signature,
      verifier: new OidcVerifier({
        issuer: config.oidcIssuer,
        audience: config.oidcAudience,
        requiredScope: config.oidcRequiredScope,
        jwksTtlMs: config.oidcJwksTtlMs,
      }),
    }
  }
  return cached.verifier
}

export function resetOidcVerifier(): void {
  cached = null
}
