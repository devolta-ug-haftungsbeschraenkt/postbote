import type { Transporter } from 'nodemailer'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/api/app.js'
import { MemoryMessageStore } from '../src/core/memory-store.js'
import type { MessageRecord, RelayRecord } from '../src/core/store.js'
import { registerJobHandlers } from '../src/worker/handlers.js'
import { MemoryJobQueue } from '../src/worker/queue.js'
import { SmtpMailSender } from '../src/worker/sender.js'
import {
  injectOpenPixel,
  rewriteHtmlLinks,
  rewriteTextLinks,
  transformForTracking,
} from '../src/worker/tracking.js'

const TOKEN_HEADER = { 'x-postmark-server-token': 'm8-token' }
const BASE = 'http://localhost:3000'

async function setup() {
  const store = new MemoryMessageStore()
  const server = await store.createServer('M8', 'm8')
  await store.addToken(server.id, 'm8-token', 'primary')
  const app = await buildApp({ store, version: 'test' })
  return { app, store, serverId: server.id }
}

const emailBody = (overrides: Record<string, unknown> = {}) => ({
  From: 'absender@example.com',
  To: 'empfaenger@example.com',
  Subject: 'M8',
  TextBody: 'Hallo',
  ...overrides,
})

describe('M8 Tracking-Transformation', () => {
  it('rewrites HTML-Links und injiziert das Pixel genau einmal', () => {
    const html =
      '<html><body><a href="https://example.com/x">Link</a><a href="mailto:a@b.de">Mail</a></body></html>'
    const rewritten = rewriteHtmlLinks(html, 'm-1', BASE)
    expect(rewritten).toContain('/track/click/m-1?')
    expect(rewritten).toContain('location=HTML')
    expect(rewritten).toContain('mailto:a@b.de')
    expect(rewritten).not.toContain('href="https://example.com/x"')

    const withPixel = injectOpenPixel(rewritten, BASE, 'm-1')
    expect(withPixel).toContain('/track/open/m-1')
    expect(withPixel.indexOf('<img')).toBeLessThan(withPixel.indexOf('</body>'))
    expect(injectOpenPixel(withPixel, BASE, 'm-1')).toBe(withPixel)
  })

  it('rewrites nackte URLs im Textpart mit location=Text', () => {
    expect(rewriteTextLinks('Siehe https://example.com/a?b=1', 'm-1', BASE)).toContain(
      'location=Text',
    )
  })

  it('transformForTracking respektiert TrackLinks-Modi', () => {
    const message: MessageRecord = {
      id: 'm-1',
      serverId: 's',
      streamId: 'outbound',
      from: 'a@b.de',
      to: ['c@d.de'],
      subject: 'x',
      status: 'queued',
      submittedAt: new Date().toISOString(),
      htmlBody: '<a href="https://x.de">x</a>',
      textBody: 'https://x.de',
    }
    expect(transformForTracking(message, BASE)).toBeNull()
    expect(
      transformForTracking({ ...message, trackOpens: true, trackLinks: 'HtmlAndText' }, BASE),
    ).toMatchObject({
      html: expect.stringContaining('/track/open/m-1'),
      text: expect.stringContaining('/track/click/m-1'),
    })
    expect(transformForTracking({ ...message, trackLinks: 'TextOnly' }, BASE)?.html).toBe(
      '<a href="https://x.de">x</a>',
    )
    expect(transformForTracking({ ...message, trackLinks: 'HtmlOnly' }, BASE)?.text).toBe(
      'https://x.de',
    )
  })

  it('SmtpMailSender sendet transformierte Bodies an den Upstream', async () => {
    const captured: Record<string, unknown>[] = []
    const fakeTransport = {
      sendMail: async (options: Record<string, unknown>) => {
        captured.push(options)
        return { response: '250 OK' }
      },
    } as unknown as Transporter
    const sender = new SmtpMailSender(new Map(), () => fakeTransport)
    const message: MessageRecord = {
      id: 'm-2',
      serverId: 's',
      streamId: 'outbound',
      from: 'a@b.de',
      to: ['c@d.de'],
      subject: 'x',
      status: 'queued',
      submittedAt: new Date().toISOString(),
      htmlBody: '<html><body><a href="https://x.de">x</a></body></html>',
      textBody: 'https://x.de',
      trackOpens: true,
      trackLinks: 'HtmlAndText',
    }
    const relay: RelayRecord = {
      serverId: 's',
      streamId: 'outbound',
      host: 'relay',
      port: 587,
      username: 'u',
      password: 'p',
      tlsMode: 'starttls',
    }
    const outcome = await sender.send(message, relay, { trackingBaseUrl: BASE })
    expect(outcome.code).toBe(250)
    expect(String(captured[0]?.html)).toContain('/track/open/m-2')
    expect(String(captured[0]?.html)).toContain('/track/click/m-2')
    expect(String(captured[0]?.text)).toContain('/track/click/m-2')
  })
})

