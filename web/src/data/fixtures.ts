/**
 * Realistische Demo-Fixtures — der Fallback, wenn die postbote-API
 * (noch) nicht erreichbar ist. Datenbild: devolta-Produktivumgebung.
 */

import type {
  BouncesResponse,
  DeliveryStats,
  MessageStream,
  MessageStreamsResponse,
  MessagesResponse,
  OutboundMessage,
  OutboundStats,
  RelayConfig,
  ServerInfo,
  StatDay,
  Suppression,
  SuppressionsResponse,
  TemplateListResponse,
  WebhookListResponse,
} from '../api/types'

const ALL_MESSAGES: OutboundMessage[] = [
  {
    MessageID: '8c3f4a1e-9d2b-4c7a-b1f4-0e5d6a7b8c9d',
    From: 'no-reply@devolta.de',
    To: ['l.weber@kunde24.de'],
    Recipient: 'l.weber@kunde24.de',
    Subject: 'Ihre Rechnung INV-2026-0418 ist bereit',
    Status: 'sent',
    Tag: 'billing',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-13T09:42:10Z',
    ReceivedAt: '2026-11-13T09:42:14Z',
  },
  {
    MessageID: 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f6a7',
    From: 'desk@servease.app',
    To: ['m.pistor@devolta.de'],
    Recipient: 'm.pistor@devolta.de',
    Subject: '[servease] Neues Ticket #412: SMTP-Relay-Timeout',
    Status: 'sent',
    Tag: 'desk',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-13T09:11:52Z',
    ReceivedAt: '2026-11-13T09:11:55Z',
  },
  {
    MessageID: 'a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9c0d',
    From: 'no-reply@devolta.de',
    To: ['it-admin@aar-consulting.ch'],
    Recipient: 'it-admin@aar-consulting.ch',
    Subject: 'Passwort zurücksetzen (gültig für 30 Minuten)',
    Status: 'bounced',
    Tag: 'auth',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-13T08:57:03Z',
    ReceivedAt: '2026-11-13T08:57:41Z',
  },
  {
    MessageID: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    From: 'welcome@servease.app',
    To: ['s.klein@neukunde.io'],
    Recipient: 's.klein@neukunde.io',
    Subject: 'Willkommen bei servease — los geht’s',
    Status: 'failed',
    Tag: 'onboarding',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-13T08:40:19Z',
  },
  {
    MessageID: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f',
    From: 'no-reply@logto.app',
    To: ['j.richter@kunde24.de'],
    Recipient: 'j.richter@kunde24.de',
    Subject: 'Ihr Anmeldecode: 483 920',
    Status: 'sent',
    Tag: 'auth',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-13T08:22:44Z',
    ReceivedAt: '2026-11-13T08:22:46Z',
  },
  {
    MessageID: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a',
    From: 'desk@servease.app',
    To: ['support@aar-consulting.ch'],
    Recipient: 'support@aar-consulting.ch',
    Subject: '[servease] Ticket #409 wurde geschlossen',
    Status: 'sent',
    Tag: 'desk',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-13T07:58:31Z',
    ReceivedAt: '2026-11-13T07:58:35Z',
  },
  {
    MessageID: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b',
    From: 'no-reply@devolta.de',
    To: ['buchhaltung@kunde24.de'],
    Recipient: 'buchhaltung@kunde24.de',
    Subject: 'Zahlungserinnerung: Rechnung INV-2026-0391',
    Status: 'queued',
    Tag: 'billing',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-13T09:55:27Z',
  },
  {
    MessageID: 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b9c',
    From: 'welcome@servease.app',
    To: ['team@neukunde.io'],
    Recipient: 'team@neukunde.io',
    Subject: 'Einladung zum servease-Team von m.pistor@devolta.de',
    Status: 'sent',
    Tag: 'onboarding',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-12T17:03:12Z',
    ReceivedAt: '2026-11-12T17:03:16Z',
  },
  {
    MessageID: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    From: 'no-reply@devolta.de',
    To: ['info@internetbauhaus.de'],
    Recipient: 'info@internetbauhaus.de',
    Subject: 'Wartungsfenster am 16.11.2026 (02:00–04:00 CET)',
    Status: 'bounced',
    Tag: 'ops',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-12T14:29:58Z',
    ReceivedAt: '2026-11-12T14:30:22Z',
  },
  {
    MessageID: 'b2c3d4e5-a6f7-4b8c-9d0e-1f2a3b4c5d6a',
    From: 'no-reply@logto.app',
    To: ['k.sommer@kunde24.de'],
    Recipient: 'k.sommer@kunde24.de',
    Subject: 'Ihr Anmeldecode: 117 548',
    Status: 'queued',
    Tag: 'auth',
    MessageStream: 'outbound',
    SubmittedAt: '2026-11-13T09:58:02Z',
  },
]

