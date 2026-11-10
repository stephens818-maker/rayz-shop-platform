import { timingSafeEqual } from "node:crypto";

/** Fails closed: with no CRON_SECRET configured, nothing is authorized. */
export function cronAuthorized(header: string | null, secret: string | undefined) {
  if (!secret) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}
