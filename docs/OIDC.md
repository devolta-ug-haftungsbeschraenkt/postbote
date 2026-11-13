# Authentifizierung via OIDC / Logto

> **Anforderung (vom 13.11.2026, ausdrücklich als wichtiger Zusatz notiert):**
> Die Authentifizierung soll über **OIDC mit Logto** gehen.
> Dieses Dokument ist die verbindliche Grundlage für die Umsetzung.

## Entscheidung

postbote unterstützt **zwei Auth-Pfade**, umschaltbar über
`POSTBOTE_AUTH_MODE`:

| Modus | Bedeutung |
|---|---|
| `both` (Default) | OIDC-Bearer-Token **oder** `X-Postmark-Server-Token` |
| `oidc` | Nur OIDC-Bearer; statische Tokens werden abgelehnt |
| `token` | Nur statische Tokens (bisheriges Verhalten, Notfall-Fallback) |

**Warum dual:** Die Postmark-kompatible API ist für Maschinen-Clients gedacht
(Logto, Desk, servease, aar …). Diese sprechen heute `X-Postmark-Server-Token`
und dürfen nicht durch einen Login-Flow brechen. OIDC ergänzt die Auth für
**Menschen / Admin-UI** und optional für Service-to-Service mit Logto-
Access-Tokens. Ein Wechsel zu `POSTBOTE_AUTH_MODE=oidc` ist jederzeit möglich,
wenn alle Clients umgestellt sind.

> Falls die Anforderung „ausschliesslich OIDC" meint: `POSTBOTE_AUTH_MODE=oidc`
> setzen und die statischen Tokens ausser Betrieb nehmen. Die Architektur ist
> dafür bereits vorbereitet.

## Architektur

```
Browser (Admin-UI)
   │  1. Authorization Code + PKCE gegen Logto
   ▼
Logto (Issuer)  ── 2. Access-Token (JWT, RS256/ES256)
   │
   │  3. Authorization: Bearer <JWT>
   ▼
postbote API ── 4. JWKS vom Issuer laden + Signatur/Claims prüfen
                  (iss, aud, exp, nbf, scope/roles)
                5. Server-Scope aus POSTBOTE_OIDC_SERVER_SLUG auflösen
   ▼
Postgres (Messages, Queue, …)
```

Maschinen-Clients senden weiterhin `X-Postmark-Server-Token` und landen über
`server_tokens.token_hash` im gleichen Server-Scope.

Es werden **keine neuen Backend-Dependencies** benötigt: JWT-Verifikation über
`node:crypto` (`createPublicKey` mit JWK), JWKS/Discovery über `fetch`.

## Konfiguration

| Variable | Default | Zweck |
|---|---|---|
| `POSTBOTE_AUTH_MODE` | `both` | `both` · `oidc` · `token` |
| `POSTBOTE_OIDC_ISSUER` | – | Logto-Issuer, z. B. `https://logto.example.com` |
| `POSTBOTE_OIDC_AUDIENCE` | – | Erwarteter `aud` (API-Resource in Logto) |
| `POSTBOTE_OIDC_REQUIRED_SCOPE` | – | Pflicht-Scope/Role, z. B. `postbote:admin` (leer = jedes gültige Token) |
| `POSTBOTE_OIDC_SERVER_SLUG` | `default` | Server, dem OIDC-Principals zugeordnet werden |
| `POSTBOTE_OIDC_JWKS_TTL_MS` | `3600000` | Cache-Lebensdauer für JWKS |

Admin-UI (Runtime-Config, siehe `docker/ui-entrypoint.sh`):

| Variable | Zweck |
|---|---|
| `POSTBOTE_UI_OIDC_ISSUER` | Logto-Endpoint für den PKCE-Flow |
| `POSTBOTE_UI_OIDC_CLIENT_ID` | Logto SPA-App-ID |
| `POSTBOTE_UI_OIDC_RESOURCE` | API-Resource für das Access-Token |
| `POSTBOTE_UI_OIDC_SCOPES` | Kommagetrennt, Default `openid,profile,postbote:admin` |

## Logto-Einrichtung

1. **API Resource** anlegen (z. B. `https://api.postbote.internal`) mit Scope
   `postbote:admin`.
2. **SPA Application** (Authorization Code + PKCE) mit Redirect-URI
   `https://<ui-host>/callback` und Post-Logout-URI `https://<ui-host>/`.
3. Der SPA die Resource/Scopes zuweisen; `POSTBOTE_OIDC_AUDIENCE` = Resource-Indicator.
4. `POSTBOTE_OIDC_ISSUER` = Logto-Endpoint (ohne `/oidc`), `jwks_uri` wird über
   `/.well-known/openid-configuration` ermittelt — falls nicht vorhanden, probt
   der Verifier automatisch `/oidc/.well-known/openid-configuration` (Logto).
   Der `iss`-Vergleich akzeptiert den Issuer aus dem Discovery-Dokument.
5. `POSTBOTE_SECRET_KEY` und `POSTBOTE_OIDC_*` in **allen Rollen** identisch
   setzen (Compose `backend-env`-Anchor).

## Sicherheitsregeln

- JWKS wird gecacht (TTL) und bei unbekannter `kid` sofort aktualisiert
  (Key-Rotation), mit Schutz gegen parallele Fetches.
- Geprüft werden `iss`, `aud`, `exp`, `nbf`, `iat` (5 s Clock-Skew) und — falls
  konfiguriert — `scope`/`scopes`/`roles`.
- `alg: none` und nicht unterstützte Algorithmen werden abgelehnt.
- Fehler liefern **HTTP 401 / ErrorCode 10**, ohne Token-Inhalte zu loggen.
- OIDC-Principals erhalten einen synthetischen Token-Record mit dem
  `serverId` des konfigurierten Servers; `allowedFrom` gilt für sie nicht.

## Migrationspfad

1. `both` ausrollen, Logto konfigurieren, Admin-UI auf OIDC umstellen.
2. Smoke-Test: UI-Login → `GET /server` mit Bearer, sowie bestehende Clients
   mit `X-Postmark-Server-Token`.
3. Nach Umstellung aller Clients optional `POSTBOTE_AUTH_MODE=oidc`.
4. Statische Tokens bleiben als Break-Glass-Fallback in der DB, bis sie
   bewusst entfernt werden.

## Offen

- Rollen-/Scope-basierte Feingranularität pro Endpunkt (z. B. nur Lesen für
  `postbote:viewer`) — derzeit ein gemeinsamer Admin-Scope.
- Token-Introspection / Revocation-Liste (JWTs sind bis `exp` gültig).
- Logto-spezifische Organisation-/Rollen-Mapping auf mehrere postbote-Server.
