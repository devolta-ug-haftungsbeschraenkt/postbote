import { buildApp } from './api/app.js'
import { loadConfig } from './config/env.js'
import { MemoryMessageStore } from './core/memory-store.js'
import { startSmtpIngress } from './smtp/start.js'
import { registerJobHandlers } from './worker/handlers.js'
import { MemoryJobQueue } from './worker/queue.js'
import { SmtpMailSender } from './worker/sender.js'

/**
 * Entry point. Roles: `POSTBOTE_ROLE=api|worker|smtp|all` (Bauplan §2).
 * Without a reachable Postgres the API starts in demo mode (in-memory store),
 * so `npm run dev` works out of the box and the Admin-UI has data to talk to.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const demo = process.env.POSTBOTE_DEMO === '1' || process.env.POSTBOTE_DEMO === 'true'

  if (demo || config.role === 'api' || config.role === 'all') {
    if (demo) {
      const store = new MemoryMessageStore()
      const server = await store.createServer('Devolta Demo', 'devolta')
      await store.addToken(server.id, 'postbote-demo-token', 'demo token')
      const smtpCred = await store.createSmtpCredential(server.id, 'outbound', {
        accessKey: 'postbote-demo-smtp',
        secretKey: 'postbote-demo-smtp-secret',
      })

      // Demo relay: sends are accepted and "delivered" instantly by the worker
      // (SmtpMailSender returns 250 when no relay is configured).
      const queue = new MemoryJobQueue((msg) => console.log(`[worker] ${msg}`))
      registerJobHandlers(queue, {
        store,
        sender: new SmtpMailSender(),
        getRelay: () => Promise.resolve(null),
      })
      await queue.start()
      const enqueue = (job: { type: string; payload: Record<string, unknown> }) =>
        void queue.enqueue(job)

      console.log('postbote starting in demo mode (in-memory store + queue)')
      console.log('demo token: postbote-demo-token (use as X-Postmark-Server-Token)')
      console.log(`demo smtp: user ${smtpCred.accessKey} / pass ${smtpCred.secretKey}`)

      const app = await buildApp({ store, version: '0.1.0', logLevel: config.logLevel, enqueue })
      await app.listen({ port: config.port, host: config.host })
      console.log(`postbote-api (demo) listening on ${config.host}:${config.port}`)

      const smtp = await startSmtpIngress(config, store, enqueue)
      console.log(`smtp ports: ${smtp.ports.join(', ')}`)

      const shutdown = async () => {
        await app.close()
        await smtp.close()
        await queue.stop()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      return
    }

    if (config.role === 'api' || config.role === 'all') {
      await (await import('./api/start.js')).startApi(config)
      return
    }
  }

  if (config.role === 'worker') {
    await (await import('./worker/start.js')).startWorker(config)
    return
  }

  if (config.role === 'smtp') {
    // Dedicated SMTP-ingress role: Postgres store + queue producer, no HTTP API.
    const { createDb } = await import('./db/client.js')
    const { PostgresMessageStore } = await import('./core/postgres-store.js')
    const { PostgresJobQueue } = await import('./worker/queue.js')
    const { sql, db } = createDb(config)
    const store = new PostgresMessageStore(db)
    const queue = new PostgresJobQueue(sql, (msg) => console.log(`[worker] ${msg}`))
    const smtp = await startSmtpIngress(config, store, (job) => void queue.enqueue(job))
    console.log(`postbote-smtp listening on ports ${smtp.ports.join(', ')}`)

    const shutdown = async () => {
      await smtp.close()
      await queue.stop()
      await sql.end()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
