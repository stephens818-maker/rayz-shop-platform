import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { db } from "@/db";
import { customers, otpCodes, refreshTokens } from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { findOrCreateCustomer, lockIdentity, matchCustomer } from "@/server/customers";
import { AppError } from "@/server/errors";
import { sendNow } from "@/server/notifications/queue";
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

/** Never in a production build, whatever the env flag says. */
export function devCodesEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.AUTH_DEV_CODES === "true";
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
  const status = await sendNow({
    kind: "otp",
    channel,
    to: identifier,
    subject: "Your Ray'z sign-in code",
    body: `Your Ray'z Barber Shop code is ${code}. It expires in 10 minutes.`,
    storedBody: "Your Ray'z Barber Shop code is ••••••. It expires in 10 minutes.",
  });
  if (status === "failed") throw new AppError("internal", "We couldn't send your code. Try again in a minute.");
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

  const profiles = await profilesFor(identifier, channel);
  const selectionToken = await signToken({ sub: identifier, ch: channel }, "otp_select", SELECTION_TTL_SECONDS);
  if (input.firstName?.trim()) return completeSignIn({ selectionToken, firstName: input.firstName, lastName: input.lastName, deviceName: input.deviceName });
  if (profiles.length === 1) return signIn(profiles[0], false, input.deviceName);
  if (profiles.length === 0) return { needsProfile: true as const, selectionToken };
  // Families share phones: never guess which person this is.
  return {
    needsProfile: false as const,
    chooseProfile: true as const,
    selectionToken,
    profiles: profiles.map((p) => ({ id: p.id, firstName: p.firstName, lastInitial: p.lastName?.[0]?.toUpperCase() ?? null })),
  };
}

const SELECTION_TTL_SECONDS = 10 * 60;

async function profilesFor(identifier: string, channel: "sms" | "email") {
  return db
    .select()
    .from(customers)
    .where(channel === "sms" ? eq(customers.phone, identifier) : eq(customers.email, identifier))
    .orderBy(asc(customers.createdAt))
    .limit(10);
}

async function signIn(customer: typeof customers.$inferSelect, isNew: boolean, deviceName?: string | null) {
  const tokens = await issueTokens(customer.id, deviceName ?? null);
  return { needsProfile: false as const, chooseProfile: false as const, isNew, customer, ...tokens };
}

/**
 * Second step after a verified code: pick one of the profiles on that phone/email, or give a name.
 * A name matches an existing profile with the shared rules, otherwise creates a new one (a family
 * member on the same phone).
 */
export async function completeSignIn(input: { selectionToken: string; customerId?: string | null; firstName?: string | null; lastName?: string | null; deviceName?: string | null }) {
  const t = await verifyToken<{ sub: string; ch: "sms" | "email" }>(input.selectionToken, "otp_select");
  if (!t) throw new AppError("unauthorized", "Code expired. Request a new one.");
  const identifier = t.sub;
  if (input.customerId) {
    const pick = (await profilesFor(identifier, t.ch)).find((p) => p.id === input.customerId);
    if (!pick) throw new AppError("forbidden", "That profile isn't on this phone number");
    return signIn(pick, false, input.deviceName);
  }
  const firstName = input.firstName?.trim();
  if (!firstName) throw new AppError("bad_request", "Pick a profile or tell us your first name");
  const contact = t.ch === "sms" ? { phone: identifier } : { email: identifier };
  const { customer, isNew } = await db.transaction(async (tx) => {
    await lockIdentity(tx, [identifier]);
    const m = await matchCustomer(tx, { firstName, lastName: input.lastName, ...contact });
    if (m) return { customer: m.customer, isNew: false };
    const c = await findOrCreateCustomer({ firstName, lastName: input.lastName, ...contact }, null, tx);
    return { customer: c, isNew: true };
  });
  return signIn(customer, isNew, input.deviceName);
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
