# Bauplan: postbote – Open-Source-Postmark-Clone

> Stand: 13.11.2026. Grundlage: `postmark_analyse.md` (API-Parität) und
> `Mail-Umstellung Postmark zu postbote (2026-11-13).md` (Bestand auf app01).
>
> Entscheidungen: Node/TypeScript · Postgres-only Queue · MVP-Scope wie Analyse 6.2 ·
> Dogfooding (Ersetzung des Live-Systems auf app01).

---

## 1. Ziel & Positionierung

**postbote** ist ein self-hosted, Docker-deploybarer Mail-Middleware-Layer:
Anwendungen sprechen die Postmark-API (oder SMTP) an, postbote übernimmt Queueing,
Message-Registry, Retry/Bounce-Handling, Webhooks und Templates und liefert über
konfigurierbare Upstream-SMTP-Credentials aus.

- **Kompatibilitätsversprechen:** Bestehende Postmark-Libraries (npm `postmark`, PHP, …)
  funktionieren durch Austausch von Base-URL/Host — Response-Schema, ErrorCode-System,
  `POSTMARK_API_TEST`-Sandbox und Header-Auth sind 1:1.
- **Das eigentliche Know-how (Analyse 6.3):** Mustachio-Rendering mit Layouts,
  Bounce-Klassifikation, Batch = HTTP 200 + pro-Item-Errors, Webhooks ohne Signatur
  aber mit Trace-Id.

## 2. Architektur

```
                    ┌──────────────────────────────────────────────┐
App (HTTP, Postmark)│ api          Fastify, /email*, /templates,    │
──▶ postbote-api ───▶             /bounces, /messages, /webhooks    │
Logto (POST /logto) │                                              │
──▶                 │        ┌───────────────────────┐             │
App (SMTP 587/2525) │ worker │ Postgres-Queue        │──▶ Upstream-│──▶ Internet
──▶ postbote-smtp ──▶        │ SKIP LOCKED, Backoff  │   SMTP      │    (Mailcow etc.)
                    │        │ Bounce-Klassifikation │   (nodemailer│
                    │        │ Webhook-Dispatcher    │    Pool)    │
                    └────────┴───────────────────────┴─────────────┘
                                  ▲
                            Postgres (einzige Stateful-Dependency)
```

- **Ein Repo, ein Image, drei Rollen** (`POSTBOTE_ROLE=api|worker|smtp`, default: alle
  in einem) — einfach für `docker compose up` und Coolify, skalierbar für größere Setups.
- **Queue:** Postgres-only (`jobs`-Tabelle, `FOR UPDATE SKIP LOCKED`, Attempts +
  exponentieller Backoff). Redis kann später ergänzt werden, ohne das Datenmodell zu ändern.

## 3. Datenmodell (Postgres, Migrationen via drizzle-kit)

| Tabelle | Inhalt |
|---|---|
| `servers` | Tenant-Instanz (Postmark-Parität: Token gehört zu Server). MVP unauffällig, aber von Tag 1 angelegt |
| `server_tokens` | Gehashte API-Tokens (heute `tokens.env`), Name, `allowedFrom`-Regeln, Sandbox-Flag |
| `smtp_credentials` | Access/Secret-Key-Paare für SMTP-Ingress (Postmark-SMTP-Token-Modell) |
| `relay_configs` | Upstream pro Server/Stream: Host, Port, User, Pass, TLS-Modus |
| `streams` | `outbound` (Default) + custom; MVP ohne Broadcast-Logik |
| `messages` | MessageID (UUID), Server, Stream, From/To/Cc/Bcc, Subject, Html/Text, Raw-Mail, Tag, Metadata (jsonb), Status `queued/sent/failed/bounced`, SubmittedAt |
| `message_events` | Eventlog je Message (accepted, sent, deferred, bounced, webhook_delivered) |
| `bounces` | Type/TypeCode (Tabelle 2.5 der Analyse), Description, BouncedAt |
| `templates` | Alias/ID, Subject, Html, Text, Layout-Ref, pro Server |
| `layouts` | `{{{content}}}`-Layouts |
| `webhooks` | URL, Events, HttpAuth, HttpHeaders, verified-Status |
| `webhook_deliveries` | Retry-Log, Trace-Id, Antwort-Status |
| `jobs` | Queue-Tabelle |

## 4. MVP-Scope

**Ingress (API):**
- `POST /email`, `/email/batch` (≤ 500, HTTP 200 + pro-Item ErrorCode),
  `/email/withTemplate`, `/email/batchWithTemplates`
- `POST /logto` (bestehender Endpoint, in den Portierungs-Scope übernommen)
- Auth: `X-Postmark-Server-Token`, Sandbox über Token-Wert `POSTMARK_API_TEST`,
  `allowedFrom`-Prüfung, Payload-Limits 10/50 MB, HTTP 429 Rate-Limit pro Token
- Error-Codes kompatibel: mindestens 10, 300, 402, 403, 406, 410, 1101, 1235, 1364
  + Echo-Header `X-PM-ApiErrorCode`

**Ingress (SMTP):** Ports 2525/587, STARTTLS, AUTH PLAIN/LOGIN mit Access/Secret-
Credentials, `X-PM-MESSAGE-STREAM`/`X-PM-Tag`/`X-PM-Metadata-*`-Header, asynchrone
Fehler als `SMTPApiError`-Bounce.

**Worker:** Versand via nodemailer-SMTP-Pool; Envelope-Absender folgt dem From
(gelernte DKIM/DMARC-Lektion aus Abschnitt 6.6 des Umstellungsdokuments wird Regel,
nicht Bugfix); Retry mit Backoff bei 4xx-Tempfails; 5xx → Bounce mit TypeCode-Mapping.

