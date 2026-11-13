# app01-Migration (M7) — Runbook

Paralleler Aufbau von **postbote-v2**, Import der Bestandsdaten, Cut-Over und
Rollback. Grundlage: [`BAUPLAN.md` §6](../../BAUPLAN.md) und
[`docs/MIGRATION.md`](../../docs/MIGRATION.md).

> ⚠️ **Sicherheitsregel:** Kein Skript in diesem Verzeichnis verändert ohne
> explizites `--apply` irgendetwas. Alle Import- und Cut-Over-Schritte sind
> standardmässig **Dry-Runs**. Container-/Netznamen, Pfade und Tokens stehen
> **nicht** im Repo — sie kommen aus `app01.env` (Vorlage:
> `env.app01.example`). Es wurden keine Aktionen gegen app01 ausgeführt.

## Vor dem Start anpassen

| Wert | Wo | Prüfen mit |
|---|---|---|
| Netzwerk-Namen (`coolify` + 4 Logto-Netze) | `app01.env` | `docker network ls` |
| Container-Namen v2 / Legacy | `app01.env` | `docker ps --format '{{.Names}}'` |
| Legacy-Deployment (wer verwaltet es? Coolify?) | organisatorisch | – |
| Logto-Env-Pfad + Restart-Kommando | `app01.env` | – |
| Client-Liste (Tokens, Absender, Empfänger) | `smoke/clients.example.json` → eigene Datei | – |
| DKIM-Selector + Domains | `smoke/domains.example.txt` | `dig` |
| Postgres-Passwort / `POSTBOTE_BOOTSTRAP_TOKEN` | `app01.env` | – |

```bash
cp deploy/app01/env.app01.example deploy/app01/app01.env
# app01.env editieren und NIEMALS committen (siehe .gitignore)
```

Backup von Legacy-Config/DB vor Phase 1:

```bash
docker compose -f <legacy-compose> exec postgres pg_dump -U postbote postbote > legacy-$(date +%F).sql
```

## Phase 0 — Vorbereitung

- [ ] `app01.env` ausgefüllt, Netz-/Containernamen verifiziert
- [ ] `POSTBOTE_IMAGE` zeigt auf das getaggte Release (nicht `:latest` in Prod)
- [ ] DKIM/SPF/DMARC für alle Absender-Domains (inkl. **aar strikte Ausrichtung**)
- [ ] Rollback-Plan gelesen (`cutover.sh --rollback --apply`)

## Phase 1 — Parallel-Deploy

```bash
docker compose -f deploy/app01/docker-compose.app01.yml \
  --env-file deploy/app01/app01.env up -d
docker compose -f deploy/app01/docker-compose.app01.yml \
  --env-file deploy/app01/app01.env ps
```

- v2 läuft auf **Port 3001** intern, SMTP auf **2526/588** (Legacy behält 3000/2525/587).
- Netz-Alias: `postbote-v2` (API) und `postbote-v2-smtp` (SMTP). Clients sprechen
  weiterhin `postbote` → Legacy.
- `migrate` legt Schema, Default-Server, `outbound`-Stream und den Bootstrap-Token an.
- **Kein Backfill nötig:** Legacy hat keinen Message-Store, die Historie startet
  mit dem Cut-Over (Bauplan §6.5).

Healthcheck:

```bash
curl -fsS http://localhost:3001/health
```

## Phase 2 — Import (dry-run → apply)

Quellen unter `${POSTBOTE_IMPORT_DIR}` (Default `/opt/postbote`):

```
/opt/postbote/
├── tokens.env              # NAME=TOKEN, ein Token pro Zeile
├── smtp.env                # SMTP_HOST/PORT/USER/PASS, TLS_MODE
└── templates/
    ├── manifest.json       # bevorzugt, siehe templates/manifest.example.json
    ├── layouts/*.html|txt
    └── <alias>.html|.txt|.subject.txt
```

Ausführung **im v2-Container** (das Image enthält `dist/cli/import.js`):

```bash
COMPOSE="docker compose -f deploy/app01/docker-compose.app01.yml --env-file deploy/app01/app01.env"

# 1. DRY RUN — zeigt Tokens (nur Hash-Präfix), Relay, Templates/Layouts
$COMPOSE exec api node dist/cli/import.js all /opt/postbote default

# 2. Anwenden (idempotente Upserts)
$COMPOSE exec api node dist/cli/import.js all /opt/postbote default --apply
```

Einzeln möglich: `tokens <file>`, `relay <file>`, `templates <dir|manifest.json>`;
`--only <name>` filtert Token-Keys. **Secrets werden nie geloggt.**

Import-Konvention:

- `tokens.env`: jede `KEY=VALUE`-Zeile ist ein Token; `KEY` wird als Name
  gespeichert, der Wert nur als SHA-256-Hash (`server_tokens.token_hash`).
- `smtp.env`: akzeptiert `SMTP_HOST|HOST|RELAY_HOST`, `SMTP_PORT|PORT`,
  `SMTP_USER|USER|…`, `SMTP_PASS|PASSWORD|…`, `TLS_MODE` (`starttls` Default).
- `manifest.json`: `layouts[]` und `templates[]` mit `alias`, `name`, `subject`
  (oder `subjectFile`), `htmlBody|htmlFile`, `textBody|textFile`, `layoutAlias`.
  Ohne Manifest greift die konventionsbasierte Discovery (`layouts/*.html`,
  `<alias>.html/.txt`, `<alias>.subject.txt`).

Nach dem Import gegen die v2-API prüfen:

```bash
curl -H "X-Postmark-Server-Token: $POSTBOTE_BOOTSTRAP_TOKEN" \
  'http://localhost:3001/templates?count=100'
```

