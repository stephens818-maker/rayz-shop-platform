import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "node:crypto";

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET must be set (32+ chars)");
    return new TextEncoder().encode("dev-only-insecure-secret-change-me-0123456789");
  }
  return new TextEncoder().encode(s);
}

/**
 * otp_select: proof that the bearer just verified a code for one phone/email, used to pick or create a profile.
 * trusted_device: a browser's device secret. device_request: a blocked sign-in that may ask for device approval.
 * handoff: this browser is handed to a client for one ticket.
 * login_2fa: a correct password waiting for its authenticator code (or for setting one up).
 */
export type TokenType = "staff_session" | "customer_access" | "otp_select" | "trusted_device" | "device_request" | "handoff" | "login_2fa";

export async function signToken(payload: Record<string, unknown>, typ: TokenType, ttlSeconds: number): Promise<string> {
  return new SignJWT({ ...payload, typ })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("rayz")
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret());
}

export async function verifyToken<T extends Record<string, unknown>>(token: string, typ: TokenType): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: "rayz" });
    if (payload.typ !== typ) return null;
    return payload as unknown as T;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
