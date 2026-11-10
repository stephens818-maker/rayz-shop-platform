import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Small secrets kept in the database (a staff member's authenticator key) are encrypted with
 * AES-256-GCM under a key derived from AUTH_SECRET, so a database copy alone can't make codes.
 * Rotating AUTH_SECRET makes stored keys unreadable: those people set up two-step sign-in again.
 */
function key(): Buffer {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET must be set (32+ chars)");
    return createHash("sha256").update("secret-box:dev-only-insecure-secret-change-me-0123456789").digest();
  }
  return createHash("sha256").update(`secret-box:${s}`).digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** The plain text, or null when it was sealed under another key or was tampered with. */
export function open(sealed: string): string | null {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
