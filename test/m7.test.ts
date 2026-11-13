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

describe('app01-Realformate (POSTBOTE_TOKENS + Verzeichnis-Templates)', () => {
  it('tokens.env als POSTBOTE_TOKENS-JSON inkl. allowedFrom/logto', () => {
    const env = parseEnvFile(
      `POSTBOTE_TOKENS=${JSON.stringify({
        pb_aar_abc: { name: 'aar', allowedFrom: ['*@aar.de'] },
        pb_logto_xyz: {
          name: 'logto-devolta',
          allowedFrom: ['office@devolta.de'],
          logto: { from: 'devolta <office@devolta.de>', templates: { SignIn: 'logto-sign-in' } },
        },
      })}`,
    )
    const plan = tokenPlan(env)
    expect(plan).toHaveLength(2)
    const logto = plan.find((e) => e.name === 'logto-devolta')
    expect(logto?.allowedFrom).toEqual(['office@devolta.de'])
    expect(logto?.logtoConfig).toEqual({
      from: 'devolta <office@devolta.de>',
      templates: { SignIn: 'logto-sign-in' },
    })
  })

  it('Discovery: <alias>/body.html + subject.txt + layout.txt und _layouts/basic', () => {
    const manifest = discoverTemplates([
      '_layouts/basic/body.html',
      'logto-sign-in/body.html',
      'logto-sign-in/body.txt',
      'logto-sign-in/subject.txt',
      'logto-sign-in/layout.txt',
      'lead-new-de/body.html',
    ])
    expect(manifest.layouts?.map((l) => l.alias)).toEqual(['basic'])
    expect(manifest.layouts?.[0]?.htmlFile).toBe('_layouts/basic/body.html')
    expect(manifest.templates?.map((t) => t.alias).sort()).toEqual(['lead-new-de', 'logto-sign-in'])
    const signIn = manifest.templates?.find((t) => t.alias === 'logto-sign-in')
    expect(signIn).toMatchObject({
      htmlFile: 'logto-sign-in/body.html',
      textFile: 'logto-sign-in/body.txt',
      subjectFile: 'logto-sign-in/subject.txt',
      layoutFile: 'logto-sign-in/layout.txt',
    })
  })

  it('relayPlan nutzt Fallback-Host/Port, wenn smtp.env sie nicht enthält', () => {
    expect(
      relayPlan({ SMTP_USER: 'u', SMTP_PASS: 'p' }, { host: 'mail.devolta.de', port: '587' }),
    ).toMatchObject({ host: 'mail.devolta.de', port: 587 })
  })
})
