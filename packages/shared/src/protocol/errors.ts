/** Machine-readable error codes used in HTTP envelopes and WS error frames. */
export const ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthenticated",
  "token_expired",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  "method_not_allowed",
  "resync_required",
  "internal",
  "unavailable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
  readonly requestId?: string;
}

/** Every failed HTTP response has this shape. */
export interface ApiErrorEnvelope {
  readonly error: ApiErrorBody;
}

/** Every successful HTTP response wraps its payload in `data`. */
export interface ApiSuccessEnvelope<T> {
  readonly data: T;
}

export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const err = (value as { error: unknown }).error;
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

/** HTTP status conventionally associated with each code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  token_expired: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  method_not_allowed: 405,
  resync_required: 409,
  internal: 500,
  unavailable: 503,
};
