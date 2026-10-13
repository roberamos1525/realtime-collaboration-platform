import { ERROR_STATUS, type ApiErrorEnvelope, type ErrorCode } from "@rcp/shared";
import type { ZodError, ZodType } from "zod";

/** Base class for every error that maps to a client-visible response. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = ERROR_STATUS[code];
  }

  toEnvelope(requestId?: string): ApiErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError("bad_request", message, details);
export const unauthenticated = (message = "authentication required") => new AppError("unauthenticated", message);
export const forbidden = (message = "you do not have permission to do that") => new AppError("forbidden", message);
export const notFound = (what: string) => new AppError("not_found", `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError("conflict", message, details);
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError("rate_limited", "too many requests, slow down", { retryAfterSeconds }, {
    "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export function validationError(error: ZodError): AppError {
  const issues: ValidationIssue[] = error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  return new AppError("validation_failed", "request validation failed", { issues });
}

/** Parses `input` with `schema`, throwing a 422 AppError on failure. */
export function parseInput<S extends ZodType>(schema: S, input: unknown): ReturnType<S["parse"]> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data as ReturnType<S["parse"]>;
}

/** Normalises anything thrown into an AppError (unknown errors become 500). */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError("internal", "internal server error");
}
