import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { db } from "@/db";
import { customers, otpCodes, refreshTokens } from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { AppError } from "@/server/errors";
import { enqueueRaw } from "@/server/notifications/queue";
import { randomToken, sha256, signToken, verifyToken } from "./tokens";

export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TTL_DAYS = 60;
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PER_HOUR = 5;

export function normalizeIdentifier(input: { phone?: string | null; email?: string | null }) {
  const phone = normalizePhone(input.phone);
  if (phone) return { identifier: phone, channel: "sms" as const };
  const email = normalizeEmail(input.email);
  if (email) return { identifier: email, channel: "email" as const };
  throw new AppError("bad_request", "Provide a valid US phone number or email");
}

export function devCodesEnabled() {
  return process.env.AUTH_DEV_CODES === "true" && process.env.VERCEL_ENV !== "production";
}

export async function startOtp(input: { phone?: string | null; email?: string | null }) {
  const { identifier, channel } = normalizeIdentifier(input);
  const recent = await db
    .select({ id: otpCodes.id })
    .from(otpCodes)
    .where(and(eq(otpCodes.identifier, identifier), gt(otpCodes.createdAt, new Date(Date.now() - 3_600_000))));
  if (recent.length >= OTP_PER_HOUR) throw new AppError("rate_limited", "Too many codes requested. Try again later.");
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await db.insert(otpCodes).values({ identifier, codeHash: sha256(`${identifier}:${code}`), expiresAt: new Date(Date.now() + OTP_TTL_MS) });
  await enqueueRaw({
    kind: "otp",
    channel,
    to: identifier,
    subject: "Your Ray'z sign-in code",
    body: `Your Ray'z Barber Shop code is ${code}. It expires in 10 minutes.`,
  });
  return { channel, expiresInSeconds: OTP_TTL_MS / 1000, ...(devCodesEnabled() ? { devCode: code } : {}) };
}

export async function verifyOtp(input: {
  phone?: string | null;
  email?: string | null;
  code: string;
  firstName?: string | null;
  lastName?: string | null;
  deviceName?: string | null;
}) {
  const { identifier, channel } = normalizeIdentifier(input);
  const [otp] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.identifier, identifier), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw new AppError("unauthorized", "Code expired. Request a new one.");
  if (otp.codeHash !== sha256(`${identifier}:${input.code.trim()}`)) {
    await db.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
    throw new AppError("unauthorized", "That code isn't right");
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));

  const where = channel === "sms" ? eq(customers.phone, identifier) : eq(customers.email, identifier);
  // Families can share a phone; the most recently created profile is the account holder by default.
  let customer = await db.query.customers.findFirst({ where, orderBy: desc(customers.createdAt) });
  let isNew = false;
  if (!customer) {
    if (!input.firstName?.trim()) {
      return { needsProfile: true as const };
    }
    [customer] = await db
      .insert(customers)
      .values({
        firstName: input.firstName.trim(),
        lastName: input.lastName?.trim() || null,
        phone: channel === "sms" ? identifier : null,
        email: channel === "email" ? identifier : null,
      })
      .returning();
    isNew = true;
  }
  const tokens = await issueTokens(customer.id, input.deviceName ?? null);
  return { needsProfile: false as const, isNew, customer, ...tokens };
}

export async function issueTokens(customerId: string, deviceName: string | null) {
  const accessToken = await signToken({ sub: customerId }, "customer_access", ACCESS_TTL_SECONDS);
  const refreshToken = randomToken(32);
  const [row] = await db
    .insert(refreshTokens)
    .values({
      customerId,
      tokenHash: sha256(refreshToken),
      deviceName,
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
    })
    .returning({ id: refreshTokens.id });
  return { accessToken, refreshToken, tokenType: "Bearer" as const, expiresIn: ACCESS_TTL_SECONDS, refreshTokenId: row.id };
}

/** Rotating refresh tokens. Re-using an already-rotated token revokes every session for that customer. */
export async function refresh(refreshToken: string) {
  const row = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256(refreshToken)) });
  if (!row) throw new AppError("unauthorized", "Invalid refresh token");
  if (row.revokedAt) {
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.customerId, row.customerId), isNull(refreshTokens.revokedAt)));
    throw new AppError("unauthorized", "Refresh token was already used; please sign in again");
  }
  if (row.expiresAt < new Date()) throw new AppError("unauthorized", "Session expired; please sign in again");
  const next = await issueTokens(row.customerId, row.deviceName);
  await db.update(refreshTokens).set({ revokedAt: new Date(), replacedBy: next.refreshTokenId }).where(eq(refreshTokens.id, row.id));
  return next;
}

export async function revoke(refreshToken: string) {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
}

export async function customerFromRequest(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return null;
  const payload = await verifyToken<{ sub: string }>(h.slice(7).trim(), "customer_access");
  return payload?.sub ?? null;
}

export async function requireCustomer(req: Request): Promise<string> {
  const id = await customerFromRequest(req);
  if (!id) throw new AppError("unauthorized", "Sign in required (Authorization: Bearer <accessToken>)");
  return id;
}
