import { and, asc, desc, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";
import { db } from "@/db";
import { customerDevices, customers, customerSquireIds, identityHelpRequests, otpCodes, refreshTokens } from "@/db/schema";
import { demoMode } from "@/lib/deployment";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { audit, customerActor } from "@/server/audit";
import { findOrCreateCustomer, lockIdentity, matchCustomer, mergeCustomers } from "@/server/customers";
import { AppError } from "@/server/errors";
import { sendNow } from "@/server/notifications/queue";
import { rateLimit } from "@/server/rate-limit";
import { smsOtpProvider, verifyCheck, verifySend } from "./otp-provider";
import { isReviewIdentifier, issueReviewCode, reviewProfile } from "./review-login";
import { randomToken, sha256, signToken, verifyToken } from "./tokens";

export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TTL_DAYS = 60;
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PER_HOUR = 5;
const OTP_PER_IP_HOUR = 20;
const IDENTITY_MAX_FAILURES = 5;

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

/** A US phone, or an email, with the client's IP for the per-IP limit and the Android SMS Retriever hash. */
export interface OtpStartInput {
  phone?: string | null;
  email?: string | null;
  appHash?: string | null;
  ip?: string | null;
}

async function countRecentCodes(identifier: string, purpose: string) {
  const rows = await db
    .select({ id: otpCodes.id })
    .from(otpCodes)
    .where(and(eq(otpCodes.identifier, identifier), eq(otpCodes.purpose, purpose), gt(otpCodes.createdAt, new Date(Date.now() - 3_600_000))));
  return rows.length;
}

/** Make and send a code. Texts go through the configured provider (Twilio Verify in production); emails through the email provider. */
async function sendCode(o: { identifier: string; to: string; channel: "sms" | "email"; purpose: string; subject: string; text: (code: string) => string; appHash?: string | null }) {
  if ((await countRecentCodes(o.identifier, o.purpose)) >= OTP_PER_HOUR) throw new AppError("rate_limited", "Too many codes requested. Try again later.");
  const provider = o.channel === "sms" ? smsOtpProvider() : "local";
  if (provider === "twilio_verify") {
    await verifySend(o.to, o.appHash);
    await db.insert(otpCodes).values({ identifier: o.identifier, codeHash: "twilio_verify", provider, purpose: o.purpose, expiresAt: new Date(Date.now() + OTP_TTL_MS) });
    return { channel: o.channel, expiresInSeconds: OTP_TTL_MS / 1000 };
  }
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await db.insert(otpCodes).values({ identifier: o.identifier, codeHash: sha256(`${o.identifier}:${code}`), purpose: o.purpose, expiresAt: new Date(Date.now() + OTP_TTL_MS) });
  const status = await sendNow({ kind: "otp", channel: o.channel, to: o.to, subject: o.subject, body: o.text(code), storedBody: o.text("••••••") });
  if (status === "failed") throw new AppError("internal", "We couldn't send your code. Try again in a minute.");
  return { channel: o.channel, expiresInSeconds: OTP_TTL_MS / 1000, ...(devCodesEnabled() ? { devCode: code } : {}) };
}

/** Check and use up the newest live code. Wrong codes count toward the attempt limit either way. */
async function consumeCode(identifier: string, to: string, purpose: string, code: string) {
  const [otp] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.identifier, identifier), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw new AppError("unauthorized", "Code expired. Request a new one.");
  const ok = otp.provider === "twilio_verify" ? await verifyCheck(to, code.trim()) : otp.codeHash === sha256(`${identifier}:${code.trim()}`);
  if (!ok) {
    await db.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
    throw new AppError("unauthorized", "That code isn't right");
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));
}

const SIGN_IN_TEXT = (code: string) => `Your Ray'z Barber Shop code is ${code}. It expires in 10 minutes.`;

export async function startOtp(input: OtpStartInput) {
  const { identifier, channel } = normalizeIdentifier(input);
  await rateLimit("otp_ip", input.ip ?? null, OTP_PER_IP_HOUR, 3_600_000, "Too many codes requested from this network. Try again later.");
  if (isReviewIdentifier(identifier)) {
    if (channel === "sms") return issueReviewCode(identifier, input.ip ?? null);
    await reviewProfile();
  }
  return sendCode({ identifier, to: identifier, channel, purpose: "sign_in", subject: "Your Ray'z sign-in code", text: SIGN_IN_TEXT, appHash: input.appHash });
}

