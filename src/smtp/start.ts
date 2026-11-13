import { readFileSync } from 'node:fs'
import type { PostboteConfig } from '../config/env.js'
import type { MessageStore } from '../core/store.js'
import { createSmtpIngress } from './server.js'

export interface SmtpIngressHandle {
  ports: number[]
  close: () => Promise<void>
}

/**
 * Start the SMTP ingress listeners (Bauplan M5): AUTH PLAIN/LOGIN with
 * access/secret credentials, messages flow into store + queue exactly like
 * HTTP-accepted ones. STARTTLS is advertised when key/cert are configured.
 */
export async function startSmtpIngress(
  config: PostboteConfig,
  store: MessageStore,
  enqueue: (job: { type: string; payload: Record<string, unknown> }) => void,
  log: (msg: string) => void = (msg) => console.log(msg),
): Promise<SmtpIngressHandle> {
  const tls =
    config.smtpTlsKey && config.smtpTlsCert
      ? {
          key: readFileSync(config.smtpTlsKey, 'utf8'),
          cert: readFileSync(config.smtpTlsCert, 'utf8'),
        }
      : undefined
  if (tls === undefined) {
    log('smtp ingress: no POSTBOTE_SMTP_TLS_KEY/CERT set — STARTTLS disabled (plain mode)')
  }

  const servers = config.smtpPorts.map((port) => {
    const ingress = createSmtpIngress({
      store,
      enqueue,
      log,
      verifyCredential: (access, secret) => store.verifySmtpCredential(access, secret),
      ...(tls !== undefined && { tls }),
    })
    ingress.listen(port, config.host)
    log(`smtp ingress listening on ${config.host}:${port} (AUTH PLAIN/LOGIN)`)
    return ingress
  })

  return {
    ports: [...config.smtpPorts],
    close: async () => {
      await Promise.all(
        servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      )
    },
  }
}
