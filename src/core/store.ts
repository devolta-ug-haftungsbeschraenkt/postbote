/**
 * Domain types + store contract. The API layer only talks to these interfaces,
 * so the same routes run against Postgres (production) and an in-memory store
 * (tests / `postbote --demo`).
 */

import { createHash } from 'node:crypto'

export interface MessageInput {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  subject: string
  htmlBody?: string
  textBody?: string
  tag?: string
  metadata?: Record<string, string>
  headers?: { name: string; value: string }[]
  attachments?: {
    name: string
    content: string
    contentType: string
    contentId?: string
  }[]
  messageStream?: string
  /** Phase 2 (M8): Open-Tracking per Nachricht. */
  trackOpens?: boolean
  /** None | HtmlAndText | HtmlOnly | TextOnly */
  trackLinks?: TrackLinksMode
}

export type TrackLinksMode = 'None' | 'HtmlAndText' | 'HtmlOnly' | 'TextOnly'

export type MessageStatus = 'queued' | 'sent' | 'failed' | 'bounced'

export interface MessageRecord {
  id: string
  serverId: string
  streamId: string
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  tag?: string
  status: MessageStatus
  submittedAt: string
  sentAt?: string
  /** Full content, only set by getMessage() (list queries omit bodies). */
  htmlBody?: string
  textBody?: string
  replyTo?: string
  headers?: { name: string; value: string }[]
  attachments?: { name: string; content: string; contentType: string; contentId?: string }[]
  metadata?: Record<string, string>
  trackOpens?: boolean
  trackLinks?: TrackLinksMode
}

export interface ServerRecord {
  id: string
  name: string
  slug: string
}

export interface LogtoConfig {
  from: string
  templates: Record<string, string>
}

export interface TokenRecord {
  serverId: string
  tokenHash: string
  name: string
  allowedFrom?: string[]
  /** Pro-Client-Konfiguration für POST /logto (app01-Migration). */
  logtoConfig?: LogtoConfig
  sandbox: boolean
}

/** Upstream relay per server/stream (Bauplan §3). */
export interface RelayRecord {
  serverId: string
  streamId: string
  host: string
  port: number
  username: string
  password: string
  tlsMode: 'starttls' | 'implicit' | 'none'
}

export type BounceType =
  | 'HardBounce'
  | 'SoftBounce'
  | 'Blocked'
  | 'DnsError'
  | 'Transient'
  | 'BadEmailAddress'
  | 'SpamNotification'
  | 'DMARCPolicy'
  | 'SMTPApiError'

export interface BounceRecord {
  messageId: string
  type: BounceType
  typeCode: number
  description: string
  email: string
  bouncedAt: string
}

export interface WebhookRecord {
  id: string
  serverId: string
  url: string
  events: string[]
  httpAuth?: { username: string; password: string }
  httpHeaders?: { name: string; value: string }[]
  verified: boolean
}

export interface WebhookDeliveryInput {
  webhookId: string
  messageId: string | null
  traceId: string
  attempt: number
  responseStatus: number | null
  error?: string
}

export interface TemplateRecord {
  id: string
  serverId: string
  alias: string
  name: string
  subject: string
  htmlBody?: string
  textBody?: string
  layoutAlias?: string
}

export interface LayoutRecord {
  id: string
  serverId: string
  alias: string
  name: string
  htmlBody: string
  textBody?: string
}