## Phase 3 — Smoke-Tests auf v2

```bash
# Testmail je Client (HTTP + SMTP), Verifikation via /messages/outbound
POSTBOTE_API_BASE=http://localhost:3001 POSTBOTE_ADMIN_TOKEN=$TOKEN \
  SMOKE_CLIENTS=deploy/app01/smoke/clients.json \
  node deploy/app01/smoke/smoke-test.mjs

# Logto Forgot-Password-Flow
LOGTO_FORGOT_PASSWORD_URL=https://… LOGTO_E2E_RECIPIENT=smoke-logto@example.com \
  node deploy/app01/smoke/logto-e2e.mjs

# Upstream/Postfix: status=sent
POSTFIX_LOG_CMD='docker logs postfix --tail 1000' \
  bash deploy/app01/smoke/postfix-check.sh smoke-logto@example.com

# DKIM je Domain (inkl. aar-Hinweis auf strikte Ausrichtung)
DKIM_SELECTOR=default bash deploy/app01/smoke/dkim-check.sh \
  deploy/app01/smoke/domains.txt
```

Checkliste (vor Cut-Over **alle** grün):

- [ ] Testmail je Client: `queued` → `sent`
- [ ] Logto-Forgot-Password E2E (Mail im Postfach, Link funktioniert)
- [ ] Postfix `status=sent` für alle Test-Empfänger
- [ ] DKIM-Check je Domain, aar strikt aligned
- [ ] `/deliverystats`: `Queued: 0`, `Failed: 0`
- [ ] Bounce-Webhook gegen absichtlich ungültige Adresse
- [ ] Sandbox-Token, Batch mit ungültigem Item (HTTP 200 + pro-Item-ErrorCode)
- [ ] **OIDC/Logto**: Admin-UI-Login (PKCE) → `Authorization: Bearer` gegen
      `GET /server`; Ablauf/Key-Rotation und `POSTBOTE_AUTH_MODE` prüfen
      (siehe [`docs/OIDC.md`](../../docs/OIDC.md))
- [ ] Templates rendern (`POST /templates/validate`) gegen Golden-Tests

## Phase 4 — Cut-Over

```bash
# 1. Zeigt exakt die Docker-Kommandos (keine Änderung)
bash deploy/app01/cutover.sh --env-file deploy/app01/app01.env

# 2. Aktuelle Aliase prüfen
bash deploy/app01/cutover.sh --env-file deploy/app01/app01.env --verify

# 3. Ausführen: Legacy → postbote-legacy, v2 → postbote
bash deploy/app01/cutover.sh --env-file deploy/app01/app01.env --apply

# 4. Logto auf den neuen Service-Namen umstellen (Env + Restart)
bash deploy/app01/logto-switch.sh --apply
```

`cutover.sh` verschiebt den Netz-Alias `postbote` auf jedem Client-Netz
(`coolify` + 4 Logto-Netze) vom Legacy- auf den v2-API-Container, prüft vorher
Laufzustand/Health und schreibt `.cutover-state` für den Rollback. Clients
ändern **nichts** — sie sprechen nur den Service-Namen an.

> Hinweis: Falls Coolify die Netz-Aliase des Legacy-Containers verwaltet, muss
> der Legacy-Teil des Swaps dort nachgezogen werden (Coolify redeploy mit
> Alias `postbote-legacy`). `cutover.sh` arbeitet bewusst mit `docker network
> connect/disconnect`, um unabhängig vom Legacy-Deployment zu sein.

## Phase 5 — Beobachtung

- Legacy bleibt **mindestens 2 Wochen** als `postbote-legacy` stehen (Rollback).
- Logs beobachten: `api`, `worker`, `smtp`; Queue-Leerlauf prüfen.
- **Postmark erst kündigen**, wenn Desk- und servease-Backend umgezogen sind
  (offener Punkt 1 aus dem Umstellungsdokument, Bauplan §6.6).
- `logto-switch.sh` / `logto-rollback.sh` sind die konsolidierten Skripte aus
  dem Umstellungsdokument.

## Phase 6 — Legacy-Abschaltung

Nach Ablauf der Beobachtungszeit und sauberem Queue-Stand:

```bash
docker stop postbote-legacy   # NICHT löschen: Image/Config für Notfälle behalten
```

## Rollback

```bash
bash deploy/app01/cutover.sh --rollback --apply --env-file deploy/app01/app01.env
bash deploy/app01/logto-rollback.sh --apply
```

Der Rollback stellt `postbote` auf Legacy zurück, gibt v2 den Alias
`postbote-v2`, stellt das Logto-Env-Backup wieder her und startet Logto neu.
Noch `queued`-Jobs in der v2-DB bleiben erhalten (Teil des DB-Backups).

## Dateien

| Datei | Zweck |
|---|---|
| `docker-compose.app01.yml` | v2-Parallel-Stack (6 Services, externe Netze) |
| `env.app01.example` | Alle Variablen (Vorlage, keine Secrets) |
| `cutover.sh` | Alias-Swap, `--verify`, `--apply`, `--rollback` |
| `logto-switch.sh` / `logto-rollback.sh` | Logto-Env + Restart + Cut-Over/Rollback |
| `smoke/smoke-test.mjs` | Testmail je Client + Verifikation |
| `smoke/logto-e2e.mjs` | Forgot-Password-Probe |
| `smoke/postfix-check.sh` | `status=sent`-Kontrolle |
| `smoke/dkim-check.sh` | DKIM-TXT je Domain |
| `templates/manifest.example.json` | Import-Schema für Templates/Layouts |
| `../../src/cli/import.ts` | Import-Logik (kompiliert ins Image) |
