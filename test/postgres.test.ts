import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PostgresMessageStore } from '../src/core/postgres-store.js'
import { encryptAtRest } from '../src/core/secret.js'
import { createDb } from '../src/db/client.js'
import { relayConfigs } from '../src/db/schema.js'

/**
 * Integrationstest gegen eine echte Postgres-DB. Läuft nur, wenn
 * POSTBOTE_TEST_DATABASE_URL gesetzt ist (CI-Job mit postgres-Service).
 * Deckt die Postgres-Pfade ab, die sonst nur über den Memory-Store getestet
 * werden: Schema/Migrationen, alle Store-Methoden, Secrets at rest.
 */
const url = process.env.POSTBOTE_TEST_DATABASE_URL

describe.skipIf(!url)('Postgres-Integration', () => {
  let sql: ReturnType<typeof createDb>['sql']
  let db: ReturnType<typeof createDb>['db']
  let store: PostgresMessageStore
  let serverId: string
  let serverSlug: string
  let tokenValue: string

  beforeAll(async () => {
    const connection = createDb({ databaseUrl: url as string })
    sql = connection.sql
    db = connection.db
    await migrate(db, { migrationsFolder: 'migrations' })
    store = new PostgresMessageStore(db)
    serverSlug = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const server = await store.createServer('Integration', serverSlug)
    serverId = server.id
    tokenValue = `pg-integration-token-${Date.now()}`
    await store.addToken(server.id, tokenValue, 'integration')
    await store.addToken(server.id, 'pg-logto-token', 'logto-client', {
      allowedFrom: ['*@devolta.de'],
      logtoConfig: { from: 'devolta <office@devolta.de>', templates: { SignIn: 'logto-sign-in' } },
    })
  })

  afterAll(async () => {
    await sql?.end()
  })

  it('Token-Auth + Server', async () => {
    const token = await store.findServerByToken(tokenValue)
    expect(token?.serverId).toBe(serverId)
    expect((await store.findServerByToken('pg-logto-token'))?.logtoConfig).toEqual({
      from: 'devolta <office@devolta.de>',
      templates: { SignIn: 'logto-sign-in' },
    })
    expect(await store.getServer(serverId)).toMatchObject({ name: 'Integration' })
    expect((await store.findServerBySlug(serverSlug))?.id).toBe(serverId)
    expect(await store.findServerBySlug('does-not-exist')).toBeNull()
  })

  it('Message inkl. Cc/Bcc/Tracking/Attachments roundtrip', async () => {
    const inserted = await store.insertMessage(
      {
        from: 'Max <max@example.com>',
        to: ['a@example.com', 'b@example.com'],
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        replyTo: 'reply@example.com',
        subject: 'Integration',
        htmlBody: '<p>Hi</p>',
        textBody: 'Hi',
        tag: 'test',
        metadata: { source: 'pg' },
        headers: [{ name: 'X-Test', value: '1' }],
        attachments: [{ name: 'a.txt', content: 'aGk=', contentType: 'text/plain' }],
        trackOpens: true,
        trackLinks: 'HtmlAndText',
      },
      serverId,
      'outbound',
    )
    const loaded = await store.getMessage(inserted.id)
    expect(loaded?.cc).toEqual(['cc@example.com'])
    expect(loaded?.bcc).toEqual(['bcc@example.com'])
    expect(loaded?.htmlBody).toBe('<p>Hi</p>')
    expect(loaded?.trackOpens).toBe(true)
    expect(loaded?.trackLinks).toBe('HtmlAndText')
    expect(loaded?.attachments?.[0]?.name).toBe('a.txt')

    await store.updateMessageStatus(inserted.id, 'sent', new Date())
    expect((await store.getMessage(inserted.id))?.status).toBe('sent')
    expect((await store.listMessages({ serverId, limit: 10, offset: 0 })).length).toBeGreaterThan(0)

    await store.recordTrackingEvent({ messageId: inserted.id, type: 'open', userAgent: 'PG/1.0' })
    await store.recordTrackingEvent({
      messageId: inserted.id,
      type: 'click',
      originalLink: 'https://x.de',
      clickLocation: 'HTML',
    })
    expect(await store.listTrackingEvents(inserted.id, 'open')).toHaveLength(1)
    const today = new Date().toISOString().slice(0, 10)
    const stats = await store.outboundStats({ serverId, fromDate: today, toDate: today })
    expect(stats[0]?.sent).toBe(1)
    expect(stats[0]?.opens).toBe(1)
    expect(stats[0]?.clicks).toBe(1)
  })

  it('Streams, Suppressions, Bounces', async () => {
    await store.upsertStream(serverId, { id: 'news', name: 'News', messageStreamType: 'broadcast' })
    expect((await store.getStream(serverId, 'news'))?.name).toBe('News')
    expect((await store.listStreams(serverId)).some((s) => s.id === 'news')).toBe(true)
    expect((await store.setStreamArchived(serverId, 'news', true))?.archived).toBe(true)

    await store.addSuppression(serverId, 'outbound', {
      email: 'Blocked@Example.com',
      reason: 'HardBounce',
    })
    expect(await store.suppressedEmails(serverId, 'outbound', ['blocked@example.com'])).toEqual([
      'blocked@example.com',
    ])
    expect(await store.listSuppressions(serverId, 'outbound')).toHaveLength(1)
    expect(await store.removeSuppression(serverId, 'outbound', 'blocked@example.com')).toBe(true)

    const message = await store.insertMessage(
      { from: 'a@b.de', to: ['bounce@example.com'], subject: 'x', textBody: 'x' },
      serverId,
      'outbound',
    )
    await store.addBounce({
      messageId: message.id,
      type: 'HardBounce',
      typeCode: 1,
      description: '550',
      email: 'bounce@example.com',
      bouncedAt: new Date().toISOString(),
    })
    const list = await store.listBounces({ serverId, limit: 10, offset: 0 })
    expect(list.total).toBeGreaterThan(0)
    expect((await store.getBounce(serverId, list.bounces[0]?.id ?? ''))?.type).toBe('HardBounce')
  })

  it('Templates, Layouts, Webhooks, SMTP-Credentials', async () => {
    await store.upsertLayout(serverId, { alias: 'base', name: 'Base', htmlBody: '{{{content}}}' })
    expect((await store.findLayout(serverId, 'base'))?.htmlBody).toBe('{{{content}}}')
    await store.upsertTemplate(serverId, {
      alias: 'welcome',
      name: 'Welcome',
      subject: 'Hi {{name}}',
      htmlBody: '<p>{{name}}</p>',
      layoutAlias: 'base',
    })
    expect((await store.findTemplate(serverId, 'welcome'))?.subject).toBe('Hi {{name}}')
    expect((await store.listTemplates(serverId, 10, 0)).total).toBeGreaterThan(0)
    expect(await store.deleteTemplate(serverId, 'welcome')).toBe(true)

    const webhook = await store.upsertWebhook(serverId, {
      url: 'https://hooks.example.com',
      events: ['Delivery', 'Open'],
      verified: true,
    })
    expect((await store.getWebhook(serverId, webhook.id))?.events).toContain('Open')
    expect(await store.listWebhooks(serverId, 'Open')).toHaveLength(1)
    expect(await store.deleteWebhook(serverId, webhook.id)).toBe(true)

    const cred = await store.createSmtpCredential(serverId, 'outbound')
    expect(await store.verifySmtpCredential(cred.accessKey, cred.secretKey)).toEqual({
      serverId,
      streamId: 'outbound',
    })
    expect(await store.verifySmtpCredential(cred.accessKey, 'wrong')).toBeNull()
  })

  it('Relay-Passwort verschlüsselt at rest, getRelay entschlüsselt', async () => {
    vi.stubEnv('POSTBOTE_SECRET_KEY', 'pg-integration-key')
    try {
      await db
        .insert(relayConfigs)
        .values({
          serverId,
          streamId: 'secure',
          host: 'smtp.example.com',
          port: 587,
          username: 'user',
          passwordEncrypted: encryptAtRest('top-secret'),
          tlsMode: 'starttls',
        })
        .onConflictDoNothing()
      const relay = await store.getRelay(serverId, 'secure')
      expect(relay?.password).toBe('top-secret')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