export function deliveryStats(): DeliveryStats {
  return {
    Sent: 1284,
    Queued: 2,
    Bounced: 37,
    Failed: 5,
    BounceRate: '2,9 %',
    SentDelta24h: 38,
    QueuedNextRun: 'nächster Versandlauf: alle 30 s',
  }
}

export function messages(count = 50): MessagesResponse {
  return {
    TotalCount: 1328,
    Messages: ALL_MESSAGES.slice(0, count),
  }
}

export function bounces(): BouncesResponse {
  return {
    TotalCount: 37,
    Bounces: [
      {
        ID: 9101,
        Type: 'HardBounce',
        TypeCode: 1,
        Name: 'Hard bounce',
        Description: 'Die Empfängeradresse existiert nicht (5.1.1 User unknown).',
        Email: 'it-admin@aar-consulting.ch',
        Subject: 'Passwort zurücksetzen (gültig für 30 Minuten)',
        BouncedAt: '2026-11-13T08:57:41Z',
      },
      {
        ID: 9100,
        Type: 'SoftBounce',
        TypeCode: 2,
        Name: 'Soft bounce',
        Description: 'Empfängerpostfach voll (5.2.2 Mailbox full).',
        Email: 'info@internetbauhaus.de',
        Subject: 'Wartungsfenster am 16.11.2026 (02:00–04:00 CET)',
        BouncedAt: '2026-11-12T14:30:22Z',
      },
      {
        ID: 9098,
        Type: 'SpamNotification',
        TypeCode: 3,
        Name: 'Spam notification',
        Description: 'Der Empfänger hat die Nachricht als Spam gemeldet.',
        Email: 'wayne@example.net',
        Subject: 'Wochen-Digest servease Desk',
        BouncedAt: '2026-11-12T09:14:07Z',
      },
      {
        ID: 9095,
        Type: 'Transient',
        TypeCode: 4,
        Name: 'Transient failure',
        Description: 'Temporäres Problem beim Upstream (4.4.1 Connection timed out) — Retry läuft.',
        Email: 'empfang@bgl-gmbh.de',
        Subject: 'Ihre Rechnung INV-2026-0402 ist bereit',
        BouncedAt: '2026-11-12T08:02:55Z',
      },
      {
        ID: 9091,
        Type: 'DnsError',
        TypeCode: 7,
        Name: 'DNS error',
        Description: 'MX-Record der Empfängerdomäne nicht auflösbar.',
        Email: 'postmaster@tld-domain-falsch.de',
        Subject: 'Einladung zum servease-Team',
        BouncedAt: '2026-11-11T16:45:33Z',
      },
      {
        ID: 9087,
        Type: 'HardBounce',
        TypeCode: 1,
        Name: 'Hard bounce',
        Description: 'Empfängerdomäne nicht erreichbar (5.4.1 No MX).',
        Email: 'alterbestand@eingestellte-firma.de',
        Subject: 'Zahlungserinnerung: Rechnung INV-2026-0388',
        BouncedAt: '2026-11-11T11:20:12Z',
      },
      {
        ID: 9084,
        Type: 'AutoResponder',
        TypeCode: 5,
        Name: 'Auto-responder',
        Description: 'Automatische Abwesenheitsnotiz — kein Retry nötig.',
        Email: 'urlaub@bgl-gmbh.de',
        Subject: '[servease] Ticket #401 wurde geschlossen',
        BouncedAt: '2026-11-10T13:31:49Z',
      },
      {
        ID: 9080,
        Type: 'SpamComplaint',
        TypeCode: 10,
        Name: 'Spam complaint',
        Description: 'Beschwerde über Feedback-Loop des Upstream-Providers.',
        Email: 'kontakt@descaler.de',
        Subject: 'Zahlungserinnerung: Rechnung INV-2026-0379',
        BouncedAt: '2026-11-09T10:05:21Z',
      },
    ],
  }
}

