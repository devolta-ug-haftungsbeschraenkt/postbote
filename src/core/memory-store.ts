import { hashToken } from './store.js'
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
  TrackingEventInput,
  TrackingEventRecord,
  WebhookDeliveryInput,
  WebhookRecord,
} from './store.js'

type StoredMessage = MessageRecord

/**
 * In-memory MessageStore. Used by unit/integration tests and as the fallback
 * store when no Postgres is configured (demo mode). Same semantics as the
 * Postgres implementation.
 */
export class MemoryMessageStore implements MessageStore {
  readonly servers = new Map<string, ServerRecord>()
  readonly smtpCredentials = new Map<
    string,
    { id: string; serverId: string; accessKey: string; secretKeyHash: string; streamId: string }
  >()
  readonly tokens = new Map<string, TokenRecord>()
  readonly relays = new Map<string, RelayRecord>()
  readonly webhooks = new Map<string, WebhookRecord>()
  readonly bounces: (BounceRecord & { id: string })[] = []
  readonly events: { messageId: string; type: string; details?: string; at: string }[] = []
  readonly webhookDeliveries: (WebhookDeliveryInput & { deliveredAt: string })[] = []
  private readonly templates = new Map<string, TemplateRecord>()
  private readonly layouts = new Map<string, LayoutRecord>()
  private readonly messages: StoredMessage[] = []
  readonly streams = new Map<string, StreamRecord>()
  readonly suppressions = new Map<string, SuppressionRecord & { serverId: string }>()
  readonly trackingEvents: TrackingEventRecord[] = []

  async findServerByToken(token: string): Promise<TokenRecord | null> {
    const hash = hashToken(token)
    return this.tokens.get(hash) ?? null
  }

  async createServer(name: string, slug: string): Promise<ServerRecord> {
    const server: ServerRecord = { id: crypto.randomUUID(), name, slug }
    this.servers.set(server.id, server)
    this.streams.set(`${server.id}:outbound`, {
      id: 'outbound',
      serverId: server.id,
      name: 'Outbound',
      description: '',
      messageStreamType: 'outbound',
      archived: false,
      createdAt: new Date().toISOString(),
    })
    return server
  }

  async addToken(serverId: string, token: string, name: string): Promise<void> {
    this.tokens.set(hashToken(token), {
      serverId,
      tokenHash: hashToken(token),
      name,
      sandbox: false,
    })
  }

  async insertMessage(
    input: MessageInput,
    serverId: string,
    streamId: string,
  ): Promise<MessageRecord> {
    const record: StoredMessage = {
      id: crypto.randomUUID(),
      serverId,
      streamId,
      from: input.from,
      to: [...input.to],
      ...(input.cc !== undefined && { cc: [...input.cc] }),
      ...(input.bcc !== undefined && { bcc: [...input.bcc] }),
      ...(input.replyTo !== undefined && { replyTo: input.replyTo }),
      subject: input.subject,
      ...(input.htmlBody !== undefined && { htmlBody: input.htmlBody }),
      ...(input.textBody !== undefined && { textBody: input.textBody }),
      ...(input.tag !== undefined && { tag: input.tag }),
      ...(input.metadata !== undefined && { metadata: { ...input.metadata } }),
      ...(input.headers !== undefined && { headers: input.headers }),
      ...(input.attachments !== undefined && { attachments: input.attachments }),
      ...(input.trackOpens !== undefined && { trackOpens: input.trackOpens }),
      ...(input.trackLinks !== undefined && { trackLinks: input.trackLinks }),
      status: 'queued',
      submittedAt: new Date().toISOString(),
    }
    this.messages.push(record)
    this.events.push({ messageId: record.id, type: 'accepted', at: new Date().toISOString() })
    return this.snapshot(record)
  }

  async getMessage(id: string): Promise<MessageRecord | null> {
    const record = this.messages.find((m) => m.id === id)
    return record ? this.snapshot(record) : null
  }

  async updateMessageStatus(id: string, status: MessageStatus, sentAt?: Date): Promise<void> {
    const record = this.messages.find((m) => m.id === id)
    if (!record) throw new Error(`message ${id} not found`)
    record.status = status
    if (sentAt !== undefined) record.sentAt = sentAt.toISOString()
  }

