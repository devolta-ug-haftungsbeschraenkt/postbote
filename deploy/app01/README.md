# app01-Migration (M7) — Runbook

Paralleler Aufbau von **postbote-v2**, Import der Bestandsdaten, Cut-Over und
Rollback. Grundlage: [`BAUPLAN.md` §6](../../BAUPLAN.md) und
[`docs/MIGRATION.md`](../../docs/MIGRATION.md).

> ⚠️ **Sicherheitsregel:** Kein Skript in diesem Verzeichnis verändert ohne
> explizites `--apply` irgendetwas. Alle Import- und Cut-Over-Schritte sind
> standardmässig **Dry-Runs**. Auf app01 wurde bislang nur **read-only**
> recherchiert (Netze, Container, Dateistruktur, Connector-Status) — es läuft
> noch kein v2-Stack.

## Realwerte app01 (verifiziert am 13.11.2026)

| Wert | Realwert |
|---|---|
| Legacy-Container | `postbote` (`devolta/postbote:1`, `/opt/postbote/docker-compose.yml`, **nicht** Coolify) |
| Legacy-API | `http://postbote:3000`, Alias `postbote` auf 5 Netzen |
| Netze | `coolify`, `1bbmzl7b9u3rl8ekddhaxutk`, `g86ntufwogji79f7hb1a3ffd`, `swixxxl5wdtvlriahjswr4om`, `zws0ev9f14ri06ailwihgrsd` |
| Logto-Instanzen | `logto-<uuid>` (4), Connector bereits `http-email` → `http://postbote:3000/logto` |
| Backups | `/root/postmark-export/<uuid>/connector-row-backup.json` (4× vorhanden) |
| Relay | `mail.devolta.de:587`, per `extra_hosts` auf `178.63.12.152` gepinnt |
| Freie Ports | **3002** (3001 belegt), 2526, 588, 5174 |
| Quellen | `/opt/postbote/tokens.env` (`POSTBOTE_TOKENS=<JSON>`, 6 Clients), `smtp.env` (nur User/Pass), `templates/` (36 Verzeichnisse + `_layouts/basic`) |
| Clients | `aar-lager`, `lambatec-office`, `logto-devolta`, `logto-servease`, `logto-servease-test`, `logto-servease-demo` |

UUID → Client (aus `fromEmail` der Connector-Backups):

| UUID | Client |
|---|---|
| `zws0ev9f14ri06ailwihgrsd` | `logto-devolta` |
| `1bbmzl7b9u3rl8ekddhaxutk` | `logto-servease` |
| `g86ntufwogji79f7hb1a3ffd` | `logto-servease-test` |
| `swixxxl5wdtvlriahjswr4om` | `logto-servease-demo` |

Die konkrete, **gitignorierte** `app01.env` liegt lokal bereit (generierte
Secrets, echte Netz-/Containernamen, `POSTBOTE_DEFAULT_HEADERS`, Relay-Fallback).
**OIDC-Werte sind noch offen** — der Stack läuft mit `POSTBOTE_AUTH_MODE=both`
auch ohne OIDC; die Logto-Connectoren nutzen statische Bearer-Tokens.

## Phase 0 — Vorbereitung

- [x] Netz-/Containernamen, Ports, Legacy-Deployment verifiziert
- [x] `app01.env` erzeugt (Secrets generiert, nicht im Repo)
- [ ] `app01.env` nach `/opt/postbote-v2/deploy/app01/app01.env` übertragen
- [ ] OIDC-Werte (Issuer/Audience/SPA-App-ID) nachtragen, falls gewünscht
- [ ] DKIM/SPF/DMARC für `@devolta.de`, `@servease.de`, `@aar-gastronomie.ch`
      (inkl. **aar strikte Ausrichtung**)
- [ ] Rollback-Plan gelesen (`cutover.sh --rollback --apply`)

## Phase 1 — Parallel-Deploy (additiv, reversibel)

Die GHCR-Packages der Org sind **privat** (kein Pull ohne Login) → auf app01
aus dem öffentlichen Repo bauen:

```bash
ssh app01
git clone https://github.com/devolta-ug-haftungsbeschraenkt/postbote.git /opt/postbote-v2
# app01.env nach /opt/postbote-v2/deploy/app01/app01.env kopieren
cd /opt/postbote-v2
docker compose -f deploy/app01/docker-compose.app01.yml \
  -f deploy/app01/docker-compose.build.yml \
  --env-file deploy/app01/app01.env build
docker compose -f deploy/app01/docker-compose.app01.yml \
  -f deploy/app01/docker-compose.build.yml \
  --env-file deploy/app01/app01.env up -d
```

- v2 läuft auf **Port 3002** (3001 ist belegt), SMTP-Host-Ports **2526/588**,
  UI **5174** (Legacy behält 3000/2525/587).
