import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../db/schema.js'
import {
  bounces,
  layouts,
  messageEvents,
  messages,
  relayConfigs,
  serverTokens,
  servers as serversTable,
  smtpCredentials,
  streams,
  suppressions,
  templates,
  trackingEvents,
  webhookDeliveries,
  webhooks,
} from '../db/schema.js'
import { decryptAtRest } from './secret.js'
import type {
  BounceRecord,
  LayoutRecord,
  MessageInput,
  MessageRecord,
  MessageStatus,
  MessageStore,
  RelayRecord,
  ServerRecord,
  StatDay,
  StreamRecord,
  SuppressionRecord,
  TemplateRecord,
  TokenRecord,
  TrackLinksMode,
  TrackingEventInput,
  TrackingEventRecord,
  WebhookDeliveryInput,
  WebhookRecord,
} from './store.js'
import { hashToken } from './store.js'

/** Postgres-backed MessageStore (drizzle). Production implementation. */
export class PostgresMessageStore implements MessageStore {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async findServerByToken(token: string): Promise<TokenRecord | null> {
    const rows = await this.db
      .select()
      .from(serverTokens)
      .where(eq(serverTokens.tokenHash, hashToken(token)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      serverId: row.serverId,
      tokenHash: row.tokenHash,
      name: row.name,
      ...(row.allowedFrom !== null && { allowedFrom: row.allowedFrom }),
      sandbox: row.sandbox,
    }
  }

  async createServer(name: string, slug: string): Promise<ServerRecord> {
    const rows = await this.db
      .insert(serversTable)
      .values({ name, slug })
      .returning({ id: serversTable.id, name: serversTable.name, slug: serversTable.slug })
    return rows[0] as ServerRecord
  }

  async addToken(serverId: string, token: string, name: string): Promise<void> {
    await this.db.insert(serverTokens).values({ serverId, tokenHash: hashToken(token), name })
  }

  async insertMessage(
    input: MessageInput,
    serverId: string,
    streamId: string,
  ): Promise<MessageRecord> {
    const rows = await this.db
      .insert(messages)
      .values({
        serverId,
        streamId,
        fromAddress: input.from,
        toAddresses: input.to,
        ...(input.cc !== undefined && { ccAddresses: input.cc }),
        ...(input.bcc !== undefined && { bccAddresses: input.bcc }),
        ...(input.replyTo !== undefined && { replyTo: input.replyTo }),
        subject: input.subject,
        ...(input.htmlBody !== undefined && { htmlBody: input.htmlBody }),
        ...(input.textBody !== undefined && { textBody: input.textBody }),
        ...(input.tag !== undefined && { tag: input.tag }),
        ...(input.metadata !== undefined && { metadata: input.metadata }),
        ...(input.headers !== undefined && { headers: input.headers }),
        ...(input.attachments !== undefined && { attachments: input.attachments }),
        ...(input.trackOpens !== undefined && { trackOpens: input.trackOpens }),
        ...(input.trackLinks !== undefined && { trackLinks: input.trackLinks }),
        status: 'queued' as const,
      })
      .returning({
        id: messages.id,
        serverId: messages.serverId,
        streamId: messages.streamId,
        fromAddress: messages.fromAddress,
        toAddresses: messages.toAddresses,
        subject: messages.subject,
        tag: messages.tag,
        status: messages.status,
        submittedAt: messages.submittedAt,
      })
    const row = rows[0]
    if (!row) throw new Error('insertMessage returned no row')
    return {
      id: row.id,
      serverId: row.serverId,
      streamId: row.streamId,
      from: row.fromAddress,
      to: row.toAddresses,
      subject: row.subject,
      ...(row.tag !== null && { tag: row.tag }),
      status: row.status as MessageStatus,
      submittedAt: row.submittedAt.toISOString(),
    }
  }

