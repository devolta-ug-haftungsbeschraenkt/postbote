import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { loadConfig } from '../config/env.js'
import { PostgresMessageStore } from '../core/postgres-store.js'
import { createDb } from './client.js'
import { serverTokens, streams } from './schema.js'

/**
 * One-shot DB bootstrap (Bauplan §5): applies generated drizzle migrations and,
 * only on a completely empty database, creates the default server, the
 * `outbound` stream and the first API token from POSTBOTE_BOOTSTRAP_TOKEN.
 * Idempotent — safe to run on every deploy.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const { sql, db } = createDb(config)

  try {
    await migrate(db, { migrationsFolder: process.env.POSTBOTE_MIGRATIONS_DIR ?? 'migrations' })
    console.log('migrations applied')

    const existing = await db.select({ id: serverTokens.id }).from(serverTokens).limit(1)
    if (existing.length === 0) {
      const store = new PostgresMessageStore(db)
      const server = await store.createServer('Default', 'default')
      await store.addToken(server.id, config.bootstrapToken, 'bootstrap token')
      await db
        .insert(streams)
        .values({ id: 'outbound', serverId: server.id, name: 'Outbound' })
        .onConflictDoNothing()
      console.log(`bootstrap token created: ${config.bootstrapToken}`)
    } else {
      console.log('bootstrap skipped: tokens already exist')
    }
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
