# SMTP-Ingress

postbote nimmt Mails nicht nur per HTTP, sondern auch klassisch per SMTP an.
Akzeptierte Nachrichten landen im **gleichen Store und derselben Queue** wie
`POST /email` — der Worker versendet sie über den konfigurierten Upstream.

## Ports & Rollen

| Port | Zweck |
|---|---|
| 2525 | Submission (unprivilegiert, Default) |
| 587 | Submission (Standard-Port) |

Konfigurierbar über `POSTBOTE_SMTP_PORTS=2525,587`; ein leerer Wert deaktiviert
den Ingress vollständig. Im Split-Deploy übernimmt die Rolle
`POSTBOTE_ROLE=smtp` den Ingress; im Demo-/All-in-One-Modus (`all`, `DEMO=1`)
läuft er im selben Prozess wie die API.

## Authentifizierung

postbote nutzt das Postmark-SMTP-Token-Modell mit **Access/Secret-Key-Paaren**:

| SMTP-Feld | Bedeutung |
|---|---|
| Username | Access Key (`pb-…`) |
| Password | Secret Key (`pbsec-…`) |

Unterstützt werden **AUTH PLAIN** und **AUTH LOGIN**. Der Access Key liegt im
Klartext in der DB (er ist der Suchschlüssel), der Secret Key **nur als
SHA-256-Hash**. Credentials gehören zu einem Server und einem Stream.

Verhalten:

- Falsche Credentials → `535 Invalid credentials`
- `MAIL FROM` ohne AUTH → `530 Authentication required`
- Akzeptierte Mail → `250 OK: message queued`

### Credentials anlegen

```bash
# Im Compose-Stack
docker compose -f docker/docker-compose.yml exec smtp \
  node dist/cli/setup.js create-smtp-credential default outbound

# Lokal (Postgres erreichbar)
npm run setup -- create-smtp-credential default outbound
```

Ausgabe (Secret wird **einmalig** angezeigt, danach nie wieder abrufbar):

```
SMTP credential created (secret shown once, store it now):
  username / access key : pb-9f1c...
  password / secret key : pbsec-7a2e...
  server                : default
  stream                : outbound
```

Im Demo-Modus sind die Credentials fix: `postbote-demo-smtp` /
`postbote-demo-smtp-secret`.

## STARTTLS

```bash
POSTBOTE_SMTP_TLS_KEY=/certs/smtp-key.pem
POSTBOTE_SMTP_TLS_CERT=/certs/smtp-cert.pem
```

Mit konfiguriertem Zertifikat wird STARTTLS angeboten, und AUTH ist erst nach
erfolgreichem TLS-Upgrade erlaubt (Postmark-Verhalten). Ohne Zertifikat läuft
der Ingress im **Plain-Modus** — beim Start wird eine Warnung geloggt. Nur für
Dev oder vertrauenswürdige Netze verwenden.

Self-signed Zertifikat für Tests:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout docker/certs/smtp-key.pem -out docker/certs/smtp-cert.pem \
  -subj '/CN=localhost'
```

In `docker/docker-compose.yml` dann die `volumes`- und Env-Zeilen beim
`smtp`-Service einkommentieren.

## `X-PM-*` Header

| Header | Wirkung |
|---|---|
| `X-PM-Message-Stream` | Überschreibt den Stream des Credentials |
| `X-PM-Tag` | Setzt das Tag (erscheint in `/messages/outbound`, Webhooks) |
| `X-PM-Metadata-<Name>` | Landet als `metadata.<name>` (lowercase) an der Nachricht |
| sonstige `X-*` | Werden als Custom-Header an den Upstream durchgereicht |

`From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, HTML-/Text-Body und Attachments
werden aus dem MIME geparst. Cc/Bcc und Anhänge gehen an den Upstream-Relay
weiter.

## Client-Beispiel (nodemailer)

```js
import nodemailer from 'nodemailer'

const transport = nodemailer.createTransport({
  host: '127.0.0.1',
  port: 2525,
  secure: false,
  auth: { user: accessKey, pass: secretKey },
  // Bei selbstsigniertem Zertifikat:
  // tls: { rejectUnauthorized: false },
})

await transport.sendMail({
  from: 'Absender <absender@deine-domain.de>',
  to: 'empfaenger@example.com',
  cc: 'kopie@example.com',
  subject: 'SMTP-Test',
  text: 'Hallo per SMTP',
  html: '<p>Hallo per SMTP</p>',
  headers: [
    { key: 'X-PM-Tag', value: 'onboarding' },
    { key: 'X-PM-Metadata-UserId', value: '42' },
  ],
})
```

`swaks` eignet sich ebenfalls:

```bash
swaks --server 127.0.0.1:2525 --auth PLAIN \
  --auth-user "$ACCESS" --auth-password "$SECRET" \
  --from absender@example.com --to empfaenger@example.com \
  --header 'X-PM-Tag: smtp-test' --body 'Hallo'
```

## Asynchrone Fehler (`SMTPApiError`)

SMTP kann Fehler nur bis zum Ende des `DATA`-Blocks synchron melden. Schlägt
die Verarbeitung danach fehl (z. B. Upstream wirft, Relay-Konfiguration
ungültig), kann postbote dem Client nichts mehr zurückgeben. In diesem Fall
wird die Nachricht als `bounced` markiert und ein Bounce vom Typ
**`SMTPApiError` (TypeCode 100007)** mit der Fehlermeldung als `Description`
erzeugt — inklusive `Bounce`-Webhook. Diese Bounces erscheinen in
`GET /bounces` und in `/deliverystats`.

Synchrone Fehler (AUTH, ungültiges MIME, Parse-Fehler) werden dagegen direkt
mit `530`/`535`/`550` abgelehnt; es entsteht keine Nachricht.

## Verifikation

```bash
# Live-Test gegen den Demo-Stack
node --input-type=module -e "
import nodemailer from 'nodemailer';
const t = nodemailer.createTransport({
  host: '127.0.0.1', port: 587, secure: false, ignoreTLS: true,
  auth: { user: 'postbote-demo-smtp', pass: 'postbote-demo-smtp-secret' },
});
console.log(await t.sendMail({ from: 'a@example.com', to: 'b@example.com',
  subject: 'Check', text: 'ok' }));
"
curl -H 'X-Postmark-Server-Token: postbote-demo-token' \
  http://localhost:3000/deliverystats
```
