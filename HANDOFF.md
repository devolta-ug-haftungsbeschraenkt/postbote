# HANDOFF — postbote

> Stand: **14.11.2026**, Repository `devolta-ug-haftungsbeschraenkt/postbote`,
> Branch `main`, HEAD `6bd9a67`, Arbeitsbaum sauber, CI grün.
> Dieses Dokument ist die Übergabe für einen Agenten mit frischem Kontext.

---

## 1. Ziel

**postbote**: self-hosted, Postmark-kompatible Mail-Middleware (Node 22 /
TypeScript ESM, Fastify, Postgres-Queue, Upstream-SMTP-Relay), inklusive
Admin-UI im Apple-Design. Open Source (MIT), Docker/Compose, CI → GHCR.

Zwei explizite Anforderungen des Users:

1. **„beides parallel"** — Backend und Admin-UI gleichzeitig bauen (erledigt).
2. **„wichtiger Zusatz (auch notieren): auth soll über OIDC mit Logto gehen"**
   — festgehalten in `docs/OIDC.md`, im Backend umgesetzt, **OIDC-Werte auf
   app01 noch nicht konfiguriert** (offen, siehe §6).

Dazu: **Ablösung des Legacy-Postmark-Clones auf app01** (`BAUPLAN.md` §6/M7),
Parallel-Deploy → Import → Cut-Over → 2 Wochen Beobachtung → Legacy-Abschaltung.

---

## 2. Was gebaut wurde (Chronologie)

| Meilenstein | Inhalt |
|---|---|
| M0 | Scaffold: TypeScript/NodeNext, Fastify, drizzle, Vitest, Biome, Docker, MIT |
| M1 | 13 Tabellen, `/email`, `/email/batch`, Token-Auth (SHA-256), Sandbox `POSTMARK_API_TEST`, Memory- + Postgres-Store, `/messages/outbound`, `/deliverystats`, `/health` |
| M2 | Worker: Postgres-Queue `FOR UPDATE SKIP LOCKED`, Retry/Backoff, Bounce-Klassifikation (TypeCodes), Webhook-Dispatcher (Basic Auth, Custom Headers, `X-PM-Webhook-Trace-Id`) |
| M3 | Mustachio-Renderer (`#each`/`#if`/`#unless`/`else`, `../../`, Layouts, Postmark-Escaping), `/templates`, `/templates/validate`, `/email/withTemplate`, `/batchWithTemplates`, 21 Golden-Tests |
| M4 | `/bounces` (Liste/Detail/Dump/Activate), `/webhooks` CRUD + Verify (1364), `/server`, CORS |
| M5 | SMTP-Ingress 2525/587, AUTH PLAIN/LOGIN, STARTTLS, `X-PM-*`-Header, `SMTPApiError`-Bounce (100007) |
| M6 | Multi-stage Dockerfile (non-root), Compose + Migration/Bootstrap, Healthchecks, GitHub Actions (CI + Release), README/Doku, LICENSE |
| M7 | app01-Toolkit: Parallel-Deploy, Import-CLI, Cut-Over/Rollback, Logto-Skripte, Smoke-Tests, Runbook |
| M8 | Phase 2: Streams, Suppressions/406, Open-/Click-Tracking, `/stats/outbound`, 3 UI-Seiten |
| Härtung | 429-Rate-Limit, `allowedFrom`/1480, 10-MB-Limit, AES-256-GCM Relay-Passwörter, Postgres-Integrationstests in CI |
| OIDC | JWKS-JWT-Verifikation ohne neue Dependency, `POSTBOTE_AUTH_MODE` (`both`/`oidc`/`token`), UI-PKCE-Login, `docs/OIDC.md` |
| app01-Prep | `POST /logto`, `POSTBOTE_TOKENS`-JSON-Import, app01-Template-Konvention, `POSTBOTE_DEFAULT_HEADERS`, echte Deploy-Artefakte |
| **app01-Deploy** | Parallel-Deploy, Import (6 Tokens/35 Templates/1 Layout/1 Relay), **Cut-Over ausgeführt**, Vorfall-Fix |

