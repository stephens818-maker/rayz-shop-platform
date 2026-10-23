import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { db } from "@/db";
import { appointments, customers, otpCodes, refreshTokens } from "@/db/schema";
import { appBaseUrl, demoMode } from "@/lib/deployment";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { findOrCreateCustomer, lockIdentity, matchCustomer } from "@/server/customers";
import { AppError } from "@/server/errors";
import { accessGate } from "@/server/mobile/identity";
import { limitOtp } from "@/server/mobile/rate-limit";
import { message } from "@/server/mobile/rules";
import { autofillSmsBody, checkTwilioVerify, reviewCodeFor, startTwilioVerify, twilioVerifyConfigured } from "@/server/mobile/verify";
import { audit, SYSTEM } from "@/server/audit";
import { sendNow } from "@/server/notifications/queue";
import { randomToken, sha256, signToken, verifyToken } from "./tokens";

export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TTL_DAYS = 60;
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;

export function normalizeIdentifier(input: { phone?: string | null; email?: string | null }) {
  const phone = normalizePhone(input.phone);
  if (phone) return { identifier: phone, channel: "sms" as const };
  const email = normalizeEmail(input.email);
  if (email) return { identifier: email, channel: "email" as const };
  throw new AppError("bad_request", "Provide a valid US phone number or email");
}

/** Never in a production build, whatever the env flag says, except a demo, which sends nothing and so has to show the code. */
export function devCodesEnabled() {
  return demoMode() || (process.env.NODE_ENV !== "production" && process.env.AUTH_DEV_CODES === "true");
}

export interface OtpContext {
  ip?: string | null;
  deviceKey?: string | null;
  purpose?: "signin" | "email_change" | "delete" | "step_up";
  androidHash?: string | null;
  locale?: "en" | "es";
}

export async function startOtp(input: { phone?: string | null; email?: string | null }, ctx: OtpContext = {}) {
  const { identifier, channel } = normalizeIdentifier(input);
  const purpose = ctx.purpose ?? "signin";
  await limitOtp({ identifier: `${purpose}:${identifier}`, ip: ctx.ip, deviceKey: ctx.deviceKey });
  const fixed = channel === "sms" ? reviewCodeFor(identifier) : null;
  if (fixed) {
    await db.insert(otpCodes).values({
      identifier,
      purpose,
      channel,
      ip: ctx.ip ?? null,
      deviceKey: ctx.deviceKey ?? null,
      codeHash: sha256(`${identifier}:${fixed}`),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });
    await audit(SYSTEM, "auth.review_login", "customer", null, { identifier }, null);
    return { channel, expiresInSeconds: OTP_TTL_MS / 1000, review: true as const };
  }
  if (channel === "sms" && purpose === "signin" && twilioVerifyConfigured()) {
    const sid = await startTwilioVerify(identifier, "sms", ctx.androidHash);
    await db.insert(otpCodes).values({
      identifier,
      purpose,
      channel,
      ip: ctx.ip ?? null,
      deviceKey: ctx.deviceKey ?? null,
      codeHash: "twilio-verify",
      verifySid: sid,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });
    return { channel, expiresInSeconds: OTP_TTL_MS / 1000, delivery: "twilio_verify" as const };
  }
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await db.insert(otpCodes).values({
    identifier,
    purpose,
    channel,
    ip: ctx.ip ?? null,
    deviceKey: ctx.deviceKey ?? null,
    codeHash: sha256(`${identifier}:${code}`),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  const domain = (process.env.APP_LINK_DOMAIN ?? appBaseUrl().replace(/^https?:\/\//, "")).replace(/\/$/, "");
  const body = channel === "sms" ? autofillSmsBody(code, domain, ctx.androidHash) : `Your Ray'z Barber Shop code is ${code}. It expires in 10 minutes.`;
  const status = await sendNow({
    kind: "otp",
    channel,
    to: identifier,
    subject: "Your Ray'z sign-in code",
    body,
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
  purpose?: "signin" | "email_change" | "delete" | "step_up";
  /** When set, a step-up code only proves the address. The caller finishes the profile change. */
  consumeOnly?: boolean;
  birthYear?: number | null;
  locale?: "en" | "es";
}) {
  const { identifier, channel } = normalizeIdentifier(input);
  const purpose = input.purpose ?? "signin";
  const locale = input.locale ?? "en";
  const [otp] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.identifier, identifier), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw new AppError("unauthorized", message(locale, "code_expired"));
  const submitted = input.code.trim();
  const approved = otp.verifySid ? await checkTwilioVerify(identifier, submitted) : otp.codeHash === sha256(`${identifier}:${submitted}`);
  if (!approved) {
    await db.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
    throw new AppError("unauthorized", message(locale, "code_invalid"));
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));
  if (input.consumeOnly || purpose !== "signin") return { verified: true as const, identifier, channel, purpose };

  const profiles = await profilesFor(identifier, channel);
  const selectionToken = await signToken({ sub: identifier, ch: channel }, "otp_select", SELECTION_TTL_SECONDS);
  if (input.firstName?.trim()) {
    return completeSignIn({ selectionToken, firstName: input.firstName, lastName: input.lastName, deviceName: input.deviceName, birthYear: input.birthYear });
  }
  if (profiles.length === 1) return signIn(profiles[0], false, input.deviceName, channel);
  if (profiles.length === 0) return { needsProfile: true as const, selectionToken };
  // Families share phones: never guess which person this is.
  return {
    needsProfile: false as const,
    chooseProfile: true as const,
    selectionToken,
    profiles: profiles.map((p) => ({ id: p.id, firstName: p.firstName })),
  };
}

const SELECTION_TTL_SECONDS = 10 * 60;

async function adoptUnverifiedGuests(customerId: string, phone: string) {
  const guests = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.phone, phone), eq(customers.unverifiedGuest, true), isNull(customers.deletedAt)));
  for (const g of guests) {
    if (g.id === customerId) continue;
    await db.update(appointments).set({ customerId }).where(eq(appointments.customerId, g.id));
    await db.update(customers).set({ deletedAt: new Date(), phone: null, email: null, unverifiedGuest: false, firstName: "Guest", lastName: null }).where(eq(customers.id, g.id));
  }
}