const SELECTION_TTL_SECONDS = 10 * 60;
const IDLE_STEP_UP_MS = 548 * 86_400_000; // 18 months
type Selection = { sub: string; ch: "sms" | "email"; cid?: string };
type Customer = typeof customers.$inferSelect;

type StepUpReason = "idle_number" | "secured";
export type SignInResult =
  | { needsProfile: true; selectionToken: string }
  | { needsProfile: false; stepUp: "email"; selectionToken: string; emailHint: string; reason: StepUpReason }
  | { needsProfile: false; cantSignIn: true; selectionToken: string; reason: StepUpReason }
  | Awaited<ReturnType<typeof signIn>>;

/** I16: who may create an account. The app must ask (requireAge); anyone saying they're under 13 is refused. */
export interface AgeAnswer {
  ageConfirmed?: boolean | null;
  requireAge?: boolean;
}

function checkAge(a: AgeAnswer) {
  if (a.ageConfirmed === false) throw new AppError("forbidden", "You need to be 13 or older to have an account. A parent or guardian can add you to theirs.", { reason: "under_13" });
  if (a.requireAge && !a.ageConfirmed) throw new AppError("bad_request", "Confirm you're 13 or older", { reason: "age_confirmation_required", field: "ageConfirmed" });
}

export async function verifyOtp(
  input: { phone?: string | null; email?: string | null; code: string; firstName?: string | null; lastName?: string | null; deviceName?: string | null } & AgeAnswer,
): Promise<SignInResult> {
  const { identifier, channel } = normalizeIdentifier(input);
  await consumeCode(identifier, identifier, "sign_in", input.code);
  const selectionToken = await signToken({ sub: identifier, ch: channel } satisfies Selection, "otp_select", SELECTION_TTL_SECONDS);
  if (input.firstName?.trim())
    return completeSignIn({ selectionToken, firstName: input.firstName, lastName: input.lastName, deviceName: input.deviceName, ageConfirmed: input.ageConfirmed, requireAge: input.requireAge });
  const profiles = await profilesFor(identifier, channel);
  if (profiles.length === 1) return gate(profiles[0], { sub: identifier, ch: channel }, false, input.deviceName);
  // None, or a family sharing the number: ask for a name. Never list who else is on a number; it may have been recycled.
  return { needsProfile: true as const, selectionToken };
}

/** Adults on this number, or on this verified email. Unverified (imported or typed) emails never sign anyone in. */
async function profilesFor(identifier: string, channel: "sms" | "email") {
  return db
    .select()
    .from(customers)
    .where(and(channel === "sms" ? eq(customers.phone, identifier) : and(eq(customers.email, identifier), isNotNull(customers.emailVerifiedAt)), isNull(customers.guardianId)))
    .orderBy(asc(customers.createdAt))
    .limit(10);
}

