# Postmark-Analyse

> Ziel dieser Analyse: Postmark (https://postmarkapp.com) vollständig verstehen – Funktionsweise,
> Funktionsumfang, API-Design – als Blueprint für ein **Open-Source-Projekt mit Docker-Deployment**,
> das als **Zwischenlayer (Middleware) für Anwendungen** dient: Anwendungen sprechen eine
> Postmark-artige API (oder SMTP) an, der Layer übernimmt Queueing, Tracking, Webhooks etc. und
> versendet die Mails über **konfigurierbare SMTP-Zugangsdaten** (Upstream-Relay).
>
> Stand der Recherche: November 2026 (Quellen: postmarkapp.com/developer, eigene API-Doku-Seiten).

---

## 1. Was ist Postmark und wie funktioniert es?

### 1.1 Grundkonzept

Postmark ist ein **E-Mail-Delivery-Service** (ESP – Email Service Provider) für
**Anwendungs-E-Mails** (transactional + broadcast): Passwort-Resets, Receipts, Notifications,
Product-Updates, Digests. Kernidee:

```
Anwendung ──(HTTP-POST /email ODER SMTP)──► Postmark ──(angekündigte IPs, SPF/DKIM/DMARC)──►
                                              │
                                              ├─ Queue / Retry / Bounce-Handling
                                              ├─ Open-/Click-Tracking
                                              ├─ Event-Verarbeitung
                                              └─ Webhooks ──► zurück in die Anwendung
```

Die Anwendung muss sich um **nichts** kümmern, was mit "Mail tatsächlich zustellen" zu tun hat:
SMTP-Handshake, Retries bei Tempfails, Bounce-Parsing, Throttling, IP-Reputation, DKIM-Signierung.
Sie postet ein JSON (oder eine SMTP-Mail) und bekommt sofort ein `MessageID` + Status zurück.
Alles Weitere liefert Postmark asynchron über Webhooks und eine Query-API zurück.

### 1.2 Zentrale Architekturprinzipien (für den Clone relevant)

1. **Sende-Akzeptanz ≠ Zustellung.** Postmark nimmt die Mail schnell an (HTTP 200 mit MessageID)
   und arbeitet sie asynchron ab. Fehler beim Zustellen landen in Bounces/Webhooks, nicht
   notwendig in der Sync-Antwort (beim SMTP-Interface sogar grundsätzlich so).
2. **Getrennte Infrastruktur für Transactional vs. Broadcast** ("Message Streams"): eigene
   IP-Pools, damit sich die Reputation nicht mischt (Gmail-Best-Practice).
3. **Alles ist querybar:** jede gesendete Mail ist über `MessageID` auffindbar (Details, Raw-Dump,
   Opens, Clicks, Bounces) – meist 30–45 Tage Retention.
4. **Event-getrieben:** Webhooks für Delivery, Bounce, SpamComplaint, Open, Click,
   SubscriptionChange (Unsubscribe), Inbound, SMTPApiError.
5. **Accounts → Servers → Message Streams → Mails**: Hierarchie der Authentifizierung/Tokens.
   Ein *Account* hat viele *Server* (z. B. pro Umgebung/App), ein *Server* hat bis zu 10
   *Message Streams* (z. B. `outbound`, `broadcast`, `invoices`).

### 1.3 Abgrenzung

- **Kein Listenmarketing-Tool**: keine Listen-Uploads, kein WYSIWYG-Editor, keine Kampagnen-Reports.
  Listenführung bleibt in der Anwendung; Postmark bietet nur Unsubscribe/Suppression-Helfer.
- **Manuelles Sender-Vetting** beim Onboarding, Anti-Abuse-Systeme.
- REST-API ist die primäre Schnittstelle; SMTP ist die "Migration-Variante" mit weniger Features.

---

## 2. Funktionsumfang (Feature-Liste)

### 2.1 Senden

| Feature | Beschreibung |
|---|---|
| Einzelversand (API) | `POST /email` mit JSON-Message, sofortige Sync-Antwort mit `MessageID` |
| Batch-Versand | `POST /email/batch`, bis **500 Messages** pro Call, bis **50 MB** Payload; Antwort pro Message mit eigenem ErrorCode (HTTP bleibt 200) |
| Template-Versand | `POST /email/withTemplate` mit `TemplateAlias`/`TemplateId` + `TemplateModel` (Handlebars-artige Variablen) |
| Batch mit Templates | `POST /email/batchWithTemplates` (bis 500) |
| Bulk (Broadcast) | `POST /email/bulk` – gemeinsamer Body + pro Empfänger `TemplateModel`; Status-Tracking über `GET /email/bulk/{id}` (Approval erforderlich) |
| SMTP-Versand | klassischer SMTP-Relay-Zugang, siehe Kapitel 4 |
| Anhänge | Base64-codierte `Attachments` inkl. Inline (`ContentID`/`cid:`) |
| Metadaten | freies Key/Value-Objekt `Metadata`, taucht in Webhooks & Messages-API wieder auf |
| Tags | ein `Tag` pro Mail zur Kategorisierung/Statistik (max. 1000 Zeichen) |
| Custom Header | beliebige Header via `Headers`-Array |
| Tracking | `TrackOpens` (bool), `TrackLinks` (`None`/`HtmlAndText`/`HtmlOnly`/`TextOnly`) – pro Mail oder per Server-Setting |
| Recipient-Limits | To/Cc/Bcc je max. 50 Adressen, je max. 254 Zeichen |
| Größenlimit | 10 MB pro Mail (E-Mail-API), 50 MB Batch-Payload |

### 2.2 Templates

- Templates mit **Alias** (stabil, empfohlen) oder numerischer ID; Variablen via `TemplateModel`.
- **Layout-Templates** mit `{{{content}}}`-Platzhalter, von denen andere Templates erben.
- CRUD: `GET/POST/PUT/DELETE /templates`, List/Paging, `Validate` (Render-Test),
  `Push` (Templates auf anderen Server kopieren).

### 2.3 Message Streams

- Typen: **Transactional** (`outbound`, 1 Empfänger, user-getriggert) und **Broadcast**
  (`broadcast`, viele Empfänger, opt-out-Pflicht), plus **Inbound**-Stream (max. 1 pro Server).
- Pro Stream eigene Webhooks, eigene SMTP-Tokens, eigene Statistiken.
- **Custom Unsubscribe Handling** pro Stream (`UnsubscribeHandlingType`) +
  Subscription-Change-Webhook.
- API: `GET/POST/PUT /message-streams`, Archive/Unarchive (Defaults können nicht archiviert werden).

### 2.4 Zustellungs-Events & Webhooks

Webhook-Typen (POST als JSON an konfigurierbare URL, pro Stream konfigurierbar):

| Webhook | Wann | Wichtige Felder |
|---|---|---|
| **Delivery** | empfangender Server antwortet `250 OK` | `RecordType: "Delivery"`, `MessageID`, `Recipient`, `DeliveredAt`, `Details` (SMTP-Response), `Tag`, `Metadata` |
| **Bounce** | Zustellversuch scheitert dauerhaft/temporär | `RecordType: "Bounce"`, `Type` (HardBounce, SoftBounce, …), `Email`, `BouncedAt`, `Description`, optional `Content` |
| **SpamComplaint** | Empfänger meldet Spam | analog Bounce |
| **Open** | Tracking-Pixel geladen | `RecordType: "Open"`, `ReceivedAt`, `UserAgent`, `ReadSeconds`; Option `PostFirstOpenOnly` |
| **Click** | getrackter Link geklickt | `RecordType: "Click"`, `ClickLocation` (HTML/Text), `OriginalLink` |
| **SubscriptionChange** | Unsubscribe/Suppression | `RecordType: "SubscriptionChange"`, `SuppressionReason` |
| **Inbound** | eingehende Mail (inbound server) | geparste Mail inkl. Attachments, `MailboxHash`, Headers |
| **SMTPApiError** | Mail über SMTP angenommen, dann abgelehnt | beschreibt den API-Fehler, der per SMTP nicht zurückgemeldet werden konnte |

Eigenschaften der Webhooks (wichtig für den Clone):

- **Keine Signaturen!** Schutz erfolgt über HTTP Basic Auth (`HttpAuth`), Custom Headers
  (`HttpHeaders`) und IP-Allowlisting in der empfangenden App.
- **Verifikation**: beim Anlegen/Editieren testet Postmark jeden aktivierten Trigger gegen die
  URL (muss je 200 liefern); sonst HTTP 422 + ErrorCode 1364, nichts wird gespeichert.
  `Verify: false` erlaubt unverified-Anlage; unverified Webhooks bekommen keine Events.
- **Retries**: bei Nicht-2xx oder Timeout → dieselbe Event-Payload kann **mehrfach** ankommen
  → Empfänger muss **idempotent** sein (z. B. Key aus `MessageID`+`Recipient`+`DeliveredAt`
  oder `X-PM-Webhook-Trace-Id`).
- Webhooks-CRUD per API: `/webhooks` (+ `/verify`, `/statistics` mit 24h-Metriken:
  SuccessRate, Retries, Response-Times).

### 2.5 Bounces & Suppressions

- **Bounce-API**: `/deliverystats`, `/bounces` (Suche, Filter, max. 10.000/Abfrage),
  `/bounces/{id}`, `/bounces/{id}/dump` (Raw-Quelle, 30 Tage), `PUT /bounces/{id}/activate`
  ("Reaktivieren" einer deaktivierten Adresse).
- Hard Bounces deaktivieren Empfänger automatisch ("inactive recipients") – weitere Sends an
  sie liefern ErrorCode 406.
- **Bounce-Typen** (Type/TypeCode), u. a.:

| Type | Code | Bedeutung |
|---|---|---|
| HardBounce | 1 | Mailbox existiert nicht / Server lehnt endgültig ab |
| Transient | 2 | temporär verzögert |
| Unsubscribe | 16 | Abmelde-Request |
| AutoResponder | 64 | Auto-Reply/OOO |
| DnsError | 256 | temporärer DNS-Fehler |
| SpamNotification | 512 | zugestellt, aber als Spam eingeordnet |
| SoftBounce | 4096 | temporär (Mailbox voll etc.) |
| BadEmailAddress | 100000 | ungültige Adresse |
| SpamComplaint | 100001 | explizite Spam-Beschwerde |
| Blocked | 100006 | ISP-Block |
| SMTPApiError | 100007 | Fehler beim SMTP-Annahme (fängt API-Fehler nachträglich ab) |
| InboundError | 100008 | Inbound-Verarbeitung fehlgeschlagen |
| DMARCPolicy | 100009 | DMARC-Ablehnung |
| TemplateRenderingFailed | 100010 | Template-Renderfehler |

- **Suppressions-API**: Dump/Create/Delete (`SuppressionReason`: HardBounce, SpamComplaint,
  ManualSuppression) – für Broadcast-Streams.

### 2.6 Nachrichten-Archiv & Activity

- Outbound-Suche: `GET /messages/outbound` (Filter: From, To, Tag, Status `sent`/`queued`/
  `failed`/`undeliverable`, timeframe, MessageStream), Details + Raw-Dump pro Message.
- Opens/Clicks pro Message und aggregiert; Message-Open-Tracking auch per API abfragbar.
- Inbound-Suche/Details, Retry/Bypass für blockierte Inbound-Mails.

### 2.7 Stats-API

`/stats/outbound` etc.: Sent, Bounced, Spam, Tracked, Opens (+ Plattform/Client/Browser-Usage),
Clicks (+ Browser/Klick-Position), mit `FromDate`/`ToDate` (max. 1 Jahr zurück).

### 2.8 Domains & Sender Signatures (Authentizität)

- **Domains**: DKIM-Keys (Rotate/Verify), Return-Path (Bounce-Domain, CNAME), SPF-Verify –
  hier veraltet zugunsten von Sender-Signaturen, beide existieren parallel in der API.
- **Sender Signatures**: bestätigte Absender (Einzel-Addressen oder ganze Domain), DKIM/SPF/
  Return-Path-Records, Verify-Flow per API.
- Für den Clone: **wichtigstes Postmark-Versprechen** – sauberes SPF/DKIM/DMARC-Setup. Ein
  Zwischenlayer, der über fremde SMTP-Credentials versendet, kann DKIM i. d. R. dem Upstream
  überlassen, sollte aber Headerraum (From, Return-Path-Verhalten) dokumentieren.

### 2.9 Inbound (E-Mails empfangen)

- Dedizierter Inbound-Server + Domain-MX-Umleitung; Postmark parst die Mail (HTML/Text,
  Attachments, Headers, `MailboxHash` aus `user+tag@domain`) und POSTet sie an einen Inbound-Webhook.
- Inbound-Regeln (Triggers): Block-/Allowlists per API.

### 2.10 Sonstiges

- **Sandbox/Test-Modus**: Server-Token `POSTMARK_API_TEST` → validiert die Mail, versendet
  nichts; "Fake Bounces" generierbar (Blackhole-Adresse `*@blackhole.postmarkapp.com`).
- **Data Removal API** (GDPR): Löschanfragen für Recipient-Daten anstoßen/status prüfen.
- **Server-/Account-Verwaltung** per API (Servers-CRUD, Token-Rotation, SMTP on/off).
- **Offizielle Libraries**: Node/TypeScript, Ruby (+Rails), .NET, Java, PHP, Python, CLI,
  WordPress; große Community-Library-Liste.

---

## 3. API-Design (wie die REST-API aufgebaut ist)

### 3.1 Grundlagen

- **REST/JSON over HTTPS**, Base URL: `https://api.postmarkapp.com`
- Header: `Accept: application/json`, `Content-Type: application/json`
- **Zwei Auth-Typen** (Header case-insensitive):
  - `X-Postmark-Server-Token` – Server-privilegierte Operationen (Senden, Bounces, Webhooks,
    Messages, Templates, Stats). Pro Server.
  - `X-Postmark-Account-Token` – Account-Operationen (Servers-CRUD, Signaturen, Domains, Data
    Removal). Pro Account.
- **Test-Modus**: statt Server-Token `POSTMARK_API_TEST` senden → Validierung ohne Zustellung.
- Falsche/fehlende Auth → HTTP 401.

### 3.2 Response-/Error-Konzept

HTTP-Status semantisch:

| HTTP | Bedeutung |
|---|---|
| 200 | OK |
| 401 | Token fehlt/falsch |
| 404 | Ressource existiert nicht |
| 413 | Payload zu groß (>10 MB Mail / >50 MB Batch) |
| 415 | Required Header fehlt |
| 422 | Validierungsfehler → Body enthält `ErrorCode` + `Message` |
| 429 | Rate Limit |
| 500/503 | Serverfehler / Wartung |

**Error-Code-System**: numerischer `ErrorCode` im Body + Echo im Response-Header
`X-PM-ApiErrorCode`. Wichtig: **Batch-Antworten kommen mit HTTP 200**, aber pro Message im Array
mit eigenem `ErrorCode` (z. B. 406 = inactive recipient). Beispiel:

```json
{ "ErrorCode": 403, "Message": "Invalid request field(s): 'From'." }
```

Ausgewählte Codes: `10` Auth, `300` Send-Validation, `402` Invalid JSON, `406` Inactive
recipient, `410` >500 pro Batch, `1101` Template nicht gefunden, `1235` Stream existiert nicht,
`1480` IP nicht erlaubt, `1364` Webhook-Verifikation fehlgeschlagen. (Vollständige Tabelle in
der Doku: developer/api/overview#error-codes.)

### 3.3 Die Sende-Endpunkte im Detail

#### `POST /email` – Message-Format (die "Kern-Entität")

```json
{
  "From": "Full Name <sender@example.com>",   // muss bestätigte Sender Signature haben
  "To": "receiver1@example.com, receiver2@example.com",  // max. 50
  "Cc": "...", "Bcc": "...",
  "Subject": "Password Reset",
  "TextBody": "Klartext ...",                  // Pflicht, wenn kein HtmlBody
  "HtmlBody": "<html>...</html>",              // Pflicht, wenn kein TextBody
  "Tag": "welcome-email",
  "ReplyTo": "reply@example.com",
  "Headers": [ { "Name": "CUSTOM-HEADER", "Value": "value" } ],
  "TrackOpens": true,
  "TrackLinks": "HtmlAndText",                 // None | HtmlAndText | HtmlOnly | TextOnly
  "Attachments": [
    { "Name": "readme.txt", "Content": "<base64>", "ContentType": "text/plain" },
    { "Name": "img.jpg", "ContentID": "cid:image.jpg", "Content": "<base64>", "ContentType": "image/jpeg" }
  ],
  "Metadata": { "client-id": "12345" },
  "MessageStream": "outbound"                  // default: "outbound"
}
```

Erfolgsantwort:

```json
{
  "To": "receiver@example.com",
  "SubmittedAt": "2026-11-13T12:01:05.1794748-05:00",
  "MessageID": "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
  "ErrorCode": 0,
  "Message": "OK"
}
```

#### `POST /email/batch` – JSON-Array von Messages (max. 500), Antwort: Array mit
`ErrorCode`/`Message`/`MessageID`/`SubmittedAt`/`To` pro Element.

#### `POST /email/withTemplate` – wie `/email`, statt Subject/Body:
`TemplateAlias` **oder** `TemplateId` + `TemplateModel` (Variablen), optional `InlineCss`,
auch hier alle übrigen Felder (Attachments, Metadata, …).

#### `POST /email/batchWithTemplates` – `{ "Messages": [ ... ] }` mit pro Message eigener
Template-Auswahl/Model.

#### `POST /email/bulk` – ein gemeinsamer Content + `Messages[]` mit Empfänger-spezifischen
`TemplateModel`s; Antwort: `BulkRequestID`; Status via `GET /email/bulk/{id}`; Liste via
`GET /email/bulk?count=&paginationKey=` (Cursor-Paging).

### 3.4 Weitere Endpunkt-Familien (Übersicht)

| Familie | Endpunkte (typisch) |
|---|---|
| Bounce | `/deliverystats`, `/bounces`, `/bounces/{id}`, `/bounces/{id}/dump`, `/bounces/{id}/activate` |
| Templates | `/templates`, `/templates/{id}`, `/templates/validate`, `/templates/push` |
| Server | `/server` (GET/PUT, Server-Token) |
| Servers (Account) | `/servers`, `/servers/{id}` (GET/POST/PUT/DELETE) |
| Message Streams | `/message-streams`, `/message-streams/{id}` (+archive/unarchive) |
| Messages | `/messages/outbound`, `/messages/outbound/{id}/details`, `/{id}/dump`, opens, clicks |
| Domains | `/domains`, `/domains/{id}`, `/verify-dkim`, `/verify-return-path`, `/verify-spf`, `/rotate-dkim` |
| Sender Signatures | `/senders`, `/senders/{id}`, `/senders/{id}/verify`, SPF/DKIM-Aktionen |
| Stats | `/stats/outbound`, `/stats/outbound/sends`, `/bounces`, `/spam`, `/tracked`, `/opens`, `/clicks`, … |
| Triggers (Inbound Rules) | `/triggers/inboundrules` |
| Webhooks | `/webhooks`, `/webhooks/{id}`, `/webhooks/{id}/verify`, `/webhooks/{id}/statistics` |
| Suppressions | `/suppressions/{stream}`, `/suppressions/{stream}/delete` |
| Data Removal | `/data-removals`, `/data-removals/{id}` |
| Bulk | `/email/bulk`, `/email/bulk/{id}` |

Paging-Muster: `count` + `offset` (klassisch, max. 500/call) oder Cursor-`paginationKey` (Bulk).

### 3.5 Sandbox

`X-Postmark-Server-Token: POSTMARK_API_TEST` in **jedem** sendenden Call → alle Validierungen
laufen, kein echter Versand. Für CI/Tests ideal.

---

## 4. SMTP-Interface (wichtig als zweite Ingress-Variante)

### 4.1 Connection Details

| Parameter | Wert |
|---|---|
| Host (Transactional) | `smtp.postmarkapp.com` |
| Host (Broadcast) | `smtp-broadcasts.postmarkapp.com` |
| Ports | 25, 2525, 587 |
| TLS | STARTTLS (empfohlen) |
| Auth-Methoden | CRAM-MD5, DIGEST-MD5, PLAIN, LOGIN |

### 4.2 Authentifizierung – zwei Wege

1. **API-Token als User+Password** (Username == Password == Server-Token) + optionaler Header
   `X-PM-MESSAGE-STREAM: {stream-id}` (ohne Header → Default-Stream `outbound`).
2. **SMTP-Token** (pro Message Stream): **Access Key** = Username, **Secret Key** = Password
   (Secret wird nur einmal angezeigt). Damit entfällt der Custom-Header – ideal für Clients ohne
   Header-Unterstützung. → **Das ist genau das Feature-Set, das unser Zwischenlayer anbieten
   sollte: generierte SMTP-Credentials pro Stream/App.**

### 4.3 Steuerung über Header (der "API-Ersatz" bei SMTP)

| Header | Wirkung |
|---|---|
| `X-PM-MESSAGE-STREAM` | Stream-Auswahl |
| `X-PM-Tag` | Tag (1 pro Mail, max. 1000 Zeichen) |
| `X-PM-Metadata-<key>` | Metadaten (Prefix-Konvention) |
| `X-PM-KeepID: true` | eigenes `Message-ID`-Header nicht überschreiben (Postmark generiert sonst eigene ID und setzt Postmark-`MessageID` in Webhooks) |
| Track-Open/Link-Tracking | per Server-/Stream-Setting, nicht pro Mail |

### 4.4 Unterschiede SMTP vs. REST-API (Design-Lehre)

- SMTP akzeptiert **alles, was syntaktisch ok ist**, und meldet Probleme **asynchron als
  Bounce vom Typ `SMTPApiError`** – die App muss Bounces monitoren. Die REST-API dagegen
  validiert synchron und liefert `ErrorCode`.
- Kein Batch, keine Sync-Errorcodes, keine Antwort-Metadaten; dafür zero-code Migration
  (nur SMTP-Config im Framework ändern).
- Multi-Region-Routing: SMTP-Endpoints in mehreren AWS-Regionen, Routing nach Latenz.

---

## 5. Offizielle Libraries (Integration-Beispiele)

| Sprache | Package / Beispiel |
|---|---|
| TypeScript/Node | `npm i postmark` → `new ServerClient(token)`, `sendEmailWithTemplate(...)` |
| Ruby/Rails | `postmark` gem, ActionMailer-Integration |
| .NET | `PostmarkDotNet` (NuGet) |
| Java | `postmark-java` |
| PHP | `wildbit/postmark-php` / Laravel-Integration |
| Python | `postmarker` / offizieller Python-Support |
| CLI | Postmark-CLI |
| WordPress/Craft/Grunt | Plugins |

Empfohlenes Client-Pattern (aus der Doku): gemeinsamer Client, Batches mit
`Promise.allSettled` (Partial-Failure-Toleranz), MessageID für Webhook-Korrelation persistieren.

---

## 6. Mapping auf das Zielprojekt: Open-Source-Zwischenlayer mit Docker

### 6.1 Zieldefinition (aus dem Projektziel abgeleitet)

Ein self-hosted, Docker-deploybarer **E-Mail-Middleware-/Gateway-Service**, der:

1. **Postmark-kompatible Ingress-Schnittstellen** anbietet:
   - HTTP-API im Postmark-Stil (`POST /email`, `/email/batch`, `/email/withTemplate`, …)
   - SMTP-Server (mit generierten Credentials pro "Stream"/App)
2. **Eigentlichen Versand über konfigurierbare SMTP-Zugangsdaten** delegiert
   (Upstream: z. B. Gmail/Workspace, eigener MTA, IONOS/Strato/SMTP.com/SendGrid-SMTP, …).
3. Die **Postmark-Erlebnisfunktionen** nachbaut: Message-ID-Registry, Status-Tracking,
   Bounce-Verarbeitung, Webhooks, Templates, Stats.
4. **Postmark-kompatibel** im Response-/Error-Schema ist (ErrorCode-System, MessageID,
   `POSTMARK_API_TEST`-Sandbox), damit bestehende Postmark-Libraries ggf. nur durch
   Base-URL-Austausch funktionieren.

```
┌─────────────┐   POST /email      ┌────────────────────────────────────┐   SMTP (STARTTLS,
│ Anwendung A  │  oder SMTP ▶       │  Postbote (Zwischenlayer)          │   User/Pass vom
└─────────────┘                    │  ┌──────────┐  ┌───────────────┐   │   Upstream) ▼
                                   │  │ API/SMTP │─▶│ Queue (Redis/ │───┼──────────────► Upstream-MTA
┌─────────────┐   Webhook ◀────────┼──│ Ingress  │  │ DB Postgres)  │   │                └──────► Internet
│ Anwendung A  │  Delivery/Bounce   │  └──────────┘  └───────────────┘   │
└─────────────┘                    │  Templates │ Stats │ Webhook-Disp. │
                                   └────────────────────────────────────┘
```

### 6.2 Feature-Must / Nice-to-have / Kann später

**MVP (Must):**
- `POST /email` + `POST /email/batch` (Postmark-Schema, Sync-Response mit `MessageID`, UUID)
- Auth per `X-Postmark-Server-Token` (Token = "Server/App") + Sandbox-Token `POSTMARK_API_TEST`
- SMTP-Ingress (Ports 2525/587, STARTTLS, Auth PLAIN/LOGIN) mit pro-App-Credentials
  (Access/Secret-Key-Pärchen wie Postmark-SMTP-Tokens)
- Persistentes Message-Store (Postgres): Status `queued/sent/failed/bounced`, Raw-Mail,
  Metadata, Tag
- Outbound-Queue mit Worker: Retry mit Backoff bei 4xx-Tempfails, Bounce-Erkennung
  (DSN/`550`-Codes → Bounce-Typ-Mapping gemäß Tabelle 2.5)
- Webhook-Dispatcher: Delivery-/Bounce-Events POSTen an konfigurierte URLs (Basic Auth +
  Custom Headers, Retry, Idempotenz-Key `X-PM-Webhook-Trace-Id`-analog)
- SMTP-Upstream-Config pro Server/Stream: Host, Port, Username, Password, TLS-Modus
- Error-Code-Schema kompatibel zu Postmark (Tabelle 3.2, mindestens 10/300/402/403/406/410)
- Docker: `docker compose up` mit api + worker + db (+ redis), Healthchecks

**Phase 2:**
- Templates (CRUD + Render, Handlebars), `/email/withTemplate`, `batchWithTemplates`
- Message-Streams (`outbound`/`broadcast` + custom), pro Stream eigene Upstream-Credentials
- Open-/Click-Tracking (Pixel + Link-Rewrite), Stats-Endpunkte
- Suppressions + Inactive-Recipient-Logik (ErrorCode 406)
- Webhooks-API (CRUD + Verify-Flow wie 2.4)
- Admin-UI (Messages-Activity, Bounces, Templates)

**Kann später:**
- Inbound (empfangen + parsen), Data Removal, Multi-Tenancy (Accounts→Servers),
  Multi-Region, Layout-Templates, Template-Push.

### 6.3 Designentscheidungen, die Postmark uns vorgibt

1. **Schnelle Sync-Annahme, async Zustellung**: API antwortet nach Persistenz in Queue
   (< ~1 s), nie auf SMTP-Handshake des Upstreams warten.
2. **MessageID als correlation key**: UUID v4, in Response, DB, Webhooks, Activity überall
   gleich; App speichert sie für Follow-ups.
3. **Batch = HTTP 200 + pro-Item Errors** – nicht 207/Mixed, exakt Postmark-Verhalten.
4. **Webhooks ohne Signatur, dafür Basic Auth/Headers/Allowlist + Retries** – Empfänger muss
   idempotent sein; wir sollten zusätzlich einen Trace-ID-Header setzen.
5. **Bounce-Klassifikation als eigene Domain-Logik** (Parsing von DSN/NDRs) – das ist der
   eigentliche "Wert" neben dem Queueing.
6. **Sandbox-Modus als Token-Wert**, nicht als Flag im Body.
7. **SMTP-Tokens pro Stream** (Access/Secret) als Credential-Modell für SMTP-Ingress.
8. **Retention**: Messages/Bounces z. B. 45 Tage konfigurierbar; Dumps kürzer.
9. **Rate-Limiting** (HTTP 429) pro Token; Payload-Limits (10/50 MB) spiegeln.

### 6.4 Technologie-Skizze (Vorschlag, nicht fester Bestandteil der Analyse)

- **API-Service**: Node (Fastify) oder Go – JSON, validation, token auth.
- **SMTP-Ingress**: Go `go-smtp` / Node `smtp-server` (Nodemailer) – STARTTLS, AUTH, Header-Extraktion
  (`X-PM-*`-Konvention übernehmen).
- **Queue/Worker**: Redis Streams/BullMQ oder Postgres-based queue (SKIP LOCKED) – Retry/Backoff,
  Bounce-Parsing (DSN-Parser), Webhook-Dispatcher mit Retry-Queue.
- **DB**: Postgres (messages, bounces, events, webhooks, templates, tokens, streams, stats).
- **Upstream-Versand**: Nodemailer-SMTP-Pool / Go `net/smtp` gegen `SMTP_HOST/PORT/USER/PASS`
  (env oder pro Stream in DB), TLS: STARTTLS erzwingen.
- **Deployment**: `docker-compose.yml` (api, smtp, worker, webhooks, postgres, redis,
  optional caddy für TLS am SMTP-Ingress), .env für Upstream-SMTP-Zugangsdaten.

### 6.5 Existierende Open-Source-Referenzen (Recherche-Kontext)

- **Postal** (postalserver.io) – self-hosted Mail-Delivery-Platform (eigener MTA, Webhooks,
  APIs) – am nächsten am Ziel, aber *ist* der MTA statt Zwischenlayer mit Upstream-SMTP.
- **Mailu / Mailcow** – Full-Mailstack (IMAP/SMTP), nicht API-first.
- **Haraka / msmtp / Nullmailer** – SMTP-Server/Relay-Bausteine ohne Postmark-API-Parität.
- **smtp4dev / MailHog / Mailpit** – nur Dev-Catching, kein Versand.
→ Lücke: *API-first, Postmark-kompatibler Zwischenlayer mit Upstream-SMTP-Relay und
Docker-Deployment* – genau die Positionierung des Zielprojekts.

---

## 7. Zusammenfassung in einem Satz

Postmark = **"Mail-Annahme + Asynchroner Zustell-Service + Event-Feedback-Loop"**:
Die Anwendung postet eine JSON-Mail (oder SMTP) mit `MessageStream`/Tag/Metadata, erhält sofort
eine `MessageID`, Postmark kümmert sich um Versand über gepflegte IP-Infrastruktur, klassifiziert
Bounces, trackt Opens/Clicks und füttert die Anwendung über Webhooks und Query-APIs mit dem
vollständigen Lebenszyklus jeder Mail – genau dieser Lebenszyklus (MessageID-Registry, Status,
Bounce-Typen, Webhook-Events, ErrorCodes, Sandbox) ist die Blaupause für den
Open-Source-Zwischenlayer mit Docker und Upstream-SMTP-Credentials.
