import "server-only";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { otpCodes, staff, staffAppTokens, staffInvites } from "@/db/schema";
import { passwordProblem } from "@/domain/users";
import { appBaseUrl } from "@/lib/deployment";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { audit } from "@/server/audit";
import { devCodesEnabled } from "@/server/auth/customer";
import { smsOtpProvider, verifyCheck, verifySend } from "@/server/auth/otp-provider";
import type { StaffContext } from "@/server/auth/staff";
import { randomToken, sha256 } from "@/server/auth/tokens";
import { signInFactorFor } from "@/server/auth/sign-in-guard";
import { twoFactorPrompt } from "@/server/auth/two-factor";
import { AppError, notFound } from "@/server/errors";
import { sendNow } from "@/server/notifications/queue";
import { rateLimit } from "@/server/rate-limit";
import { assertMay } from "@/server/users";
import { Install, StaffLoginResult, admit, endAllStaffAppSessions, endStaffAppSession } from "./auth";

/**
 * The staff app's other ways in (ST-C1, ST-C10): a code by text or email instead of the password, and
 * a staff app invite link that sets up the login. Both still end at the authenticator code for anyone
 * with two-step sign-in, and at the location sign-in rules. Answers never say whether an account exists.
 */

const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const WINDOW_MS = 15 * 60_000;
export const APP_INVITE_TTL_DAYS = 3;
const PURPOSE = "staff_sign_in";

type Where = { ip: string | null; userAgent: string | null };
type Person = typeof staff.$inferSelect;

/** The signed-up person a phone or email belongs to; null for anyone else (shop logins, invited-only, inactive). */
async function personFor(input: { email?: string | null; phone?: string | null }): Promise<{ person: Person | null; channel: "sms" | "email"; to: string }> {
  const phone = normalizePhone(input.phone);
  const email = phone ? null : normalizeEmail(input.email);
  if (!phone && !email) throw new AppError("bad_request", "Send the phone number or email you use at Ray'z", { field: phone === null && input.phone ? "phone" : "email" });
  const rows = await db
    .select()
    .from(staff)
    .where(and(phone ? eq(staff.phone, phone) : sql`lower(${staff.email}) = ${email}`, eq(staff.active, true), isNull(staff.removedAt), eq(staff.kind, "person")))
    .limit(2);
  // A phone shared by two people signs in neither: they use their email.
  const person = rows.length === 1 && rows[0].passwordHash ? rows[0] : null;
  return { person, channel: phone ? "sms" : "email", to: (phone ?? email)! };
}

const codeText = (code: string) => `Your Ray'z Team sign-in code is ${code}. It expires in 10 minutes. Ray'z will never ask you for it.`;

