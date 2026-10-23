import { describe, expect, it } from "vitest";
import { ErrorBody } from "@/server/api-schemas";
import { openApiDocument } from "@/server/openapi";

/**
 * Store builds freeze against /api/v1. Paths and error codes that already shipped stay.
 * Adding a path or a field is fine. Removing one is not.
 */
const FROZEN_PATHS = [
  "/shops",
  "/shops/{shop}",
  "/shops/{shop}/services",
  "/shops/{shop}/barbers",
  "/shops/{shop}/availability",
  "/shops/{shop}/available-days",
  "/appointments",
  "/appointments/{code}",
  "/appointments/{code}/cancel",
  "/appointments/{code}/reschedule",
  "/auth/otp/start",
  "/auth/otp/verify",
  "/auth/otp/complete",
  "/auth/refresh",
  "/auth/logout",
  "/me",
  "/me/appointments",
  "/me/loyalty",
  "/me/devices",
  "/me/devices/{id}",
  "/app/config",
  "/me/purchases",
  "/me/purchases/receipt",
  "/internal/connect/onboard",
];

const FROZEN_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "slot_unavailable",
  "cutoff_passed",
  "rate_limited",
  "payment_failed",
  "upgrade_required",
  "internal",
];

describe("/api/v1 stays compatible after launch", () => {
  it("keeps every shipped path and error code, and stays on document version 1.0.0", () => {
    const doc = openApiDocument("https://rayzbs.com");
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.0.0");
    for (const path of FROZEN_PATHS) expect(doc.paths, path).toHaveProperty(path);
    for (const code of FROZEN_ERROR_CODES) {
      expect(ErrorBody.safeParse({ error: { code, message: "ok", details: null } }).success, code).toBe(true);
    }
    expect(doc.info.description).toMatch(/additive/);
  });
});