export function templates(): TemplateListResponse {
  return {
    TotalCount: 6,
    Templates: [
      {
        TemplateId: 1101,
        Name: 'Willkommen',
        Alias: 'welcome',
        Subject: 'Willkommen bei {{product}} — los geht’s',
        Layout: 'base',
        LastModified: '2026-11-04T10:12:00Z',
      },
      {
        TemplateId: 1102,
        Name: 'Passwort-Reset',
        Alias: 'password-reset',
        Subject: 'Passwort zurücksetzen (gültig für {{ttl}})',
        Layout: 'base',
        LastModified: '2026-11-02T16:40:00Z',
      },
      {
        TemplateId: 1103,
        Name: 'Anmeldecode',
        Alias: 'login-code',
        Subject: 'Ihr Anmeldecode: {{code}}',
        Layout: 'transactional',
        LastModified: '2026-10-28T08:05:00Z',
      },
      {
        TemplateId: 1104,
        Name: 'Rechnung verfügbar',
        Alias: 'invoice-ready',
        Subject: 'Ihre Rechnung {{invoiceNo}} ist bereit',
        Layout: 'base',
        LastModified: '2026-10-21T14:22:00Z',
      },
      {
        TemplateId: 1105,
        Name: 'Team-Einladung',
        Alias: 'team-invite',
        Subject: 'Einladung zum {{product}}-Team von {{inviter}}',
        Layout: 'base',
        LastModified: '2026-10-15T09:55:00Z',
      },
      {
        TemplateId: 1106,
        Name: 'Wochen-Digest',
        Alias: 'weekly-digest',
        Subject: 'Wochen-Digest servease Desk',
        Layout: 'newsletter',
        LastModified: '2026-10-08T07:30:00Z',
      },
    ],
  }
}

export function webhooks(): WebhookListResponse {
  return {
    TotalCount: 3,
    Webhooks: [
      {
        ID: 301,
        Url: 'https://app01.devolta.de/hooks/postbote/bounce',
        Events: ['Bounce', 'SpamComplaint'],
        Verified: true,
        HttpAuth: true,
      },
      {
        ID: 302,
        Url: 'https://servease.app/api/mail/events',
        Events: ['Delivery', 'Bounce'],
        Verified: true,
        HttpAuth: false,
      },
      {
        ID: 303,
        Url: 'https://staging.servease.app/hooks/mail',
        Events: ['Delivery', 'Bounce', 'SpamComplaint'],
        Verified: false,
        HttpAuth: false,
      },
    ],
  }
}

export function server(): ServerInfo {
  return {
    Name: 'devolta / Produktion',
    ServerId: 81231,
    ApiBase: 'http://localhost:3000',
    MessageStream: 'outbound (Default)',
    TokenPreview: '••••••••••••3f9a',
  }
}

export function relayConfig(): RelayConfig {
  return {
    Host: 'smtp.mailcow.devolta.de',
    Port: 587,
    Username: 'postbote@app01.devolta.de',
    Password: '',
    TlsMode: 'starttls',
  }
}

/* ---- M8: Message Streams ---- */

