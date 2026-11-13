import { describe, expect, it } from 'vitest'
import {
  applyLayout,
  deriveTextFromHtml,
  escapePostmark,
  renderPart,
  tokenize,
} from '../src/mustachio/render.js'

describe('Postmark-Escaping (nur & < > " \')', () => {
  it('escapes exactly the five Postmark characters', () => {
    expect(escapePostmark(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })

  it('does NOT escape > into &gt; twice or touch unicode', () => {
    expect(escapePostmark('ÄÖÜ ß €')).toBe('ÄÖÜ ß €')
  })
})

describe('Interpolation', () => {
  it('{{Var}} wird in HTML escaped', () => {
    const result = renderPart('Hello {{Name}}', { Name: '<b>Max</b>' }, true)
    expect(result.value).toBe('Hello &lt;b&gt;Max&lt;/b&gt;')
  })

  it('{{{Var}}} bleibt roh', () => {
    const result = renderPart('Hello {{{Name}}}', { Name: '<b>Max</b>' }, true)
    expect(result.value).toBe('Hello <b>Max</b>')
  })

  it('Subject/Text werden roh gerendert (nicht escaped)', () => {
    const result = renderPart('Rechnung & "Details" {{Nr}}', { Nr: '<2026>' }, false)
    expect(result.value).toBe('Rechnung & "Details" <2026>')
  })

  it('missing values render empty', () => {
    expect(renderPart('a{{x}}b', {}, true).value).toBe('ab')
  })
})

describe('each → Section-Übersetzung', () => {
  it('iteriert Items mit direktem Zugriff auf Properties', () => {
    const template = '{{#each Items}}{{Name}}, {{/each}}'
    const result = renderPart(template, { Items: [{ Name: 'A' }, { Name: 'B' }] }, true)
    expect(result.value).toBe('A, B, ')
  })

  it('leeres Array rendert nichts', () => {
    expect(renderPart('{{#each Items}}x{{/each}}', { Items: [] }, true).value).toBe('')
  })

  it('Parent-Refs mit ../../ (Bauplan: ../../-Parent-Refs)', () => {
    const template =
      '{{#each Orders}}{{#each Lines}}{{../../Customer}}: {{Product}}; {{/each}}{{/each}}'
    const result = renderPart(
      template,
      { Customer: 'Devolta', Orders: [{ Lines: [{ Product: 'Desk' }] }] },
      true,
    )
    expect(result.value).toBe('Devolta: Desk; ')
  })

  it('verschachtelte Felder via A.B', () => {
    expect(renderPart('{{User.Email}}', { User: { Email: 'a@b.de' } }, true).value).toBe('a@b.de')
  })
})

describe('Sektionen: if/unless/else', () => {
  it('#if truthy → rendert, falsy → rendert nichts', () => {
    expect(renderPart('{{#if Show}}yes{{/if}}', { Show: true }, true).value).toBe('yes')
    expect(renderPart('{{#if Show}}yes{{/if}}', { Show: false }, true).value).toBe('')
  })

  it('#else-Zweig bei falsy', () => {
    expect(
      renderPart('{{#if Premium}}Premium{{else}}Standard{{/if}}', { Premium: false }, true).value,
    ).toBe('Standard')
  })

  it('#unless invertiert', () => {
    expect(renderPart('{{#unless Flag}}hidden{{/unless}}', { Flag: true }, true).value).toBe('')
    expect(renderPart('{{#unless Flag}}hidden{{/unless}}', { Flag: false }, true).value).toBe(
      'hidden',
    )
  })
})

describe('Layouts mit {{{content}}}', () => {
  it('fügt den gerenderten Body ins Layout ein', () => {
    const layout = '<html><body>{{{content}}}</body></html>'
    const result = applyLayout(layout, '<h1>Hallo</h1>')
    expect(result.value).toBe('<html><body><h1>Hallo</h1></body></html>')
  })

  it('unterstützt auch {{@content}} (Bauplan: Layouts mit @content)', () => {
    const layout = '<div>{{@content}}</div>'
    expect(applyLayout(layout, 'x').value).toBe('<div>x</div>')
  })

  it('{{content}} (escaped) wird als Text eingefügt', () => {
    expect(applyLayout('<p>{{content}}</p>', '<b>').value).toBe('<p>&lt;b&gt;</p>')
  })
})

describe('Syntax-Fehler für /templates/validate', () => {
  it('unclosed section → Fehler mit Zeile', () => {
    const { errors } = tokenize('{{#each Items}}\ntext\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('Unclosed')
    expect(errors[0]?.line).toBe(1)
  })

  it('mismatched closing tag', () => {
    const { errors } = tokenize('{{#each Items}}x{{/each2}}')
    expect(errors[0]?.message).toContain('Mismatched')
  })

  it('unexpected closing tag', () => {
    const { errors } = tokenize('plain text {{/each}}')
    expect(errors[0]?.message).toContain('Unexpected closing tag')
  })
})

describe('HTML → Text-Ableitung', () => {
  it('wandelt Block-Tags in Zeilenumbrüche und stript Rest', () => {
    const html = '<h1>Rechnung</h1><p>Betrag: &euro; 100</p><p>Bitte zahlen.</p>'
    expect(deriveTextFromHtml(html)).toBe('Rechnung\nBetrag: &euro; 100\nBitte zahlen.')
  })

  it('entfernt style/script-Klötze', () => {
    expect(deriveTextFromHtml('<style>a{}</style><p>x</p>')).toBe('x')
  })
})
