import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffAppTokens, staffDevices } from "@/db/schema";
import { BLOCK_MESSAGE } from "@/domain/network-access";
import { WIPE_FOR, type SessionEnd } from "@/domain/staff-device-policy";
import { deviceLabel, idleTooLong } from "@/domain/staff-auth";
import { clientIp } from "@/lib/client-ip";
import { audit } from "@/server/audit";
import { loadStaffAccess } from "@/server/auth/access";
import { evaluateNetwork, recordBlocked } from "@/server/auth/network";
import { checkPassword, noteSignInDevice, signInFactorFor } from "@/server/auth/sign-in-guard";
import { StaffContext, staffContextOf } from "@/server/auth/staff";
import { randomToken, sha256, signToken, verifyToken } from "@/server/auth/tokens";
import { TwoFactorPrompt, finishTwoFactor, twoFactorPrompt } from "@/server/auth/two-factor";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";

/**
 * The staff app's sign-in (/api/staff/v1): email and password, a code by text or email, or a staff
 * app invite link; then the authenticator code when the person has two-step sign-in. Apart from the
 * customer app's sign-in (its own token type). Each sign-in is a session of rotating refresh tokens
 * bound to the install that signed in; the Bearer access token names it, so signing out ends both at
 * once. Every request is held to the same roles, permissions and location sign-in rules as the web.
 */

export const STAFF_ACCESS_TTL_SECONDS = 60 * 60;
export const STAFF_REFRESH_TTL_DAYS = 30;
const LOGIN_WINDOW_MS = 15 * 60_000;

/** A refused session, with what the app wipes (ST-I18): details.reason and details.wipe. */
const ended = (reason: SessionEnd, message: string) => new AppError("unauthorized", message, { reason, wipe: WIPE_FOR[reason] });

export interface StaffTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  sessionId: string;
}

export type StaffLoginResult = { tokens: StaffTokens } | { twoFactor: TwoFactorPrompt };

interface Where {
  ip: string | null;
  userAgent: string | null;
}

/** The install signing in: a name for their list of sign-ins, and the app's own random install id the refresh token is bound to. */
export interface Install {
  deviceName?: string | null;
  deviceId?: string | null;
}

export const requestWhere = (req: Request): Where => ({ ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") });

const cleanDevice = (name: string | null | undefined) => name?.trim().slice(0, 80) || null;
const cleanDeviceId = (id: string | null | undefined) => id?.trim().slice(0, 100) || null;

async function issue(staffId: string, install: { deviceName: string | null; deviceId: string | null }, sessionId?: string): Promise<StaffTokens & { tokenId: string }> {
  const id = randomUUID();
  const sid = sessionId ?? id;
  const refreshToken = randomToken(32);
  await db.insert(staffAppTokens).values({
    id,
    staffId,
    sessionId: sid,
    tokenHash: sha256(refreshToken),
    deviceName: install.deviceName,
    deviceId: install.deviceId,
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + STAFF_REFRESH_TTL_DAYS * 86_400_000),
  });
  const accessToken = await signToken({ sub: staffId, sid }, "staff_app_access", STAFF_ACCESS_TTL_SECONDS);
  return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: STAFF_ACCESS_TTL_SECONDS, sessionId: sid, tokenId: id };
}

const strip = ({ tokenId: _t, ...t }: StaffTokens & { tokenId: string }): StaffTokens => t;

export type SignInVia = "password" | "code" | "invite";

/** The first step was right (and the authenticator code, if they have one): held to the location sign-in rules, then a new session. */
export async function admit(user: typeof staff.$inferSelect, where: Where, install: Install, twoStep: boolean, via: SignInVia = "password"): Promise<StaffTokens> {
  if (!user.active || user.removedAt || (user.kind !== "person" && via !== "password")) throw new AppError("unauthorized", "Email or password is incorrect");
  // Whatever the way in, someone who needs two-step sign-in only gets tokens after their code (ST-C0c).
  if (!twoStep && (await signInFactorFor(user))) throw new AppError("unauthorized", "Two-step sign-in is required. Sign in again.");
  const deviceName = cleanDevice(install.deviceName);
  const access = await loadStaffAccess(user.id);
  if (!access) throw new AppError("unauthorized", "Email or password is incorrect");
  const verdict = await evaluateNetwork(access, { ip: where.ip, deviceShopIds: [] });
  if (verdict.blocked.length) {
    await recordBlocked({ staff: user, roleName: access.role.name, verdict, ip: where.ip, via: "sign_in", outcome: verdict.full ? "blocked" : "limited", userAgent: where.userAgent, path: "/api/staff/v1/auth/login" });
  }
  if (verdict.full) throw new AppError("forbidden", BLOCK_MESSAGE, { networkBlocked: true });
  const deviceId = cleanDeviceId(install.deviceId);
  const tokens = await issue(user.id, { deviceName, deviceId });
  await noteSignInDevice(user, "app", { deviceKey: deviceId, label: deviceName ?? deviceLabel(where.userAgent), ip: where.ip });
  await db.update(staff).set({ lastSignInAt: new Date() }).where(eq(staff.id, user.id));
  await audit(
    { staffId: user.id, label: `${access.role.name}:${user.displayLabel}` },
    "staff.login",
    "staff",
    user.id,
    { ip: where.ip, via: "staff_app", signIn: via, deviceName, ...(twoStep ? { twoStep: true } : {}) },
    access.scope === "all" ? null : (access.shopIds[0] ?? null),
  );
  return strip(tokens);
}