const ALL_STREAMS: MessageStream[] = [
  {
    ID: 'outbound',
    Name: 'Standard (Transaktionsmail)',
    Description: 'Rechnungen, Passwort-Reset, Anmeldecodes — der Default-Stream.',
    MessageStreamType: 'Transactional',
    Archived: false,
    CreatedAt: '2026-01-14T09:12:00Z',
  },
  {
    ID: 'broadcast',
    Name: 'Newsletter & Kampagnen',
    Description: 'Wochen-Digest, Produktneuigkeiten und Marketing-Kampagnen.',
    MessageStreamType: 'Broadcast',
    Archived: false,
    CreatedAt: '2026-02-03T11:45:00Z',
  },
  {
    ID: 'onboarding',
    Name: 'Onboarding',
    Description: 'Willkommens- und Einladungsmails für neue Teams.',
    MessageStreamType: 'Transactional',
    Archived: false,
    CreatedAt: '2026-03-21T08:30:00Z',
  },
  {
    ID: 'legacy-import',
    Name: 'Legacy-Import',
    Description: 'Alter Stream aus dem Vorgängersystem, nicht mehr aktiv.',
    MessageStreamType: 'Transactional',
    Archived: true,
    CreatedAt: '2025-11-02T14:05:00Z',
  },
]

export function streams(): MessageStreamsResponse {
  return {
    TotalCount: ALL_STREAMS.length,
    MessageStreams: ALL_STREAMS,
  }
}

/* ---- M8: Suppressions ---- */

const ALL_SUPPRESSIONS: Suppression[] = [
  {
    EmailAddress: 'info@internetbauhaus.de',
    SuppressionReason: 'HardBounce',
    CreatedAt: '2026-11-12T14:30:22Z',
  },
  {
    EmailAddress: 'bounce@weg-der-firma.de',
    SuppressionReason: 'HardBounce',
    CreatedAt: '2026-11-11T11:20:12Z',
  },
  {
    EmailAddress: 'kontakt@descaler.de',
    SuppressionReason: 'SpamComplaint',
    CreatedAt: '2026-11-09T10:05:21Z',
  },
  {
    EmailAddress: 'kein-newsletter@beispiel.de',
    SuppressionReason: 'ManualSuppression',
    CreatedAt: '2026-11-06T15:42:00Z',
  },
  {
    EmailAddress: 'urlaub@bgl-gmbh.de',
    SuppressionReason: 'ManualSuppression',
    CreatedAt: '2026-10-28T09:13:44Z',
  },
]

export function suppressions(): SuppressionsResponse {
  return {
    TotalCount: ALL_SUPPRESSIONS.length,
    Suppressions: ALL_SUPPRESSIONS,
  }
}

/* ---- M8: Outbound Stats ---- */

const STAT_DAYS: StatDay[] = [
  { Date: '2026-11-07', Sent: 142, Bounced: 4, Opens: 61, Clicks: 18, Tracked: 120 },
  { Date: '2026-11-08', Sent: 98, Bounced: 2, Opens: 44, Clicks: 12, Tracked: 83 },
  { Date: '2026-11-09', Sent: 110, Bounced: 5, Opens: 52, Clicks: 15, Tracked: 96 },
  { Date: '2026-11-10', Sent: 176, Bounced: 6, Opens: 78, Clicks: 24, Tracked: 150 },
  { Date: '2026-11-11', Sent: 205, Bounced: 7, Opens: 96, Clicks: 31, Tracked: 172 },
  { Date: '2026-11-12', Sent: 188, Bounced: 5, Opens: 88, Clicks: 27, Tracked: 160 },
  { Date: '2026-11-13', Sent: 231, Bounced: 8, Opens: 104, Clicks: 36, Tracked: 195 },
]

export function outboundStats(): OutboundStats {
  const total = (key: 'Sent' | 'Bounced' | 'Opens' | 'Clicks' | 'Tracked') =>
    STAT_DAYS.reduce((sum, day) => sum + day[key], 0)

  return {
    Days: STAT_DAYS,
    Sent: total('Sent'),
    Bounced: total('Bounced'),
    Opens: total('Opens'),
    Clicks: total('Clicks'),
    Tracked: total('Tracked'),
    FromDate: '2026-11-07',
    ToDate: '2026-11-13',
  }
}
