import { createHmac, timingSafeEqual } from "node:crypto";

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Signatures older or newer than this are refused, so a captured webhook can't be replayed later. */
export const WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Resend signs webhooks the Svix way: HMAC-SHA256 of "id.timestamp.body" under the base64 secret
 * after "whsec_", sent as one or more space-separated "v1,<base64>" values.
 */
export function verifySvix(secret: string, h: { id: string | null; timestamp: string | null; signature: string | null }, payload: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${payload}`).digest("base64");
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    return version === "v1" && !!sig && same(sig, expected);
  });
}

/** Postmark webhooks carry the HTTP basic credentials set on the webhook ("user:password"). */
export function verifyBasicAuth(header: string | null, expected: string): boolean {
  if (!expected || !header?.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6), "base64").toString("utf8");
  return same(given, expected);
}

function linkKey(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET must be set (32+ chars)");
    return "dev-only-insecure-secret-change-me-0123456789";
  }
  return s;
}

const mac = (purpose: string, id: string) => createHmac("sha256", linkKey()).update(`${purpose}:${id}`).digest("base64url").slice(0, 22);

/** A link token naming one row (an email's job id): "<id>.<mac>". Nothing about the person is in it. */
export const signedId = (purpose: string, id: string) => `${id}.${mac(purpose, id)}`;

export function readSignedId(purpose: string, token: string): string | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  return same(m[2], mac(purpose, m[1])) ? m[1] : null;
}