/** When this profile was last active: its newest visit, app sign-in, staff or self identity confirmation, or creation. */
async function lastActive(c: Customer): Promise<Date> {
  const [row] = (await db.execute(sql`select max(starts_at) at from appointments where customer_id = ${c.id} and status <> 'cancelled' and starts_at <= now()`)) as unknown as { at: Date | string | null }[];
  const times = [c.createdAt, c.lastAppSignInAt, c.identityVerifiedAt, row?.at ? new Date(row.at) : null].filter((d): d is Date => !!d);
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

const maskEmail = (e: string) => {
  const [user, domain] = e.split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
};

/**
 * Before signing someone in by phone: a number unused for 18 months may belong to someone new now,
 * and a secured profile (I15) always asks, so either needs a code to the profile's verified email
 * too, or a staff check when there's none.
 */
async function gate(c: Customer, sel: Selection, isNew: boolean, deviceName?: string | null): Promise<SignInResult> {
  if (sel.ch === "sms" && !isNew && !isReviewIdentifier(sel.sub)) {
    const reason: StepUpReason | null = c.securedAt ? "secured" : Date.now() - (await lastActive(c)).getTime() > IDLE_STEP_UP_MS ? "idle_number" : null;
    if (reason) {
      const selectionToken = await signToken({ ...sel, cid: c.id } satisfies Selection, "otp_select", SELECTION_TTL_SECONDS);
      if (c.email && c.emailVerifiedAt) return { needsProfile: false as const, stepUp: "email" as const, selectionToken, emailHint: maskEmail(c.email), reason };
      return { needsProfile: false as const, cantSignIn: true as const, selectionToken, reason };
    }
  }
  return signIn(c, isNew, deviceName, sel);
}

/**
 * I14: the phone is proven now, so the unverified guest records booked on it under this first
 * name fold into one profile: the oldest record that isn't a guest one (or this one). Records
 * under other first names stay apart; they may be someone else sharing the phone.
 */
async function foldGuestRecords(c: Customer, phone: string): Promise<Customer> {
  const same = (
    await db
      .select()
      .from(customers)
      .where(and(eq(customers.phone, phone), isNull(customers.guardianId), isNull(customers.deletedAt), ne(customers.id, c.id)))
      .orderBy(asc(customers.createdAt))
  ).filter((x) => sameName(x.firstName, c.firstName));
  const all = [c, ...same];
  const guests = all.filter((x) => x.unverifiedGuestAt);
  if (!guests.length) return c;
  const keep = c.unverifiedGuestAt ? (same.find((x) => !x.unverifiedGuestAt) ?? c) : c;
  for (const g of guests) {
    if (g.id === keep.id) continue;
    await mergeCustomers(keep.id, g.id, { staffId: null, label: "system:guest_verified" }).catch((e: Error) => console.error("guest record fold failed", g.id, e.message));
  }
  await db.update(customers).set({ unverifiedGuestAt: null }).where(eq(customers.id, keep.id));
  const after = await db.query.customers.findFirst({ where: eq(customers.id, keep.id) });
  return after ?? keep;
}

/** An imported (Squire) profile someone hasn't yet confirmed is theirs. Loyalty redemption stays hidden until they do. */
export async function needsIdentityCheck(c: Pick<Customer, "id" | "identityVerifiedAt" | "source">): Promise<boolean> {
  if (c.identityVerifiedAt) return false;
  if (c.source === "Squire import") return true;
  const [hit] = await db.select({ id: customerSquireIds.customerId }).from(customerSquireIds).where(eq(customerSquireIds.customerId, c.id)).limit(1);
  return !!hit;
}

async function signIn(c: Customer, isNew: boolean, deviceName?: string | null, sel?: Selection) {
  const customer = sel?.ch === "sms" ? await foldGuestRecords(c, sel.sub) : c;
  if (sel && isReviewIdentifier(sel.sub)) await audit({ staffId: null, label: "review" }, "review.sign_in", "customer", customer.id, { channel: sel.ch }, null);
  const tokens = await issueTokens(customer.id, deviceName ?? null);
  await db.update(customers).set({ lastAppSignInAt: new Date() }).where(eq(customers.id, customer.id));
  return { needsProfile: false as const, isNew, customer, identityCheckRequired: await needsIdentityCheck(customer), ...tokens };
}

/**
 * Second step after a verified code: a name. By phone it matches a profile on that number with the
 * shared rules, or creates one (a family member on the same phone). By email it matches only a
 * profile whose email is verified, or creates one with the email verified.
 */
export async function completeSignIn(
  input: { selectionToken: string; customerId?: string | null; firstName?: string | null; lastName?: string | null; deviceName?: string | null } & AgeAnswer,
): Promise<SignInResult> {
  const t = await verifyToken<Selection>(input.selectionToken, "otp_select");
  if (!t) throw new AppError("unauthorized", "Code expired. Request a new one.");
  const sel: Selection = { sub: t.sub, ch: t.ch };
  const identifier = t.sub;
  const firstName = input.firstName?.trim();
  if (!firstName) throw new AppError("bad_request", "Tell us your first name");
  if (t.ch === "email") {
    const mine = (await profilesFor(identifier, "email")).find((p) => sameName(p.firstName, firstName));
    if (mine) return gate(mine, sel, false, input.deviceName);
    checkAge(input);
    const c = await findOrCreateCustomer({ firstName, lastName: input.lastName, ageConfirmed: !!input.ageConfirmed }, null, db, { allowNoContact: true });
    await db.update(customers).set({ email: identifier, emailVerifiedAt: new Date() }).where(eq(customers.id, c.id));
    return gate({ ...c, email: identifier }, sel, true, input.deviceName);
  }
  const { customer, isNew } = await db.transaction(async (tx) => {
    await lockIdentity(tx, [identifier]);
    const m = await matchCustomer(tx, { firstName, lastName: input.lastName, phone: identifier });
    if (m && m.customer.phone === identifier && !m.customer.guardianId) return { customer: m.customer, isNew: false };
    checkAge(input);
    const c = await findOrCreateCustomer({ firstName, lastName: input.lastName, phone: identifier, ageConfirmed: !!input.ageConfirmed }, null, tx);
    return { customer: c, isNew: c.createdAt.getTime() > Date.now() - 60_000 };
  });
  return gate(customer, sel, isNew, input.deviceName);
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Idle number: send a code to the profile's verified email. */
export async function startStepUp(selectionToken: string) {
  const t = await verifyToken<Selection>(selectionToken, "otp_select");
  if (!t?.cid) throw new AppError("unauthorized", "Start again with a new code.");
  const c = await db.query.customers.findFirst({ where: eq(customers.id, t.cid) });
  if (!c?.email || !c.emailVerifiedAt) throw new AppError("forbidden", "There's no verified email on this profile. Ask the shop to help you sign in.");
  return sendCode({ identifier: `step:${c.id}`, to: c.email, channel: "email", purpose: "step_up", subject: "Confirm it's you", text: SIGN_IN_TEXT });
}

export async function verifyStepUp(selectionToken: string, code: string, deviceName?: string | null) {
  const t = await verifyToken<Selection>(selectionToken, "otp_select");
  if (!t?.cid) throw new AppError("unauthorized", "Start again with a new code.");
  const c = await db.query.customers.findFirst({ where: eq(customers.id, t.cid) });
  if (!c?.email || !c.emailVerifiedAt) throw new AppError("forbidden", "There's no verified email on this profile.");
  await consumeCode(`step:${c.id}`, c.email, "step_up", code);
  return signIn(c, false, deviceName, { sub: t.sub, ch: t.ch });
}

/**
 * The light check on an imported profile's first app sign-in: their last name, or the shop of their
 * last visit. Five misses lock it and open a staff task.
 */
export async function checkIdentity(customerId: string, answer: { lastName?: string | null; lastShop?: string | null }) {
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c) throw new AppError("not_found", "Customer not found");
  if (!(await needsIdentityCheck(c))) return { verified: true };
  if (c.identityCheckFailures >= IDENTITY_MAX_FAILURES) throw new AppError("forbidden", "We couldn't confirm it's you. The shop will be in touch to help.");
  const [last] = (await db.execute(
    sql`select s.slug, s.name from appointments a join shops s on s.id = a.shop_id where a.customer_id = ${c.id} and a.status = 'completed' order by a.starts_at desc limit 1`,
  )) as unknown as { slug: string; name: string }[];
  const byName = !!answer.lastName?.trim() && !!c.lastName && sameName(answer.lastName, c.lastName);
  const byShop = !!answer.lastShop?.trim() && !!last && (sameName(answer.lastShop, last.slug) || sameName(answer.lastShop, last.name));
  if (byName || byShop) {
    await db.update(customers).set({ identityVerifiedAt: new Date(), identityCheckFailures: 0 }).where(eq(customers.id, c.id));
    return { verified: true };
  }
  const failures = c.identityCheckFailures + 1;
  await db.update(customers).set({ identityCheckFailures: failures }).where(eq(customers.id, c.id));
  if (failures >= IDENTITY_MAX_FAILURES) {
    await db.insert(identityHelpRequests).values({ phone: c.phone, email: c.email, firstName: c.firstName, lastName: null, reason: "identity_check", candidateIds: [c.id] });
    throw new AppError("forbidden", "We couldn't confirm it's you. The shop will be in touch to help.");
  }
  throw new AppError("unauthorized", "That doesn't match what we have.", { attemptsLeft: IDENTITY_MAX_FAILURES - failures });
}

/** "I can't sign in": a staff task. With a selection token the number is proven and the profiles on it are attached. */
export async function requestSignInHelp(input: { selectionToken?: string | null; phone?: string | null; email?: string | null; firstName: string; lastName?: string | null; message?: string | null; ip?: string | null }) {
  await rateLimit("sign_in_help", input.ip ?? null, 5, 3_600_000);
  const t = input.selectionToken ? await verifyToken<Selection>(input.selectionToken, "otp_select") : null;
  const phone = t?.ch === "sms" ? t.sub : normalizePhone(input.phone);
  const email = t?.ch === "email" ? t.sub : normalizeEmail(input.email);
  if (!phone && !email) throw new AppError("bad_request", "Give the phone number or email you used at the shop");
  const candidates = t ? (t.cid ? [t.cid] : (await profilesFor(t.sub, t.ch)).map((p) => p.id)) : [];
  await db.insert(identityHelpRequests).values({
    phone,
    email,
    firstName: input.firstName.trim(),
    lastName: input.lastName?.trim() || null,
    message: input.message?.trim() || null,
    reason: t?.cid ? "idle_number" : "cant_sign_in",
    candidateIds: candidates,
  });
  return { received: true };
}

/** C17: a new email is written only once a code sent to it is entered. */
export async function startEmailChange(customerId: string, rawEmail: string, ip?: string | null) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AppError("bad_request", "Enter a valid email");
  await rateLimit("email_change_ip", ip ?? null, OTP_PER_IP_HOUR, 3_600_000);
  return sendCode({ identifier: `${customerId}:${email}`, to: email, channel: "email", purpose: "email_change", subject: "Confirm your email", text: (code) => `Your Ray'z Barber Shop code to confirm this email is ${code}. It expires in 10 minutes.` });
}