describe('M8 Message-Streams', () => {
  it('CRUD + Archive/Unarchive', async () => {
    const { app } = await setup()
    const listed = await app.inject({
      method: 'GET',
      url: '/message-streams',
      headers: TOKEN_HEADER,
    })
    expect(listed.json().TotalCount).toBe(1)
    expect(listed.json().MessageStreams[0].ID).toBe('outbound')

    const created = await app.inject({
      method: 'POST',
      url: '/message-streams',
      headers: TOKEN_HEADER,
      payload: {
        ID: 'broadcast',
        Name: 'Broadcast',
        MessageStreamType: 'broadcast',
        Description: 'Newsletter',
      },
    })
    expect(created.json().ID).toBe('broadcast')
    expect(created.json().Archived).toBe(false)

    const archived = await app.inject({
      method: 'POST',
      url: '/message-streams/broadcast/archive',
      headers: TOKEN_HEADER,
    })
    expect(archived.json().Archived).toBe(true)
    const unarchived = await app.inject({
      method: 'POST',
      url: '/message-streams/broadcast/unarchive',
      headers: TOKEN_HEADER,
    })
    expect(unarchived.json().Archived).toBe(false)

    const updated = await app.inject({
      method: 'PUT',
      url: '/message-streams/broadcast',
      headers: TOKEN_HEADER,
      payload: { Name: 'Broadcast 2' },
    })
    expect(updated.json().Name).toBe('Broadcast 2')
  })

  it('unbekannter/archivierter Stream → ErrorCode 1235', async () => {
    const { app } = await setup()
    const unknown = await app.inject({
      method: 'POST',
      url: '/email',
      headers: TOKEN_HEADER,
      payload: emailBody({ MessageStream: 'gibts-nicht' }),
    })
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json().ErrorCode).toBe(1235)

    await app.inject({
      method: 'POST',
      url: '/message-streams',
      headers: TOKEN_HEADER,
      payload: { ID: 'news', Name: 'News' },
    })
    await app.inject({
      method: 'POST',
      url: '/message-streams/news/archive',
      headers: TOKEN_HEADER,
    })
    const archived = await app.inject({
      method: 'POST',
      url: '/email',
      headers: TOKEN_HEADER,
      payload: emailBody({ MessageStream: 'news' }),
    })
    expect(archived.json().ErrorCode).toBe(1235)
  })
})

