# Docker Compose & Betrieb

## Stack

`docker/docker-compose.yml` startet sechs Services:

| Service | Rolle | Ports | Abhängigkeit |
|---|---|---|---|
| `postgres` | Postgres 17 (State + Queue) | intern | – |
| `migrate` | One-shot: Migrationen + Bootstrap | – | postgres healthy |
| `api` | HTTP-API (`POSTBOTE_ROLE=api`) | 3000 | migrate erfolgreich |
| `worker` | Queue-Consumer (`POSTBOTE_ROLE=worker`) | – | migrate erfolgreich |
| `smtp` | SMTP-Ingress (`POSTBOTE_ROLE=smtp`) | 2525, 587 | migrate erfolgreich |
| `ui` | Admin-UI (nginx) | 5173 → 80 | api healthy |

Ein einziges Image (`docker/Dockerfile`, multi-stage, non-root User `postbote`)
wird für alle Backend-Rollen genutzt; `POSTBOTE_ROLE` entscheidet, was startet.
Die UI hat ein eigenes Image (`web/Dockerfile`, Vite-Build → nginx).

## Start

```bash
cp .env.example .env
# POSTBOTE_BOOTSTRAP_TOKEN in .env setzen!
docker compose -f docker/docker-compose.yml --env-file .env up -d --build
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs -f api worker smtp
```

`--env-file .env` ist wichtig, weil die Compose-Datei unter `docker/` liegt.
Ohne eigene `.env` greifen die Defaults (`change-me` als Token).

### Migration & Bootstrap

Der `migrate`-Service führt `node dist/db/migrate.js` aus:

1. Wendet die generierten SQL-Dateien aus `migrations/` an
   (drizzle-orm Migrator, idempotent über `__drizzle_migrations`).
2. Legt **nur bei leerer DB** den Server `Default` (`slug=default`), den Stream
   `outbound` und den ersten API-Token aus `POSTBOTE_BOOTSTRAP_TOKEN` an.

Erneutes Starten ist gefahrlos (`bootstrap skipped: tokens already exist`).
Neue Migrationen erzeugen: `npm run db:generate` (drizzle-kit liest
`src/db/schema.ts`, schreibt nach `migrations/`), danach Images neu bauen.

## Healthchecks

- `postgres`: `pg_isready -U postbote`
- `api`: `docker/healthcheck.mjs` → `GET /health` (rolle-bewusst: `worker`/`smtp`
  haben keinen HTTP-Listener und melden Prozess-Liveness)
- `ui`: nginx antwortet auf `/`

Das Backend-Image enthält denselben Healthcheck als `HEALTHCHECK`-Instruktion,
sodass er auch ausserhalb von Compose wirkt.

## Ersteinrichtung

```bash
# 1. Upstream-Relay (sonst simuliert der Worker 250, es wird nichts zugestellt)
docker compose -f docker/docker-compose.yml exec api \
  node dist/cli/setup.js set-relay smtp.example.com 587 user pass starttls

# 2. SMTP-Credentials (Secret einmalig ausgeben lassen)
docker compose -f docker/docker-compose.yml exec smtp \
  node dist/cli/setup.js create-smtp-credential default outbound

# 3. Testmail
curl -X POST http://localhost:3000/email \
  -H "X-Postmark-Server-Token: $POSTBOTE_BOOTSTRAP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"From":"absender@example.com","To":"empfaenger@example.com","Subject":"Test","TextBody":"Hallo"}'
```

`node dist/cli/setup.js --help` zeigt alle Setup-Kommandos. `set-relay`
akzeptiert `tlsMode` = `starttls` (Default, erzwungen), `implicit` (Port 465)
oder `none`.

## STARTTLS für SMTP

Zertifikate nach `docker/certs/` legen, in `docker/docker-compose.yml` beim
`smtp`-Service die `volumes`-Zeile und die zwei `POSTBOTE_SMTP_TLS_*`-Variablen
einkommentieren, danach `up -d`. Ohne Zertifikat logged der Ingress eine Warnung
und erlaubt Plain-AUTH (nur für Dev/trusted Networks).

## Tracking (Phase 2, M8)

