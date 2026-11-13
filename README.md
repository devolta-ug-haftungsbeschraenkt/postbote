# postbote

**Self-hosted, Postmark-compatible mail middleware.** Drop-in-Ersatz für die
Postmark-API: Nachrichten werden synchron akzeptiert, in einer Postgres-Queue
gepuffert und asynchron über einen eigenen Upstream-SMTP-Relay zugestellt.
Inklusive SMTP-Ingress, Templates (Mustachio), Bounces, Webhooks und einem
Admin-Dashboard.

Open Source (MIT) · Node 22 / TypeScript · Fastify · Postgres · kein SaaS,
keine externen Abhängigkeiten ausser deinem eigenen Mailserver.

> Status: **MVP + Phase 2 (M0–M8)**. M7 ist das vorbereitete app01-Migrations-Toolkit
> (Parallel-Deploy, Import, Cut-Over, Rollback, Smoke-Tests) — **nicht** gegen
> Produktion ausgeführt. Siehe [Bekannte Einschränkungen](#bekannte-einschränkungen).
> Implementierungsplan: [`BAUPLAN.md`](BAUPLAN.md), API-Parität:
> [`postmark_analyse.md`](postmark_analyse.md).

---

## Features

| Bereich | Umfang |
|---|---|
| HTTP-API | `POST /email`, `/email/batch`, `/email/withTemplate`, `/email/batchWithTemplates` |
| Templates | Mustachio-Renderer (`#each`, `#if`, `#unless`, `else`, `../../`, Layouts `{{{content}}}`), `/templates`, `/templates/validate` |
| Query | `/messages/outbound`, `/deliverystats`, `/bounces` (+ `/dump`, `/activate`), `/server`, `/webhooks` (+ `/verify`) |
| SMTP-Ingress | Ports 2525/587, AUTH PLAIN/LOGIN (Access/Secret), STARTTLS, `X-PM-*` Header |
| Streams & Suppressions | `/message-streams` CRUD/Archive, `/suppressions` Dump/Create/Delete, **ErrorCode 406/1235** |
| Tracking & Stats | `TrackOpens`/`TrackLinks`, Open-Pixel, Click-Redirect, `Open`/`Click`-Webhooks, `/stats/outbound` |
| Härtung | `allowedFrom`/1480, Rate-Limit/429, 10-MB-Limit, AES-256-GCM für Relay-Passwörter, Postgres-Integrationstests |
| Worker | Postgres-Queue (`FOR UPDATE SKIP LOCKED`), Retry mit Backoff, Bounce-Klassifikation, Delivery-/Bounce-Webhooks |
| Auth | `X-Postmark-Server-Token`, Tokens nur als SHA-256-Hash, Sandbox-Token `POSTMARK_API_TEST` |
| Fehler | Postmark-ErrorCodes (10, 300, 402, 410, 1101, 1364, …) + `X-PM-ApiErrorCode` |
| Admin-UI | Dashboard im Apple-Design (`web/`), Live-Daten oder Demo-Fixtures |

---

## Quickstart (Docker Compose)

```bash
git clone https://github.com/devolta-ug-haftungsbeschraenkt/postbote.git
cd postbote
cp .env.example .env          # POSTBOTE_BOOTSTRAP_TOKEN setzen!
docker compose -f docker/docker-compose.yml --env-file .env up -d --build
```

Der `migrate`-Service legt Schema, Default-Server, `outbound`-Stream und den
ersten API-Token an (idempotent). Danach:

| Service | URL | Rolle |
|---|---|---|
| Admin-UI | http://localhost:5173 | Übersicht, Messages, Bounces, Webhooks, Templates |
| API | http://localhost:3000 | `api` |
| SMTP | `localhost:2525`, `localhost:587` | `smtp` |
| Postgres | intern | State + Queue |
| Worker | intern | `worker` |

**Erste Testmail (HTTP):**

```bash
curl -X POST http://localhost:3000/email \
  -H 'Content-Type: application/json' \
  -H "X-Postmark-Server-Token: $POSTBOTE_BOOTSTRAP_TOKEN" \
  -d '{
    "From": "absender@deine-domain.de",
    "To": "empfaenger@example.com",
    "Subject": "Hallo von postbote",
    "TextBody": "Es funktioniert.",
    "MessageStream": "outbound"
  }'
# → {"To":"...","SubmittedAt":"...","MessageID":"<uuid>","ErrorCode":0,"Message":"OK"}
```

Den Status prüfen:

```bash
curl -H "X-Postmark-Server-Token: $POSTBOTE_BOOTSTRAP_TOKEN" \
  http://localhost:3000/messages/outbound?count=5
```

**Upstream-Relay konfigurieren** (sonst akzeptiert postbote die Mail, kann sie
aber nicht zustellen — der Worker simuliert dann `250` wie im Demo-Modus):

```bash
docker compose -f docker/docker-compose.yml exec api \
  node dist/cli/setup.js set-relay smtp.deine-domain.de 587 user pass starttls
```

**SMTP-Credentials anlegen** (Secret wird einmalig ausgegeben):

```bash
docker compose -f docker/docker-compose.yml exec smtp \
  node dist/cli/setup.js create-smtp-credential default outbound
```

Details: [`docs/COMPOSE.md`](docs/COMPOSE.md) · [`docs/SMTP.md`](docs/SMTP.md).

---

## Ohne Docker: Demo-Modus

```bash
npm ci
POSTBOTE_DEMO=1 npm run dev          # API :3000 + SMTP :2525/:587
cd web && npm ci && npm run dev      # UI  :5173
```

Demo-Modus nutzt In-Memory-Store/-Queue, kein Postgres, kein Relay (Zustellung
wird simuliert). Fixe Credentials:

| Zweck | Wert |
|---|---|
| API-Token | `postbote-demo-token` |
| SMTP-User | `postbote-demo-smtp` |
| SMTP-Pass | `postbote-demo-smtp-secret` |

**Mail per SMTP (Demo):**

```bash
node --input-type=module -e "
import nodemailer from 'nodemailer';
const t = nodemailer.createTransport({
  host: '127.0.0.1', port: 2525, secure: false, ignoreTLS: true,
  auth: { user: 'postbote-demo-smtp', pass: 'postbote-demo-smtp-secret' },
});
console.log(await t.sendMail({
  from: 'absender@example.com', to: 'empfaenger@example.com',
  subject: 'SMTP-Test', text: 'Hallo',
  headers: [{ key: 'X-PM-Tag', value: 'demo' }],
}));
"
```

---

## Von Postmark migrieren

Die meisten Clients müssen nur den Host umbiegen — Token, Payload und
Antwortformat bleiben gleich:

```bash
# Node-Library (postmark.js) u.ä.
POSTMARK_API_HOST=http://localhost:3000
POSTMARK_SERVER_TOKEN=<dein Bootstrap-Token>

# Clients mit URL-Override (z. B. Logto, aar)
POSTMARK_API_URL=http://localhost:3000/email
```

Alternativ kann der SMTP-Client unverändert bleiben: einfach Host/Port auf
postbote umstellen und die Access/Secret-Credentials verwenden. Details und
Cut-Over-Checkliste: [`docs/MIGRATION.md`](docs/MIGRATION.md).

---

## Konfiguration

| Variable | Default | Bedeutung |
|---|---|---|
| `POSTBOTE_ROLE` | `all` | `api` · `worker` · `smtp` · `all` |
| `POSTBOTE_HOST` / `POSTBOTE_PORT` | `0.0.0.0` / `3000` | HTTP-Listener |
| `POSTBOTE_DATABASE_URL` | `postgres://postbote:postbote@localhost:5432/postbote` | Postgres |
| `POSTBOTE_BOOTSTRAP_TOKEN` | `postbote-bootstrap-token` | Erster API-Token (nur bei leerer DB) |
| `POSTBOTE_SMTP_PORTS` | `2525,587` | Leer deaktiviert SMTP-Ingress |
| `POSTBOTE_SMTP_TLS_KEY` / `..._CERT` | – | PEM-Pfade für STARTTLS; ohne sie Plain-Modus |
| `POSTBOTE_TRACKING_BASE_URL` | `http://localhost:3000` | Öffentliche Basis-URL für Open-Pixel/Click-Links |
| `POSTBOTE_RATE_LIMIT_PER_MIN` | `600` | Requests/Minute pro Token; `0` = aus |
| `POSTBOTE_SECRET_KEY` | – | AES-Key für Relay-Passwörter (`openssl rand -hex 32`); ohne Key Klartext-Legacy-Modus |
| `POSTBOTE_MIGRATIONS_DIR` | `migrations` | Pfad zu den SQL-Migrationen |
| `POSTBOTE_LOG_LEVEL` | `info` | Fastify-Loglevel |
| `POSTBOTE_DEMO` | – | `1` = In-Memory-Demo |
| `POSTBOTE_UI_API` / `POSTBOTE_UI_TOKEN` | – | Runtime-Config für die UI im Container |

Vollständige Vorlage: [`.env.example`](.env.example).

---

## Architektur

```
Client (Postmark-Library / SMTP) ──▶ api (Fastify) ──┐
                                                    ├──▶ Postgres (messages + jobs)
SMTP-Ingress :2525/:587 ─────────▶ smtp role ───────┘            │
                                                                 ▼
                                                    worker (SKIP LOCKED)
                                                                 │
                                            Upstream-SMTP (nodemailer)
                                                                 │
                                     Bounce-Klassifikation ──▶ Webhooks
```

- **Ein Image, vier Rollen**: `POSTBOTE_ROLE` entscheidet, was ein Container
  startet. `all` kombiniert alles für die lokale Entwicklung.
- **Postgres ist die einzige stateful Dependency** — Queue und Message-Store
  liegen in derselben DB; `FOR UPDATE SKIP LOCKED` erlaubt mehrere Worker.
- **Envelope-Absender folgt dem `From`** (DKIM/DMARC-Ausrichtung), nie umgekehrt.
- **Tokens** werden nur als SHA-256-Hash gespeichert; SMTP-Secrets ebenfalls.

---

## Entwicklung

```bash
npm ci
npm run lint          # Biome
npx tsc --noEmit      # Typecheck
npm test              # Vitest (98 Tests + 5 Postgres-Integration in CI)
npm run build         # tsc → dist/
npm run db:generate   # Migration aus src/db/schema.ts erzeugen
npm run db:migrate    # Migrationen + Bootstrap anwenden
npm run setup -- --help
npm run import -- all /pfad/zu/opt/postbote default   # dry-run, --apply zum Schreiben
```

CI (`.github/workflows/ci.yml`): lint → test → build → Docker-Image-Smoke-Test,
parallel ein **Postgres-17-Service-Job** für die Integrationstests.
Release-Tags `v*.*.*` publizieren `ghcr.io/devolta-ug-haftungsbeschraenkt/postbote` und
`ghcr.io/devolta-ug-haftungsbeschraenkt/postbote-ui` (semver + `latest`).

---

## Dokumentation

- [`docs/API.md`](docs/API.md) — Endpunkte, Payloads, ErrorCodes, Sandbox, Templates
- [`docs/SMTP.md`](docs/SMTP.md) — SMTP-Ingress, AUTH, STARTTLS, `X-PM-*` Header
- [`docs/COMPOSE.md`](docs/COMPOSE.md) — Services, Healthchecks, TLS, Backup, Upgrade
- [`docs/MIGRATION.md`](docs/MIGRATION.md) — Postmark → postbote, Cut-Over-Checkliste
- [`deploy/app01/README.md`](deploy/app01/README.md) — **M7-Runbook**: Parallel-Deploy, Import, Cut-Over, Rollback, Smoke-Tests

---

## Bekannte Einschränkungen (Stand M8)

- **NDR-Mailbox-Ingestion** (echte asynchrone Bounces vom Upstream) ist nicht
  implementiert — Bounces stammen derzeit aus SMTP-Response-Codes und
  SMTPApiError-Fehlern.
- **Bulk/Broadcast-Versand** (`POST /email/bulk`, gemeinsamer Body + pro-
  Empfänger-Modelle), Inbound-Verarbeitung und Domains/Sender-Signaturen sind
  nicht Teil des aktuellen Umfangs.
- **Secrets**: Mit `POSTBOTE_SECRET_KEY` werden Relay-Passwörter per
  AES-256-GCM verschlüsselt; ohne Key bleiben neue Werte im Klartext
  (Kompatibilitätsmodus). Bestehende Klartextwerte bleiben immer lesbar.
- **Keine Signaturen** bei Webhooks (wie Postmark): Absicherung über Basic Auth,
  Custom Headers oder IP-Allowlisting.
- **Tracking-Basics**: Plattform-/Browser-/Client-Auswertung und
  `PostFirstOpenOnly`-Filterung sind noch nicht ausgebaut; die Events werden
  gezählt und per Webhook gemeldet.
- Ohne konfiguriertes TLS-Zertifikat läuft SMTP-Ingress im Plain-Modus — nur für
  Dev/vertrauenswürdige Netze gedacht.

---

## Lizenz

[MIT](LICENSE) © 2026 Devolta
