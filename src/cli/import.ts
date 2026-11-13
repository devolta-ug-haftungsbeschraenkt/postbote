import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { loadConfig } from '../config/env.js'
import { hashToken } from '../core/store.js'
import { createDb } from '../db/client.js'
import {
  layouts as layoutsTable,
  relayConfigs,
  serverTokens,
  templates as templatesTable,
} from '../db/schema.js'
import {
  type LayoutSpec,
  type TemplateManifest,
  type TemplateSpec,
  discoverTemplates,
  parseEnvFile,
  parseManifest,
  relayPlan,
  tokenPlan,
} from './import-lib.js'

/**
 * app01 import scripts (Bauplan §6 / M7). Runs inside the postbote container:
 *
 *   node dist/cli/import.js all /opt/postbote            # dry-run
 *   node dist/cli/import.js all /opt/postbote --apply    # write to DB
 *   node dist/cli/import.js tokens /opt/postbote/tokens.env [slug] --apply
 *   node dist/cli/import.js relay  /opt/postbote/smtp.env [slug] [stream] --apply
 *   node dist/cli/import.js templates /opt/postbote/templates [slug] --apply
 *
 * All writes are idempotent upserts; secrets are never printed.
 */
const USAGE = `Usage:
  node dist/cli/import.js all <dir> [slug] [--apply]
  node dist/cli/import.js tokens <tokens.env> [slug] [--apply] [--only <name>]
  node dist/cli/import.js relay <smtp.env> [slug] [stream] [--apply]
  node dist/cli/import.js templates <dir-or-manifest.json> [slug] [--apply]

Default is a DRY RUN — use --apply to write. Slug default: default.`

function safeJoin(dir: string, file: string): string {
  const target = resolve(dir, file)
  if (!target.startsWith(`${resolve(dir)}/`) && target !== resolve(dir)) {
    throw new Error(`path escapes template directory: ${file}`)
  }
  return target
}

function readOptional(dir: string, file: string | undefined): string | undefined {
  return file === undefined ? undefined : readFileSync(safeJoin(dir, file), 'utf8')
}

function listTemplateFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() && entry.name === 'layouts') {
      for (const sub of readdirSync(full, { withFileTypes: true })) {
        if (sub.isFile()) out.push(relative(dir, join(full, sub.name)))
      }
    } else if (entry.isFile()) {
      out.push(relative(dir, full))
    }
  }
  return out
}

function loadManifest(source: string): { manifest: TemplateManifest; dir: string } {
  if (statSync(source).isDirectory()) {
    const manifestPath = join(source, 'manifest.json')
    const dir = source
    return {
      dir,
      manifest: existsSync(manifestPath)
        ? parseManifest(readFileSync(manifestPath, 'utf8'))
        : discoverTemplates(listTemplateFiles(source)),
    }
  }
  return { dir: resolve(source, '..'), manifest: parseManifest(readFileSync(source, 'utf8')) }
}

function resolveLayout(spec: LayoutSpec, dir: string) {
  return {
    alias: spec.alias,
    name: spec.name,
    htmlBody: spec.htmlBody ?? readOptional(dir, spec.htmlFile) ?? '',
    textBody: spec.textBody ?? readOptional(dir, spec.textFile),
  }
}

function resolveTemplate(spec: TemplateSpec, dir: string) {
  return {
    alias: spec.alias,
    name: spec.name,
    subject: spec.subjectFile
      ? (readOptional(dir, spec.subjectFile) ?? spec.subject).trim()
      : spec.subject,
    htmlBody: spec.htmlBody ?? readOptional(dir, spec.htmlFile),
    textBody: spec.textBody ?? readOptional(dir, spec.textFile),
    layoutAlias: spec.layoutAlias,
  }
}

interface Args {
  command: string
  positional: string[]
  apply: boolean
  only?: string
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply')
  const onlyIndex = argv.indexOf('--only')
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined
  const filtered = argv.filter(
    (arg, i) => arg !== '--apply' && arg !== '--only' && !(onlyIndex >= 0 && i === onlyIndex + 1),
  )
  const [command, ...positional] = filtered
  if (!command || command === '--help' || command === '-h')
    return { command: '--help', positional: [], apply }
  return { command, positional, apply, ...(only !== undefined && { only }) }
}

