# Changelog

Alle nennenswerten Änderungen an postbote. Format orientiert sich an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/); Versionen folgen
[Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

### app01-Deploy: Blocker geschlossen

- `POST /logto` nach Legacy-Vertrag (`{to,type,payload}`, Bearer-Token,
  pro-Client `from`/Template-Mapping), inkl. 1480/406/1101/100010.
- `server_tokens.logto_config` + `allowedFrom`-Import aus dem
  `POSTBOTE_TOKENS`-JSON (Migration `0003`).
- Template-Discovery für die app01-Konvention (`<alias>/body.html`,
  `subject.txt`, `layout.txt`, `_layouts/<name>/`).
- `POSTBOTE_DEFAULT_HEADERS` für `X-Devolta-Signature: skip` (Mailcow-Milter)
  und Relay-Host/Port-Fallback für `smtp.env`.
- Deploy-Artefakte: reale `app01.env`, Build-Override (GHCR-Packages sind
  privat), Port 3002, `extra_hosts` für `mail.devolta.de`.

### Auth via OIDC / Logto (wichtiger Zusatz)

- **Anforderung notiert** in `docs/OIDC.md`: Authentifizierung über OIDC mit
  Logto, dualer Betrieb mit statischen Postmark-Tokens über
  `POSTBOTE_AUTH_MODE` (`both` · `oidc` · `token`).
- Backend: JWKS-basierte JWT-Verifikation (RS256/RS384/RS512/ES256, Discovery,
  Key-Rotation, `iss`/`aud`/`exp`/`nbf`/`iat`, Pflicht-Scope) ohne neue
  Dependencies; OIDC-Principals werden auf `POSTBOTE_OIDC_SERVER_SLUG`
  abgebildet.
- Admin-UI: optionaler Authorization-Code+PKCE-Login gegen Logto, Bearer-Token
  statt statischem Header; ohne OIDC-Konfiguration unverändertes Demo-Verhalten.
- 15 Integrationstests gegen einen lokalen JWKS-Server.

### Härtung

- **Rate-Limit** pro Server-Token (`POSTBOTE_RATE_LIMIT_PER_MIN`, Default 600)
  → HTTP 429 mit `Retry-After`.
- **Sender-Allowlist** `allowedFrom` wird durchgesetzt → ErrorCode 1480;
  `From` akzeptiert jetzt auch Anzeigenamen (`"Max <max@devolta.de>"`).
- **Payload-Limits**: 10 MB pro Nachricht (422/300), 50 MB pro Batch,
  übergrosse Batch-Items werden einzeln markiert.
- **Secrets at rest**: Relay-Passwörter werden mit AES-256-GCM verschlüsselt
  (`POSTBOTE_SECRET_KEY`), Klartext-Fallback für bestehende Daten.
- **Postgres-Integrationstests** (`test/postgres.test.ts`) gegen Postgres 17 in
  CI und lokal verifiziert: Migrationen und alle Store-Pfade.

## [0.1.0] – 2026-11-13

Erstes Release. Self-hosted, Postmark-kompatible Mail-Middleware mit
Postgres-Queue und eigenem Upstream-SMTP-Relay.

### Enthalten

- **M0** – Repo-Scaffold: Node 22 / TypeScript (ESM), Fastify, drizzle-orm,
  Vitest, Biome, MIT-Lizenz.
- **M1** – DB-Schema (13 Tabellen), `POST /email`, `/email/batch`,
  Token-Auth (`X-Postmark-Server-Token`), Sandbox `POSTMARK_API_TEST`,
  Message-Store (Memory + Postgres), `/messages/outbound`, `/deliverystats`,
  `/health`.
- **M2** – Worker: Postgres-Queue mit `FOR UPDATE SKIP LOCKED`, Retry mit
  Backoff, Bounce-Klassifikation, Webhook-Dispatcher (Basic Auth, Custom
  Headers, `X-PM-Webhook-Trace-Id`).
- **M3** – Mustachio-Renderer (`#each`, `#if`, `#unless`, `else`, `../../`,
  Layouts), `/templates` CRUD + `/templates/validate`,
  `/email/withTemplate`, `/email/batchWithTemplates`, 21 Golden-Tests.
- **M4** – `/bounces` (Liste, Detail, Dump, Activate), `/webhooks` CRUD +
  Verify-Flow (ErrorCode 1364), `GET /server`, CORS für die Admin-UI.
- **M5** – SMTP-Ingress auf 2525/587, AUTH PLAIN/LOGIN mit Access/Secret-
  Credentials, STARTTLS, `X-PM-*` Header, `SMTPApiError`-Bounce (100007).
- **M6** – Multi-stage Dockerfile (non-root), Docker Compose mit Migration +
  Bootstrap, rollen-bewusste Healthchecks, GitHub Actions (CI + Image-Publish
  nach `ghcr.io/devolta-ug-haftungsbeschraenkt/postbote`), README und Doku (API, SMTP, Compose,
  Migration), MIT-Lizenz.
- **M7** – app01-Migrations-Toolkit: Parallel-Deploy `postbote-v2`,
  Import-Skripte (Tokens/Templates/Layouts/Relay), Cut-Over/Rollback,
  Logto-Switch, Smoke-Tests und Runbook. **Nur vorbereitet, nicht gegen
  Produktion ausgeführt.**
- **M8** – Phase 2: Message-Streams, Suppressions mit ErrorCode 406/1235,
  Open-/Click-Tracking (Pixel + Link-Rewrite), Open-/Click-Webhooks,
  `/stats/outbound`, Admin-UI-Seiten für Streams, Suppressions und Statistik.

### Bekannte Einschränkungen

- NDR-Mailbox-Ingestion, Bulk/Broadcast-Versand, Inbound-Verarbeitung und
  Domains/Sender-Signaturen sind nicht enthalten.
- Relay-Passwörter liegen unverschlüsselt in der DB; Webhooks haben keine
  Signaturen (wie Postmark).
- Ohne TLS-Zertifikat läuft der SMTP-Ingress im Plain-Modus.
- Die Postgres-Pfade sind unit-getestet (Memory-Store), aber nicht gegen eine
  laufende Postgres-Instanz verifiziert.

[0.1.0]: https://github.com/devolta-ug-haftungsbeschraenkt/postbote/releases/tag/v0.1.0
