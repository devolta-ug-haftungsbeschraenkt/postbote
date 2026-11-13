/**
 * Minimaler, abhängigkeitsfreier OIDC-Client (Authorization Code + PKCE) für Logto.
 *
 * Konfiguration kommt zur Laufzeit aus /config.js (window.__POSTBOTE_CONFIG__.oidc),
 * für die Entwicklung ersatzweise aus VITE_LOGTO_* env-Variablen. Runtime-Konfiguration
 * gewinnt. Ist weder Issuer noch Client-ID vorhanden, ist OIDC deaktiviert und die UI
 * läuft unverändert im Demo-/Static-Token-Modus.
 *
 * Es werden absichtlich keine Token-Werte geloggt.
 */

export interface OidcConfig {
  issuer: string
  clientId: string
  resource?: string
  scopes?: string[]
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

const STORAGE_KEYS = {
  verifier: 'postbote.oidc.code_verifier',
  state: 'postbote.oidc.state',
  accessToken: 'postbote.oidc.access_token',
  refreshToken: 'postbote.oidc.refresh_token',
  expiresAt: 'postbote.oidc.expires_at',
} as const

/* ---- Konfiguration ---- */

/** Liest die Runtime-Konfiguration defensiv (untrusted) über unknown-Casts. */
function getRuntimeOidc(): unknown {
  if (typeof window === 'undefined') return undefined
  const config = (window as unknown as { __POSTBOTE_CONFIG__?: unknown }).__POSTBOTE_CONFIG__
  if (typeof config !== 'object' || config === null) return undefined
  return (config as Record<string, unknown>)['oidc']
}

/** Baut ein Konfigurationsobjekt aus den VITE_* Fallbacks (Dev). */
function buildViteOidc(): Record<string, unknown> {
  const scopesEnv = import.meta.env.VITE_LOGTO_SCOPES
  const scopes =
    typeof scopesEnv === 'string'
      ? scopesEnv
          .split(',')
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0)
      : []
  return {
    issuer: import.meta.env.VITE_LOGTO_ENDPOINT,
    clientId: import.meta.env.VITE_LOGTO_APP_ID,
    resource: import.meta.env.VITE_LOGTO_RESOURCE,
    scopes,
  }
}

/** Validiert ein unbekanntes Objekt zu einer OidcConfig (oder null). */
function normalizeOidc(value: unknown): OidcConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>

  const issuer = typeof obj['issuer'] === 'string' ? obj['issuer'].trim().replace(/\/+$/, '') : ''
  const clientId = typeof obj['clientId'] === 'string' ? obj['clientId'].trim() : ''
  if (issuer === '' || clientId === '') return null

  const resource = typeof obj['resource'] === 'string' ? obj['resource'].trim() : ''
  const scopes = Array.isArray(obj['scopes'])
    ? obj['scopes']
        .filter((scope): scope is string => typeof scope === 'string' && scope.trim().length > 0)
        .map((scope) => scope.trim())
    : []

  return {
    issuer,
    clientId,
    ...(resource !== '' ? { resource } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
  }
}

/** Runtime-Konfiguration zuerst, danach VITE_*. null, wenn OIDC nicht konfiguriert ist. */
export function getOidcConfig(): OidcConfig | null {
  const fromRuntime = normalizeOidc(getRuntimeOidc())
  if (fromRuntime) return fromRuntime
  return normalizeOidc(buildViteOidc())
}

export function isOidcEnabled(): boolean {
  return getOidcConfig() !== null
}

/* ---- PKCE-Hilfen ---- */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generateRandomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

function getRedirectUri(): string {
  return `${window.location.origin}/callback`
}

function buildScopes(scopes?: string[]): string {
  const all = scopes ? ['openid', 'profile', ...scopes] : ['openid', 'profile']
  const unique = Array.from(
    new Set(all.map((scope) => scope.trim()).filter((scope) => scope.length > 0)),
  )
  return unique.join(' ')
}

/* ---- Token-Speicher ---- */

function storeTokens(token: TokenResponse): void {
  sessionStorage.setItem(STORAGE_KEYS.accessToken, token.access_token)
  if (token.refresh_token) {
    sessionStorage.setItem(STORAGE_KEYS.refreshToken, token.refresh_token)
  } else {
    sessionStorage.removeItem(STORAGE_KEYS.refreshToken)
  }
  const expiresIn = token.expires_in ?? 3600
  sessionStorage.setItem(STORAGE_KEYS.expiresAt, String(Date.now() + expiresIn * 1000))
}

function clearTokens(): void {
  sessionStorage.removeItem(STORAGE_KEYS.accessToken)
  sessionStorage.removeItem(STORAGE_KEYS.refreshToken)
  sessionStorage.removeItem(STORAGE_KEYS.expiresAt)
}

