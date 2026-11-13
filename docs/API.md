# postbote HTTP-API

Postmark-kompatible REST-API. Basis-URL im Default `http://localhost:3000`.
Alle Endpunkte (ausser `/health`) erwarten den Header
`X-Postmark-Server-Token: <token>`.

## Authentifizierung & Sandbox

- Tokens gehören zu einem *Server*; der Token wird nur als SHA-256-Hash
  gespeichert und bestimmt den `serverId`-Scope aller Queries.
- **Sandbox**: Tokenwert `POSTMARK_API_TEST` führt die vollständige Validierung
  aus, speichert aber nichts und versendet nichts. Antwort ist eine normale
  Erfolgs-Antwort mit `ErrorCode: 0`.
- Fehlende/falsche Tokens → HTTP 401, `{"ErrorCode":10,...}` und Echo-Header
  `X-PM-ApiErrorCode: 10`.
- Das gleiche Echo gibt es bei allen API-Fehlern.

## Fehlercodes

| Code | HTTP | Bedeutung |
|---|---|---|
| 0 | 200 | OK |
| 10 | 401 | Token fehlt/ungültig |
| 300 | 422 | Validierungsfehler (From/To/Subject/…) |
| 402 | 400 | Ungültiges JSON |
| 406 | 422 | Inaktiver Empfänger (Suppression für diesen Stream) |
| 410 | 422 | Batch > 500 Nachrichten |
| 1101 | 422 | Template nicht gefunden |
| 1235 | 422 | Message-Stream existiert nicht oder ist archiviert |
| 1364 | 422 | Webhook-Verifikation fehlgeschlagen |
| 429 | 429 | Rate-Limit pro Token überschritten |
| 1480 | 422 | Absender nicht in der `allowedFrom`-Allowlist |
| 100010 | 422 | Template-Renderfehler |

Batch-Aufrufe antworten **immer mit HTTP 200** und pro Item einem `ErrorCode`
(Postmark-Verhalten), nie mit 207/Mixed-Status.

### Limits & Sender-Allowlist

- **Rate-Limit**: pro Server-Token `POSTBOTE_RATE_LIMIT_PER_MIN` Requests/Minute
  (Default 600, `0` = aus). Überschreitung → **HTTP 429**, `ErrorCode: 429`,
  Header `Retry-After` in Sekunden.
- **Payload**: max. **10 MB pro Nachricht** (→ 422/ErrorCode 300), max. **50 MB**
  pro Batch-Payload. Im Batch wird ein zu grosses Item einzeln mit 300 markiert.
- **allowedFrom**: Ein Token kann eine Sender-Allowlist tragen (exakte Adresse
  oder `*@domain.tld`). Verstösse → **ErrorCode 1480**. Ohne Allowlist sind alle
  Absender erlaubt.
- `From` akzeptiert auch Anzeigenamen (`"Max <max@devolta.de>"`).

---

## Senden

### `POST /email`

```json
{
  "From": "Absender <absender@deine-domain.de>",
  "To": "a@example.com, b@example.com",
  "Cc": "cc@example.com",
  "Bcc": "bcc@example.com",
  "ReplyTo": "reply@deine-domain.de",
  "Subject": "Betreff",
  "HtmlBody": "<p>Hallo {{name}}</p>",
  "TextBody": "Hallo",
  "Tag": "onboarding",
  "Metadata": { "userId": "42" },
  "Headers": [{ "Name": "X-Custom", "Value": "wert" }],
  "Attachments": [{
    "Name": "report.pdf", "Content": "<base64>",
    "ContentType": "application/pdf", "ContentID": "cid:report"
  }],
  "TrackOpens": true,
  "TrackLinks": "HtmlAndText",
  "MessageStream": "outbound"
}
```

Antwort `200`:

```json
{
  "To": "a@example.com, b@example.com",
  "SubmittedAt": "2026-11-13T17:48:30.557Z",
  "MessageID": "7c0244db-f059-4f4e-9b83-4f8b0a52d037",
  "ErrorCode": 0,
  "Message": "OK"
}
```

Die Nachricht wird synchron mit Status `queued` akzeptiert; der Worker
übernimmt den Versand. Der Envelope-Absender folgt immer dem `From`
(DKIM/DMARC-Ausrichtung).

`TrackOpens: true` bettet ein 1x1-Pixel ein, `TrackLinks` rewrite Links
(`None` · `HtmlAndText` · `HtmlOnly` · `TextOnly`). Die Transform passiert erst
beim Versand — der gespeicherte Original-Body bleibt über `/dump` abrufbar.
Basis-URL: `POSTBOTE_TRACKING_BASE_URL` (Default `http://localhost:3000`).