export interface MessageStore {
  /** Resolve a raw server token to its owning server, or null if unknown. */
  findServerByToken(token: string): Promise<TokenRecord | null>
  createServer(name: string, slug: string): Promise<ServerRecord>
  addToken(
    serverId: string,
    token: string,
    name: string,
    extras?: { allowedFrom?: string[]; logtoConfig?: LogtoConfig },
  ): Promise<void>
  insertMessage(input: MessageInput, serverId: string, streamId: string): Promise<MessageRecord>
  getMessage(id: string): Promise<MessageRecord | null>
  updateMessageStatus(id: string, status: MessageStatus, sentAt?: Date): Promise<void>
  appendEvent(
    messageId: string,
    type: 'accepted' | 'sent' | 'deferred' | 'bounced' | 'webhook_delivered' | 'opened' | 'clicked',
    details?: string,
  ): Promise<void>
  addBounce(bounce: BounceRecord): Promise<void>
  listMessages(options: {
    serverId: string
    status?: MessageStatus
    tag?: string
    limit: number
    offset: number
  }): Promise<MessageRecord[]>
  countMessages(
    serverId: string,
    since?: Date,
  ): Promise<{
    sent: number
    queued: number
    failed: number
    bounced: number
  }>
  getRelay(serverId: string, streamId: string): Promise<RelayRecord | null>
  listWebhooks(serverId: string, event: string): Promise<WebhookRecord[]>
  recordWebhookDelivery(delivery: WebhookDeliveryInput): Promise<void>
  /** Resolve by alias (preferred) or by id. */
  findTemplate(serverId: string, key: string): Promise<TemplateRecord | null>
  upsertTemplate(
    serverId: string,
    record: Omit<TemplateRecord, 'id' | 'serverId'>,
  ): Promise<TemplateRecord>
  listTemplates(
    serverId: string,
    limit: number,
    offset: number,
  ): Promise<{ total: number; templates: TemplateRecord[] }>
  deleteTemplate(serverId: string, key: string): Promise<boolean>
  findLayout(serverId: string, alias: string): Promise<LayoutRecord | null>
  upsertLayout(
    serverId: string,
    record: Omit<LayoutRecord, 'id' | 'serverId'>,
  ): Promise<LayoutRecord>
  /** Bounce-Query für /bounces (Bauplan §4 M4). */
  listBounces(options: {
    serverId: string
    type?: string
    limit: number
    offset: number
  }): Promise<{ total: number; bounces: (BounceRecord & { id: string })[] }>
  getBounce(serverId: string, id: string): Promise<(BounceRecord & { id: string }) | null>
  getWebhook(serverId: string, id: string): Promise<WebhookRecord | null>
  upsertWebhook(
    serverId: string,
    record: {
      id?: string
      url: string
      events: string[]
      httpAuth?: { username: string; password: string }
      httpHeaders?: { name: string; value: string }[]
      verified: boolean
    },
  ): Promise<WebhookRecord>
  deleteWebhook(serverId: string, id: string): Promise<boolean>
  getServer(serverId: string): Promise<ServerRecord | null>
  findServerBySlug(slug: string): Promise<ServerRecord | null>
  /**
   * Create an SMTP credential (Postmark SMTP-token model): accessKey is the
   * SMTP username, secretKey is returned once in plaintext and stored hashed.
   */
  createSmtpCredential(
    serverId: string,
    streamId?: string,
    /** Optional fixed keys (demo/bootstrap); otherwise randomly generated. */
    keys?: { accessKey: string; secretKey: string },
  ): Promise<{ accessKey: string; secretKey: string; id: string }>
  /** Resolve a serverId/streamId from SMTP AUTH credentials, or null. */
  verifySmtpCredential(
    accessKey: string,
    secretKey: string,
  ): Promise<{ serverId: string; streamId: string } | null>

  // --- Phase 2 (M8): Streams, Suppressions, Tracking, Stats ---------------
  listStreams(serverId: string): Promise<StreamRecord[]>
  getStream(serverId: string, id: string): Promise<StreamRecord | null>
  upsertStream(
    serverId: string,
    record: {
      id: string
      name: string
      description?: string
      messageStreamType?: string
      archived?: boolean
    },
  ): Promise<StreamRecord>
  setStreamArchived(serverId: string, id: string, archived: boolean): Promise<StreamRecord | null>

  listSuppressions(serverId: string, streamId: string): Promise<SuppressionRecord[]>
  /** Returns the subset of `emails` that is suppressed for this server/stream. */
  suppressedEmails(serverId: string, streamId: string, emails: string[]): Promise<string[]>
  addSuppression(
    serverId: string,
    streamId: string,
    record: { email: string; reason?: string },
  ): Promise<SuppressionRecord>
  removeSuppression(serverId: string, streamId: string, email: string): Promise<boolean>

  recordTrackingEvent(event: TrackingEventInput): Promise<TrackingEventRecord>
  listTrackingEvents(
    messageId: string,
    type?: 'open' | 'click',
    limit?: number,
  ): Promise<TrackingEventRecord[]>
  /** Daily aggregates for /stats/outbound (M8). */
  outboundStats(options: {
    serverId: string
    fromDate: string
    toDate: string
    tag?: string
  }): Promise<StatDay[]>
}

/** Phase 2 (M8): Message-Stream mit Archiv-Status. */
export interface StreamRecord {
  id: string
  serverId: string
  name: string
  description: string
  messageStreamType: string
  archived: boolean
  createdAt: string
}

/** Phase 2 (M8): unterdrückte Adresse (→ ErrorCode 406). */
export interface SuppressionRecord {
  email: string
  streamId: string
  reason: string
  createdAt: string
}

export type TrackingEventInput = {
  messageId: string
  type: 'open' | 'click'
  userAgent?: string
  ipAddress?: string
  originalLink?: string
  clickLocation?: 'HTML' | 'Text'
}

export interface TrackingEventRecord extends TrackingEventInput {
  id: string
  createdAt: string
}

export interface StatDay {
  date: string
  sent: number
  bounced: number
  opens: number
  clicks: number
  tracked: number
}

/** SHA-256 hash as lowercase hex — tokens are never stored in plaintext. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