**Release:** Tag `v0.1.0` (`c0a5398`), CI grün. Achtung: die GHCR-Images
`:v0.1.0`/`:latest` enthalten **nicht** die späteren Fixes (OIDC, Härtung,
`/logto`, Layout-Fix). app01 wurde deshalb **aus dem Repo gebaut**, nicht aus
GHCR gezogen.

---

## 3. Aktueller Zustand (verifiziert am 14.11.2026)

### Repository / CI
- `main` @ `6bd9a67`, `git status` leer. Letzter CI-Lauf `43581284517`: **success**
  (`check` + `postgres` + `docker`).
- 127 Tests grün (+5 Postgres-Integration, die ohne `POSTBOTE_TEST_DATABASE_URL`
  skipped werden). `tsc`, Biome, Backend- und UI-Build clean.
- Migrationen `0000` … `0003` (`0003` = `server_tokens.logto_config`).

### app01 (SSH-Alias `app01`, root@100.100.151.121)
- Clone: `/opt/postbote-v2` @ `6bd9a67`.
- Env (gitignored, `0600`): `/opt/postbote-v2/deploy/app01/app01.env`
  — generierte Secrets, echte Netz-/Containernamen, `POSTBOTE_AUTH_MODE=both`,
  **OIDC-Variablen leer/kommentiert**, `POSTBOTE_DEFAULT_HEADERS` gesetzt.
- Stack `postbote-v2` (Compose + `docker-compose.build.yml`, lokal gebaut):
  `postbote-v2-{api,worker,smtp,ui,postgres,migrate}-1`, alle healthy.
  Host-Ports **3002 / 2526 / 588 / 5174** (3001 war belegt).
- DB: **7 Tokens** (6 importiert + Bootstrap), **4 mit `logto_config`**,
  **35 Templates**, 1 Layout (`basic`), 1 Relay (`enc:v1:` verschlüsselt).
- Legacy: Container **`postbote-legacy`** (umbenannt von `postbote`), läuft,
  Alias `postbote-legacy`, Rollback für ≥2 Wochen.
- **Cut-Over aktiv**: `postbote` löst auf allen 5 Netzen nur noch auf
  `postbote-v2-api-1` auf; State in `deploy/app01/.cutover-state`
  (`legacy_renamed=true`).
- `/opt/postbote/token.sh` zeigt auf `postbote-legacy` (Backup
  `token.sh.bak-postbote-v2`).
- Alle 4 Logto-Connectoren (`http-email`) zeigen bereits auf
  `http://postbote:3000/logto`; Backups unter
  `/root/postmark-export/<uuid>/connector-row-backup.json`.
- Verifiziert: `POST /logto` aus einem Logto-Container → 422/1101 für unbekannten
  Typ (kein Versand), Health `{"status":"ok","version":"0.1.0"}`, Worker →
  `mail.devolta.de:587` TCP OK, `X-Devolta-Signature: skip` im Worker-Env.
- **Echter Smoke-Versand**: `Sent: 2` (eine echte `logto-SignIn` aus Live-Traffic
  + eine `logto-Generic`-Testmail an `office@devolta.de`), Mailcow
  `status=sent`, keine Bounces/Failed.

### Lokal (Mac)
- Demo-API `POSTBOTE_DEMO=1 npx tsx src/index.ts` auf :3000 (läuft),
  Vite-UI auf :5173 (läuft). Demo-Token `postbote-demo-token`,
  SMTP `postbote-demo-smtp` / `postbote-demo-smtp-secret`.
- **Lokaler Docker/OrbStack ist hängig** (alle `docker`-Calls laufen in Timeout).
  Für lokale Postgres-Tests ggf. OrbStack neu starten; app01s Docker-Daemon
  ist separat und gesund.

