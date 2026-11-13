import type { BounceType } from '../core/store.js'

/**
 * Bounce-Klassifikation aus SMTP-Response-Codes (MVP-Tiefe gemäß Bauplan §8:
 * 5xx = dauerhaft, 4xx = Retry). NDR-Mailbox-Ingestion ist Phase 2.
 *
 * TypeCodes gemäß Postmark-Tabelle (Analyse 2.5):
 * HardBounce=1, Transient=2, DnsError=256, SoftBounce=4096, BadEmailAddress=100000,
 * Blocked=100006, DMARCPolicy=100009
 */

const TYPE_CODES: Record<BounceType, number> = {
  HardBounce: 1,
  Transient: 2,
  DnsError: 256,
  SpamNotification: 512,
  SoftBounce: 4096,
  BadEmailAddress: 100000,
  Blocked: 100006,
  DMARCPolicy: 100009,
  /** Fehler nach SMTP-Annahme, die dem Client nicht mehr synchron gemeldet werden können. */
  SMTPApiError: 100007,
}

export interface Classification {
  type: BounceType | null
  typeCode: number
  /** true → retry with backoff; false → permanent bounce or success. */
  retry: boolean
}

/** Classify an SMTP response (code + optional response text). */
export function classifySmtpResponse(code: number, text?: string): Classification {
  if (code >= 200 && code < 300) return { type: null, typeCode: 0, retry: false }
  if (code >= 400 && code < 500) return transient()

  // 5xx — permanent from the MTA's perspective, but distinguish common patterns:
  const lower = (text ?? '').toLowerCase()

  if (lower.includes('mailbox full') || lower.includes('storage') || lower.includes('quota')) {
    return { type: 'SoftBounce', typeCode: TYPE_CODES.SoftBounce, retry: true }
  }
  if (
    lower.includes('dns') ||
    lower.includes('domain not found') ||
    lower.includes('host not found')
  ) {
    return { type: 'DnsError', typeCode: TYPE_CODES.DnsError, retry: true }
  }
  if (lower.includes('blocked') || lower.includes('blacklist') || lower.includes('spamhaus')) {
    return { type: 'Blocked', typeCode: TYPE_CODES.Blocked, retry: false }
  }
  if (lower.includes('dmarc') || lower.includes('policy rejection')) {
    return { type: 'DMARCPolicy', typeCode: TYPE_CODES.DMARCPolicy, retry: false }
  }
  if (
    lower.includes('invalid address') ||
    lower.includes('bad address') ||
    lower.includes('recipient rejected')
  ) {
    return { type: 'BadEmailAddress', typeCode: TYPE_CODES.BadEmailAddress, retry: false }
  }
  // Default 5xx: mailbox doesn't exist / server refuses permanently.
  return { type: 'HardBounce', typeCode: TYPE_CODES.HardBounce, retry: false }
}

function transient(): Classification {
  return { type: 'Transient', typeCode: TYPE_CODES.Transient, retry: true }
}
