import "server-only";
import bcrypt from "bcryptjs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffAppTokens, staffKnownDevices, staffWebSessions } from "@/db/schema";
import type { Permission } from "@/domain/permissions";
import { LOGIN_PER_EMAIL, LOGIN_PER_IP, LOGIN_WINDOW_MINUTES, TOO_MANY_SIGN_INS, isPrivileged, passwordLock, signInFactor } from "@/domain/staff-auth";
import { appBaseUrl, demoMode } from "@/lib/deployment";
import { formatDateTime } from "@/lib/time";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { sendNow } from "@/server/notifications/queue";
import { rateCheck, rateLimit, rateRecord } from "@/server/rate-limit";
import { loadStaffAccess } from "./access";
import type { SessionRef } from "./sessions";
import { sha256 } from "./tokens";
import { checkTotp } from "./two-factor";

/**
 * The password step of every staff sign-in, web and staff app (ST-C0c): limited per address and per
 * email, and a wrong password ten times in a row locks the account (15 minutes, doubling). The
 * answers never say whether an account exists: a lock reads like the email's rate limit.
 */

type Staff = typeof staff.$inferSelect;
const INCORRECT = "Email or password is incorrect";
// Compared against when there's no account, so a missing email takes as long as a wrong password.
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= bcrypt.hash("no account", 10));

export async function checkPassword(email: string, password: string, where: { ip: string | null; via: "web" | "app" }, now = new Date()): Promise<Staff> {
  const clean = email.trim().toLowerCase();
  const windowMs = LOGIN_WINDOW_MINUTES * 60_000;
  const emailBucket = `staff_${where.via}_login_email`;
  await rateLimit(`staff_${where.via}_login_ip`, where.ip, LOGIN_PER_IP, windowMs, TOO_MANY_SIGN_INS);
  await rateCheck(emailBucket, clean || null, LOGIN_PER_EMAIL, windowMs, TOO_MANY_SIGN_INS);
  const row = clean ? await db.query.staff.findFirst({ where: and(eq(staff.email, clean), eq(staff.active, true), isNull(staff.removedAt)) }) : undefined;
  // The Demo Shop's app review login (ST-I19) is for the staff app only.
  if (!row?.passwordHash || (row.isDemo && where.via !== "app")) {
    await bcrypt.compare(password, await dummy());
    await rateRecord(emailBucket, clean || null);
    throw new AppError("unauthorized", INCORRECT);
  }
  if (row.passwordLockedUntil && row.passwordLockedUntil > now) throw new AppError("rate_limited", TOO_MANY_SIGN_INS);
  if (!(await bcrypt.compare(password, row.passwordHash))) {
    await rateRecord(emailBucket, clean);
    const failures = row.passwordFailures + 1;
    await db.update(staff).set({ passwordFailures: failures, passwordLockedUntil: passwordLock(failures, now) ?? row.passwordLockedUntil }).where(eq(staff.id, row.id));
    throw new AppError("unauthorized", INCORRECT);
  }
  if (row.passwordFailures || row.passwordLockedUntil) {
    await db.update(staff).set({ passwordFailures: 0, passwordLockedUntil: null }).where(eq(staff.id, row.id));
    return { ...row, passwordFailures: 0, passwordLockedUntil: null };
  }
  return row;
}

/** Every permission someone holds at any of their shops. */
async function allPermissions(staffId: string): Promise<Permission[]> {
  const access = await loadStaffAccess(staffId);
  if (!access) return [];
  return [...access.permissions, ...[...access.byShop.values()].flatMap((a) => [...a.permissions])];
}

/** The sandbox demo skips the privileged rule; so does the test suite unless a test turns it on (ENFORCE_STAFF_MFA=1). */
const privilegedRuleOn = () => !demoMode() && (process.env.NODE_ENV !== "test" || process.env.ENFORCE_STAFF_MFA === "1");

/**
 * The second step a sign-in needs: their authenticator code, setting one up first (they're required
 * to, or hold a privileged permission anywhere), or none.
 */
export async function signInFactorFor(user: Pick<Staff, "id" | "twoFactorRequired" | "totpEnabledAt">): Promise<"code" | "enroll" | null> {
  const privileged = privilegedRuleOn() && isPrivileged(await allPermissions(user.id));
  return signInFactor(user, privileged);
}

// ───────────────────────────── Step-up and new-device alerts ─────────────────────────────