---

## 4. Was funktioniert hat (bewahren)

- **Store-Zwilling** `MemoryMessageStore` / `PostgresMessageStore` hinter einem
  `MessageStore`-Contract → alle API-Tests laufen ohne DB, CI prüft echte Postgres.
- **Alles was Produktion verändert, zuerst read-only recon + Dry-Run** (SSHRecon,
  `import.js` ohne `--apply`, `cutover.sh` ohne `--apply`). Hat mehrfach Fehler
  verhindert.
- **Aus dem Repo bauen** statt GHCR (Packages der Org sind privat).
- **SSH + `bash -s`-Heredoc** für komplexe Remote-Kommandos (kein Quoting-Chaos).
- **Sentinel-Ansatz** bei `applyLayout`: Layout rendern, bereits gerenderten
  Content nicht nochmal durch den Renderer schicken.
- **`POSTBOTE_AUTH_MODE` dual** hält Postmark-Maschinen-Clients kompatibel,
  während OIDC für Menschen vorbereitet ist.
- **`cutover.sh --repair`** als Betriebs-Safeguard nach Container-Recreates.
- Subagenten für klar abgrenzbare UI-Arbeit (M8-Seiten, OIDC-Login) parallel
  einsetzen — mit exaktem API-/Config-Vertrag im Prompt.

---

## 5. Was NICHT funktioniert hat (nicht wiederholen)

| Falle | Korrektur |
|---|---|
| GHCR `docker manifest inspect` → 403 (Pakete privat) | `docker-compose.build.yml` Override, lokal auf app01 bauen |
| `POSTBOTE_DATABASE_URL` hatte `postbote:postbote`, `POSTGRES_PASSWORD` war zufällig → `password authentication failed` | Beide synchronisieren; **danach Container force-recreaten** |
| Hostname `postgres` auf app01 → fremder Coolify-Postgres (`192.168.160.x`) | Eindeutiger Alias **`postbote-v2-db`** im internal-Netz |
| `/opt/postbote` ist `0700 root`, Container non-root → Import „file not found" | `docker compose exec -u root -T api ...` |
| `internal: true`-Netz → Worker `ENETUNREACH` zu `mail.devolta.de:587` | Worker zusätzlich ans `coolify`-Netz hängen |
| **Nur Alias-Swap beim Cut-Over** → Docker löst auch Container*Namen* auf, `postbote` lieferte 2 IPs (Round-Robin Legacy/v2) | Legacy-Container **`docker rename postbote postbote-legacy`**; `cutover.sh` benennt beim Rollback zurück |
| `docker compose up -d --force-recreate api` → Compose setzt Aliase auf `postbote-v2` zurück, `postbote` verschwindet (kurzer Ausfall) | Danach **`bash cutover.sh --repair --apply`** |
| `/opt/postbote/token.sh` nutzte `docker exec postbote` → nach Rename „No such container" | Auf `postbote-legacy` umgestellt |
| `allowedFrom: ["aar-gastronomie.ch"]` (nackte Domain) → 1480 für aar-lager | `checkSenderAllowed`: Regel ohne `@` = Domain-Vergleich (Legacy-Semantik) |
| **`applyLayout` rendert das Layout nicht** → echte Logto-Mails enthielten rohe `{{#application}}`/`{{^logoUrl}}`/`{{../../name}}`-Tags | Fix `e86a985` + 5 Golden-Tests; mit echten Templates im Container verifiziert |
| Release-Workflow: Tag-Push `v0.1.0` → GHCR 403; zwei `workflow_dispatch`-Re-Runs für Semver-Tags hingen im Runner | Workflow auf bewährten Stand zurückgesetzt; veröffentlichte Tags sind `:v0.1.0` + `:latest` (kein `:0.1.0`/`:0.1`) |
| `gh run watch` / API-Calls hatten sporadische Netzwerk-Resets | Status direkt per `gh run view` abfragen statt zu pollen |
| `npx biome check … \| tail -2` maskierte Lint-Fehler → CI rot | Immer volle Ausgabe/`grep` prüfen |

