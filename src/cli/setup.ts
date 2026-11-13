import { loadConfig } from '../config/env.js'
import { PostgresMessageStore } from '../core/postgres-store.js'
import { createDb } from '../db/client.js'
import { relayConfigs } from '../db/schema.js'

/**
 * postbote setup CLI (runs inside the container with plain `node`):
 *
 *   node dist/cli/setup.js create-smtp-credential [slug] [stream]
 *   node dist/cli/setup.js set-relay <host> <port> <user> <pass> [tlsMode] [slug] [stream]
 *
 * Secrets (SMTP secret key, relay password) are printed/entered once and only
 * hashes / at-rest values are persisted. See docs/COMPOSE.md.
 */
const USAGE = `Usage:
  node dist/cli/setup.js create-smtp-credential [slug] [stream]
  node dist/cli/setup.js set-relay <host> <port> <user> <pass> [tlsMode] [slug] [stream]

Defaults: slug=default, stream=outbound, tlsMode=starttls
tlsMode: starttls | implicit | none`

async function resolveServerId(
  sql: ReturnType<typeof createDb>['sql'],
  slug: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from servers where slug = ${slug} limit 1`
  const id = rows[0]?.id
  if (!id) throw new Error(`no server with slug "${slug}" — run migrations first`)
  return id
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }

  const config = loadConfig()
  const { sql, db } = createDb(config)

  try {
    if (command === 'create-smtp-credential') {
      const slug = args[0] ?? 'default'
      const stream = args[1] ?? 'outbound'
      const serverId = await resolveServerId(sql, slug)
      const store = new PostgresMessageStore(db)
      const cred = await store.createSmtpCredential(serverId, stream)
      console.log('SMTP credential created (secret shown once, store it now):')
      console.log(`  username / access key : ${cred.accessKey}`)
      console.log(`  password / secret key : ${cred.secretKey}`)
      console.log(`  server                : ${slug} (${serverId})`)
      console.log(`  stream                : ${stream}`)
      return
    }

    if (command === 'set-relay') {
      const [host, portArg, username, password, tlsModeArg, slugArg, streamArg] = args
      if (!host || !portArg || !username || !password) {
        throw new Error('set-relay requires <host> <port> <user> <pass>')
      }
      const port = Number.parseInt(portArg, 10)
      if (!Number.isFinite(port) || port <= 0) throw new Error(`invalid port: ${portArg}`)
      const tlsMode = tlsModeArg ?? 'starttls'
      if (!['starttls', 'implicit', 'none'].includes(tlsMode)) {
        throw new Error(`invalid tlsMode: ${tlsMode}`)
      }
      const slug = slugArg ?? 'default'
      const stream = streamArg ?? 'outbound'
      const serverId = await resolveServerId(sql, slug)

      const values = {
        serverId,
        streamId: stream,
        host,
        port,
        username,
        passwordEncrypted: password,
        tlsMode,
      }
      await db
        .insert(relayConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: [relayConfigs.serverId, relayConfigs.streamId],
          set: {
            host,
            port,
            username,
            passwordEncrypted: password,
            tlsMode,
          },
        })
      console.log(`relay configured: ${host}:${port} (${tlsMode}) for ${slug}/${stream}`)
      return
    }

    throw new Error(`unknown command: ${command}`)
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  console.log(USAGE)
  process.exit(1)
})