/** What a step-up asks them for: their authenticator code once set up, else their password. */
export async function stepUpFactor(staffId: string): Promise<"code" | "password"> {
  const me = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { totpEnabledAt: true } });
  return me?.totpEnabledAt ? "code" : "password";
}

/**
 * Proves it's them again on this session: their authenticator code where they have one, else their
 * password. Wrong passwords count toward the lockout like a sign-in's.
 */
export async function stepUp(c: { staff: { id: string; displayLabel: string }; actor: { staffId?: string | null; label: string }; session?: SessionRef | null }, input: { password?: string | null; code?: string | null }, now = new Date()) {
  if (!c.session) throw new AppError("unauthorized", "Sign in again");
  const me = await db.query.staff.findFirst({ where: eq(staff.id, c.staff.id) });
  if (!me) throw new AppError("unauthorized", "Sign in again");
  if (me.totpEnabledAt) {
    const r = await checkTotp(me.id, String(input.code ?? ""), now);
    if (!r.ok) throw new AppError("unauthorized", r.error);
  } else {
    if (me.passwordLockedUntil && me.passwordLockedUntil > now) throw new AppError("rate_limited", "Too many wrong passwords. Try again later, or ask a manager to help you sign in.");
    const ok = !!me.passwordHash && (await bcrypt.compare(String(input.password ?? ""), me.passwordHash));
    if (!ok) {
      const failures = me.passwordFailures + 1;
      await db.update(staff).set({ passwordFailures: failures, passwordLockedUntil: passwordLock(failures, now) }).where(eq(staff.id, me.id));
      throw new AppError("unauthorized", "That password isn't right");
    }
    if (me.passwordFailures) await db.update(staff).set({ passwordFailures: 0, passwordLockedUntil: null }).where(eq(staff.id, me.id));
  }
  if (c.session.kind === "web") await db.update(staffWebSessions).set({ stepUpAt: now }).where(eq(staffWebSessions.id, c.session.id));
  else await db.update(staffAppTokens).set({ stepUpAt: now }).where(eq(staffAppTokens.id, c.session.id));
  await audit(c.actor, "staff.step_up", "staff", me.id, { via: c.session.kind, factor: me.totpEnabledAt ? "authenticator" : "password" }, null);
  return { steppedUpAt: now.toISOString(), factor: me.totpEnabledAt ? ("code" as const) : ("password" as const) };
}

// ───────────────────────────── New-device alerts ─────────────────────────────

/**
 * Records the browser or app install a sign-in came from. The first time someone signs in on one,
 * after having signed in somewhere before, they get an email saying where, with how to lock their
 * account if it wasn't them. Never blocks the sign-in.
 */
export async function noteSignInDevice(user: { id: string; email: string | null; firstName: string }, via: "web" | "app", o: { deviceKey: string | null; label: string | null; ip: string | null }, now = new Date()) {
  if (!o.deviceKey) return { isNew: false };
  const deviceHash = sha256(`${via}:${o.deviceKey}`);
  const [seenBefore] = await db.select({ n: sql<number>`count(*)::int` }).from(staffKnownDevices).where(eq(staffKnownDevices.staffId, user.id));
  const [row] = await db
    .insert(staffKnownDevices)
    .values({ staffId: user.id, via, deviceHash, deviceLabel: o.label, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: [staffKnownDevices.staffId, staffKnownDevices.deviceHash], set: { lastSeenAt: now } })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  const isNew = !!row?.inserted;
  if (!isNew || !seenBefore.n) return { isNew };
  await audit({ staffId: user.id, label: user.firstName }, "staff.new_device", "staff", user.id, { via, device: o.label, ip: o.ip }, null);
  if (user.email) {
    const when = formatDateTime(now, { date: "MMM d, yyyy", sep: ", " });
    const body = `Hi ${user.firstName}, someone signed in to your Ray'z account on a new ${via === "app" ? "phone or tablet (the staff app)" : "browser"}: ${o.label ?? "unknown device"}, ${when} Central. If this was you, there's nothing to do. If it wasn't, sign it out at ${appBaseUrl()}/admin/my-security and tell your manager right away, so they can reset your sign-in.`;
    await sendNow({ kind: "new_sign_in", channel: "email", to: user.email, subject: "New sign-in to your Ray'z account", body, storedBody: body }).catch((e) => console.error("new sign-in email", e));
  }
  return { isNew };
}
