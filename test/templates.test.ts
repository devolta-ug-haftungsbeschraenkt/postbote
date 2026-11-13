import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/api/app.js'
import { MemoryMessageStore } from '../src/core/memory-store.js'

const TOKEN_HEADER = { 'x-postmark-server-token': 'tmpl-token' }

async function setup() {
  const store = new MemoryMessageStore()
  const server = await store.createServer('Templates', 'tmpl')
  await store.addToken(server.id, 'tmpl-token', 'primary')
  const app = await buildApp({ store, version: 'test' })
  return { app, store, serverId: server.id }
}

describe('Templates-CRUD', () => {
  it('creates and lists templates', async () => {
    const { app } = await setup()
    const created = await app.inject({
      method: 'POST',
      url: '/templates',
      headers: TOKEN_HEADER,
      payload: {
        Name: 'Rechnung',
        Alias: 'invoice',
        Subject: 'Rechnung {{Nr}}',
        HtmlBody: '<h1>Rechnung</h1>',
        TextBody: 'Rechnung {{Nr}}',
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().Alias).toBe('invoice')

    const list = await app.inject({ method: 'GET', url: '/templates', headers: TOKEN_HEADER })
    expect(list.json().TotalCount).toBe(1)
    expect(list.json().Templates[0].Name).toBe('Rechnung')
  })

  it('returns ErrorCode 1101 for unknown template', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'GET',
      url: '/templates/nope',
      headers: TOKEN_HEADER,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().ErrorCode).toBe(1101)
  })

  it('deletes a template', async () => {
    const { app } = await setup()
    await app.inject({
      method: 'POST',
      url: '/templates',
      headers: TOKEN_HEADER,
      payload: { Name: 'X', Subject: 'x', TextBody: 'x' },
    })
    const del = await app.inject({
      method: 'DELETE',
      url: '/templates/X',
      headers: TOKEN_HEADER,
    })
    expect(del.json().ErrorCode).toBe(0)
  })
})

describe('/templates/validate', () => {
  it('validates a clean template without errors', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/templates/validate',
      headers: TOKEN_HEADER,
      payload: { Subject: 'Hi {{Name}}', HtmlBody: '<b>{{Name}}</b>' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.Errors).toHaveLength(0)
    expect(body.Subject.Rendered).toBe('Hi ')
    expect(body.HtmlBody?.Rendered).toBe('<b></b>')
  })

  it('reports syntax errors (unclosed section)', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/templates/validate',
      headers: TOKEN_HEADER,
      payload: { Subject: 'ok', HtmlBody: '{{#each Items}}broken' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.Errors).toHaveLength(1)
    expect(body.Errors[0].Message).toContain('Unclosed')
  })
})

describe('POST /email/withTemplate', () => {
  async function templateSetup() {
    const ctx = await setup()
    await ctx.app.inject({
      method: 'POST',
      url: '/templates',
      headers: TOKEN_HEADER,
      payload: {
        Name: 'Willkommen',
        Alias: 'welcome',
        Subject: 'Willkommen bei {{Firma}}',
        HtmlBody: '<h1>Hallo {{Name}}</h1>',
      },
    })
    return ctx
  }

  it('renders subject (raw) and html (escaped) and returns MessageID', async () => {
    const { app, store } = await templateSetup()
    const res = await app.inject({
      method: 'POST',
      url: '/email/withTemplate',
      headers: TOKEN_HEADER,
      payload: {
        TemplateAlias: 'welcome',
        TemplateModel: { Firma: 'Devolta & Co', Name: '<b>Max</b>' },
        From: 'no-reply@devolta.de',
        To: 'max@devolta.de',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ErrorCode).toBe(0)
    expect(body.MessageID).toMatch(/^[0-9a-f-]{36}$/)

    // Content check via message store: subject raw, html escaped.
    const message = await store.getMessage(body.MessageID)
    expect(message?.subject).toBe('Willkommen bei Devolta & Co')
    expect(message?.htmlBody).toBe('<h1>Hallo &lt;b&gt;Max&lt;/b&gt;</h1>')
  })

  it('derives TextBody from HTML when the template has none', async () => {
    const { app, store } = await templateSetup()
    const res = await app.inject({
      method: 'POST',
      url: '/email/withTemplate',
      headers: TOKEN_HEADER,
      payload: {
        TemplateAlias: 'welcome',
        TemplateModel: { Firma: 'X', Name: 'Max' },
        From: 'no-reply@devolta.de',
        To: 'max@devolta.de',
      },
    })
    const message = await store.getMessage(res.json().MessageID)
    expect(message?.textBody).toBe('Hallo Max')
  })

  it('unknown template → ErrorCode 1101', async () => {
    const { app } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email/withTemplate',
      headers: TOKEN_HEADER,
      payload: {
        TemplateAlias: 'missing',
        From: 'a@b.de',
        To: 'c@d.de',
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().ErrorCode).toBe(1101)
  })

  it('sandbox works with POSTMARK_API_TEST (no persistence)', async () => {
    const { app, store } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/email/withTemplate',
      headers: { 'x-postmark-server-token': 'POSTMARK_API_TEST' },
      payload: {
        TemplateAlias: 'anything',
        From: 'a@b.de',
        To: 'c@d.de',
      },
    })
    // Sandbox without a stored template also errors 1101 — template lookup is
    // per-token server and the sandbox has none.
    expect(res.json().ErrorCode).toBe(1101)
    expect(store.messages).toHaveLength(0)
  })
})

describe('POST /email/batchWithTemplates', () => {
  it('returns per-item results with HTTP 200', async () => {
    const { app } = await setup()
    await app.inject({
      method: 'POST',
      url: '/templates',
      headers: TOKEN_HEADER,
      payload: { Name: 'T', Alias: 't', Subject: 's', TextBody: 'body' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/email/batchWithTemplates',
      headers: TOKEN_HEADER,
      payload: {
        Messages: [
          { TemplateAlias: 't', TemplateModel: {}, From: 'a@b.de', To: 'c@d.de' },
          { TemplateAlias: 'missing', From: 'a@b.de', To: 'c@d.de' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const results = res.json()
    expect(results[0].ErrorCode).toBe(0)
    expect(results[1].ErrorCode).toBe(1101)
  })
})