/** Texts or emails a sign-in code to the person with that phone or email. The same answer either way. */
export async function startStaffCode(input: { email?: string | null; phone?: string | null }, where: Where) {
  await rateLimit("staff_app_code_ip", where.ip, 20, 3_600_000, "Too many codes requested from this network. Try again later.");
  const { person, channel, to } = await personFor(input);
  await rateLimit("staff_app_code_to", to, CODES_PER_HOUR, 3_600_000, "Too many codes requested. Try again later.");
  const answer = { channel, expiresInSeconds: CODE_TTL_MS / 1000 };
  if (!person) return answer;
  const identifier = `staff:${person.id}`;
  if (channel === "sms" && smsOtpProvider() === "twilio_verify") {
    await verifySend(to);
    await db.insert(otpCodes).values({ identifier, codeHash: "twilio_verify", provider: "twilio_verify", purpose: PURPOSE, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
    return answer;
  }
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await db.insert(otpCodes).values({ identifier, codeHash: sha256(`${identifier}:${code}`), purpose: PURPOSE, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
  const status = await sendNow({ kind: "otp", channel, to, subject: "Your Ray'z Team sign-in code", body: codeText(code), storedBody: codeText("••••••") });
  if (status === "failed") throw new AppError("internal", "We couldn't send your code. Try again in a minute.");
  return { ...answer, ...(devCodesEnabled() ? { devCode: code } : {}) };
}

/** The code from startStaffCode: tokens, or the authenticator step for someone with two-step sign-in. */
export async function verifyStaffCode(input: { email?: string | null; phone?: string | null; code: string } & Install, where: Where): Promise<StaffLoginResult> {
  await rateLimit("staff_app_login_ip", where.ip, 30, WINDOW_MS, "Too many sign-in attempts. Try again in 15 minutes.");
  const { person, to } = await personFor(input);
  const wrong = new AppError("unauthorized", "That code isn't right, or it expired. Request a new one.");
  if (!person) throw wrong;
  const identifier = `staff:${person.id}`;
  const [otp] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.identifier, identifier), eq(otpCodes.purpose, PURPOSE), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!otp || otp.attempts >= CODE_MAX_ATTEMPTS) throw wrong;
  const code = input.code.trim();
  const ok = otp.provider === "twilio_verify" ? await verifyCheck(to, code) : otp.codeHash === sha256(`${identifier}:${code}`);
  if (!ok) {
    await db.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
    throw wrong;
  }
  const [used] = await db
    .update(otpCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(otpCodes.id, otp.id), isNull(otpCodes.consumedAt)))
    .returning({ id: otpCodes.id });
  if (!used) throw wrong;
  const step = await signInFactorFor(person);
  if (step) return { twoFactor: await twoFactorPrompt(person, step) };
  return { tokens: await admit(person, where, input, false, "code") };
}

// ───────────────────────────── Staff app invites ─────────────────────────────

const inviteText = (firstName: string, by: string, link: string) =>
  [
    `Hi ${firstName}, ${by} invited you to the Ray'z Team app.`,
    `Open this link on your phone to sign in. It works once, for ${APP_INVITE_TTL_DAYS} days:`,
    link,
    "If you weren't expecting this, ignore it.",
  ].join("\n\n");

/**
 * Sends someone the staff app's sign-in link by text (their phone) or email. Opening it signs them in
 * once; someone who hasn't signed up sets their password there. A new link cancels the last one.
 * The outbox keeps the message without the link; the link comes back only when it couldn't go.
 */
export async function sendStaffAppInvite(ctx: StaffContext, staffId: string, channel: "sms" | "email" | null = null) {
  const { row } = await assertMay(ctx, staffId, "app_invite");
  const via = channel ?? (row.phone ? "sms" : "email");
  const to = via === "sms" ? row.phone : row.email;
  if (!to) throw new AppError("bad_request", via === "sms" ? "Add their mobile number first" : "Add their email first");
  const token = randomToken(32);
  await db.transaction(async (tx) => {
    await tx
      .update(staffInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffInvites.staffId, staffId), eq(staffInvites.purpose, "staff_app"), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt)));
    await tx.insert(staffInvites).values({ staffId, tokenHash: sha256(token), purpose: "staff_app", channel: via, expiresAt: new Date(Date.now() + APP_INVITE_TTL_DAYS * 86_400_000), createdBy: ctx.staff.id });
    await audit(ctx.actor, "user.app_invite", "staff", staffId, { name: row.displayLabel, channel: via }, ctx.currentShopId, tx);
  });
  const link = `${appBaseUrl()}/staff-app/invite/${token}`;
  const status = await sendNow({
    kind: "staff_app_invite",
    channel: via,
    to,
    subject: "Your Ray'z Team app invite",
    body: inviteText(row.firstName, ctx.staff.displayLabel, link),
    storedBody: inviteText(row.firstName, ctx.staff.displayLabel, "[sign-in link removed]"),
  });
  return { channel: via, delivered: status === "sent", link: status === "sent" ? null : link };
}

async function openAppInvite(token: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [r] = await db
    .select({ invite: staffInvites, person: staff })
    .from(staffInvites)
    .innerJoin(staff, eq(staff.id, staffInvites.staffId))
    .where(and(eq(staffInvites.tokenHash, sha256(token)), eq(staffInvites.purpose, "staff_app"), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt), gt(staffInvites.expiresAt, now)));
  if (!r || !r.person.active || r.person.removedAt || r.person.kind !== "person") return null;
  return r;
}

/** What the invite screen shows: their first name and whether they set a password. Nothing for a used or wrong link. */
export async function appInviteView(token: string) {
  const r = await openAppInvite(token);
  if (!r) throw notFound("Invite");
  return { firstName: r.person.firstName, setPassword: !r.person.passwordHash, twoStep: !!(await signInFactorFor(r.person)), expiresAt: r.invite.expiresAt.toISOString() };
}

/**
 * Uses the invite: sets their password when they haven't one (held to the password rules), then
 * tokens, or the authenticator step (or its setup) for two-step sign-in. The link works once.
 */
