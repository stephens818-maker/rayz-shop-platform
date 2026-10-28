import { createHmac, randomBytes } from "node:crypto";
import { lt } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { clockNonces } from "@/db/schema";
import { sameSecret, sha256 } from "./auth/tokens";
import { AppError } from "./errors";

/**
 * The time clock's own signing key and single-use nonces (launch security, claude bot, Oct 28).
 *
 * - CLOCK_HMAC_SECRET signs the kiosk's QR codes. There's no fallback in any environment: without it
 *   (or with one under 32 characters) every punch, PIN check and QR code refuses, so a missing
 *   setting can never quietly fall back to a guessable key.
 * - Every punch request carries a nonce and the time it was made. Claiming the nonce is an insert
 *   into clock_nonces, whose primary key refuses a second claim atomically, and the time has to be
 *   within REQUEST_WINDOW_MS of the server's clock.
 * - Each QR code the kiosk draws carries its own nonce, so one scan uses it up.
 */

export const CLOCK_SECRET_ENV = "CLOCK_HMAC_SECRET";
const MIN_SECRET_CHARS = 32;
export const CLOCK_SECRET_MISSING = "The time clock is off: its signing key (CLOCK_HMAC_SECRET) isn't set on the server. Tell the owner; no punches go in until it is.";

export function clockSecret(): string {
  const s = process.env[CLOCK_SECRET_ENV]?.trim();
  if (!s || s.length < MIN_SECRET_CHARS) throw new AppError("internal", CLOCK_SECRET_MISSING, { reason: "clock_secret_missing" });
  return s;
}

const sign = (data: string) => createHmac("sha256", clockSecret()).update(data).digest("base64url").slice(0, 32);

/** A paired app install's id as the device row keeps it. */
export const installHash = (installId: string) => sha256(`clock-install:${installId}`);

// ───────────────────────────── Nonces ─────────────────────────────

/** How far a request's own timestamp may be from the server's clock, either way. */
export const REQUEST_WINDOW_MS = 60_000;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export interface ClockNonce {
  /** 16 to 128 letters, digits, - or _ (a UUID works), new for every send, retries included. */
  id: string | null | undefined;
  /** When the client made the request: epoch milliseconds, or an ISO time. */
  at: Date | string | number | null | undefined;
}

/** A timestamp as epoch milliseconds or an ISO time; null when it isn't either. */
export function parseClockTime(raw: Date | string | number | null | undefined): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const d = raw instanceof Date ? raw : typeof raw === "number" || /^\d{10,16}$/.test(raw.trim()) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The X-Clock-Nonce and X-Clock-Timestamp headers of a staff app punch. */
export function requestNonce(req: Request): ClockNonce {
  return { id: req.headers.get("x-clock-nonce")?.trim() || null, at: req.headers.get("x-clock-timestamp")?.trim() || null };
}

/**
 * Uses up a nonce, or refuses: 400 when it's missing or malformed or its time is outside the
 * window, 409 when it was used before. Pass the punch's transaction for a QR nonce, so a punch that
 * fails leaves the code usable.
 */
export async function claimClockNonce(
  v: { nonce: ClockNonce; kind: "request" | "qr"; deviceId?: string | null; staffId?: string | null; windowMs?: number },
  now = new Date(),
  tx: DBorTx = db,
): Promise<void> {
  clockSecret();
  const id = v.nonce.id ?? "";
  const qr = v.kind === "qr";
  if (!NONCE.test(id)) throw new AppError("bad_request", qr ? "That QR code can't be read. Scan the one on the front-desk clock." : "This punch is missing its one-time code (X-Clock-Nonce). Update the app and try again.", { field: "nonce", reason: "nonce_required" });
  const at = parseClockTime(v.nonce.at);
  if (!at) throw new AppError("bad_request", "This punch is missing the time it was sent (X-Clock-Timestamp).", { field: "timestamp", reason: "timestamp_required" });
  const window = v.windowMs ?? REQUEST_WINDOW_MS;
  if (Math.abs(now.getTime() - at.getTime()) > window)
    throw new AppError("bad_request", qr ? "That QR code has expired. Scan the one on the front-desk clock now." : "This punch was sent too long ago, or your phone's clock is off. Check the time on your phone and try again.", {
      field: "timestamp",
      reason: "stale_request",
    });
  const [row] = await tx
    .insert(clockNonces)
    .values({ nonce: `${qr ? "qr" : "req"}:${id}`, kind: v.kind, deviceId: v.deviceId ?? null, staffId: v.staffId ?? null, requestedAt: at })
    .onConflictDoNothing()
    .returning({ nonce: clockNonces.nonce });
  if (!row) throw new AppError("conflict", qr ? "That QR code was just used. Scan the new one on the front-desk clock." : "This punch was already sent once, so it can't go in again.", { reason: qr ? "qr_used" : "nonce_replayed" });
  if (Math.random() < 0.02) await tx.delete(clockNonces).where(lt(clockNonces.createdAt, new Date(now.getTime() - 86_400_000)));
}

// ───────────────────────────── Kiosk QR codes ─────────────────────────────

/** A kiosk QR code is good for a minute; the kiosk draws a new one well before that. */
export const QR_TTL_MS = 60_000;
export const QR_REFRESH_MS = 15_000;
/** A code may be stamped this far ahead of the server's clock (two app servers a little apart). */
const QR_SKEW_MS = 5_000;

const qrData = (shopId: string, deviceId: string, nonce: string, t: number) => `clock-qr:${shopId}:${deviceId}:${nonce}:${t}`;

/** The code a paired front-desk clock draws: its device, a fresh nonce and the time, signed with CLOCK_HMAC_SECRET. */
export function issueKioskQr(device: { id: string; shopId: string }, now = new Date()) {
  const nonce = randomBytes(16).toString("base64url");
  const t = now.getTime();
  return {
    code: `${device.id}.${nonce}.${t.toString(36)}.${sign(qrData(device.shopId, device.id, nonce, t))}`,
    expiresAt: new Date(t + QR_TTL_MS),
    refreshAt: new Date(t + QR_REFRESH_MS),
  };
}

/** The device, nonce and time in a QR code that's signed for this shop and still fresh; null otherwise. */
export function verifyKioskQr(shopId: string, code: string | null | undefined, now = new Date()): { deviceId: string; nonce: string; issuedAt: Date } | null {
  clockSecret();
  const parts = (code ?? "").split(".");
  if (parts.length !== 4) return null;
  const [deviceId, nonce, t36, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(deviceId) || !NONCE.test(nonce) || !/^[0-9a-z]{1,12}$/.test(t36)) return null;
  const t = parseInt(t36, 36);
  if (!sameSecret(sign(qrData(shopId, deviceId, nonce, t)), sig)) return null;
  const age = now.getTime() - t;
  if (age > QR_TTL_MS || age < -QR_SKEW_MS) return null;
  return { deviceId, nonce, issuedAt: new Date(t) };
}
