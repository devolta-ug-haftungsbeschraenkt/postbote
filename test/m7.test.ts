import { describe, expect, it } from 'vitest'
import {
  discoverTemplates,
  parseEnvFile,
  parseManifest,
  relayPlan,
  tokenPlan,
} from '../src/cli/import-lib.js'

describe('app01 Import: parseEnvFile', () => {
  it('ignoriert Kommentare/Leerzeilen, strippt Quotes und export', () => {
    const env = parseEnvFile(`
# Kommentar
export LOGI_TOKEN="abc=123"
SIMPLE='secret#with-hash'
EMPTY=
  SPACED = value  
`)
    expect(env).toEqual({
      LOGI_TOKEN: 'abc=123',
      SIMPLE: 'secret#with-hash',
      EMPTY: '',
      SPACED: 'value',
    })
  })
})

describe('app01 Import: tokenPlan', () => {
  it('sortiert, filtert leere Werte und erlaubt --only', () => {
    const env = { Z_TOKEN: 'z', A_TOKEN: 'a', EMPTY: '' }
    expect(tokenPlan(env).map((e) => e.name)).toEqual(['A_TOKEN', 'Z_TOKEN'])
    expect(tokenPlan(env, { only: 'a_' }).map((e) => e.name)).toEqual(['A_TOKEN'])
  })
})

describe('app01 Import: relayPlan (smtp.env)', () => {
  it('mappt die üblichen Key-Varianten', () => {
    expect(
      relayPlan({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '465',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        TLS_MODE: 'implicit',
      }),
    ).toEqual({
      host: 'smtp.example.com',
      port: 465,
      username: 'user',
      password: 'pass',
      tlsMode: 'implicit',
    })
    expect(relayPlan({ HOST: 'h', USER: 'u', PASS: 'p' })).toMatchObject({
      host: 'h',
      port: 587,
      tlsMode: 'starttls',
    })
  })

  it('weist fehlende/ungültige Werte ab', () => {
    expect(() => relayPlan({ SMTP_USER: 'u', SMTP_PASS: 'p' })).toThrow(/host/)
    expect(() => relayPlan({ HOST: 'h', SMTP_PORT: 'nope', USER: 'u', PASS: 'p' })).toThrow(/port/)
    expect(() => relayPlan({ HOST: 'h', USER: 'u', PASS: 'p', TLS_MODE: 'bogus' })).toThrow(
      /TLS_MODE/,
    )
  })
})

describe('app01 Import: Template-Manifest & Discovery', () => {
  it('parst Manifest mit Inline-Bodies und File-Referenzen', () => {
    const manifest = parseManifest(
      JSON.stringify({
        layouts: [{ alias: 'base', name: 'Base', htmlBody: '<html>{{{content}}}</html>' }],
        templates: [
          {
            alias: 'welcome',
            subject: 'Willkommen {{name}}',
            htmlFile: 'welcome.html',
            textFile: 'welcome.txt',
            layoutAlias: 'base',
          },
        ],
      }),
    )
    expect(manifest.layouts?.[0]?.htmlBody).toContain('{{{content}}}')
    expect(manifest.templates?.[0]).toMatchObject({
      alias: 'welcome',
      htmlFile: 'welcome.html',
      layoutAlias: 'base',
    })
  })

  it('lehnt ungültige Manifeste ab', () => {
    expect(() => parseManifest('not-json')).toThrow()
    expect(() => parseManifest('{"templates":[{"name":"x"}]}')).toThrow(/alias/)
  })

  it('Discovery: layouts/, html/txt/subject-Paare', () => {
    const manifest = discoverTemplates([
      'layouts/base.html',
      'layouts/base.txt',
      'welcome.html',
      'welcome.txt',
      'welcome.subject.txt',
      'manifest.json',
    ])
    expect(manifest.layouts?.map((l) => l.alias)).toEqual(['base'])
    expect(manifest.layouts?.[0]).toMatchObject({
      htmlFile: 'layouts/base.html',
      textFile: 'layouts/base.txt',
    })
    expect(manifest.templates?.map((t) => t.alias)).toEqual(['welcome'])
    expect(manifest.templates?.[0]).toMatchObject({
      htmlFile: 'welcome.html',
      textFile: 'welcome.txt',
      subjectFile: 'welcome.subject.txt',
    })
  })
})