  async appendEvent(
    messageId: string,
    type: 'accepted' | 'sent' | 'deferred' | 'bounced' | 'webhook_delivered' | 'opened' | 'clicked',
    details?: string,
  ): Promise<void> {
    this.events.push({
      messageId,
      type,
      ...(details !== undefined && { details }),
      at: new Date().toISOString(),
    })
  }

  async addBounce(bounce: BounceRecord): Promise<void> {
    this.bounces.push({ ...bounce, id: crypto.randomUUID() })
  }

  async listMessages(options: {
    serverId: string
    status?: MessageStatus
    tag?: string
    limit: number
    offset: number
  }): Promise<MessageRecord[]> {
    let filtered = this.messages.filter((m) => m.serverId === options.serverId)
    if (options.status) filtered = filtered.filter((m) => m.status === options.status)
    if (options.tag) filtered = filtered.filter((m) => m.tag === options.tag)
    return filtered
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .slice(options.offset, options.offset + options.limit)
      .map((m) => this.snapshot(m))
  }

  async countMessages(serverId: string): Promise<{
    sent: number
    queued: number
    failed: number
    bounced: number
  }> {
    const counts = { sent: 0, queued: 0, failed: 0, bounced: 0 }
    for (const m of this.messages) {
      if (m.serverId === serverId) counts[m.status]++
    }
    return counts
  }

  async getRelay(serverId: string, streamId: string): Promise<RelayRecord | null> {
    return this.relays.get(`${serverId}:${streamId}`) ?? null
  }

  addRelay(relay: RelayRecord): void {
    this.relays.set(`${relay.serverId}:${relay.streamId}`, relay)
  }

  async listWebhooks(serverId: string, event: string): Promise<WebhookRecord[]> {
    return [...this.webhooks.values()].filter(
      (w) => w.serverId === serverId && w.verified && w.events.includes(event),
    )
  }

  addWebhook(webhook: WebhookRecord): void {
    this.webhooks.set(webhook.id, webhook)
  }

  async recordWebhookDelivery(delivery: WebhookDeliveryInput): Promise<void> {
    this.webhookDeliveries.push({ ...delivery, deliveredAt: new Date().toISOString() })
  }

  async findTemplate(serverId: string, key: string): Promise<TemplateRecord | null> {
    return this.templates.get(`${serverId}:${key}`) ?? null
  }

  async upsertTemplate(
    serverId: string,
    record: Omit<TemplateRecord, 'id' | 'serverId'>,
  ): Promise<TemplateRecord> {
    const key = `${serverId}:${record.alias}`
    const existing = this.templates.get(key)
    const stored: TemplateRecord = { id: existing?.id ?? crypto.randomUUID(), serverId, ...record }
    this.templates.set(key, stored)
    return stored
  }