Vor dem Akzeptieren prüft postbote zwei Regeln: unbekannte/archivierte
`MessageStream` → **1235**, unterdrückte Empfänger → **406** (siehe
[Suppressions](#suppressions)).

### `POST /email/batch`

Body: Array von bis zu **500** Message-Objekten (gleiche Felder wie `/email`).
Antwort: Array mit pro-Item `ErrorCode`/`Message`/`MessageID` — fehlerhafte
Items werden einzeln markiert, gültige trotzdem akzeptiert.

### `POST /email/withTemplate`

```json
{
  "From": "absender@deine-domain.de",
  "To": "a@example.com",
  "TemplateAlias": "welcome",
  "TemplateModel": { "name": "Max" },
  "MessageStream": "outbound"
}
```

`TemplateId` statt `TemplateAlias` wird ebenfalls akzeptiert. Unbekanntes
Template → `1101`, Renderfehler → `100010`.

### `POST /email/batchWithTemplates`

Array aus `{ TemplateAlias|TemplateId, TemplateModel, From, To, ... }`.
HTTP 200 + pro-Item-Errors, analog zu `/email/batch`.

---

## Templates & Layouts

| Endpunkt | Zweck |
|---|---|
| `POST /templates` | Anlage/Update (`Alias`, `Name`, `Subject`, `HtmlBody`, `TextBody`, `LayoutAlias`) |
| `GET /templates?count=&offset=` | Liste mit `TotalCount` |
| `GET /templates/:key` | Details (Alias oder UUID) |
| `PUT /templates/:key` | Update |
| `DELETE /templates/:key` | Löschen |
| `POST /templates/validate` | Render-Prüfung ohne Versand; liefert gerenderte Teile + Fehler |

Renderer (Mustachio-kompatibel): `{{var}}`, `{{{raw}}}`, `#each`, `#if`,
`#unless`, `else`, Parent-Referenzen `../../`. `Subject` und `TextBody` werden
**nicht** HTML-escaped; `HtmlBody` escaped nur `& < > " '`.
Layouts mit `{{{content}}}` oder `{{@content}}` werden über `LayoutAlias`
eingebunden. Fehlt `HtmlBody`, wird Text verwendet; fehlt `TextBody`, wird es
aus HTML abgeleitet.

---

## Abfragen

| Endpunkt | Antwort (Auszug) |
|---|---|
| `GET /messages/outbound?count=50&offset=0` | `{ TotalCount, Messages: [{ MessageID, From, To, Subject, Tag, Status, MessageStream, SubmittedAt }] }` |
| `GET /deliverystats` | `{ Sent, Queued, Failed, Bounced }` |
| `GET /server` | `{ ID, Name, Slug, MessageStreamDefault }` |
| `GET /health` | `{ status: "ok", version }` — ohne Auth |

Statuswerte: `queued` · `sent` · `failed` · `bounced`.

### Bounces

| Endpunkt | Zweck |
|---|---|
| `GET /bounces?count=&offset=&type=` | Liste (Filter nach `Type`), `TotalCount` |
| `GET /bounces/:id` | Einzelbounce mit `Type`, `TypeCode`, `Description`, `Email`, `BouncedAt`, `MessageID` |
| `GET /bounces/:id/dump` | `{ Body }` — Rohinhalt der Nachricht |
| `PUT /bounces/:id/activate` | Reaktivierung: entfernt die durch den Bounce erzeugte Suppression (ErrorCode 406 entfällt) |

Bounce-Typen und Codes: `HardBounce` 1 · `Transient` 2 · `DnsError` 256 ·
`SoftBounce` 4096 · `BadEmailAddress` 100000 · `Blocked` 100006 ·
`SMTPApiError` 100007 (asynchrone Fehler nach SMTP-Annahme) · `DMARCPolicy` 100009.

### Webhooks

| Endpunkt | Zweck |
|---|---|
| `GET /webhooks` | `{ Webhooks: [...] }` |
| `GET /webhooks/:id` | Einzelwebhook |
| `POST /webhooks` | Anlage |
| `PUT /webhooks/:id` | Update |
| `DELETE /webhooks/:id` | Löschen |
| `POST /webhooks/:id/verify` | Erneute Verifikation |

```json
{
  "Url": "https://app.example.com/hooks",
  "Triggers": { "Delivery": { "Enabled": true }, "Bounce": { "Enabled": true }, "Open": { "Enabled": true }, "Click": { "Enabled": true } },
  "HttpAuth": { "Username": "user", "Password": "pass" },
  "HttpHeaders": [{ "Name": "X-Source", "Value": "postbote" }],
  "Verify": true
}
```

Beim Anlegen/Editieren mit `Verify: true` (Default) sendet postbote eine
Verifikations-Probe an die URL. Antwortet sie nicht mit 2xx → **HTTP 422,
ErrorCode 1364**, und es wird nichts gespeichert. `Verify: false` legt einen
unverifizierten Webhook an, der keine Events erhält. Passwörter werden in
Antworten als `REDACTED` ausgegeben.

**Event-Payloads** (keine Signaturen!): `RecordType: "Delivery" | "Bounce" | "Open" | "Click"`,
`MessageID`, `Recipient`, `Tag`, `Metadata`, `DeliveredAt`/`BouncedAt`, `Type`,
`TypeCode`, `Description`. Jeder Request trägt
`X-PM-Webhook-Trace-Id` zur Idempotenz; Nicht-2xx/Timeouts werden wiederholt,
Empfänger müssen also idempotent sein.

---

## Message-Streams (Phase 2)

`outbound` ist der eingebaute Default-Stream und immer gültig. Eigene Streams
müssen angelegt sein und dürfen nicht archiviert sein, sonst antwortet
`POST /email` mit **ErrorCode 1235**.

| Endpunkt | Zweck |
|---|---|
| `GET /message-streams` | `{ TotalCount, MessageStreams: [...] }` |
| `GET /message-streams/:id` | Einzelstream |
| `POST /message-streams` | Anlage: `{ ID, Name, Description?, MessageStreamType? }` |
| `PUT /message-streams/:id` | `Name`/`Description` ändern |
| `POST /message-streams/:id/archive` · `/unarchive` | Archivieren / reaktivieren |

Antwortfelder: `ID`, `Name`, `Description`, `MessageStreamType`
(`outbound`/`broadcast`/custom), `Archived`, `CreatedAt`.

## Suppressions (Phase 2)

Unterdrückte Adressen gelten pro Server **und Stream**. Ein `HardBounce` legt
die Suppression automatisch an; weitere Sends an die Adresse liefern
**ErrorCode 406** (im Batch als pro-Item-Error bei HTTP 200).

| Endpunkt | Zweck |
|---|---|
| `GET /suppressions/:stream` | Dump: `{ TotalCount, Suppressions: [{ EmailAddress, SuppressionReason, CreatedAt, MessageStream }] }` |
| `POST /suppressions/:stream` | `{ EmailAddress, SuppressionReason? }` oder `{ Suppressions: [...] }` |
| `POST /suppressions/:stream/delete` | `{ EmailAddress }` → `{ ErrorCode: 0, Message }` |
| `DELETE /suppressions/:stream` | Alias mit `{ EmailAddress }` |

`SuppressionReason`: `HardBounce` · `SpamComplaint` · `ManualSuppression`.
Adressen werden kleingeschrieben normalisiert. `PUT /bounces/:id/activate`
entfernt die zum Bounce gehörende Suppression wieder.

## Stats & Tracking (Phase 2)

| Endpunkt | Zweck |
|---|---|
| `GET /stats/outbound?from=&to=&tag=` | Tageswerte + Summen: `Days[]` mit `Sent/Bounced/Opens/Clicks/Tracked`, dazu `Sent`, `Bounced`, `Opens`, `Clicks`, `Tracked`, `FromDate`, `ToDate` (Default: letzte 7 Tage, max. 366) |
| `GET /messages/outbound/:id/opens` | `{ TotalCount, Opens: [{ ReceivedAt, UserAgent }] }` |
| `GET /messages/outbound/:id/clicks` | `{ TotalCount, Clicks: [{ ReceivedAt, OriginalLink, ClickLocation, UserAgent }] }` |
| `GET /track/open/:messageId` | **öffentlich**: 1x1-GIF, erzeugt Open-Event + `Open`-Webhook |
| `GET /track/click/:messageId?url=&location=` | **öffentlich**: 302-Redirect, erzeugt Click-Event + `Click`-Webhook |

Die `/track/*`-Endpunkte brauchen **keinen Token** (Mail-Clients rufen sie auf)
und müssen über `POSTBOTE_TRACKING_BASE_URL` öffentlich erreichbar sein.
`url` muss `http`/`https` sein, sonst HTTP 400. Webhooks können jetzt zusätzlich
die Trigger `Open` und `Click` aktivieren.

## Beispiele

```bash
# Sandbox — volle Validierung, kein Versand
curl -X POST http://localhost:3000/email \
  -H 'X-Postmark-Server-Token: POSTMARK_API_TEST' \
  -H 'Content-Type: application/json' \
  -d '{"From":"a@b.de","To":"c@d.de","Subject":"Test","TextBody":"Hi"}'

# Batch
curl -X POST http://localhost:3000/email/batch \
  -H "X-Postmark-Server-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '[{"From":"a@b.de","To":"c@d.de","Subject":"1","TextBody":"x"},
       {"From":"","To":"bad","Subject":"2"}]'

# Bounces nach Typ
curl -H "X-Postmark-Server-Token: $TOKEN" \
  'http://localhost:3000/bounces?type=HardBounce&count=50'
```
