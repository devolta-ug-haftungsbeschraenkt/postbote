/**
 * HTTP-Client gegen die Postmark-kompatible postbote-API.
 * Basis-URL konfigurierbar über VITE_POSTBOTE_API (Default: http://localhost:3000),
 * Server-Token optional über VITE_POSTBOTE_TOKEN.
 *
 * Schlägt ein Request fehl, wirft der Client — die Aufrufer (useApi) fallen
 * automatisch auf Demo-Fixtures zurück.
 */

import type {
  AddSuppressionBody,
  AddSuppressionResponse,
  BouncesResponse,
  CreateStreamBody,
  DeliveryStats,
  MessageStream,
  MessageStreamsResponse,
  MessagesResponse,
  OutboundStats,
  OutboundStatsParams,
  RelayConfig,
  ServerInfo,
  SuppressionDeleteResponse,
  SuppressionsResponse,
  TemplateListResponse,
  UpdateStreamBody,
  WebhookListResponse,
} from './types'

/**
 * Container deployments inject config at runtime via /config.js
 * (window.__POSTBOTE_CONFIG__); dev builds fall back to VITE_* env vars.
 */
declare global {
  interface Window {
    __POSTBOTE_CONFIG__?: { apiBase?: string; token?: string }
  }
}

const runtimeConfig =
  typeof window !== 'undefined' ? (window.__POSTBOTE_CONFIG__ ?? {}) : {}

const envBase = (runtimeConfig.apiBase ?? (import.meta.env.VITE_POSTBOTE_API as string | undefined))?.trim()
export const API_BASE = (envBase && envBase.length > 0 ? envBase : 'http://localhost:3000').replace(/\/+$/, '')

const envToken = (runtimeConfig.token ?? (import.meta.env.VITE_POSTBOTE_TOKEN as string | undefined))?.trim()

export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const REQUEST_TIMEOUT_MS = 4000

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(envToken ? { 'X-Postmark-Server-Token': envToken } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      throw new ApiError(`API antwortete mit ${response.status}`, response.status)
    }
    return (await response.json()) as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(error instanceof Error ? error.message : 'Netzwerkfehler')
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  deliveryStats: () => request<DeliveryStats>('/deliverystats'),

  messages: (count = 50) => request<MessagesResponse>(`/messages/outbound?count=${count}`),

  bounces: (count = 50) => request<BouncesResponse>(`/bounces?count=${count}`),

  templates: () => request<TemplateListResponse>('/templates?count=100'),

  webhooks: () => request<WebhookListResponse>('/webhooks'),

  server: () => request<ServerInfo>('/server'),

  saveRelay: (config: RelayConfig) =>
    request<ServerInfo>('/server/relay', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  /* ---- M8: Message Streams ---- */

  streams: () => request<MessageStreamsResponse>('/message-streams'),

  createStream: (body: CreateStreamBody) =>
    request<MessageStream>('/message-streams', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateStream: (id: string, body: UpdateStreamBody) =>
    request<MessageStream>(`/message-streams/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  archiveStream: (id: string) =>
    request<MessageStream>(`/message-streams/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    }),

  unarchiveStream: (id: string) =>
    request<MessageStream>(`/message-streams/${encodeURIComponent(id)}/unarchive`, {
      method: 'POST',
    }),

  /* ---- M8: Suppressions ---- */

  suppressions: (stream: string) =>
    request<SuppressionsResponse>(`/suppressions/${encodeURIComponent(stream)}`),

  addSuppression: (stream: string, body: AddSuppressionBody) =>
    request<AddSuppressionResponse>(`/suppressions/${encodeURIComponent(stream)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeSuppression: (stream: string, email: string) =>
    request<SuppressionDeleteResponse>(
      `/suppressions/${encodeURIComponent(stream)}/delete`,
      {
        method: 'POST',
        body: JSON.stringify({ EmailAddress: email }),
      },
    ),

  /* ---- M8: Outbound Stats ---- */

  outboundStats: (params?: OutboundStatsParams) => {
    const query = new URLSearchParams()
    if (params?.from) query.set('from', params.from)
    if (params?.to) query.set('to', params.to)
    if (params?.tag) query.set('tag', params.tag)
    const qs = query.toString()
    return request<OutboundStats>(`/stats/outbound${qs ? `?${qs}` : ''}`)
  },
}