  async listMessages(options: {
    serverId: string
    status?: MessageStatus
    tag?: string
    limit: number
    offset: number
  }): Promise<MessageRecord[]> {
    const conditions = [eq(messages.serverId, options.serverId)]
    if (options.status) conditions.push(eq(messages.status, options.status))
    if (options.tag) conditions.push(eq(messages.tag, options.tag))
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(sql`${messages.submittedAt} DESC`)
      .limit(options.limit)
      .offset(options.offset)
    return rows.map((row) => ({
      id: row.id,
      serverId: row.serverId,
      streamId: row.streamId,
      from: row.fromAddress,
      to: row.toAddresses,
      ...(row.ccAddresses !== null && { cc: row.ccAddresses }),
      ...(row.bccAddresses !== null && { bcc: row.bccAddresses }),
      subject: row.subject,
      ...(row.tag !== null && { tag: row.tag }),
      status: row.status as MessageStatus,
      submittedAt: row.submittedAt.toISOString(),
      ...(row.sentAt !== null && { sentAt: row.sentAt.toISOString() }),
      trackOpens: row.trackOpens,
      trackLinks: (row.trackLinks ?? 'None') as TrackLinksMode,
    }))
  }

  async getMessage(id: string): Promise<MessageRecord | null> {
    const rows = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      serverId: row.serverId,
      streamId: row.streamId,
      from: row.fromAddress,
      to: row.toAddresses,
      ...(row.ccAddresses !== null && { cc: row.ccAddresses }),
      ...(row.bccAddresses !== null && { bcc: row.bccAddresses }),
      subject: row.subject,
      ...(row.tag !== null && { tag: row.tag }),
      status: row.status as MessageStatus,
      submittedAt: row.submittedAt.toISOString(),
      ...(row.sentAt !== null && { sentAt: row.sentAt.toISOString() }),
      trackOpens: row.trackOpens,
      trackLinks: (row.trackLinks ?? 'None') as TrackLinksMode,
      ...(row.htmlBody !== null && { htmlBody: row.htmlBody }),
      ...(row.textBody !== null && { textBody: row.textBody }),
      ...(row.replyTo !== null && { replyTo: row.replyTo }),
      ...(row.headers !== null && { headers: row.headers }),
      ...(row.attachments !== null && { attachments: row.attachments }),
      ...(row.metadata !== null && { metadata: row.metadata }),
    }
  }

  async updateMessageStatus(id: string, status: MessageStatus, sentAt?: Date): Promise<void> {
    await this.db
      .update(messages)
      .set({ status, ...(sentAt !== undefined && { sentAt }) })
      .where(eq(messages.id, id))
  }

  async appendEvent(
    messageId: string,
    type: 'accepted' | 'sent' | 'deferred' | 'bounced' | 'webhook_delivered' | 'opened' | 'clicked',
    details?: string,
  ): Promise<void> {
    await this.db.insert(messageEvents).values({
      messageId,
      type,
      ...(details !== undefined && { details }),
    })
  }

  async addBounce(bounce: BounceRecord): Promise<void> {
    await this.db.insert(bounces).values({
      messageId: bounce.messageId,
      type: bounce.type,
      typeCode: bounce.typeCode,
      description: bounce.description,
      email: bounce.email,
    })
  }

  async countMessages(serverId: string): Promise<{
    sent: number
    queued: number
    failed: number
    bounced: number
  }> {
    const rows = await this.db
      .select({ status: messages.status, count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.serverId, serverId))
      .groupBy(messages.status)
    const counts = { sent: 0, queued: 0, failed: 0, bounced: 0 }
    for (const row of rows) counts[row.status as MessageStatus] = row.count
    return counts
  }

