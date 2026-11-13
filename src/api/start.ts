import { buildApp } from '../api/app.js'
import type { PostboteConfig } from '../config/env.js'
import { PostgresMessageStore } from '../core/postgres-store.js'
import { createDb } from '../db/client.js'
import { startSmtpIngress } from '../smtp/start.js'
import { registerJobHandlers } from '../worker/handlers.js'
import { PostgresJobQueue } from '../worker/queue.js'
import { SmtpMailSender } from '../worker/sender.js'

/** Start the API role: Fastify server backed by the Postgres store + queue. */
export async function startApi(config: PostboteConfig): Promise<void> {
  const { sql, db } = createDb(config)
  const store = new PostgresMessageStore(db)

  // In `all` mode the API process also runs the queue loop; with a separate
  // worker role, jobs simply wait in the table until the worker claims them.
  const queue = new PostgresJobQueue(sql, (msg) => console.log(`[worker] ${msg}`))
  registerJobHandlers(queue, {
    store,
    sender: new SmtpMailSender(),
    getRelay: (serverId, streamId) => store.getRelay(serverId, streamId),
  })
  // Only the combined `all` role claims jobs; in split deployments the API
  // process is a pure producer and the dedicated worker does the claiming.
  if (config.role === 'all') await queue.start()

  const app = await buildApp({
    store,
    version: '0.1.0',
    logLevel: config.logLevel,
    enqueue: (job) => void queue.enqueue(job),
  })

  await app.listen({ port: config.port, host: config.host })
  console.log(`postbote-api listening on ${config.host}:${config.port}`)

  // SMTP ingress only runs in the combined `all` role; split deployments use
  // POSTBOTE_ROLE=smtp (Bauplan §2). The worker role never starts listeners.
  const smtp =
    config.role === 'all'
      ? await startSmtpIngress(config, store, (job) => void queue.enqueue(job))
      : null

  const shutdown = async () => {
    await app.close()
    if (smtp !== null) await smtp.close()
    await queue.stop()
    await sql.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
