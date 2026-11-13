import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Schema gemäß Bauplan §3. Tenant-Modell von Tag 1 angelegt (Postmark-Parität:
 * Tokens gehören zu Servern), auch wenn das MVP sie kaum nutzt.
 */

export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Human-readable identifier used by clients that address a server by name. */
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const serverTokens = pgTable(
  'server_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    /** SHA-256 hash of the raw token; raw tokens are never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    name: text('name').notNull(),
    /** Optional sender allowlist, e.g. ["*@devolta.de"]. null = any sender. */
    allowedFrom: jsonb('allowed_from').$type<string[]>(),
    sandbox: boolean('sandbox').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('server_tokens_server_idx').on(t.serverId)],
)

export const smtpCredentials = pgTable(
  'smtp_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    /** Access key = SMTP username (Postmark SMTP-token model). */
    accessKey: text('access_key').notNull().unique(),
    /** SHA-256 hash of the secret key; shown only once at creation. */
    secretKeyHash: text('secret_key_hash').notNull(),
    streamId: text('stream_id').notNull().default('outbound'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('smtp_credentials_server_idx').on(t.serverId)],
)

export const relayConfigs = pgTable(
  'relay_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    streamId: text('stream_id').notNull().default('outbound'),
    host: text('host').notNull(),
    port: integer('port').notNull().default(587),
    username: text('username').notNull(),
    passwordEncrypted: text('password_encrypted').notNull(),
    /** TLS mode: 'starttls' (default, enforced), 'implicit', 'none'. */
    tlsMode: text('tls_mode').notNull().default('starttls'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('relay_configs_server_stream_idx').on(t.serverId, t.streamId)],
)

export const streams = pgTable(
  'streams',
  {
    id: text('id').primaryKey(), // "outbound" or custom
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** 'outbound' | 'broadcast' | custom (Postmark MessageStreamType). */
    messageStreamType: text('message_stream_type').notNull().default('outbound'),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('streams_server_idx').on(t.serverId)],
)

/** Phase 2 (M8): unterdrückte Empfänger pro Server/Stream → ErrorCode 406. */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    streamId: text('stream_id').notNull().default('outbound'),
    email: text('email').notNull(),
    /** HardBounce | SpamComplaint | ManualSuppression */
    reason: text('reason').notNull().default('ManualSuppression'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('suppressions_server_stream_email_idx').on(t.serverId, t.streamId, t.email),
    index('suppressions_server_idx').on(t.serverId),
  ],
)

/** Phase 2 (M8): Open-/Click-Events aus Tracking-Pixel und Link-Rewrite. */
export const trackingEvents = pgTable(
  'tracking_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id),
    /** 'open' | 'click' */
    type: text('type').notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    originalLink: text('original_link'),
    /** 'HTML' | 'Text' — wo der Link geklickt wurde. */
    clickLocation: text('click_location'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tracking_events_message_idx').on(t.messageId, t.createdAt)],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    streamId: text('stream_id').notNull().default('outbound'),
    fromAddress: text('from_address').notNull(),
    toAddresses: jsonb('to_addresses').$type<string[]>().notNull(),
    ccAddresses: jsonb('cc_addresses').$type<string[]>(),
    bccAddresses: jsonb('bcc_addresses').$type<string[]>(),
    replyTo: text('reply_to'),
    subject: text('subject').notNull(),
    htmlBody: text('html_body'),
    textBody: text('text_body'),
    /** Composed raw MIME message, persisted after rendering. */
    rawMail: text('raw_mail'),
    tag: text('tag'),
    metadata: jsonb('metadata').$type<Record<string, string>>(),
    headers: jsonb('headers').$type<{ name: string; value: string }[]>(),
    attachments:
      jsonb('attachments').$type<
        { name: string; content: string; contentType: string; contentId?: string }[]
      >(),
    /** queued | sent | failed | bounced */
    status: text('status').notNull().default('queued'),
    /** Phase 2 (M8): Tracking-Flags pro Nachricht. */
    trackOpens: boolean('track_opens').notNull().default(false),
    /** None | HtmlAndText | HtmlOnly | TextOnly */
    trackLinks: text('track_links').notNull().default('None'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    index('messages_server_submitted_idx').on(t.serverId, t.submittedAt),
    index('messages_status_idx').on(t.status),
    index('messages_tag_idx').on(t.tag),
  ],
)

export const messageEvents = pgTable(
  'message_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id),
    /** accepted | sent | deferred | bounced | webhook_delivered */
    type: text('type').notNull(),
    details: text('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('message_events_message_idx').on(t.messageId, t.createdAt)],
)

export const bounces = pgTable(
  'bounces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id),
    /** Postmark bounce type, e.g. HardBounce, SoftBounce (Analyse Tabelle 2.5). */
    type: text('type').notNull(),
    typeCode: integer('type_code').notNull(),
    description: text('description'),
    email: text('email').notNull(),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bounces_message_idx').on(t.messageId), index('bounces_type_idx').on(t.type)],
)

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    /** Stable alias, recommended over numeric ids (Postmark convention). */
    alias: text('alias').notNull(),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    htmlBody: text('html_body'),
    textBody: text('text_body'),
    layoutAlias: text('layout_alias'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('templates_server_alias_idx').on(t.serverId, t.alias)],
)

export const layouts = pgTable(
  'layouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    alias: text('alias').notNull(),
    name: text('name').notNull(),
    /** Layout body with a `{{{content}}}` (or `@content`) placeholder. */
    htmlBody: text('html_body').notNull(),
    textBody: text('text_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('layouts_server_alias_idx').on(t.serverId, t.alias)],
)

export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id),
    url: text('url').notNull(),
    /** Delivery | Bounce | SpamComplaint | ... (MVP: Delivery + Bounce). */
    events: jsonb('events').$type<string[]>().notNull(),
    httpAuth: jsonb('http_auth').$type<{ username: string; password: string }>(),
    httpHeaders: jsonb('http_headers').$type<{ name: string; value: string }[]>(),
    /** Verified webhooks receive events; unverified ones get nothing (Postmark 1364 flow). */
    verified: boolean('verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhooks_server_idx').on(t.serverId)],
)

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id),
    messageId: uuid('message_id').references(() => messages.id),
    /** Trace id echoed as X-PM-Webhook-Trace-Id (idempotency key). */
    traceId: text('trace_id').notNull(),
    attempt: integer('attempt').notNull().default(1),
    responseStatus: integer('response_status'),
    error: text('error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhook_deliveries_webhook_idx').on(t.webhookId, t.deliveredAt)],
)

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** send_email | dispatch_webhook */
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('jobs_status_runafter_idx').on(t.status, t.runAfter)],
)
