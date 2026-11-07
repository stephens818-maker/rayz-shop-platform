export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "slot_unavailable"
  | "cutoff_passed"
  | "rate_limited"
  | "payment_failed"
  | "upgrade_required"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  slot_unavailable: 409,
  cutoff_passed: 422,
  rate_limited: 429,
  payment_failed: 402,
  upgrade_required: 426,
  internal: 500,
};

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get status() {
    return STATUS[this.code];
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} not found`);
export const forbidden = (msg = "You don't have access to this") => new AppError("forbidden", msg);

/** Postgres exclusion-constraint violation = someone else just took that time. */
export function isDoubleBookingError(e: unknown): boolean {
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const c = err?.cause ?? err;
  return c?.code === "23P01" || c?.constraint_name === "appointments_no_double_booking" || c?.constraint_name === "appointments_no_buffer_overlap";
}