**Wichtig:** Während des 2-Wochen-Rollback-Fensters **kein**
`docker compose up -d` in `/opt/postbote` ausführen — das würde den
Containernamen `postbote` (und damit den DNS-Konflikt) zurückbringen.

---

## 6. Nächste Schritte (priorisiert)

1. **Beobachtung (jetzt, ≥2 Wochen):** Queue-Leerlauf (`/deliverystats` →
   `Queued: 0`), `/bounces`, Logs von `api`/`worker`/`smtp`, echte
   Forgot-Password-Flows der 4 Logto-Instanzen, `status=sent` je Client,
   DKIM/SPF/DMARC je Domain (inkl. **aar strikte Ausrichtung**).
2. **OIDC/Logto fertig konfigurieren** (die explizite Anforderung): Logto
   API-Resource + SPA-App anlegen, `POSTBOTE_OIDC_ISSUER`,
   `POSTBOTE_OIDC_AUDIENCE`, `POSTBOTE_OIDC_REQUIRED_SCOPE`,
   `POSTBOTE_UI_OIDC_ISSUER`, `POSTBOTE_UI_OIDC_CLIENT_ID`,
   `POSTBOTE_UI_OIDC_RESOURCE` in `app01.env` setzen, Container neu erstellen
   (+ `cutover.sh --repair --apply` nicht vergessen), PKCE-Login in der UI testen.
   Optional danach `POSTBOTE_AUTH_MODE=oidc`.
3. **Smoke-Tests je Client** (`deploy/app01/smoke/`): `aar-lager`,
   `lambatec-office`, `logto-devolta`, `logto-servease`,
   `logto-servease-test`, `logto-servease-demo`. Bisher nur eine Testmail.
4. **`v0.1.1` taggen**, damit aktuelle GHCR-Images publiziert werden. Hinweis:
   Release-Workflow per `workflow_dispatch -f tag=v0.1.1` ist zuverlässiger als
   Tag-Push (403-Risiko). Dokumentierte Tags ggf. anpassen.
5. **Legacy-Abschaltung** nach Beobachtungszeit: `docker stop postbote-legacy`
   (nicht löschen), `logto-switch.sh`/`logto-rollback.sh` im Repo konsolidieren
   (Bauplan §6.6), **Postmark erst kündigen, wenn Desk- und servease-Backend
   umgezogen sind** (offener Punkt 1).
6. **Phase 3 / offene Lücken:** NDR-Mailbox-Ingestion, Bulk/Broadcast-Versand,
   Inbound, Domains/Sender-Signaturen, Plattform-/Browser-Tracking-Auswertung,
   `PostFirstOpenOnly`, Rollen-/Scope-Feingranularität, Token-Revocation,
   `POSTBOTE_SECRET_KEY`-Rotation.
7. **Lokalen OrbStack neu starten**, falls lokale Docker-/Postgres-Tests nötig sind.

### Rollback (jederzeit)
```bash
ssh app01
cd /opt/postbote-v2/deploy/app01
bash cutover.sh --rollback --apply
# Optional: 4 Logto-Connectoren zurück auf Postmark:
for u in 1bbmzl7b9u3rl8ekddhaxutk g86ntufwogji79f7hb1a3ffd \
         swixxxl5wdtvlriahjswr4om zws0ev9f14ri06ailwihgrsd; do
  /opt/postbote/logto-rollback.sh "$u"
done
```

---

## 7. Wichtige Dateien / Kommandos

