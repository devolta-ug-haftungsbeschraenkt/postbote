import { describe, expect, it } from 'vitest'
import { renderTemplate } from '../src/api/render-template.js'
import { MemoryMessageStore } from '../src/core/memory-store.js'
import { applyLayout, renderPart } from '../src/mustachio/render.js'

/** Vereinfachtes Abbild von app01/templates/_layouts/basic/body.html. */
const APP01_LAYOUT = `KOPF
{{#application}} {{#branding}} {{#logoUrl}} IMG:{{{.}}} | {{../../name}} {{/logoUrl}} {{^logoUrl}} Bild {{/logoUrl}} {{/branding}} {{^branding}} Bild {{/branding}} {{/application}} {{^application}} Bild {{/application}}
{{{ @content }}}
FUSS {{#application}} {{name}} {{/application}} {{^application}} Bild {{/application}}`

const SIGN_IN_BODY = '<p>Dein Anmeldecode fuer {{application.name}}</p><p>{{code}}</p>'

async function setup() {
  const store = new MemoryMessageStore()
  const server = await store.createServer('Layout', 'layout')
  await store.upsertLayout(server.id, {
    alias: 'basic',
    name: 'Basic',
    htmlBody: APP01_LAYOUT,
  })
  const template = await store.upsertTemplate(server.id, {
    alias: 'logto-sign-in',
    name: 'Sign In',
    subject: 'Anmeldecode fuer {{application.name}}',
    htmlBody: SIGN_IN_BODY,
    layoutAlias: 'basic',
  })
  return { store, serverId: server.id, template }
}

describe('Layout-Rendering (app01-Vorfall: rohe Mustache-Tags in Mails)', () => {
  it('rendert das Layout selbst: keine {{...}} Tags bleiben übrig', async () => {
    const { store, serverId, template } = await setup()
    const rendered = await renderTemplate(store, serverId, template, {
      application: {
        name: 'devolta Desk',
        branding: { logoUrl: 'https://cdn.example.com/logo.png' },
      },
      code: '954538',
    })

    expect(rendered.errors).toEqual([])
    expect(rendered.subject).toBe('Anmeldecode fuer devolta Desk')
    expect(rendered.htmlBody).not.toContain('{{')
    expect(rendered.htmlBody).not.toContain('}}')
    expect(rendered.htmlBody).toContain('IMG:https://cdn.example.com/logo.png')
    expect(rendered.htmlBody).toContain('devolta Desk')
    expect(rendered.htmlBody).toContain('954538')
    expect(rendered.htmlBody).toContain('Dein Anmeldecode fuer devolta Desk')
    // Abgeleiteter Text darf ebenfalls keine rohen Tags enthalten.
    expect(rendered.textBody).not.toContain('{{')
    expect(rendered.textBody).toContain('954538')
  })

  it('^invertierte Sektionen greifen, wenn application/branding fehlen', async () => {
    const { store, serverId, template } = await setup()
    const rendered = await renderTemplate(store, serverId, template, { code: '111111' })
    expect(rendered.errors).toEqual([])
    expect(rendered.htmlBody).not.toContain('{{')
    expect(rendered.htmlBody).toContain('Bild')
    expect(rendered.htmlBody).toContain('111111')
    expect(rendered.htmlBody).not.toContain('IMG:')
  })

  it('applyLayout: Content wird nicht ein zweites Mal gerendert', () => {
    const content = '<p>{{code}}</p>'
    const result = applyLayout('<div>{{{ @content }}}</div>', content, { code: '999' })
    expect(result.value).toBe('<div><p>{{code}}</p></div>')
  })

  it('applyLayout: escaped content bei {{content}}', () => {
    expect(applyLayout('<p>{{content}}</p>', '<b>').value).toBe('<p>&lt;b&gt;</p>')
    expect(applyLayout('<div>{{@content}}</div>', 'x').value).toBe('<div>x</div>')
  })

  it('{{{.}}} und ../../name innerhalb generischer Sektionen', () => {
    const source =
      '{{#application}}{{#branding}}{{#logoUrl}}[{{{.}}}|{{../../name}}]{{/logoUrl}}{{/branding}}{{/application}}'
    const model = { application: { name: 'Desk', branding: { logoUrl: 'URL' } } }
    expect(renderPart(source, model, false).value).toBe('[URL|Desk]')
  })
})
