import { z } from 'zod';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'TOKEN_REUSED',
  'SESSION_REVOKED',
  'FORBIDDEN',
  'CSRF_FAILED',
  'REAUTH_REQUIRED',
  'OAUTH_FAILED',
  'EMAIL_NOT_VERIFIED',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'FILE_TOO_LARGE',
  'QUOTA_EXCEEDED',
  'NOT_A_PDF',
  'FINGERPRINT_MISMATCH',
  'UPLOAD_IN_PROGRESS',
  'LIMIT_EXCEEDED',
  'CURSOR_EXPIRED',
  'IDEMPOTENCY_MISMATCH',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
  'UNAVAILABLE',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status per error code (design §5). */
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  OAUTH_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REUSED: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  REAUTH_REQUIRED: 403,
  EMAIL_NOT_VERIFIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UPLOAD_IN_PROGRESS: 409,
  IDEMPOTENCY_MISMATCH: 409,
  CURSOR_EXPIRED: 410,
  PAYLOAD_TOO_LARGE: 413,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NOT_A_PDF: 422,
  FINGERPRINT_MISMATCH: 422,
  LIMIT_EXCEEDED: 422,
  QUOTA_EXCEEDED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const satisfies Record<ErrorCode, number>;

export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    /** English, diagnostic; UIs map by code. Never contains user content or secrets. */
    message: z.string().max(500),
    /** Present with RATE_LIMITED / UNAVAILABLE. */
    retryAfterMs: z.number().int().nonnegative().optional(),
    details: z
      .strictObject({
        field: z.string().max(200).optional(),
        limit: z.number().optional(),
      })
      .optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