/** Step one: email and password. Someone with two-step sign-in gets a ticket for their code (or for setting it up). */
export async function staffPasswordLogin(input: { email: string; password: string } & Install, where: Where): Promise<StaffLoginResult> {
  const user = await checkPassword(input.email, input.password, { ip: where.ip, via: "app" });
  const step = await signInFactorFor(user);
  if (step) return { twoFactor: await twoFactorPrompt(user, step) };
  return { tokens: await admit(user, where, input, false) };
}

/** Step two: the authenticator code against the ticket from step one. A wrong code returns the same ticket to try again. */
export async function staffCodeLogin(input: { ticket: string; code: string } & Install, where: Where): Promise<StaffTokens> {
  await rateLimit("staff_app_login_ip", where.ip, 30, LOGIN_WINDOW_MS, "Too many sign-in attempts. Try again in 15 minutes.");
  const r = await finishTwoFactor(input.ticket, input.code);
  if (!("user" in r)) throw new AppError("unauthorized", r.error, r.twoFactor ? { twoFactor: r.twoFactor } : undefined);
  return admit(r.user, where, input, true);
}

/** Ends a staff app session: its refresh tokens stop working, its access token with them, and its phone gets no more pushes. */
export async function endStaffAppSession(sessionId: string, now = new Date()) {
  await db.update(staffAppTokens).set({ revokedAt: now }).where(and(eq(staffAppTokens.sessionId, sessionId), isNull(staffAppTokens.revokedAt)));
  await db.update(staffDevices).set({ revokedAt: now }).where(and(eq(staffDevices.sessionId, sessionId), isNull(staffDevices.revokedAt)));
}

/** Every staff app session someone has: offboarding, or reuse of a rotated refresh token. */
export async function endAllStaffAppSessions(staffId: string, now = new Date()) {
  const live = await db.selectDistinct({ sessionId: staffAppTokens.sessionId }).from(staffAppTokens).where(and(eq(staffAppTokens.staffId, staffId), isNull(staffAppTokens.revokedAt)));
  for (const s of live) await endStaffAppSession(s.sessionId, now);
  await db.update(staffDevices).set({ revokedAt: now }).where(and(eq(staffDevices.staffId, staffId), isNull(staffDevices.revokedAt)));
}

/**
 * Rotating refresh tokens, bound to the install that signed in: a token sent from another install ends
 * its session. Reusing one that was already rotated ends every staff app session for that person.
 * Someone made inactive, or signed out everywhere since, can't refresh.
 */
export async function refreshStaffTokens(refreshToken: string, deviceId?: string | null): Promise<StaffTokens> {
  const row = await db.query.staffAppTokens.findFirst({ where: eq(staffAppTokens.tokenHash, sha256(refreshToken)) });
  if (!row) throw ended("session_expired", "Invalid refresh token");
  if (row.deviceId && row.deviceId !== cleanDeviceId(deviceId)) {
    if (!row.revokedAt) await endStaffAppSession(row.sessionId);
    throw ended("other_device", "This sign-in belongs to another phone; please sign in again");
  }
  if (row.revokedAt) {
    if (row.replacedBy) {
      await endAllStaffAppSessions(row.staffId);
      throw ended("session_ended", "Refresh token was already used; please sign in again");
    }
    throw ended("session_ended", "This phone was signed out; please sign in again");
  }
  if (row.expiresAt < new Date() || idleTooLong(row.lastUsedAt, new Date())) throw ended("session_expired", "Session expired; please sign in again");
  const person = await db.query.staff.findFirst({ where: eq(staff.id, row.staffId), columns: { active: true, removedAt: true, sessionsValidAfter: true } });
  const started = await db.query.staffAppTokens.findFirst({ where: eq(staffAppTokens.id, row.sessionId), columns: { createdAt: true } });
  const since = (started ?? row).createdAt;
  if (!person?.active || person.removedAt || (person.sessionsValidAfter && Math.floor(since.getTime() / 1000) < Math.floor(person.sessionsValidAfter.getTime() / 1000))) {
    await endStaffAppSession(row.sessionId);
    throw ended("account_ended", "Please sign in again");
  }
  const next = await issue(row.staffId, { deviceName: row.deviceName, deviceId: row.deviceId }, row.sessionId);
  await db.update(staffAppTokens).set({ revokedAt: new Date(), replacedBy: next.tokenId }).where(eq(staffAppTokens.id, row.id));
  return strip(next);
}