  async listTemplates(
    serverId: string,
    limit: number,
    offset: number,
  ): Promise<{ total: number; templates: TemplateRecord[] }> {
    const all = [...this.templates.values()].filter((t) => t.serverId === serverId)
    return {
      total: all.length,
      templates: all.sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit),
    }
  }

  async deleteTemplate(serverId: string, key: string): Promise<boolean> {
    return this.templates.delete(`${serverId}:${key}`)
  }

  async findLayout(serverId: string, alias: string): Promise<LayoutRecord | null> {
    return this.layouts.get(`${serverId}:${alias}`) ?? null
  }

  async upsertLayout(
    serverId: string,
    record: Omit<LayoutRecord, 'id' | 'serverId'>,
  ): Promise<LayoutRecord> {
    const key = `${serverId}:${record.alias}`
    const existing = this.layouts.get(key)
    const stored: LayoutRecord = { id: existing?.id ?? crypto.randomUUID(), serverId, ...record }
    this.layouts.set(key, stored)
    return stored
  }

  async listBounces(options: {
    serverId: string
    type?: string
    limit: number
    offset: number
  }): Promise<{ total: number; bounces: (BounceRecord & { id: string })[] }> {
    // Bounces belong to messages which belong to servers.
    const serverMessages = new Set(
      this.messages.filter((m) => m.serverId === options.serverId).map((m) => m.id),
    )
    let filtered = this.bounces.filter((b) => serverMessages.has(b.messageId))
    if (options.type) filtered = filtered.filter((b) => b.type === options.type)
    filtered = filtered.sort((a, b) => b.bouncedAt.localeCompare(a.bouncedAt))
    return {
      total: filtered.length,
      bounces: filtered.slice(options.offset, options.offset + options.limit),
    }
  }

  async getBounce(_serverId: string, id: string): Promise<(BounceRecord & { id: string }) | null> {
    return this.bounces.find((b) => b.id === id) ?? null
  }

  async getWebhook(serverId: string, id: string): Promise<WebhookRecord | null> {
    const webhook = this.webhooks.get(id)
    return webhook && webhook.serverId === serverId ? webhook : null
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
    const webhook: WebhookRecord = {
      id: record.id ?? crypto.randomUUID(),
      serverId,
      url: record.url,
      events: [...record.events],
      ...(record.httpAuth !== undefined && { httpAuth: record.httpAuth }),
      ...(record.httpHeaders !== undefined && { httpHeaders: record.httpHeaders }),
      verified: record.verified,
    }
    this.webhooks.set(webhook.id, webhook)
    return webhook
  }

  async deleteWebhook(serverId: string, id: string): Promise<boolean> {
    const webhook = this.webhooks.get(id)
    if (!webhook || webhook.serverId !== serverId) return false
    return this.webhooks.delete(id)
  }

  async getServer(serverId: string): Promise<ServerRecord | null> {
    return this.servers.get(serverId) ?? null
  }

  async createSmtpCredential(
    serverId: string,
    streamId = 'outbound',
    keys?: { accessKey: string; secretKey: string },
  ): Promise<{ accessKey: string; secretKey: string; id: string }> {
    const accessKey = keys?.accessKey ?? `pb-${crypto.randomUUID().replaceAll('-', '')}`
    const secretKey = keys?.secretKey ?? `pbsec-${crypto.randomUUID().replaceAll('-', '')}`
    const record = {
      id: crypto.randomUUID(),
      serverId,
      accessKey,
      secretKeyHash: hashToken(secretKey),
      streamId,
    }
    this.smtpCredentials.set(accessKey, record)
    return { accessKey, secretKey, id: record.id }
  }

  async verifySmtpCredential(
    accessKey: string,
    secretKey: string,
  ): Promise<{ serverId: string; streamId: string } | null> {
    const record = this.smtpCredentials.get(accessKey)
    if (!record || record.secretKeyHash !== hashToken(secretKey)) return null
    return { serverId: record.serverId, streamId: record.streamId }
  }

  /** Copy without internal state so callers can't mutate the store. */
  private snapshot(record: StoredMessage): MessageRecord {
    return {
      id: record.id,
      serverId: record.serverId,
      streamId: record.streamId,
      from: record.from,
      to: [...record.to],
      ...(record.cc !== undefined && { cc: [...record.cc] }),
      ...(record.bcc !== undefined && { bcc: [...record.bcc] }),
      ...(record.replyTo !== undefined && { replyTo: record.replyTo }),
      subject: record.subject,
      ...(record.tag !== undefined && { tag: record.tag }),
      status: record.status,
      submittedAt: record.submittedAt,
      ...(record.sentAt !== undefined && { sentAt: record.sentAt }),
      ...(record.htmlBody !== undefined && { htmlBody: record.htmlBody }),
      ...(record.textBody !== undefined && { textBody: record.textBody }),
      ...(record.headers !== undefined && { headers: record.headers }),
      ...(record.attachments !== undefined && { attachments: record.attachments }),
      ...(record.metadata !== undefined && { metadata: record.metadata }),
      ...(record.trackOpens !== undefined && { trackOpens: record.trackOpens }),
      ...(record.trackLinks !== undefined && { trackLinks: record.trackLinks }),
    }
  }

  // --- Phase 2 (M8): Streams, Suppressions, Tracking, Stats ----------------

  async listStreams(serverId: string): Promise<StreamRecord[]> {
    return [...this.streams.values()]
      .filter((s) => s.serverId === serverId)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async getStream(serverId: string, id: string): Promise<StreamRecord | null> {
    return this.streams.get(`${serverId}:${id}`) ?? null
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
    const key = `${serverId}:${record.id}`
    const existing = this.streams.get(key)
    const stream: StreamRecord = {
      id: record.id,
      serverId,
      name: record.name,
      description: record.description ?? existing?.description ?? '',
      messageStreamType: record.messageStreamType ?? existing?.messageStreamType ?? 'outbound',
      archived: record.archived ?? existing?.archived ?? false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    this.streams.set(key, stream)
    return stream
  }

  async setStreamArchived(
    serverId: string,
    id: string,
    archived: boolean,
  ): Promise<StreamRecord | null> {
    const stream = this.streams.get(`${serverId}:${id}`)
    if (!stream) return null
    stream.archived = archived
    return { ...stream }
  }

  async listSuppressions(serverId: string, streamId: string): Promise<SuppressionRecord[]> {
    return [...this.suppressions.values()]
      .filter((s) => s.serverId === serverId && s.streamId === streamId)
      .sort((a, b) => a.email.localeCompare(b.email))
  }

  async suppressedEmails(serverId: string, streamId: string, emails: string[]): Promise<string[]> {
    const suppressed = new Set(
      [...this.suppressions.values()]
        .filter((s) => s.serverId === serverId && s.streamId === streamId)
        .map((s) => s.email.toLowerCase()),
    )
    return emails.filter((email) => suppressed.has(email.toLowerCase()))
  }

  async addSuppression(
    serverId: string,
    streamId: string,
    record: { email: string; reason?: string },
  ): Promise<SuppressionRecord> {
    const email = record.email.trim().toLowerCase()
    const key = `${serverId}:${streamId}:${email}`
    const existing = this.suppressions.get(key)
    const entry: SuppressionRecord & { serverId: string } = {
      email,
      streamId,
      serverId,
      reason: record.reason ?? existing?.reason ?? 'ManualSuppression',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    this.suppressions.set(key, entry)
    return entry
  }

  async removeSuppression(serverId: string, streamId: string, email: string): Promise<boolean> {
    return this.suppressions.delete(`${serverId}:${streamId}:${email.trim().toLowerCase()}`)
  }

  async recordTrackingEvent(event: TrackingEventInput): Promise<TrackingEventRecord> {
    const record: TrackingEventRecord = {
      ...event,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    this.trackingEvents.push(record)
    return record
  }

  async listTrackingEvents(
    messageId: string,
    type?: 'open' | 'click',
    limit = 100,
  ): Promise<TrackingEventRecord[]> {
    return this.trackingEvents
      .filter((e) => e.messageId === messageId && (type === undefined || e.type === type))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  }

  async outboundStats(options: {
    serverId: string
    fromDate: string
    toDate: string
    tag?: string
  }): Promise<StatDay[]> {
    const days: StatDay[] = []
    const from = new Date(`${options.fromDate}T00:00:00.000Z`)
    const to = new Date(`${options.toDate}T00:00:00.000Z`)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return days
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
    const messageById = new Map(this.messages.map((m) => [m.id, m]))
    const dayOf = (iso: string): string => iso.slice(0, 10)

    for (const message of this.messages) {
      if (message.serverId !== options.serverId) continue
      if (options.tag !== undefined && message.tag !== options.tag) continue
      const day = byDate.get(dayOf(message.submittedAt))
      if (!day) continue
      if (message.status === 'sent') day.sent++
      if (message.status === 'bounced') day.bounced++
      if (
        message.trackOpens === true ||
        (message.trackLinks !== undefined && message.trackLinks !== 'None')
      ) {
        day.tracked++
      }
    }
    for (const event of this.trackingEvents) {
      const message = messageById.get(event.messageId)
      if (!message || message.serverId !== options.serverId) continue
      if (options.tag !== undefined && message.tag !== options.tag) continue
      const day = byDate.get(dayOf(event.createdAt))
      if (!day) continue
      if (event.type === 'open') day.opens++
      else day.clicks++
    }
    return days
  }
}