function parseTokenResponse(data: unknown): TokenResponse {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Ungültige Antwort des Anmeldedienstes.')
  }
  const obj = data as Record<string, unknown>
  const accessToken = obj['access_token']
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Ungültige Antwort des Anmeldedienstes (kein Access-Token).')
  }
  const refreshToken = typeof obj['refresh_token'] === 'string' ? obj['refresh_token'] : undefined
  const expiresIn = typeof obj['expires_in'] === 'number' ? obj['expires_in'] : undefined
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn }
}

/**
 * Liefert den gültigen Access-Token oder null. Bewusst synchron und ohne Refresh:
 * ein abgelaufener Token wird verworfen; die UI zeigt dann erneut „Anmelden".
 */
export function getAccessToken(): string | null {
  const token = sessionStorage.getItem(STORAGE_KEYS.accessToken)
  if (!token) return null
  const expiresAt = Number(sessionStorage.getItem(STORAGE_KEYS.expiresAt) ?? 0)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    clearTokens()
    return null
  }
  return token
}

export function isAuthenticated(): boolean {
  return getAccessToken() !== null
}

/* ---- JWT-Payload (nur Anzeige, keine Signaturprüfung im Browser) ---- */

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  const segment = parts[1] ?? ''
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Anzeigename aus name / email / sub des Access-Tokens (oder null). */
export function getUserLabel(): string | null {
  const token = getAccessToken()
  if (!token) return null
  const payload = decodeJwtPayload(token)
  if (!payload) return null
  for (const claim of ['name', 'email', 'sub'] as const) {
    const value = payload[claim]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/* ---- Flows ---- */

/** Startet den Authorization-Code-Flow mit PKCE (Redirect zum Issuer). */
export async function signIn(): Promise<void> {
  const config = getOidcConfig()
  if (!config) return

  const verifier = generateRandomString()
  const challenge = await generateCodeChallenge(verifier)
  const state = generateRandomString()
  sessionStorage.setItem(STORAGE_KEYS.verifier, verifier)
  sessionStorage.setItem(STORAGE_KEYS.state, state)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: getRedirectUri(),
    scope: buildScopes(config.scopes),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  if (config.resource) params.set('resource', config.resource)

  window.location.assign(`${config.issuer}/oidc/auth?${params.toString()}`)
}

/**
 * Verarbeitet den OIDC-Callback: State prüfen, Code gegen Token tauschen,
 * Tokens speichern und zurück zur Startseite. Wirft bei Fehlern eine Error
 * mit deutscher Meldung (inkl. `error`-Query-Parameter des Providers).
 */
export async function handleCallback(): Promise<void> {
  const params = new URLSearchParams(window.location.search)

  const providerError = params.get('error')
  if (providerError) {
    const description = params.get('error_description')
    throw new Error(description ?? `Anmeldung abgebrochen (${providerError}).`)
  }

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) {
    throw new Error('Ungültige Antwort des Anmeldedienstes (fehlender Code oder State).')
  }

  const storedState = sessionStorage.getItem(STORAGE_KEYS.state)
  const verifier = sessionStorage.getItem(STORAGE_KEYS.verifier)
  if (verifier === null || state !== storedState) {
    throw new Error('Sicherheitsprüfung fehlgeschlagen. Bitte melden Sie sich erneut an.')
  }

  const config = getOidcConfig()
  if (!config) throw new Error('OIDC-Konfiguration fehlt.')

  // Verbrauchte PKCE-/State-Werte immer entfernen.
  sessionStorage.removeItem(STORAGE_KEYS.state)
  sessionStorage.removeItem(STORAGE_KEYS.verifier)

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    client_id: config.clientId,
    code_verifier: verifier,
  })

  const response = await fetch(`${config.issuer}/oidc/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    throw new Error('Token-Austausch fehlgeschlagen. Bitte melden Sie sich erneut an.')
  }

  const tokens = parseTokenResponse((await response.json()) as unknown)
  storeTokens(tokens)
  window.location.replace('/')
}

/** Löscht Tokens und leitet zum Logout-Endpunkt (oder zur Startseite) weiter. */
export function signOut(): void {
  const config = getOidcConfig()
  clearTokens()
  sessionStorage.removeItem(STORAGE_KEYS.state)
  sessionStorage.removeItem(STORAGE_KEYS.verifier)

  if (config) {
    const params = new URLSearchParams({
      client_id: config.clientId,
      post_logout_redirect_uri: `${window.location.origin}/`,
    })
    window.location.assign(`${config.issuer}/oidc/logout?${params.toString()}`)
  } else {
    window.location.assign('/')
  }
}