- Netz-Alias: `postbote-v2` (API) und `postbote-v2-smtp` (SMTP). Clients
  sprechen weiterhin `postbote` → Legacy.
- `migrate` legt Schema (0000–0003), Default-Server, `outbound`-Stream und den
  Bootstrap-Token an.
- Der Worker bekommt `extra_hosts: mail.devolta.de:178.63.12.152` (SPF/PTR).
- **DNS-Falle:** Der Postgres-Service heisst im internen Netz `postbote-v2-db`
  (Alias), nicht `postgres`. Auf app01 gibt es in den externen Netzen weitere
  Container namens `postgres` — mit dem kurzen Namen würde der API-Container
  eine fremde DB treffen (`password authentication failed`). Der Alias ist
  deshalb zwingend; `POSTBOTE_DATABASE_URL` muss ihn verwenden.
- **Zweite DNS-Falle:** Docker löst auch **Containernamen** auf. Der Legacy-
  Container hiess `postbote` — ein reiner Alias-Swap würde `postbote` auf
  **zwei** IPs auflösen (Round-Robin). `cutover.sh` benennt ihn deshalb in
  `postbote-legacy` um und benennt beim Rollback zurück. Nach dem Cut-Over
  `/opt/postbote/token.sh` auf `postbote-legacy` umstellen. Während des
  Rollback-Fensters **kein** `docker compose up -d` in `/opt/postbote`
  ausführen (würde den Namen `postbote` zurückbringen).
- Der Worker hängt zusätzlich am `coolify`-Netz: das reine `internal`-Netz hat
  keinen Egress zu `mail.devolta.de:587`.
- **Kein Backfill nötig:** Legacy hat keinen Message-Store, die Historie startet
  mit dem Cut-Over (Bauplan §6.5).

Healthcheck:

```bash
curl -fsS http://localhost:3002/health
```

## Phase 2 — Import (dry-run → apply)

Quellen unter `${POSTBOTE_IMPORT_DIR}` (Default `/opt/postbote`):

```
/opt/postbote/                        # Realstruktur auf app01
├── tokens.env              # POSTBOTE_TOKENS=<JSON> mit 6 Clients
│                           # {name, allowedFrom, logto:{from,templates}}
├── smtp.env                # nur SMTP_USER / SMTP_PASS
└── templates/
    ├── _layouts/basic/body.html
    └── <alias>/{body.html,body.txt,subject.txt,layout.txt}   # 36 Stück
```

Ausführung **im v2-Container** (das Image enthält `dist/cli/import.js`):

```bash
COMPOSE="docker compose -f deploy/app01/docker-compose.app01.yml \
  -f deploy/app01/docker-compose.build.yml --env-file deploy/app01/app01.env"

# 1. DRY RUN — zeigt Tokens (nur Hash-Präfix), Relay, Templates/Layouts
#    -u root ist nötig: /opt/postbote ist 0700 root, der Container läuft non-root.
$COMPOSE exec -u root -T api node dist/cli/import.js all /opt/postbote default

# 2. Anwenden (idempotente Upserts)
$COMPOSE exec -u root -T api node dist/cli/import.js all /opt/postbote default --apply
```

Einzeln möglich: `tokens <file>`, `relay <file>`, `templates <dir|manifest.json>`;
`--only <name>` filtert Token-Keys. **Secrets werden nie geloggt.**

Import-Konvention (beide Formate unterstützt):

- `tokens.env`: entweder `KEY=TOKEN` pro Zeile **oder** `POSTBOTE_TOKENS=<JSON>`
  (app01-Realformat). Pro Client werden `name`, `allowedFrom` und
  `logto:{from,templates}` übernommen; der Token selbst nur als SHA-256-Hash.
- `smtp.env`: `SMTP_HOST|HOST|RELAY_HOST`, `SMTP_PORT|PORT`, `SMTP_USER|USER|…`,
  `SMTP_PASS|PASSWORD|…`, `TLS_MODE`. Fehlende Host/Port/TLS kommen aus
  `POSTBOTE_RELAY_*` in `app01.env` (auf app01: `mail.devolta.de:587`).
- Templates: entweder `manifest.json` oder konventionsbasierte Discovery —
  `<alias>/body.html|body.txt|subject.txt|layout.txt` und
  `_layouts/<name>/body.html`. `layout.txt` enthält den Layout-Alias (`basic`).
  Ohne `body.txt` leitet der Renderer den Text aus dem HTML ab.

Nach dem Import gegen die v2-API prüfen:

```bash
curl -H "X-Postmark-Server-Token: $POSTBOTE_BOOTSTRAP_TOKEN" \
  'http://localhost:3002/templates?count=100'
```

## Phase 3 — Smoke-Tests auf v2

```bash
# Testmail je Client (HTTP + SMTP), Verifikation via /messages/outbound
POSTBOTE_API_BASE=http://localhost:3002 POSTBOTE_ADMIN_TOKEN=$TOKEN \
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
