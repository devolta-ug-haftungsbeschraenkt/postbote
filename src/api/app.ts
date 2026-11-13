import cors from '@fastify/cors'
import Fastify from 'fastify'
import { MemoryMessageStore } from '../core/memory-store.js'
import type { MessageStore } from '../core/store.js'
import { registerBounceRoutes } from './routes/bounces.js'
import { registerEmailRoutes } from './routes/email.js'
import { registerQueryRoutes } from './routes/query.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerStreamRoutes } from './routes/streams.js'
import { registerSuppressionRoutes } from './routes/suppressions.js'
import { registerTemplateRoutes } from './routes/templates.js'
import { registerTrackingRoutes } from './routes/tracking.js'
import { registerWebhookRoutes } from './routes/webhooks.js'

export interface PostboteAppOptions {
  store?: MessageStore
  version?: string
  logLevel?: string
  /** Queue producer; overridden by the worker wiring in production. */
  enqueue?: (job: { type: string; payload: Record<string, unknown> }) => void
}

export interface PostboteApp {
  postbote: {
    store: MessageStore
    version: string
    enqueue: (job: { type: string; payload: Record<string, unknown> }) => void
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    postbote: {
      store: MessageStore
      version: string
      enqueue: (job: { type: string; payload: Record<string, unknown> }) => void
    }
  }
}

/**
 * Fastify app with Postmark-compatible routing. The store is injected so the
 * same routes serve Postgres (production) and the in-memory store (tests).
 */
export async function buildApp(options: PostboteAppOptions = {}) {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'warn' },
    // Postmark payload limits: 10 MB per mail, 50 MB per batch payload.
    bodyLimit: 52_428_800,
  })

  app.decorate('postbote', {
    store: options.store ?? new MemoryMessageStore(),
    version: options.version ?? '0.1.0',
    enqueue:
      options.enqueue ??
      ((_job: { type: string; payload: Record<string, unknown> }) => {
        // No worker attached (e.g. POSTBOTE_ROLE=api without queue) — jobs are dropped.
      }),
  })

  app.addHook('onRequest', async (_request, reply) => {
    // Postmark always speaks JSON.
    reply.header('Content-Type', 'application/json; charset=utf-8')
  })

  // The Admin-UI (Vite dev server) talks to the API cross-origin; Postmark
  // clients are server-side and don't need CORS, so this is dev-friendly only.
  await app.register(cors, { origin: true })

  registerEmailRoutes(app)
  registerQueryRoutes(app)
  registerTemplateRoutes(app)
  registerBounceRoutes(app)
  registerWebhookRoutes(app)
  registerStreamRoutes(app)
  registerSuppressionRoutes(app)
  registerStatsRoutes(app)
  registerTrackingRoutes(app)

  return app
}
