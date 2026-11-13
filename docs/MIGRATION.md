# Migration von Postmark zu postbote

Ziel: bestehende Clients sprechen weiterhin „Postmark", zeigen aber auf eigene
Infrastruktur. Im Idealfall ändert sich **nur der Host** — Token, Payload und
Antwortformat bleiben kompatibel.

> Hinweis: Dieses Dokument beschreibt die allgemeine Migration. Der konkrete
> Cut-Over des Live-Systems auf `app01` ist Meilenstein **M7** im
> [`BAUPLAN.md`](../BAUPLAN.md); das komplette Runbook (Parallel-Deploy,
> Import-Skripte, Cut-Over, Rollback, Smoke-Tests) liegt unter
> [`deploy/app01/README.md`](../deploy/app01/README.md).

## 1. Client-Konfiguration umstellen

### Postmark-Library (Node, `postmark` u. ä.)

Viele Bibliotheken erlauben einen Host-Override:

```bash
POSTMARK_API_HOST=http://localhost:3000
POSTMARK_SERVER_TOKEN=<postbote API-Token>
```

Falls die Library keinen Host-Override kennt, den Base-URL-Parameter des
Clients setzen (je nach Version `baseUrl`, `apiHost` o. ä.). Wichtig: kein
`https://api.postmarkapp.com` mehr.

### Clients mit URL-Override (z. B. Logto, aar)

```bash
POSTMARK_API_URL=http://localhost:3000/email
```

Beide Muster (`POSTMARK_API_HOST` bei lambatec, `POSTMARK_API_URL` bei aar)
wurden beim bestehenden System bewusst so gewählt, dass ein Service-Wechsel
ohne Code-Änderung möglich ist.

### SMTP-Clients

Kein Code nötig: Host/Port auf postbote umstellen und die Access/Secret-
Credentials eintragen.

```js
const transport = nodemailer.createTransport({
  host: 'postbote',          // Service-Name im Docker-Netz
  port: 587,
  secure: false,             // STARTTLS via postbote
  auth: { user: accessKey, pass: secretKey },
})
```

Siehe [`SMTP.md`](SMTP.md) für Ports, STARTTLS und `X-PM-*` Header.

## 2. Kompatibilitäts-Matrix

| Postmark-Feature | postbote (MVP) | Anmerkung |
|---|---|---|
| `POST /email`, `/email/batch` | ✅ | Batch ≤ 500, HTTP 200 + pro-Item-Errors |
| `X-Postmark-Server-Token` | ✅ | Tokens als SHA-256-Hash |
| Sandbox-Token `POSTMARK_API_TEST` | ✅ | Validierung ohne Persistenz/Versand |
| `POST /email/withTemplate`, `/batchWithTemplates` | ✅ | Mustachio, Layouts |
| `/templates`, `/templates/validate` | ✅ | |
| `/messages/outbound`, `/deliverystats` | ✅ | |
| `/bounces`, `/bounces/:id`, `/dump` | ✅ | `activate` ohne Suppressions-Logik |
| `/webhooks` + Verify (1364) | ✅ | Delivery + Bounce |
| `/server`, `/message-streams`, `/stats/outbound` | ✅ | Streams mit Archive/Unarchive |
| `/suppressions` + ErrorCode 406 | ✅ | Dump/Create/Delete, HardBounce deaktiviert automatisch |
| SMTP-Ingress mit Token-Auth | ✅ | 2525/587, PLAIN/LOGIN |
| Delivery-/Bounce-/Open-/Click-Webhooks | ✅ | keine Signaturen, Trace-Id |
| Open-/Click-Tracking | ✅ | Pixel + Link-Rewrite, Events und Tagesstatistik |
| ErrorCodes + `X-PM-ApiErrorCode` | ✅ | siehe [`API.md`](API.md) |
| NDR-Mailbox-Ingestion (asynchrone Bounces) | ⛔ | Phase 3 |
| Bulk/Broadcast-Versand, Inbound, Domains/Sender-Signaturen | ⛔ | Phase 3 |
| Open-/Click-Tracking | ✅ | Phase 2, M8 |

