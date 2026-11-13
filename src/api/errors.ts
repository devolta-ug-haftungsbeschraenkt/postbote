/**
 * Postmark-kompatibles ErrorCode-System (Analyse 3.2). Der Code steht im Body
 * und wird als Echo-Header `X-PM-ApiErrorCode` zurückgegeben. Batch-Antworten
 * kommen mit HTTP 200 und pro-Item-Errors — niemals 207/Mixed.
 */

export interface PostmarkError {
  ErrorCode: number
  Message: string
}

export const ErrorCodes = {
  /** Server token is missing, invalid, or does not match. */
  Auth: 10,
  /** Validation of the send request failed. */
  SendValidation: 300,
  /** Invalid JSON in request body. */
  InvalidJSON: 402,
  /** Inactive recipient (suppressed/bounced address). */
  InactiveRecipient: 406,
  /** More than 500 messages per batch call. */
  BatchTooLarge: 410,
  /** Template not found. */
  TemplateNotFound: 1101,
  /** Template render error (Postmark type 100010). */
  TemplateRenderingFailed: 100010,
  /** Sender not allowed by token allowlist. */
  SenderNotAllowed: 1480,
  /** Webhook verification failed. */
  WebhookVerificationFailed: 1364,
  /** Message stream does not exist. */
  StreamNotFound: 1235,
} as const

export function postmarkError(
  status: number,
  code: number,
  message: string,
): PostmarkError & {
  status: number
} {
  return { status, ErrorCode: code, Message: message }
}

export function errorResponse(status: number, code: number, message: string) {
  return {
    statusCode: status,
    body: { ErrorCode: code, Message: message } satisfies PostmarkError,
  }
}