describe('M8 Suppressions + ErrorCode 406', () => {
  it('Create/Dump/Delete und 406 beim Senden', async () => {
    const { app, store } = await setup()
    const added = await app.inject({
      method: 'POST',
      url: '/suppressions/outbound',
      headers: TOKEN_HEADER,
      payload: { EmailAddress: 'Blocked@Example.com', SuppressionReason: 'ManualSuppression' },
    })
    expect(added.json().Suppressions[0].EmailAddress).toBe('blocked@example.com')

    const dumped = await app.inject({
      method: 'GET',
      url: '/suppressions/outbound',
      headers: TOKEN_HEADER,
    })
    expect(dumped.json().TotalCount).toBe(1)

    const blocked = await app.inject({
      method: 'POST',
      url: '/email',
      headers: TOKEN_HEADER,
      payload: emailBody({ To: 'blocked@example.com' }),
    })
    expect(blocked.statusCode).toBe(422)
    expect(blocked.json().ErrorCode).toBe(406)

    const removed = await app.inject({
      method: 'POST',
      url: '/suppressions/outbound/delete',
      headers: TOKEN_HEADER,
      payload: { EmailAddress: 'blocked@example.com' },
    })
    expect(removed.json().ErrorCode).toBe(0)
    const ok = await app.inject({
      method: 'POST',
      url: '/email',
      headers: TOKEN_HEADER,
      payload: emailBody({ To: 'blocked@example.com' }),
    })
    expect(ok.json().ErrorCode).toBe(0)
    expect(store.suppressions.size).toBe(0)
  })

  it('Batch liefert pro-Item 406 statt HTTP-Fehler', async () => {
    const { app } = await setup()
    await app.inject({
      method: 'POST',
      url: '/suppressions/outbound',
      headers: TOKEN_HEADER,
      payload: { EmailAddress: 'bad@example.com' },
    })
    const batch = await app.inject({
      method: 'POST',
      url: '/email/batch',
      headers: TOKEN_HEADER,
      payload: [emailBody({ To: 'gut@example.com' }), emailBody({ To: 'bad@example.com' })],
    })
    expect(batch.statusCode).toBe(200)
    expect(batch.json()[0].ErrorCode).toBe(0)
    expect(batch.json()[1].ErrorCode).toBe(406)
  })

  it('HardBounce im Worker erzeugt automatisch eine Suppression', async () => {
    const { store, serverId } = await setup()
    const queue = new MemoryJobQueue()
    registerJobHandlers(queue, {
      store,
      sender: { send: async () => ({ code: 550, response: '550 5.1.1 user unknown' }) },
      getRelay: () => Promise.resolve(null),
      fetchImpl: (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    })
    await queue.start()
    const message = await store.insertMessage(
      { from: 'a@b.de', to: ['bounce@example.com'], subject: 'x', textBody: 'x' },
      serverId,
      'outbound',
    )
    await queue.enqueue({ type: 'send_email', payload: { messageId: message.id } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await store.suppressedEmails(serverId, 'outbound', ['bounce@example.com'])).toEqual([
      'bounce@example.com',
    ])
    expect(store.bounces[0]?.type).toBe('HardBounce')
    await queue.stop()
  })

  it('/bounces/:id/activate entfernt die Suppression', async () => {
    const { app, store, serverId } = await setup()
    const message = await store.insertMessage(
      { from: 'a@b.de', to: ['weg@example.com'], subject: 'x', textBody: 'x' },
      serverId,
      'outbound',
    )
    await store.addBounce({
      messageId: message.id,
      type: 'HardBounce',
      typeCode: 1,
      description: '550',
      email: 'weg@example.com',
      bouncedAt: new Date().toISOString(),
    })
    await store.addSuppression(serverId, 'outbound', {
      email: 'weg@example.com',
      reason: 'HardBounce',
    })
    const id = store.bounces[0]?.id as string
    const activated = await app.inject({
      method: 'PUT',
      url: `/bounces/${id}/activate`,
      headers: TOKEN_HEADER,
    })
    expect(activated.json().Message).toBe('OK')
    expect(store.suppressions.size).toBe(0)
  })
})

describe('M8 Tracking-Endpunkte, Webhooks & Stats', () => {
  it('Pixel → GIF + Open-Event, Click → 302 + Click-Event', async () => {
    const { app, store, serverId } = await setup()
    const message = await store.insertMessage(
      {
        from: 'a@b.de',
        to: ['c@d.de'],
        subject: 'x',
        textBody: 'x',
        trackOpens: true,
        trackLinks: 'HtmlAndText',
      },
      serverId,
      'outbound',
    )

    const pixel = await app.inject({
      method: 'GET',
      url: `/track/open/${message.id}`,
      headers: { 'user-agent': 'TestMailClient/1.0' },
    })
    expect(pixel.statusCode).toBe(200)
    expect(pixel.headers['content-type']).toContain('image/gif')
    expect(pixel.rawPayload.subarray(0, 3).toString()).toBe('GIF')

    const click = await app.inject({
      method: 'GET',
      url: `/track/click/${message.id}?url=${encodeURIComponent('https://example.com/ziel')}&location=HTML`,
    })
    expect(click.statusCode).toBe(302)
    expect(click.headers.location).toBe('https://example.com/ziel')

    const opens = await app.inject({
      method: 'GET',
      url: `/messages/outbound/${message.id}/opens`,
      headers: TOKEN_HEADER,
    })
    expect(opens.json().TotalCount).toBe(1)
    expect(opens.json().Opens[0].UserAgent).toBe('TestMailClient/1.0')

    const clicks = await app.inject({
      method: 'GET',
      url: `/messages/outbound/${message.id}/clicks`,
      headers: TOKEN_HEADER,
    })
    expect(clicks.json().TotalCount).toBe(1)
    expect(clicks.json().Clicks[0].OriginalLink).toBe('https://example.com/ziel')

    const invalid = await app.inject({
      method: 'GET',
      url: `/track/click/${message.id}?url=javascript:alert(1)`,
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('Webhook-Trigger akzeptieren Open/Click', async () => {
    const { app } = await setup()
    const created = await app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: TOKEN_HEADER,
      payload: {
        Url: 'https://hooks.example.com/x',
        Triggers: { Open: { Enabled: true }, Click: { Enabled: true } },
        Verify: false,
      },
    })
    expect(created.json().Triggers.Open.Enabled).toBe(true)
    expect(created.json().Triggers.Click.Enabled).toBe(true)
  })

  it('/stats/outbound liefert Tageswerte und Summen', async () => {
    const { app, store, serverId } = await setup()
    const message = await store.insertMessage(
      { from: 'a@b.de', to: ['c@d.de'], subject: 'x', textBody: 'x', trackOpens: true },
      serverId,
      'outbound',
    )
    await store.updateMessageStatus(message.id, 'sent', new Date())
    await store.recordTrackingEvent({ messageId: message.id, type: 'open' })
    await store.recordTrackingEvent({ messageId: message.id, type: 'click' })

    const today = new Date().toISOString().slice(0, 10)
    const stats = await app.inject({
      method: 'GET',
      url: `/stats/outbound?from=${today}&to=${today}`,
      headers: TOKEN_HEADER,
    })
    expect(stats.statusCode).toBe(200)
    expect(stats.json().Days).toHaveLength(1)
    expect(stats.json().Sent).toBe(1)
    expect(stats.json().Tracked).toBe(1)
    expect(stats.json().Opens).toBe(1)
    expect(stats.json().Clicks).toBe(1)
  })

  it('/email übernimmt TrackOpens/TrackLinks', async () => {
    const { app, store } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email',
      headers: TOKEN_HEADER,
      payload: emailBody({ HtmlBody: '<p>Hi</p>', TrackOpens: true, TrackLinks: 'HtmlAndText' }),
    })
    expect(res.json().ErrorCode).toBe(0)
    const message = await store.getMessage(res.json().MessageID)
    expect(message?.trackOpens).toBe(true)
    expect(message?.trackLinks).toBe('HtmlAndText')
  })
})