`POSTBOTE_TRACKING_BASE_URL` muss aus Sicht der **Mail-Clients** erreichbar sein
(bei Remote-Deploy die öffentliche URL, nicht den Compose-Service-Namen), denn
`/track/open/:id` (Pixel) und `/track/click/:id` (Redirect) werden von den
Empfänger-Clients aufgerufen. Die Endpunkte sind bewusst ohne Token. Der Worker
verwendet die URL, um beim Versand Links umzuschreiben und das Pixel einzubetten.

## Admin-UI Runtime-Config

Die UI wird als statisches Bundle ausgeliefert; API-URL und Token werden **beim
Containerstart** in `/config.js` geschrieben (`docker/ui-entrypoint.sh`) und vom
Browser gelesen — kein Token im JS-Bundle:

```yaml
environment:
  POSTBOTE_UI_API: http://localhost:3000
  POSTBOTE_UI_TOKEN: ${POSTBOTE_BOOTSTRAP_TOKEN}
```

`POSTBOTE_UI_API` muss aus Sicht des **Browsers** erreichbar sein (bei
Remote-Deploy also die öffentliche API-URL, nicht den Compose-Service-Namen).
`/config.js` wird mit `Cache-Control: no-store` ausgeliefert. Die API erlaubt
CORS für alle Origins.

## Skalierung & Betrieb

- Mehrere `worker`-Instanzen sind möglich: die Queue nutzt
  `FOR UPDATE SKIP LOCKED`, damit kein Job doppelt verarbeitet wird.
- `api` ist im Split-Deploy ein reiner Producer (claimt keine Jobs); nur die
  Rolle `all` betreibt Queue-Loop + HTTP + SMTP gemeinsam.
- Rollen lassen sich separat starten: `POSTBOTE_ROLE=api|worker|smtp|all`.
- Backup: `docker compose exec postgres pg_dump -U postbote postbote > dump.sql`
  (enthält Nachrichten, Queue, Tokens, Templates, Webhooks).
- Graceful Shutdown: alle Rollen fangen `SIGINT`/`SIGTERM`, schliessen
  Fastify/SMTP-Listener, Queue und DB-Verbindung.

## Upgrade

```bash
git pull
docker compose -f docker/docker-compose.yml --env-file .env up -d --build
```

`migrate` läuft bei jedem Start und wendet neue Migrationen an. Für
Produktiv-Systeme empfiehlt sich ein Blick ins Log des `migrate`-Services,
bevor `api`/`worker` traffic bekommen (`depends_on: service_completed_successfully`
stellt das sicher).

## Release-Images

Tags `v*.*.*` publizieren via GitHub Actions:

- `ghcr.io/devolta-ug-haftungsbeschraenkt/postbote:<version>`, `:<major>.<minor>`, `:latest`
- `ghcr.io/devolta-ug-haftungsbeschraenkt/postbote-ui:<version>`, `:<major>.<minor>`, `:latest`

Für **v0.1.0** wurde der Release manuell per `workflow_dispatch` ausgelöst; dabei
liegen `:v0.1.0` und `:latest` in der Registry. Normale Tag-Pushes (`v*.*.*`)
erzeugen zusätzlich die Semver-Tags `:<version>` und `:<major>.<minor>`.

Multi-Arch (`linux/amd64`, `linux/arm64`). Statt `build:` kann in Compose
`image: ghcr.io/devolta-ug-haftungsbeschraenkt/postbote:latest` verwendet werden.

### GHCR-Berechtigung bei Organisationen

Der Release-Workflow nutzt standardmässig `GITHUB_TOKEN` mit `packages: write`.
Bei Repos in einer Organisation kann GitHub das Anlegen **neuer** Packages
dennoch mit `403 Forbidden` blockieren (Org-Einstellung *Packages → Package
creation*). Abhilfe, eine von beiden:

1. In den Org-Settings das Anlegen von Container-Packages für Actions
   erlauben und den Workflow erneut starten.
2. Einen klassischen PAT mit `write:packages` (+ `read:org`) als Repo-Secret
   `GHCR_TOKEN` hinterlegen — `docker/login-action` nutzt ihn automatisch
   statt `GITHUB_TOKEN`.

Danach ohne Force-Push des Tags neu starten:

```bash
gh workflow run release.yml \
  --repo devolta-ug-haftungsbeschraenkt/postbote --ref main -f tag=v0.1.0
```