**Webhook-Dispatcher:** Delivery/Bounce-Events, Basic Auth + Custom Headers, Retry
mit Backoff, Idempotenz via `X-PM-Webhook-Trace-Id`.

**Query-APIs:** `/messages/outbound` (+`/details`, `/dump`), `/bounces` (+`/dump`,
`/activate`), `/deliverystats` (MVP: Zähler aus message_events), `/templates`-CRUD +
`/templates/validate`, `/webhooks`-CRUD + `/verify`, `/server`.

**Templates:** Portierung von `render.mjs` als eigenes Modul (`mustachio`):
`each`→Section-Übersetzung, `../../`-Parent-Refs, Layouts mit `@content`,
Postmark-Escaping (nur `& < > " '`), nicht-escaped Subject/Text, HTML→Text-Ableitung.
**Golden Tests** gegen Postmark-`/templates/validate`-Outputs (der manuelle Abgleich
aus Abschnitt 4 des Umstellungsdokuments wird automatisiert).

**Bewusst NICHT ins MVP (Phase 2):** Open-/Click-Tracking, volle Stats-API,
Suppressions/Inactive-Recipients, Custom-Message-Streams-Logik, Broadcast, Admin-UI,
Inbound, Data-Removal, Multi-Tenancy-Accounts.

## 5. Repo- & Projekt-Setup

```
postbote/
  src/
    api/            # Fastify-Routen, Auth, Validation, Error-Mapping
    smtp/           # SMTP-Ingress (smtp-server)
    worker/         # Queue, Sender, Bounce-Klassifikation, Webhook-Dispatcher
    mustachio/      # Rendering (portiert aus render.mjs)
    db/             # Schema (drizzle), Migrationen, Repos
    config/         # Env-Config, Token-Bootstrap
  migrations/
  docker/           # Dockerfile (multi-stage, non-root), compose, .env.example
  docs/             # md-Doku (API, SMTP, Compose, Migration von Postmark)
  test/             # Unit + Golden-Tests (mustachio), API-Integrationstests (Sandbox)
```

- TypeScript, Fastify, drizzle-orm + drizzle-kit, nodemailer, smtp-server, Vitest,
  Biome (lint+format), **Lizenz: MIT**
- GitHub Actions: lint → test → build → Image-Publish nach `ghcr.io/devolta/postbote`
  (semver + `latest`)
- README mit Quickstart (`docker compose up` + erste Testmail), Doku-Beispiele für die
  Postmark-Library-Migration (wie bei lambatec `POSTMARK_API_HOST` und aar
  `POSTMARK_API_URL` demonstriert)

## 6. Migration des Live-Systems auf app01 (Dogfooding)

1. **Parallel-Deploy:** neuer Stack als `postbote-v2` (Port 3001 intern), gleiche
   Docker-Netze (`coolify` + 4 Logto-Netze).
2. **Import-Skripte:** Tokens aus `tokens.env` → DB (gehasht), Templates aus
   `/opt/postbote/templates` (inkl. Layouts), relay-config aus `smtp.env`.
3. **Cut-Over:** `postbote-v2` übernimmt den Namen `postbote` (Clients ändern nichts,
   sie sprechen nur den Service-Namen an), Legacy wird zu `postbote-legacy` und bleibt
   als Rollback ≥ 2 Wochen stehen.
4. **Smoke-Tests** (Umstellungsdokument Abschnitt 12): Testmail je Client, Logto-E2E
   (Forgot-Password-Flow), Postfix `status=sent`-Kontrolle, DKIM-Check je Domain
   (inkl. aar strikte Ausrichtung).
5. **Kein Backfill nötig:** Legacy hat keinen Message-Store, Historie startet mit dem Cut-Over.
6. Danach: `logto-switch.sh`/`logto-rollback.sh` im Repo konsolidieren; Postmark erst
   kündigen, wenn Desk- und servease-Backend umgezogen sind (offener Punkt 1).

## 7. Meilensteine

| # | Inhalt | Abhängig von |
|---|---|---|
| M0 | Repo, Scaffold, CI, Image-Build | – |
| M1 | DB-Schema, Auth, `/email` + `/batch` + Sandbox, Message-Store | M0 |
| M2 | Worker: Queue, Upstream-SMTP, Retry, Bounce-Klassifikation | M1 |
| M3 | mustachio-Port + Golden-Tests, `/withTemplate` + `/batchWithTemplates`, Template-Import | M1 |
| M4 | Webhooks (CRUD/Verify/Dispatcher), Query-APIs (messages, bounces, deliverystats) | M2 |
| M5 | SMTP-Ingress + Credentials | M1 |
| M6 | Compose/Healthchecks/Doku/README, OSS-Release | M1–M5 |
| M7 | app01-Parallel-Deploy + Cut-Over + Legacy-Abschaltung | M6 |
| M8 | Phase 2: Tracking, Stats, Streams, Suppressions, Admin-UI | M7 |

## 8. Risiken & offene Punkte

- **Bounce-Erkennungstiefe:** MVP wertet SMTP-Response-Codes aus (5xx = HardBounce,
  4xx = Retry). NDR-Mailbox-Ingestion (echte asynchrone Bounces vom Upstream) ist der
  anspruchsvollere Teil — explizit als M8/Phase-2-Punkt planen, nicht heimlich ins MVP ziehen.
- **Secrets:** Tokens gehasht in DB, Bootstrap-Env für Erst-Token; `smtp.env`/
  `tokens.env`-Muster bleibt für Compose.
- **Eine IP für alles:** Umstellungsdokument nennt getrennte IPs/Streams für
  Massenversand — späterer Stream-/Broadcast-Komplex; MVP dokumentiert die Einschränkung.
