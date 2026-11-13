import type { PostboteConfig } from '../config/env.js'
import { PostgresMessageStore } from '../core/postgres-store.js'
import { registerJobHandlers } from './handlers.js'
import { PostgresJobQueue } from './queue.js'
import { SmtpMailSender } from './sender.js'

/** Start the worker role: claims jobs from Postgres and sends via upstream SMTP. */
export async function startWorker(config: PostboteConfig): Promise<void> {
  const { sql, db } = (await import('../db/client.js')).createDb(config)
  const store = new PostgresMessageStore(db)
  const queue = new PostgresJobQueue(sql, (msg) => console.log(`[worker] ${msg}`))
  const sender = new SmtpMailSender()

  registerJobHandlers(queue, {
    store,
    sender,
    getRelay: (serverId, streamId) => store.getRelay(serverId, streamId),
  })

  await queue.start()
  console.log('[worker] started (Postgres queue, SKIP LOCKED)')

  const shutdown = async () => {
    await queue.stop()
    await sql.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