async function profilesFor(identifier: string, channel: "sms" | "email") {
  // Email OTP already proved the inbox, so an imported address becomes a login identifier here and is marked verified on sign-in.
  // Unverified addresses never match a code that was not sent to them, and PATCH /me cannot set email.
  return db
    .select()
    .from(customers)
    .where(and(channel === "sms" ? eq(customers.phone, identifier) : eq(customers.email, identifier), isNull(customers.deletedAt), eq(customers.unverifiedGuest, false)))
    .orderBy(asc(customers.createdAt))
    .limit(10);
}

async function signIn(customer: typeof customers.$inferSelect, isNew: boolean, deviceName?: string | null, channel?: "sms" | "email") {
  if (channel === "email" && !customer.emailVerifiedAt) {
    await db.update(customers).set({ emailVerifiedAt: new Date() }).where(eq(customers.id, customer.id));
    customer = { ...customer, emailVerifiedAt: new Date() };
  }
  if (channel === "sms" && customer.phone) await adoptUnverifiedGuests(customer.id, customer.phone);
  const gate = await accessGate(customer);
  if (gate) {
    const selectionToken = await signToken({ sub: customer.phone ?? customer.email ?? customer.id, ch: channel ?? "sms", customerId: customer.id }, "otp_select", SELECTION_TTL_SECONDS);
    return { needsProfile: false as const, chooseProfile: false as const, isNew, selectionToken, customerId: customer.id, ...gate };
  }
  const tokens = await issueTokens(customer.id, deviceName ?? null);
  return { needsProfile: false as const, chooseProfile: false as const, isNew, customer, ...tokens };
}

/**
 * Second step after a verified code: pick one of the profiles on that phone/email, or give a name.
 * A name matches an existing profile with the shared rules, otherwise creates a new one (a family
 * member on the same phone).
 */
export async function completeSignIn(input: {
  selectionToken: string;
  customerId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  deviceName?: string | null;
  birthYear?: number | null;
  /** ios/android account creation requires age 13+. Direct server calls (staff tools, tests) leave this off. */
  requireAdult?: boolean;
}) {
  const t = await verifyToken<{ sub: string; ch: "sms" | "email"; customerId?: string }>(input.selectionToken, "otp_select");
  if (!t) throw new AppError("unauthorized", "Code expired. Request a new one.");
  const identifier = t.sub;
  if (input.customerId || t.customerId) {
    const id = input.customerId ?? t.customerId!;
    const pick = (await profilesFor(identifier, t.ch)).find((p) => p.id === id) ?? (t.customerId === id ? await db.query.customers.findFirst({ where: eq(customers.id, id) }) : undefined);
    if (!pick || pick.deletedAt) throw new AppError("forbidden", "That profile isn't on this phone number");
    return signIn(pick, false, input.deviceName, t.ch);
  }
  const firstName = input.firstName?.trim();
  if (!firstName) throw new AppError("bad_request", "Pick a profile or tell us your first name");
  if (input.requireAdult) {
    const { ageAllowed } = await import("@/server/mobile/rules");
    if (input.birthYear == null || !ageAllowed(input.birthYear)) throw new AppError("forbidden", message("en", "age"));
  }
  const contact = t.ch === "sms" ? { phone: identifier } : { email: identifier };
  const { customer, isNew } = await db.transaction(async (tx) => {
    await lockIdentity(tx, [identifier]);
    const m = await matchCustomer(tx, { firstName, lastName: input.lastName, ...contact });
    if (m && !m.customer.deletedAt && !m.customer.unverifiedGuest) return { customer: m.customer, isNew: false };
    const c = await findOrCreateCustomer({ firstName, lastName: input.lastName, ...contact }, null, tx);
    if (input.birthYear != null) {
      await tx.update(customers).set({ birthYear: input.birthYear, ageConfirmedAt: new Date() }).where(eq(customers.id, c.id));
    }
    return { customer: c, isNew: true };
  });
  return signIn(customer, isNew, input.deviceName, t.ch);
}

export async function issueTokens(customerId: string, deviceName: string | null, meta?: { client?: string | null; appVersion?: string | null; ip?: string | null; deviceId?: string | null }) {
  const accessToken = await signToken({ sub: customerId }, "customer_access", ACCESS_TTL_SECONDS);
  const refreshToken = randomToken(32);
  const [row] = await db
    .insert(refreshTokens)
    .values({
      customerId,
      tokenHash: sha256(refreshToken),
      deviceName,
      client: meta?.client ?? null,
      appVersion: meta?.appVersion ?? null,
      ip: meta?.ip ?? null,
      deviceId: meta?.deviceId ?? null,
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
  const c = await db.query.customers.findFirst({ where: eq(customers.id, id), columns: { id: true, deletedAt: true } });
  if (!c || c.deletedAt) throw new AppError("unauthorized", "Sign in required (Authorization: Bearer <accessToken>)");
  return id;
}