export async function verifyEmailChange(customerId: string, rawEmail: string, code: string) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AppError("bad_request", "Enter a valid email");
  await consumeCode(`${customerId}:${email}`, email, "email_change", code);
  await db.update(customers).set({ email, emailVerifiedAt: new Date() }).where(eq(customers.id, customerId));
}

/** C10: deleting an account needs a fresh code, to the profile's phone or else its verified email. A child's goes to the guardian. */
export async function startDeletionCode(customerId: string) {
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c || c.deletedAt) throw new AppError("not_found", "Customer not found");
  const text = (code: string) => `Your Ray'z Barber Shop code to delete your account is ${code}. If you didn't ask for this, ignore it.`;
  if (c.phone) return sendCode({ identifier: `delete:${c.id}`, to: c.phone, channel: "sms", purpose: "delete", subject: "Delete your account", text });
  if (c.email && c.emailVerifiedAt) return sendCode({ identifier: `delete:${c.id}`, to: c.email, channel: "email", purpose: "delete", subject: "Delete your account", text });
  throw new AppError("forbidden", "There's no phone or confirmed email to send a code to. Ask the shop to delete your account.");
}

export async function checkDeletionCode(customerId: string, code: string) {
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c || c.deletedAt) throw new AppError("not_found", "Customer not found");
  const to = c.phone ?? c.email;
  if (!to) throw new AppError("unauthorized", "Code expired. Request a new one.");
  await consumeCode(`delete:${c.id}`, to, "delete", code);
}

