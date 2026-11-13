/** Typen der Postmark-kompatiblen postbote-API. */

export type MessageStatus = 'queued' | 'sent' | 'failed' | 'bounced'

export interface OutboundMessage {
  MessageID: string
  From: string
  To: string[]
  Recipient: string
  Subject: string
  Status: MessageStatus
  Tag?: string | null
  MessageStream?: string
  SubmittedAt?: string
  ReceivedAt?: string
}

export interface MessagesResponse {
  TotalCount: number
  Messages: OutboundMessage[]
}

export interface Bounce {
  ID: number | string
  Type: string
  TypeCode: number
  Name?: string
  Description?: string
  Email: string
  Subject?: string
  BouncedAt: string
}

export interface BouncesResponse {
  TotalCount: number
  Bounces: Bounce[]
}

export interface DeliveryStats {
  Sent: number
  Queued: number
  Bounced: number
  Failed: number
  BounceRate?: string
  SentDelta24h?: number
  QueuedNextRun?: string
}

export interface Template {
  TemplateId: number | string
  Name: string
  Alias?: string
  Subject: string
  Layout?: string | null
  LastModified?: string
}

export interface TemplateListResponse {
  TotalCount: number
  Templates: Template[]
}

export interface Webhook {
  ID: number | string
  Url: string
  Events: string[]
  Verified: boolean
  HttpAuth?: boolean
}

export interface WebhookListResponse {
  TotalCount: number
  Webhooks: Webhook[]
}

export interface ServerInfo {
  Name: string
  ServerId?: number | string
  ApiBase?: string
  MessageStream?: string
  TokenPreview?: string
}

export type TlsMode = 'none' | 'starttls' | 'tls'

export interface RelayConfig {
  Host: string
  Port: number
  Username: string
  Password: string
  TlsMode: TlsMode
}

/* ---- M8: Message Streams ---- */

export interface MessageStream {
  ID: string
  Name: string
  Description: string
  MessageStreamType: string
  Archived: boolean
  CreatedAt: string
}

export interface MessageStreamsResponse {
  TotalCount: number
  MessageStreams: MessageStream[]
}

export interface CreateStreamBody {
  ID: string
  Name: string
  Description?: string
  MessageStreamType?: string
}

export interface UpdateStreamBody {
  Name?: string
  Description?: string
}

/* ---- M8: Suppressions ---- */

export type SuppressionReason = 'HardBounce' | 'SpamComplaint' | 'ManualSuppression'

export interface Suppression {
  EmailAddress: string
  SuppressionReason: string
  CreatedAt: string
}

export interface SuppressionsResponse {
  TotalCount: number
  Suppressions: Suppression[]
}

export interface AddSuppressionBody {
  EmailAddress: string
  SuppressionReason?: string
}

export interface AddSuppressionResponse {
  Suppressions: Suppression[]
}

export interface SuppressionDeleteResponse {
  ErrorCode: number
  Message: string
}

/* ---- M8: Outbound Stats ---- */

export interface StatDay {
  Date: string
  Sent: number
  Bounced: number
  Opens: number
  Clicks: number
  Tracked: number
}

export interface OutboundStats {
  Days: StatDay[]
  Sent: number
  Bounced: number
  Opens: number
  Clicks: number
  Tracked: number
  FromDate: string
  ToDate: string
}

export interface OutboundStatsParams {
  from?: string
  to?: string
  tag?: string
}