| Zweck | Pfad/Kommando |
|---|---|
| Master-Plan | `BAUPLAN.md` (M0–M8, §6 Migration) |
| API-Parität | `postmark_analyse.md` |
| Design | `DESIGN_GUIDELINES/APPLE_DESIGN.md` |
| OIDC-Anforderung | `docs/OIDC.md` |
| app01-Runbook (Realwerte!) | `deploy/app01/README.md` |
| Deploy-Env (geheim, gitignored) | `deploy/app01/app01.env` (lokal + `/opt/postbote-v2/deploy/app01/`) |
| Build-Override | `deploy/app01/docker-compose.build.yml` |
| Cut-Over | `deploy/app01/cutover.sh` (`--verify`, `--repair --apply`, `--rollback --apply`) |
| Import | `node dist/cli/import.js all /opt/postbote default [--apply]` (mit `-u root`) |
| Setup-CLI | `node dist/cli/setup.js set-relay …` / `create-smtp-credential …` |
| Checks | `npm test`, `npx tsc --noEmit`, `npx biome check src test`, `npm --prefix web run build` |
| PG-Integration | `POSTBOTE_TEST_DATABASE_URL=… npx vitest run test/postgres.test.ts` |
| CI | `gh run list --workflow=ci.yml --repo devolta-ug-haftungsbeschraenkt/postbote` |

**UUID → Logto-Client** (für `logto-switch.sh <uuid> <client>`):
`zws0ev9f14ri06ailwihgrsd`→`logto-devolta`,
`1bbmzl7b9u3rl8ekddhaxutk`→`logto-servease`,
`g86ntufwogji79f7hb1a3ffd`→`logto-servease-test`,
`swixxxl5wdtvlriahjswr4om`→`logto-servease-demo`.

---

## 8. Prompt für den nächsten Agenten

> Kopiere diesen Block in eine neue Session:

