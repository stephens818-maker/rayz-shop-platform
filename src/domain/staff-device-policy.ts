/**
 * ST-I18: what the Ray'z Staff app may keep on a phone and how it protects it. The server serves this
 * as `dataProtection` in GET /config, marks every response with X-Staff-Cache, and tells the app what
 * to wipe when it refuses a session. The app enforces the rest on the phone.
 */

export const OFFLINE_CACHE_TTL_HOURS = 24;
/** A punch tapped with no signal can be sent this long afterwards; older ones are for a manager to add. */
export const OFFLINE_PUNCH_MAX_HOURS = 24;
/** How far ahead of the server a phone's clock may be before a queued punch's time is refused. */
export const OFFLINE_PUNCH_CLOCK_SKEW_MS = 2 * 60_000;
export const APP_LOCK_AFTER_BACKGROUND_SECONDS = 300;

/**
 * GET routes whose responses the app may keep, encrypted, for at most 24 hours, so their own day
 * still shows with no signal. Their own work only: no client contact details, notes or history, no
 * pay, tips or banking, nobody else's timecard.
 */
export const OFFLINE_READABLE: readonly RegExp[] = [
  /^\/config$/,
  /^\/me$/,
  /^\/me\/calendar$/,
  /^\/me\/schedule$/,
  /^\/me\/timecard$/,
  /^\/me\/time-off-requests$/,
  /^\/schedule$/,
  /^\/clock$/,
];

/** Why a queued punch's tapped time can't be used, or null. */
export function queuedPunchProblem(queuedAt: Date, now: Date): string | null {
  if (Number.isNaN(queuedAt.getTime())) return "That punch's time couldn't be read.";
  if (queuedAt.getTime() > now.getTime() + OFFLINE_PUNCH_CLOCK_SKEW_MS) return "That punch's time is in the future. Check the phone's clock and punch again.";
  if (now.getTime() - queuedAt.getTime() > OFFLINE_PUNCH_MAX_HOURS * 3600_000) return `That punch waited more than ${OFFLINE_PUNCH_MAX_HOURS} hours to send. Ask a manager to add it.`;
  return null;
}

export type CacheRule = "offline-24h" | "none";
export const STAFF_CACHE_HEADER = "X-Staff-Cache";

/** The path after /api/staff/v1. Anything not a GET, or not listed, is never kept. */
export function cacheRuleFor(method: string, path: string): CacheRule {
  if (method.toUpperCase() !== "GET") return "none";
  const p = path.replace(/^\/api\/staff\/v1/, "").replace(/\/+$/, "") || "/";
  return OFFLINE_READABLE.some((r) => r.test(p)) ? "offline-24h" : "none";
}

/**
 * What the app wipes when the server refuses its session:
 * - all: everything, queued punches included (signed out from another phone or the web, by a manager,
 *   made inactive or removed, or a stolen refresh token);
 * - cache: the cached screens, keeping queued punches to send after they sign in again (expired or idle);
 * - none: nothing (an access token that only needs refreshing).
 */
export type Wipe = "all" | "cache" | "none";
export type SessionEnd = "token_expired" | "session_expired" | "session_ended" | "account_ended" | "other_device";
export const WIPE_FOR: Record<SessionEnd, Wipe> = {
  token_expired: "none",
  session_expired: "cache",
  session_ended: "all",
  account_ended: "all",
  other_device: "all",
};

export const STAFF_DEVICE_POLICY = {
  version: "2026-10-27",
  cache: {
    encrypted: true,
    /** iOS: Keychain key, files with NSFileProtectionComplete. Android: Keystore key, EncryptedFile. */
    storage: "Encrypted with a key kept in the phone's Keychain or Keystore, readable only while the phone is unlocked.",
    ttlHours: OFFLINE_CACHE_TTL_HOURS,
    header: STAFF_CACHE_HEADER,
    rule: "Keep a response only when its X-Staff-Cache header is offline-24h, and drop it 24 hours after it was fetched. Never keep anything else, or any response, on the SD card, in backups or in shared storage.",
    excludeFromBackup: true,
  },
  appLock: {
    required: true,
    afterBackgroundSeconds: APP_LOCK_AFTER_BACKGROUND_SECONDS,
    unlock: "The phone's passcode, or Face ID, Touch ID or a fingerprint through the phone's own unlock (the app only hears yes or no; see the no-biometrics policy).",
  },
  snapshotBlur: {
    required: true,
    rule: "Cover the screen when the app goes to the background, so the app switcher shows no client or pay details (iOS: a blur view on resign active; Android: FLAG_SECURE).",
  },
  copyShare: {
    blocked: true,
    rule: "No copy, share, print, drag or screenshots of client details, contact, notes or pay. Calls and texts go through the shop line (POST /clients/{id}/contact).",
  },
  offline: {
    mode: "read_only" as const,
    rule: "With no signal, show the cached screens read-only and allow nothing but clock punches. Queue each punch with the time it was tapped and send them in order when back online.",
    queued: ["clock_punch"] as const,
    punchMaxAgeHours: OFFLINE_PUNCH_MAX_HOURS,
    punchFields: "Send queuedAt (when it was tapped) and clientPunchId (a random id, so a retry never punches twice). Shop Wi-Fi can't prove a queued punch; QR, NFC and location can.",
  },
  wipe: {
    onSignOut: true,
    onRevoke: true,
    rule: "A 401 with details.wipe = all deletes everything, queued punches included; cache deletes the cached screens and keeps queued punches; none means refresh the token. Then POST /auth/wiped with the refresh token, so the sign-in shows as wiped.",
  },
} as const;