async function serverIdFromSlug(
  sql: ReturnType<typeof createDb>['sql'],
  slug: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from servers where slug = ${slug} limit 1`
  const id = rows[0]?.id
  if (!id) throw new Error(`no server with slug "${slug}" — run migrations first`)
  return id
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === '--help') {
    console.log(USAGE)
    return
  }
  const { sql, db } = createDb(loadConfig())

  try {
    const commands = args.command === 'all' ? ['tokens', 'relay', 'templates'] : [args.command]
    for (const command of commands) {
      if (command === 'tokens') {
        const [fileArg, slugArg] = args.positional
        const file = args.command === 'all' ? join(fileArg ?? '.', 'tokens.env') : (fileArg ?? '')
        if (!file || !existsSync(file)) throw new Error(`tokens file not found: ${file}`)
        const slug = slugArg ?? 'default'
        const plan = tokenPlan(parseEnvFile(readFileSync(file, 'utf8')), {
          ...(args.only !== undefined && { only: args.only }),
        })
        console.log(`tokens: ${plan.length} entries from ${file} (server ${slug})`)
        for (const entry of plan) {
          console.log(
            `  ${entry.name}: <redacted> (${entry.token.length} chars) → hash ${hashToken(entry.token).slice(0, 12)}…`,
          )
        }
        if (!args.apply) continue
        const serverId = await serverIdFromSlug(sql, slug)
        const inserted = await db
          .insert(serverTokens)
          .values(
            plan.map((entry) => ({
              serverId,
              tokenHash: hashToken(entry.token),
              name: entry.name,
            })),
          )
          .onConflictDoNothing({ target: serverTokens.tokenHash })
          .returning({ id: serverTokens.id })
        console.log(`  applied: ${inserted.length} new token(s)`)
        continue
      }

      if (command === 'relay') {
        const [fileArg, slugArg, streamArg] = args.positional
        const file = args.command === 'all' ? join(fileArg ?? '.', 'smtp.env') : (fileArg ?? '')
        if (!file || !existsSync(file)) throw new Error(`relay file not found: ${file}`)
        const slug = args.command === 'all' ? 'default' : (slugArg ?? 'default')
        const stream = args.command === 'all' ? 'outbound' : (streamArg ?? 'outbound')
        const plan = relayPlan(parseEnvFile(readFileSync(file, 'utf8')))
        console.log(
          `relay: ${plan.host}:${plan.port} (${plan.tlsMode}) user <redacted> for ${slug}/${stream}`,
        )
        if (!args.apply) continue
        const serverId = await serverIdFromSlug(sql, slug)
        await db
          .insert(relayConfigs)
          .values({
            serverId,
            streamId: stream,
            host: plan.host,
            port: plan.port,
            username: plan.username,
            passwordEncrypted: plan.password,
            tlsMode: plan.tlsMode,
          })
          .onConflictDoUpdate({
            target: [relayConfigs.serverId, relayConfigs.streamId],
            set: {
              host: plan.host,
              port: plan.port,
              username: plan.username,
              passwordEncrypted: plan.password,
              tlsMode: plan.tlsMode,
            },
          })
        console.log('  applied')
        continue
      }

      if (command === 'templates') {
        const [sourceArg, slugArg] = args.positional
        const source =
          args.command === 'all' ? join(sourceArg ?? '.', 'templates') : (sourceArg ?? '')
        if (!source || !existsSync(source)) throw new Error(`template source not found: ${source}`)
        const slug = args.command === 'all' ? 'default' : (slugArg ?? 'default')
        const { manifest, dir } = loadManifest(source)
        const layoutRows = (manifest.layouts ?? []).map((spec) => resolveLayout(spec, dir))
        const templateRows = (manifest.templates ?? []).map((spec) => resolveTemplate(spec, dir))
        console.log(
          `templates: ${layoutRows.length} layouts, ${templateRows.length} templates from ${source} (server ${slug})`,
        )
        for (const row of layoutRows)
          console.log(`  layout  ${row.alias} (${row.htmlBody.length} chars html)`)
        for (const row of templateRows) {
          console.log(
            `  template ${row.alias} subject="${row.subject}" html=${row.htmlBody?.length ?? 0} text=${row.textBody?.length ?? 0}${row.layoutAlias ? ` layout=${row.layoutAlias}` : ''}`,
          )
        }
        if (!args.apply) continue
        const serverId = await serverIdFromSlug(sql, slug)
        for (const row of layoutRows) {
          await db
            .insert(layoutsTable)
            .values({
              serverId,
              alias: row.alias,
              name: row.name,
              htmlBody: row.htmlBody,
              ...(row.textBody !== undefined && { textBody: row.textBody }),
            })
            .onConflictDoUpdate({
              target: [layoutsTable.serverId, layoutsTable.alias],
              set: {
                name: row.name,
                htmlBody: row.htmlBody,
                ...(row.textBody !== undefined && { textBody: row.textBody }),
              },
            })
        }
        for (const row of templateRows) {
          await db
            .insert(templatesTable)
            .values({
              serverId,
              alias: row.alias,
              name: row.name,
              subject: row.subject,
              ...(row.htmlBody !== undefined && { htmlBody: row.htmlBody }),
              ...(row.textBody !== undefined && { textBody: row.textBody }),
              ...(row.layoutAlias !== undefined && { layoutAlias: row.layoutAlias }),
            })
            .onConflictDoUpdate({
              target: [templatesTable.serverId, templatesTable.alias],
              set: {
                name: row.name,
                subject: row.subject,
                ...(row.htmlBody !== undefined && { htmlBody: row.htmlBody }),
                ...(row.textBody !== undefined && { textBody: row.textBody }),
                ...(row.layoutAlias !== undefined && { layoutAlias: row.layoutAlias }),
              },
            })
        }
        console.log(`  applied: ${layoutRows.length} layouts, ${templateRows.length} templates`)
        continue
      }

      throw new Error(`unknown command: ${command}`)
    }
    if (!args.apply) console.log('\nDRY RUN — nothing was written. Add --apply to import.')
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  console.log(USAGE)
  process.exit(1)
})