```
Lies zuerst /Users/maximilianpistor/Documents/dev/devolta/postbote/HANDOFF.md
vollständig. Es beschreibt das Projekt postbote (Postmark-kompatible
Mail-Middleware), den Stand nach M0–M8, OIDC/Logto und dem app01-Cut-Over.

AUFGABE — zweistufig:

A) PRÜFEN (read-only, keine Änderungen an Produktion):
   1. Repository: `git status`, `git log --oneline -5`, `npm test`,
      `npx tsc --noEmit`, `npx biome check src test`, `npm run build`,
      `npm --prefix web run build`, letzter CI-Lauf.
   2. app01 (SSH-Alias `app01`): `cd /opt/postbote-v2 && git log -1`,
      `docker compose ... ps`, `/health` auf :3002, `/deliverystats`,
      `/messages/outbound?count=5`, `/bounces?count=5`, DNS `postbote` auf
      allen 5 Netzen (frischer alpine-Container), `cutover.sh --verify`,
      Zustand von `postbote-legacy`, `.cutover-state`.
   3. Prüfe insbesondere, ob seit dem Layout-Fix (`e86a985`) noch rohe
      Mustache-Tags (`{{`) in versendeten Mails/Templates auftauchen und ob
      `Queued: 0`, `Failed: 0`, `Bounced: 0`.
   4. Berichte Abweichungen zum HANDOFF.md, inkl. lokaler OrbStack-Status.

B) WEITER ARBEITEN (erst nach A, mit Rückfragen bei Produktionsänderungen):
   - Priorität 1: OIDC/Logto real konfigurieren (siehe HANDOFF §6.2) — Werte
     beim User erfragen, keine Secrets erfinden oder loggen.
   - Priorität 2: Smoke-Tests je Client + DKIM/SPF/DMARC-Checks (§6.1/6.3).
   - Priorität 3: `v0.1.1`-Release für aktuelle GHCR-Images.
   - Danach: Beobachtung, Legacy-Abschaltung, Phase-3-Lücken.

REGELN:
   * Vor JEDER Änderung auf app01: read-only Recon + Dry-Run, dann explizite
     Freigabe einholen. Niemals Secrets in Ausgaben/Logs.
   * Nach `docker compose up -d --force-recreate api` IMMER
     `bash cutover.sh --repair --apply` (Alias-Verlust!).
   * Kein `docker compose up -d` in `/opt/postbote` während des
     Rollback-Fensters.
   * Import braucht `docker compose exec -u root -T api ...`.
   * Bau auf app01 aus dem Repo (GHCR-Pakete sind privat).
   * Änderungen am Code: Biome/tsc/Tests/Builds UND CI grün, dann commit+push,
     danach auf app01 `git pull` + Rebuild + Recreate + `--repair`.
   * Antworte auf Deutsch, knapp, mit konkreten Dateipfaden und Kommandos.
```

---

## 9. Kurzform für den User

**Es läuft.** postbote v2 hat auf app01 den Live-Mailverkehr übernommen
(Cut-Over aktiv, Legacy als `postbote-legacy` für Rollback). Der gemeldete
Vorfall (rohe Mustache-Tags in Anmeldemails) ist behoben und gegen die echten
Templates verifiziert; eine Smoke-Mail wurde zugestellt (`status=sent`).
**Offen:** OIDC/Logto-Realwerte, Smoke-Tests je Client, `v0.1.1`-Release,
2-Wochen-Beobachtung, Legacy-Abschaltung.

---

## 10. Nachtrag 17.11.2026 (Stand-Wechsel)

Seit dem Handoff ist `main` weitergewandert; **nicht alle Änderungen sind auf
app01 deployt**:

| Commit | Inhalt | CI | app01 |
|---|---|---|---|
| `103f599` | HANDOFF.md | grün | gezogen (Doku, harmlos) |
| `5fc9c8c` | **`fix(mail): inline CSS before SMTP delivery`** — neue Dependency `juice` (`^12.2.3`), `src/worker/sender.ts` + 40 Zeilen Tests in `test/m8.test.ts` | grün | **nur gezogen, NICHT gebaut** |

Verifiziert am 17.11.:
- Repo: `main` @ `5fc9c8c`, Arbeitsbaum sauber, 128 Tests grün (+5 PG
  skipped), `tsc`/Biome/Build clean.
- app01: `/opt/postbote-v2` @ `5fc9c8c`, aber
  `postbote-v2-api-1` **created 2026-11-14**, `require('juice')` →
  `MODULE_NOT_FOUND`. Der Fix ist also **nicht live**.
- Cut-Over weiterhin intakt: `postbote` → `172.19.0.59` (nur v2), Aliase auf
  allen 5 Netzen `[postbote]`, Legacy `postbote-legacy` läuft,
  `/health` OK.
- Lokal: Demo-API :3000 läuft, **Vite-UI :5173 ist beendet** (Dev-Server
  `state=completed`; kein Fehler im Log). Ein fremder `infisical run … vite`-
  Prozess und ein Vite aus `~/Documents/dev/servease/servease-frontend` laufen
  noch, gehören aber nicht zu postbote.

**Zum Ausrollen von `5fc9c8c` auf app01 (bekanntes Procedere):**
```bash
ssh app01
cd /opt/postbote-v2
docker compose -f deploy/app01/docker-compose.app01.yml \
  -f deploy/app01/docker-compose.build.yml \
  --env-file deploy/app01/app01.env build
docker compose -f deploy/app01/docker-compose.app01.yml \
  -f deploy/app01/docker-compose.build.yml \
  --env-file deploy/app01/app01.env up -d --force-recreate api worker smtp
cd deploy/app01 && bash cutover.sh --repair --apply   # ZWINGEND nach Recreate
```
Danach prüfen: `docker exec postbote-v2-api-1 node -e "require('juice')"`,
DNS `postbote` auf allen 5 Netzen, `/health`, `/deliverystats`, eine
Smoke-Mail mit HTML/CSS.

Der `5fc9c8c`-Commit stammt **nicht** aus dieser Session — vor Änderungen an
`sender.ts` / `test/m8.test.ts` / `package.json` kurz mit dem User klären,
damit nichts überschrieben wird.