/** A new sign-in starts a session; a refresh continues `sessionId`. The access token names the session (sid). */
export async function issueTokens(customerId: string, deviceName: string | null, sessionId?: string) {
  const id = randomUUID();
  const sid = sessionId ?? id;
  const refreshToken = randomToken(32);
  await db.insert(refreshTokens).values({
    id,
    customerId,
    sessionId: sid,
    tokenHash: sha256(refreshToken),
    deviceName,
    expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
  });
  const accessToken = await signToken({ sub: customerId, sid }, "customer_access", ACCESS_TTL_SECONDS);
  return { accessToken, refreshToken, tokenType: "Bearer" as const, expiresIn: ACCESS_TTL_SECONDS, refreshTokenId: id };
}

/** Rotating refresh tokens. Re-using an already-rotated token revokes every session for that customer. */
export async function refresh(refreshToken: string) {
  const row = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256(refreshToken)) });
  if (!row) throw new AppError("unauthorized", "Invalid refresh token");
  if (row.revokedAt) {
    const live = await db.selectDistinct({ sessionId: refreshTokens.sessionId }).from(refreshTokens).where(and(eq(refreshTokens.customerId, row.customerId), isNull(refreshTokens.revokedAt)));
    for (const s of live) await endSession(s.sessionId);
    throw new AppError("unauthorized", "Refresh token was already used; please sign in again");
  }
  if (row.expiresAt < new Date()) throw new AppError("unauthorized", "Session expired; please sign in again");
  const next = await issueTokens(row.customerId, row.deviceName, row.sessionId);
  await db.update(refreshTokens).set({ revokedAt: new Date(), replacedBy: next.refreshTokenId }).where(eq(refreshTokens.id, row.id));
  return next;
}