Bekannte Einschränkungen auch im [README](../README.md#bekannte-einschränkungen).

## 3. Vorbereitung

1. **postbote parallel deployen** (neuer Stack, eigener Port/Service-Name),
   Postgres und Upstream-Relay erreichbar machen.
2. **Tokens übernehmen**: Wert aus `tokens.env` wird als
   `POSTBOTE_BOOTSTRAP_TOKEN` gesetzt (postbote speichert nur den Hash) oder
   per Setup-CLI ein weiterer Token angelegt.
3. **Templates/Layouts importieren**: bestehende Dateien aus
   `/opt/postbote/templates` per `POST /templates` bzw. `POST /templates`
   mit `LayoutAlias` übernehmen; Renderer-Verhalten vorher mit
   `POST /templates/validate` gegen die Golden-Tests prüfen.
4. **Relay-Konfiguration** aus `smtp.env` übernehmen:

   ```bash
   npm run setup -- set-relay <host> <port> <user> <pass> starttls
   ```

5. **Absender-Domains prüfen**: SPF/DKIM/DMARC für alle `From`-Domains. Der
   Envelope-Absender folgt bei postbote immer dem `From` — bei strikter
   DMARC-Ausrichtung (z. B. aar) ist das die entscheidende Regel.

## 4. Smoke-Tests vor dem Cut-Over

- [ ] Testmail je Client (HTTP *und* SMTP) → `queued` → `sent`
- [ ] Logto-Forgot-Password-Flow Ende-zu-Ende
- [ ] Postfix/Upstream-Log: `status=sent`
- [ ] DKIM-Check je Domain, inkl. strikter Ausrichtung
- [ ] `GET /deliverystats` und `/messages/outbound` zeigen die Testmails
- [ ] Bounce-Webhook gegen eine absichtlich ungültige Adresse auslösen
- [ ] Sandbox-Token: Validierung ohne Versand
- [ ] Batch mit einem ungültigen Item: HTTP 200 + pro-Item-ErrorCode

## 5. Cut-Over (M7)

1. Neuer Stack übernimmt den Service-Namen `postbote`; Clients ändern nichts,
   weil sie nur den Namen ansprechen.
2. Legacy wird zu `postbote-legacy` und bleibt als Rollback **mindestens zwei
   Wochen** stehen.
3. Nach dem Wechsel Logs von `api`, `worker` und `smtp` beobachten; Queue-Leerlauf
   (`Queued: 0`) prüfen.

## 6. Rollback

Service-Namen zurück auf `postbote-legacy` zeigen (oder Compose-Service
umstellen). Da postbote seine Nachrichten in Postgres puffert, können noch
`queued`-Jobs vor dem Rollback abgearbeitet oder bewusst verworfen werden —
die Queue-Tabelle `jobs` ist Teil des DB-Backups.

## 7. Häufige Stolpersteine

| Symptom | Ursache / Lösung |
|---|---|
| `401 ErrorCode 10` | Falscher Token-Header; Bootstrap-Token gilt nur für den Default-Server |
| Mail bleibt `queued` | Kein `worker`-Container aktiv oder Relay nicht konfiguriert |
| Mail `sent`, aber nie angekommen | Kein Relay → Demo-Simulation `250`; `set-relay` ausführen |
| `422 ErrorCode 300` | `From`/`To`/`Subject` prüfen; Sandbox zeigt die genaue Validierung |
| `422 ErrorCode 1364` | Webhook-URL antwortet nicht 2xx; `Verify: false` nur für Tests |
| DKIM fail | Envelope-/Header-From-Domains abgleichen; DKIM-Key je Domain prüfen |
| SMTP `535` | Access/Secret vertauscht oder Secret nicht vollständig kopiert |