/** The phone deleted its data after a refused session (ST-I18): kept against that sign-in, in the security log. */
export async function recordStaffAppWipe(refreshToken: string, wipe: "all" | "cache", where: Where) {
  await rateLimit("staff_app_wiped_ip", where.ip, 30, LOGIN_WINDOW_MS, "Too many requests. Try again in 15 minutes.");
  const row = await db.query.staffAppTokens.findFirst({ where: eq(staffAppTokens.tokenHash, sha256(refreshToken)), columns: { staffId: true, sessionId: true, deviceName: true } });
  if (!row) return;
  await audit({ staffId: row.staffId, label: "staff app" }, "staff.app_wiped", "staff", row.staffId, { sessionId: row.sessionId, deviceName: row.deviceName, wipe, ip: where.ip }, null);
}

export async function staffLogout(refreshToken: string) {
  const row = await db.query.staffAppTokens.findFirst({ where: eq(staffAppTokens.tokenHash, sha256(refreshToken)), columns: { sessionId: true } });
  if (row) await endStaffAppSession(row.sessionId);
}

interface AppSession {
  staffId: string;
  sessionId: string;
  iat: number;
}

/** The Bearer token's staff member and session while it's live, else why not. Customer tokens and web cookies don't count. */
async function checkStaffAppSession(req: Request): Promise<AppSession | { end: SessionEnd | null }> {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return { end: null };
  const p = await verifyToken<{ sub: string; sid: string; iat?: number }>(h.slice(7).trim(), "staff_app_access");
  if (!p?.sub || !p.sid) return { end: "token_expired" };
  const [live] = await db
    .select({ id: staffAppTokens.id, createdAt: staffAppTokens.createdAt })
    .from(staffAppTokens)
    .where(and(eq(staffAppTokens.id, p.sid), eq(staffAppTokens.staffId, p.sub)))
    .limit(1);
  if (!live) return { end: "session_ended" };
  const [open] = await db
    .select({ id: staffAppTokens.id })
    .from(staffAppTokens)
    .where(and(eq(staffAppTokens.sessionId, p.sid), isNull(staffAppTokens.revokedAt), gt(staffAppTokens.expiresAt, new Date())))
    .limit(1);
  if (!open) {
    // Rotation revokes a token and names its successor; ending the session revokes with no successor.
    const [cut] = await db
      .select({ id: staffAppTokens.id })
      .from(staffAppTokens)
      .where(and(eq(staffAppTokens.sessionId, p.sid), isNotNull(staffAppTokens.revokedAt), isNull(staffAppTokens.replacedBy)))
      .limit(1);
    return { end: cut ? "session_ended" : "session_expired" };
  }
  // Signing out everywhere is checked against when the session started, not when this access token was minted.
  return { staffId: p.sub, sessionId: p.sid, iat: Math.floor(live.createdAt.getTime() / 1000) };
}

export async function staffAppSession(req: Request): Promise<AppSession | null> {
  const s = await checkStaffAppSession(req);
  return "end" in s ? null : s;
}

const END_MESSAGE: Record<SessionEnd, string> = {
  token_expired: "Your sign-in needs refreshing (POST /api/staff/v1/auth/refresh)",
  session_expired: "Your sign-in expired. Please sign in again.",
  session_ended: "This phone was signed out of Ray'z Staff. Please sign in again.",
  account_ended: "Please sign in again",
  other_device: "This sign-in belongs to another phone; please sign in again",
};

/**
 * The request's staff context: the person's roles and permissions as of now, the shops this request
 * may reach from where it comes (X-Shop-Id picks one, or "all"), or 401.
 */
export async function requireStaffApp(req: Request): Promise<StaffContext & { sessionId: string }> {
  const s = await checkStaffAppSession(req);
  if ("end" in s) {
    if (!s.end) throw new AppError("unauthorized", "Sign in required (Authorization: Bearer <accessToken> from /api/staff/v1/auth/login)");
    throw ended(s.end, END_MESSAGE[s.end]);
  }
  const ctx = await staffContextOf(s.staffId, s.iat, { ip: clientIp(req.headers), deviceShopIds: [], shopPref: req.headers.get("x-shop-id")?.trim() || null });
  if (!ctx) {
    const person = await db.query.staff.findFirst({ where: eq(staff.id, s.staffId), columns: { active: true, sessionsValidAfter: true } });
    const out = !person?.active || (person.sessionsValidAfter && s.iat < Math.floor(person.sessionsValidAfter.getTime() / 1000));
    if (out) throw ended("account_ended", END_MESSAGE.account_ended);
    throw new AppError("forbidden", BLOCK_MESSAGE, { networkBlocked: true, wipe: "cache" });
  }
  return { ...ctx, sessionId: s.sessionId, session: { kind: "app", id: s.sessionId } };
}