  async getRelay(serverId: string, streamId: string): Promise<RelayRecord | null> {
    const rows = await this.db
      .select()
      .from(relayConfigs)
      .where(and(eq(relayConfigs.serverId, serverId), eq(relayConfigs.streamId, streamId)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      serverId: row.serverId,
      streamId: row.streamId,
      host: row.host,
      port: row.port,
      username: row.username,
      password: decryptAtRest(row.passwordEncrypted),
      tlsMode: row.tlsMode as RelayRecord['tlsMode'],
    }
  }

  async listWebhooks(serverId: string, event: string): Promise<WebhookRecord[]> {
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.serverId, serverId), eq(webhooks.verified, true)))
    return rows
      .filter((row) => row.events.includes(event))
      .map((row) => ({
        id: row.id,
        serverId: row.serverId,
        url: row.url,
        events: row.events,
        ...(row.httpAuth !== null && { httpAuth: row.httpAuth }),
        ...(row.httpHeaders !== null && { httpHeaders: row.httpHeaders }),
        verified: row.verified,
      }))
  }

  async recordWebhookDelivery(delivery: WebhookDeliveryInput): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      webhookId: delivery.webhookId,
      ...(delivery.messageId !== null && { messageId: delivery.messageId }),
      traceId: delivery.traceId,
      attempt: delivery.attempt,
      ...(delivery.responseStatus !== null && { responseStatus: delivery.responseStatus }),
      ...(delivery.error !== undefined && { error: delivery.error }),
    })
  }

  async getServer(serverId: string): Promise<ServerRecord | null> {
    const rows = await this.db
      .select({ id: serversTable.id, name: serversTable.name, slug: serversTable.slug })
      .from(serversTable)
      .where(eq(serversTable.id, serverId))
      .limit(1)
    return rows[0] ?? null
  }

  async findServerBySlug(slug: string): Promise<ServerRecord | null> {
    const rows = await this.db
      .select({ id: serversTable.id, name: serversTable.name, slug: serversTable.slug })
      .from(serversTable)
      .where(eq(serversTable.slug, slug))
      .limit(1)
    return rows[0] ?? null
  }

  async listBounces(options: {
    serverId: string
    type?: string
    limit: number
    offset: number
  }): Promise<{ total: number; bounces: (BounceRecord & { id: string })[] }> {
    const conditions = [eq(messages.serverId, options.serverId)]
    if (options.type) conditions.push(eq(bounces.type, options.type))
    const rows = await this.db
      .select({
        id: bounces.id,
        messageId: bounces.messageId,
        type: bounces.type,
        typeCode: bounces.typeCode,
        description: bounces.description,
        email: bounces.email,
        bouncedAt: bounces.bouncedAt,
      })
      .from(bounces)
      .innerJoin(messages, eq(bounces.messageId, messages.id))
      .where(and(...conditions))
      .orderBy(sql`${bounces.bouncedAt} DESC`)
      .limit(options.limit)
      .offset(options.offset)
    const countRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(bounces)
      .innerJoin(messages, eq(bounces.messageId, messages.id))
      .where(and(...conditions))
    return {
      total: countRows[0]?.count ?? 0,
      bounces: rows.map((row) => ({
        id: row.id,
        messageId: row.messageId,
        type: row.type as BounceRecord['type'],
        typeCode: row.typeCode,
        description: row.description ?? '',
        email: row.email,
        bouncedAt: row.bouncedAt.toISOString(),
      })),
    }
  }

  async getBounce(serverId: string, id: string): Promise<(BounceRecord & { id: string }) | null> {
    const rows = await this.db
      .select({
        id: bounces.id,
        messageId: bounces.messageId,
        type: bounces.type,
        typeCode: bounces.typeCode,
        description: bounces.description,
        email: bounces.email,
        bouncedAt: bounces.bouncedAt,
      })
      .from(bounces)
      .innerJoin(messages, eq(bounces.messageId, messages.id))
      .where(and(eq(bounces.id, id), eq(messages.serverId, serverId)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      messageId: row.messageId,
      type: row.type as BounceRecord['type'],
      typeCode: row.typeCode,
      description: row.description ?? '',
      email: row.email,
      bouncedAt: row.bouncedAt.toISOString(),
    }
  }

  async getWebhook(serverId: string, id: string): Promise<WebhookRecord | null> {
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.serverId, serverId)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      serverId: row.serverId,
      url: row.url,
      events: row.events,
      ...(row.httpAuth !== null && { httpAuth: row.httpAuth }),
      ...(row.httpHeaders !== null && { httpHeaders: row.httpHeaders }),
      verified: row.verified,
    }
  }

  async upsertWebhook(
    serverId: string,
    record: {
      id?: string
      url: string
      events: string[]
      httpAuth?: { username: string; password: string }
      httpHeaders?: { name: string; value: string }[]
      verified: boolean
    },
  ): Promise<WebhookRecord> {
    const values = {
      serverId,
      url: record.url,
      events: record.events,
      ...(record.httpAuth !== undefined && { httpAuth: record.httpAuth }),
      ...(record.httpHeaders !== undefined && { httpHeaders: record.httpHeaders }),
      verified: record.verified,
    }
    const rows = record.id
      ? await this.db.update(webhooks).set(values).where(eq(webhooks.id, record.id)).returning()
      : await this.db.insert(webhooks).values(values).returning()
    const row = rows[0]
    if (!row) throw new Error('upsertWebhook returned no row')
    return {
      id: row.id,
      serverId: row.serverId,
      url: row.url,
      events: row.events,
      ...(row.httpAuth !== null && { httpAuth: row.httpAuth }),
      ...(row.httpHeaders !== null && { httpHeaders: row.httpHeaders }),
      verified: row.verified,
    }
  }

  async deleteWebhook(serverId: string, id: string): Promise<boolean> {
    const result = await this.db
      .delete(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.serverId, serverId)))
      .returning({ id: webhooks.id })
    return result.length > 0
  }

  async findTemplate(serverId: string, key: string): Promise<TemplateRecord | null> {
    // Alias is preferred (stable), uuid id as fallback.
    const byAlias = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.serverId, serverId), eq(templates.alias, key)))
      .limit(1)
    const row = byAlias[0]
    if (row) return this.templateFromRow(row)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
    if (!isUuid) return null
    const byId = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.serverId, serverId), eq(templates.id, key)))
      .limit(1)
    const idRow = byId[0]
    return idRow ? this.templateFromRow(idRow) : null
  }

  private templateFromRow(row: typeof templates.$inferSelect): TemplateRecord {
    return {
      id: row.id,
      serverId: row.serverId,
      alias: row.alias,
      name: row.name,
      subject: row.subject,
      ...(row.htmlBody !== null && { htmlBody: row.htmlBody }),
      ...(row.textBody !== null && { textBody: row.textBody }),
      ...(row.layoutAlias !== null && { layoutAlias: row.layoutAlias }),
    }
  }

  async upsertTemplate(
    serverId: string,
    record: Omit<TemplateRecord, 'id' | 'serverId'>,
  ): Promise<TemplateRecord> {
    const rows = await this.db
      .insert(templates)
      .values({
        serverId,
        alias: record.alias,
        name: record.name,
        subject: record.subject,
        ...(record.htmlBody !== undefined && { htmlBody: record.htmlBody }),
        ...(record.textBody !== undefined && { textBody: record.textBody }),
        ...(record.layoutAlias !== undefined && { layoutAlias: record.layoutAlias }),
      })
      .onConflictDoUpdate({
        target: [templates.serverId, templates.alias],
        set: {
          name: record.name,
          subject: record.subject,
          ...(record.htmlBody !== undefined && { htmlBody: record.htmlBody }),
          ...(record.textBody !== undefined && { textBody: record.textBody }),
          ...(record.layoutAlias !== undefined && { layoutAlias: record.layoutAlias }),
          updatedAt: new Date(),
        },
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error('upsertTemplate returned no row')
    return this.templateFromRow(row)
  }

  async listTemplates(
    serverId: string,
    limit: number,
    offset: number,
  ): Promise<{ total: number; templates: TemplateRecord[] }> {
    const rows = await this.db
      .select()
      .from(templates)
      .where(eq(templates.serverId, serverId))
      .orderBy(templates.name)
      .limit(limit)
      .offset(offset)
    const countRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(templates)
      .where(eq(templates.serverId, serverId))
    return {
      total: countRows[0]?.count ?? 0,
      templates: rows.map((row) => this.templateFromRow(row)),
    }
  }

  async deleteTemplate(serverId: string, key: string): Promise<boolean> {
    const result = await this.db
      .delete(templates)
      .where(and(eq(templates.serverId, serverId), eq(templates.alias, key)))
      .returning({ id: templates.id })
    return result.length > 0
  }

  async findLayout(serverId: string, alias: string): Promise<LayoutRecord | null> {
    const rows = await this.db
      .select()
      .from(layouts)
      .where(and(eq(layouts.serverId, serverId), eq(layouts.alias, alias)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      serverId: row.serverId,
      alias: row.alias,
      name: row.name,
      htmlBody: row.htmlBody,
      ...(row.textBody !== null && { textBody: row.textBody }),
    }
  }

  async upsertLayout(
    serverId: string,
    record: Omit<LayoutRecord, 'id' | 'serverId'>,
  ): Promise<LayoutRecord> {
    const rows = await this.db
      .insert(layouts)
      .values({
        serverId,
        alias: record.alias,
        name: record.name,
        htmlBody: record.htmlBody,
        ...(record.textBody !== undefined && { textBody: record.textBody }),
      })
      .onConflictDoUpdate({
        target: [layouts.serverId, layouts.alias],
        set: { name: record.name, htmlBody: record.htmlBody },
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error('upsertLayout returned no row')
    return {
      id: row.id,
      serverId: row.serverId,
      alias: row.alias,
      name: row.name,
      htmlBody: row.htmlBody,
      ...(row.textBody !== null && { textBody: row.textBody }),
    }
  }

  async createSmtpCredential(
    serverId: string,
    streamId = 'outbound',
    keys?: { accessKey: string; secretKey: string },
  ): Promise<{ accessKey: string; secretKey: string; id: string }> {
    const accessKey = keys?.accessKey ?? `pb-${crypto.randomUUID().replaceAll('-', '')}`
    const secretKey = keys?.secretKey ?? `pbsec-${crypto.randomUUID().replaceAll('-', '')}`
    const rows = await this.db
      .insert(smtpCredentials)
      .values({ serverId, accessKey, secretKeyHash: hashToken(secretKey), streamId })
      .returning({ id: smtpCredentials.id })
    return { accessKey, secretKey, id: rows[0]?.id ?? '' }
  }

  async verifySmtpCredential(
    accessKey: string,
    secretKey: string,
  ): Promise<{ serverId: string; streamId: string } | null> {
    const rows = await this.db
      .select({
        serverId: smtpCredentials.serverId,
        streamId: smtpCredentials.streamId,
        secretKeyHash: smtpCredentials.secretKeyHash,
      })
      .from(smtpCredentials)
      .where(eq(smtpCredentials.accessKey, accessKey))
      .limit(1)
    const row = rows[0]
    if (!row || row.secretKeyHash !== hashToken(secretKey)) return null
    return { serverId: row.serverId, streamId: row.streamId }
  }

  // --- Phase 2 (M8): Streams, Suppressions, Tracking, Stats ----------------

  async listStreams(serverId: string): Promise<StreamRecord[]> {
    const rows = await this.db
      .select()
      .from(streams)
      .where(eq(streams.serverId, serverId))
      .orderBy(sql`${streams.id} ASC`)
    return rows.map((row) => ({
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      description: row.description,
      messageStreamType: row.messageStreamType,
      archived: row.archived,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async getStream(serverId: string, id: string): Promise<StreamRecord | null> {
    const rows = await this.db
      .select()
      .from(streams)
      .where(and(eq(streams.serverId, serverId), eq(streams.id, id)))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      description: row.description,
      messageStreamType: row.messageStreamType,
      archived: row.archived,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async upsertStream(
    serverId: string,
    record: {
      id: string
      name: string
      description?: string
      messageStreamType?: string
      archived?: boolean
    },
  ): Promise<StreamRecord> {
    const existing = await this.getStream(serverId, record.id)
    const values = {
      name: record.name,
      description: record.description ?? existing?.description ?? '',
      messageStreamType: record.messageStreamType ?? existing?.messageStreamType ?? 'outbound',
      archived: record.archived ?? existing?.archived ?? false,
    }
    const rows = await this.db
      .insert(streams)
      .values({ id: record.id, serverId, ...values })
      .onConflictDoUpdate({
        target: [streams.serverId, streams.id],
        set: values,
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error(`stream ${record.id} could not be upserted`)
    return {
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      description: row.description,
      messageStreamType: row.messageStreamType,
      archived: row.archived,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async setStreamArchived(
    serverId: string,
    id: string,
    archived: boolean,
  ): Promise<StreamRecord | null> {
    const rows = await this.db
      .update(streams)
      .set({ archived })
      .where(and(eq(streams.serverId, serverId), eq(streams.id, id)))
      .returning({ id: streams.id })
    return rows.length > 0 ? this.getStream(serverId, id) : null
  }

  async listSuppressions(serverId: string, streamId: string): Promise<SuppressionRecord[]> {
    const rows = await this.db
      .select()
      .from(suppressions)
      .where(and(eq(suppressions.serverId, serverId), eq(suppressions.streamId, streamId)))
      .orderBy(sql`${suppressions.email} ASC`)
    return rows.map((row) => ({
      email: row.email,
      streamId: row.streamId,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async suppressedEmails(serverId: string, streamId: string, emails: string[]): Promise<string[]> {
    if (emails.length === 0) return []
    const rows = await this.db
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.serverId, serverId),
          eq(suppressions.streamId, streamId),
          inArray(
            suppressions.email,
            emails.map((email) => email.toLowerCase()),
          ),
        ),
      )
    return rows.map((row) => row.email)
  }

  async addSuppression(
    serverId: string,
    streamId: string,
    record: { email: string; reason?: string },
  ): Promise<SuppressionRecord> {
    const email = record.email.trim().toLowerCase()
    const rows = await this.db
      .insert(suppressions)
      .values({ serverId, streamId, email, reason: record.reason ?? 'ManualSuppression' })
      .onConflictDoUpdate({
        target: [suppressions.serverId, suppressions.streamId, suppressions.email],
        set: { reason: record.reason ?? 'ManualSuppression' },
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error('addSuppression returned no row')
    return {
      email: row.email,
      streamId: row.streamId,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async removeSuppression(serverId: string, streamId: string, email: string): Promise<boolean> {
    const rows = await this.db
      .delete(suppressions)
      .where(
        and(
          eq(suppressions.serverId, serverId),
          eq(suppressions.streamId, streamId),
          eq(suppressions.email, email.trim().toLowerCase()),
        ),
      )
      .returning({ id: suppressions.id })
    return rows.length > 0
  }

  async recordTrackingEvent(event: TrackingEventInput): Promise<TrackingEventRecord> {
    const rows = await this.db
      .insert(trackingEvents)
      .values({
        messageId: event.messageId,
        type: event.type,
        ...(event.userAgent !== undefined && { userAgent: event.userAgent }),
        ...(event.ipAddress !== undefined && { ipAddress: event.ipAddress }),
        ...(event.originalLink !== undefined && { originalLink: event.originalLink }),
        ...(event.clickLocation !== undefined && { clickLocation: event.clickLocation }),
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error('recordTrackingEvent returned no row')
    return {
      id: row.id,
      messageId: row.messageId,
      type: row.type as 'open' | 'click',
      ...(row.userAgent !== null && { userAgent: row.userAgent }),
      ...(row.ipAddress !== null && { ipAddress: row.ipAddress }),
      ...(row.originalLink !== null && { originalLink: row.originalLink }),
      ...(row.clickLocation !== null && { clickLocation: row.clickLocation as 'HTML' | 'Text' }),
      createdAt: row.createdAt.toISOString(),
    }
  }

  async listTrackingEvents(
    messageId: string,
    type?: 'open' | 'click',
    limit = 100,
  ): Promise<TrackingEventRecord[]> {
    const conditions = [eq(trackingEvents.messageId, messageId)]
    if (type !== undefined) conditions.push(eq(trackingEvents.type, type))
    const rows = await this.db
      .select()
      .from(trackingEvents)
      .where(and(...conditions))
      .orderBy(sql`${trackingEvents.createdAt} DESC`)
      .limit(limit)
    return rows.map((row) => ({
      id: row.id,
      messageId: row.messageId,
      type: row.type as 'open' | 'click',
      ...(row.userAgent !== null && { userAgent: row.userAgent }),
      ...(row.ipAddress !== null && { ipAddress: row.ipAddress }),
      ...(row.originalLink !== null && { originalLink: row.originalLink }),
      ...(row.clickLocation !== null && { clickLocation: row.clickLocation as 'HTML' | 'Text' }),
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async outboundStats(options: {
    serverId: string
    fromDate: string
    toDate: string
    tag?: string
  }): Promise<StatDay[]> {
    const from = new Date(`${options.fromDate}T00:00:00.000Z`)
    const to = new Date(`${options.toDate}T00:00:00.000Z`)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return []
    const toEnd = new Date(to.getTime() + 86_400_000)
    const days: StatDay[] = []
    const count = Math.min(Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1, 366)
    for (let i = 0; i < count; i++) {
      days.push({
        date: new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10),
        sent: 0,
        bounced: 0,
        opens: 0,
        clicks: 0,
        tracked: 0,
      })
    }
    const byDate = new Map(days.map((d) => [d.date, d]))

    const messageConditions = [
      eq(messages.serverId, options.serverId),
      gte(messages.submittedAt, from),
      lte(messages.submittedAt, toEnd),
    ]
    if (options.tag !== undefined) messageConditions.push(eq(messages.tag, options.tag))
    const messageRows = await this.db
      .select({
        status: messages.status,
        submittedAt: messages.submittedAt,
        trackOpens: messages.trackOpens,
        trackLinks: messages.trackLinks,
      })
      .from(messages)
      .where(and(...messageConditions))
    for (const row of messageRows) {
      const day = byDate.get(row.submittedAt.toISOString().slice(0, 10))
      if (!day) continue
      if (row.status === 'sent') day.sent++
      if (row.status === 'bounced') day.bounced++
      if (row.trackOpens || row.trackLinks !== 'None') day.tracked++
    }

    const trackingConditions = [
      eq(messages.serverId, options.serverId),
      gte(trackingEvents.createdAt, from),
      lte(trackingEvents.createdAt, toEnd),
    ]
    if (options.tag !== undefined) trackingConditions.push(eq(messages.tag, options.tag))
    const trackingRows = await this.db
      .select({ type: trackingEvents.type, createdAt: trackingEvents.createdAt })
      .from(trackingEvents)
      .innerJoin(messages, eq(trackingEvents.messageId, messages.id))
      .where(and(...trackingConditions))
    for (const row of trackingRows) {
      const day = byDate.get(row.createdAt.toISOString().slice(0, 10))
      if (!day) continue
      if (row.type === 'open') day.opens++
      else day.clicks++
    }
    return days
  }
}
