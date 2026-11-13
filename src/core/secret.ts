import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { loadConfig } from '../config/env.js'

/**
 * Härtung: Verschlüsselung von Secrets at rest (Bauplan §8). AES-256-GCM mit
 * einem aus POSTBOTE_SECRET_KEY abgeleiteten Schlüssel. Bestehende Klartext-
 * Werte bleiben lesbar (Migration ohne Downtime); neue Werte werden
 * verschlüsselt, sobald ein Key gesetzt ist.
 *
 * Format: enc:v1:<iv base64url>:<authTag base64url>:<ciphertext base64url>
 */
const PREFIX = 'enc:v1:'

function deriveKey(secretKey: string): Buffer {
  return createHash('sha256').update(secretKey, 'utf8').digest()
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX)
}

export function encryptSecret(plaintext: string, secretKey: string): string {
  if (secretKey.length === 0) return plaintext
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
}

export function decryptSecret(stored: string, secretKey: string): string {
  if (!isEncrypted(stored)) return stored
  if (secretKey.length === 0) {
    throw new Error('encrypted secret found but POSTBOTE_SECRET_KEY is not configured')
  }
  const parts = stored.split(':')
  const iv = parts[2]
  const tag = parts[3]
  const data = parts[4]
  if (!iv || !tag || !data) throw new Error('malformed encrypted secret')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(secretKey),
    Buffer.from(iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** Convenience-Wrapper, die den Key aus der Config lesen. */
export function encryptAtRest(plaintext: string): string {
  return encryptSecret(plaintext, loadConfig().secretKey)
}

export function decryptAtRest(stored: string): string {
  return decryptSecret(stored, loadConfig().secretKey)
}