/** Sign out: the session ends, so its access token stops working too, and its push devices stop getting pushes. */
export async function revoke(refreshToken: string) {
  const row = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256(refreshToken)), columns: { sessionId: true } });
  if (row) await endSession(row.sessionId);
}

export async function endSession(sessionId: string, now = new Date()) {
  await db.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)));
  await db.update(customerDevices).set({ revokedAt: now }).where(and(eq(customerDevices.sessionId, sessionId), isNull(customerDevices.revokedAt)));
}

async function accessOf(req: Request): Promise<{ sub: string; sid?: string } | null> {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return null;
  const payload = await verifyToken<{ sub: string; sid?: string }>(h.slice(7).trim(), "customer_access");
  if (!payload?.sub) return null;
  // Tokens issued before sessions (no sid) run out within the hour.
  if (payload.sid) {
    const [live] = await db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.sessionId, payload.sid), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())))
      .limit(1);
    if (!live) return null;
  }
  return payload;
}

export async function customerFromRequest(req: Request): Promise<string | null> {
  return (await accessOf(req))?.sub ?? null;
}

/** The session of the request's access token (I12), when it names one. */
export async function sessionFromRequest(req: Request): Promise<string | null> {
  return (await accessOf(req))?.sid ?? null;
}

export async function requireCustomer(req: Request): Promise<string> {
  const id = await customerFromRequest(req);
  if (!id) throw new AppError("unauthorized", "Sign in required (Authorization: Bearer <accessToken>)");
  const live = await db.query.customers.findFirst({ where: eq(customers.id, id), columns: { deletedAt: true } });
  if (!live || live.deletedAt) throw new AppError("unauthorized", "This account was deleted");
  return id;
}

/** I12: the customer's signed-in devices. One row per session, newest activity first. */
export async function listSessions(customerId: string, currentSessionId: string | null) {
  const rows = (await db.execute(sql`
    select session_id, max(device_name) filter (where revoked_at is null) device_name, min(created_at) started_at, max(created_at) last_active_at
    from refresh_tokens
    where customer_id = ${customerId}
      and session_id in (select session_id from refresh_tokens where customer_id = ${customerId} and revoked_at is null and expires_at > now())
    group by session_id
    order by max(created_at) desc`)) as unknown as { session_id: string; device_name: string | null; started_at: Date | string; last_active_at: Date | string }[];
  return rows.map((r) => ({
    id: r.session_id,
    deviceName: r.device_name,
    signedInAt: new Date(r.started_at).toISOString(),
    lastActiveAt: new Date(r.last_active_at).toISOString(),
    current: r.session_id === currentSessionId,
  }));
}

/** Sign out one of the customer's sessions, or every one but this (`except`). */
export async function endSessions(customerId: string, which: { id: string } | { except: string | null }) {
  const live = await listSessions(customerId, null);
  const ids = "id" in which ? live.filter((s) => s.id === which.id).map((s) => s.id) : live.filter((s) => s.id !== which.except).map((s) => s.id);
  if ("id" in which && !ids.length) throw new AppError("not_found", "Session not found");
  for (const id of ids) await endSession(id);
  if (ids.length) {
    const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId), columns: { firstName: true } });
    await audit(customerActor(c?.firstName ?? "customer"), "customer.sessions_ended", "customer", customerId, { count: ids.length }, null);
  }
  return { ended: ids.length };
}