export async function acceptAppInvite(input: { token: string; password?: string | null } & Install, where: Where): Promise<StaffLoginResult> {
  await rateLimit("staff_app_login_ip", where.ip, 30, WINDOW_MS, "Too many sign-in attempts. Try again in 15 minutes.");
  const found = await openAppInvite(input.token);
  if (!found) throw new AppError("not_found", "This invite link has expired or was already used. Ask your manager for a new one.");
  const { invite, person } = found;
  let hash: string | null = null;
  if (!person.passwordHash) {
    if (!input.password) throw new AppError("bad_request", "Choose a password", { field: "password" });
    const problem = passwordProblem(input.password, person.email);
    if (problem) throw new AppError("bad_request", problem, { field: "password" });
    hash = await bcrypt.hash(input.password, 10);
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    const [used] = await tx
      .update(staffInvites)
      .set({ usedAt: now })
      .where(and(eq(staffInvites.id, invite.id), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt)))
      .returning({ id: staffInvites.id });
    if (!used) throw new AppError("conflict", "This invite link was already used");
    if (hash) {
      await tx.update(staff).set({ passwordHash: hash }).where(and(eq(staff.id, person.id), isNull(staff.passwordHash)));
      await audit({ staffId: person.id, label: person.displayLabel }, "user.signup", "staff", person.id, { via: "staff_app_invite" }, null, tx);
    }
  });
  const fresh = (await db.query.staff.findFirst({ where: eq(staff.id, person.id) }))!;
  const step = await signInFactorFor(fresh);
  if (step) return { twoFactor: await twoFactorPrompt(fresh, step) };
  return { tokens: await admit(fresh, where, input, false, "invite") };
}

// ───────────────────────────── Their sessions ─────────────────────────────

/** Every phone signed in to the staff app as them: the name it gave, when it signed in and was last used. Never an IP or token. */
export async function listStaffAppSessions(staffId: string, currentSessionId: string | null) {
  const rows = await db
    .select({
      sessionId: staffAppTokens.sessionId,
      deviceName: sql<string | null>`max(${staffAppTokens.deviceName})`,
      bound: sql<boolean>`bool_or(${staffAppTokens.deviceId} is not null)`,
      startedAt: sql<Date>`min(${staffAppTokens.createdAt})`,
      lastUsedAt: sql<Date>`max(coalesce(${staffAppTokens.lastUsedAt}, ${staffAppTokens.createdAt}))`,
      live: sql<boolean>`bool_or(${staffAppTokens.revokedAt} is null and ${staffAppTokens.expiresAt} > now())`,
    })
    .from(staffAppTokens)
    .where(eq(staffAppTokens.staffId, staffId))
    .groupBy(staffAppTokens.sessionId);
  return rows
    .filter((r) => r.live)
    .map((r) => ({
      id: r.sessionId,
      deviceName: r.deviceName,
      boundToDevice: r.bound,
      startedAt: new Date(r.startedAt).toISOString(),
      lastUsedAt: new Date(r.lastUsedAt).toISOString(),
      current: r.sessionId === currentSessionId,
    }))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

/** Signs one of their own phones out (a lost phone): its tokens and pushes stop at once. Someone else's is not found. */
export async function endMyStaffAppSession(staffId: string, sessionId: string) {
  const [row] = await db
    .select({ id: staffAppTokens.id })
    .from(staffAppTokens)
    .where(and(eq(staffAppTokens.staffId, staffId), eq(staffAppTokens.sessionId, sessionId)))
    .limit(1);
  if (!row) throw notFound("Session");
  await endStaffAppSession(sessionId);
}

/** Every phone but this one. */
export async function endMyOtherSessions(staffId: string, keep: string) {
  const live = await db
    .selectDistinct({ sessionId: staffAppTokens.sessionId })
    .from(staffAppTokens)
    .where(and(eq(staffAppTokens.staffId, staffId), isNull(staffAppTokens.revokedAt)));
  let n = 0;
  for (const s of live) {
    if (s.sessionId === keep) continue;
    await endStaffAppSession(s.sessionId);
    n++;
  }
  return n;
}

/** A manager signs someone out of the staff app on every phone (a lost or shared phone), without deactivating them. */
export async function signOutOfStaffApp(ctx: StaffContext, staffId: string) {
  const { row } = await assertMay(ctx, staffId, "sign_out");
  await endAllStaffAppSessions(staffId);
  await audit(ctx.actor, "user.app_sign_out", "staff", staffId, { name: row.displayLabel }, ctx.currentShopId);
  return null;
}
