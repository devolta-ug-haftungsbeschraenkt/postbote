import type { AddressInfo } from 'node:net'
import nodemailer from 'nodemailer'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryMessageStore } from '../src/core/memory-store.js'
import { createSmtpIngress } from '../src/smtp/server.js'

interface Running {
  port: number
  close: () => Promise<void>
}

const running: Running[] = []

async function startIngress(store: MemoryMessageStore, enqueued: string[]) {
  const ingress = createSmtpIngress({
    store,
    verifyCredential: (access, secret) => store.verifySmtpCredential(access, secret),
    enqueue: (job) => enqueued.push(job.payload.messageId as string),
    log: () => {},
  })
  const netServer = ingress.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => netServer.once('listening', () => resolve()))
  const port = (netServer.address() as AddressInfo).port
  const handle = {
    port,
    close: () => new Promise<void>((resolve) => ingress.close(() => resolve())),
  }
  running.push(handle)
  return handle
}

function transport(port: number, auth?: { user: string; pass: string }) {
  return nodemailer.createTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    ...(auth !== undefined && { auth }),
    // STARTTLS is not advertised by the MVP ingress without a TLS cert.
    ignoreTLS: true,
  })
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()))
})

describe('SMTP-Credentials (Access/Secret, Hash)', () => {
  it('create → verify ok, wrong secret → null', async () => {
    const store = new MemoryMessageStore()
    const server = await store.createServer('SMTP', 'smtp')
    const cred = await store.createSmtpCredential(server.id, 'outbound')

    expect(cred.accessKey).toMatch(/^pb-/)
    expect(cred.secretKey).toMatch(/^pbsec-/)
    expect(store.smtpCredentials.get(cred.accessKey)?.secretKeyHash).not.toBe(cred.secretKey)
    expect(await store.verifySmtpCredential(cred.accessKey, cred.secretKey)).toEqual({
      serverId: server.id,
      streamId: 'outbound',
    })
    expect(await store.verifySmtpCredential(cred.accessKey, 'wrong')).toBeNull()
    expect(await store.verifySmtpCredential('nope', cred.secretKey)).toBeNull()
  })
})

describe('SMTP-Ingress (AUTH PLAIN/LOGIN)', () => {
  it('accepts a mail and enqueues it with X-PM headers mapped', async () => {
    const store = new MemoryMessageStore()
    const server = await store.createServer('SMTP', 'smtp')
    const cred = await store.createSmtpCredential(server.id, 'outbound')
    const enqueued: string[] = []
    const { port } = await startIngress(store, enqueued)

    const info = await transport(port, { user: cred.accessKey, pass: cred.secretKey }).sendMail({
      from: 'Absender <sender@example.com>',
      to: 'empfaenger@example.com, zweiter@example.com',
      cc: 'cc@example.com',
      subject: 'SMTP-Test',
      text: 'Hallo per SMTP',
      html: '<p>Hallo per SMTP</p>',
      headers: [
        { key: 'X-PM-Message-Stream', value: 'custom-stream' },
        { key: 'X-PM-Tag', value: 'onboarding' },
        { key: 'X-PM-Metadata-UserId', value: '42' },
        { key: 'X-Custom-Header', value: 'keep-me' },
      ],
    })

    expect(info.accepted).toEqual([
      'empfaenger@example.com',
      'zweiter@example.com',
      'cc@example.com',
    ])
    expect(enqueued).toHaveLength(1)

    const message = await store.getMessage(enqueued[0] as string)
    expect(message).not.toBeNull()
    expect(message?.from).toContain('sender@example.com')
    expect(message?.to).toEqual(['empfaenger@example.com', 'zweiter@example.com'])
    expect(message?.cc).toEqual(['cc@example.com'])
    expect(message?.subject).toBe('SMTP-Test')
    expect(message?.textBody).toContain('Hallo per SMTP')
    expect(message?.htmlBody).toContain('<p>Hallo per SMTP</p>')
    expect(message?.streamId).toBe('custom-stream')
    expect(message?.tag).toBe('onboarding')
    expect(message?.metadata).toEqual({ userid: '42' })
    expect(message?.headers).toContainEqual({ name: 'x-custom-header', value: 'keep-me' })
    expect(message?.serverId).toBe(server.id)
  })

  it('rejects invalid credentials with 535', async () => {
    const store = new MemoryMessageStore()
    const server = await store.createServer('SMTP', 'smtp')
    const cred = await store.createSmtpCredential(server.id)
    const { port } = await startIngress(store, [])

    await expect(
      transport(port, { user: cred.accessKey, pass: 'falsch' }).sendMail({
        from: 'a@example.com',
        to: 'b@example.com',
        subject: 'x',
        text: 'x',
      }),
    ).rejects.toThrow(/535|Invalid|authentication/i)
    expect(store.messages).toHaveLength(0)
  })

  it('rejects unauthenticated MAIL FROM with 530', async () => {
    const store = new MemoryMessageStore()
    const { port } = await startIngress(store, [])

    await expect(
      transport(port).sendMail({
        from: 'a@example.com',
        to: 'b@example.com',
        subject: 'x',
        text: 'x',
      }),
    ).rejects.toThrow(/530|Authentication|authentication/i)
    expect(store.messages).toHaveLength(0)
  })
})
