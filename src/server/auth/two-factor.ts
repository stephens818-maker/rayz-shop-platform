import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { TOTP_LOCK_MINUTES, TOTP_MAX_FAILURES } from "@/domain/users";
import { open, seal } from "@/lib/secret-box";
import { groupedSecret, newTotpSecret, otpauthUri, verifyTotp } from "@/lib/totp";
import { audit } from "@/server/audit";
import { signToken, verifyToken } from "./tokens";

const TICKET_TTL = 10 * 60;

export interface TwoFactorPrompt {
  ticket: string;
  /** Setting up an authenticator: the key as a QR code and grouped for typing. */
  enroll?: { qr: string; secret: string };
}

async function enrollment(secret: string, account: string) {
  return { qr: await QRCode.toDataURL(otpauthUri(secret, account), { margin: 1, width: 192 }), secret: groupedSecret(secret) };
}

/** After a correct password: the step that asks for a code, or sets up an authenticator first. */
export async function twoFactorPrompt(user: { id: string; email: string | null }, step: "code" | "enroll"): Promise<TwoFactorPrompt> {
  if (step === "code") return { ticket: await signToken({ sub: user.id }, "login_2fa", TICKET_TTL) };
  const secret = newTotpSecret();
  return { ticket: await signToken({ sub: user.id, es: seal(secret) }, "login_2fa", TICKET_TTL), enroll: await enrollment(secret, user.email ?? "staff") };
}

/** The same prompt again after a wrong code, keeping the key being set up. */
export async function repeatPrompt(ticket: string, t: { es?: string }, email: string | null): Promise<TwoFactorPrompt> {
  const secret = t.es ? open(t.es) : null;
  return secret ? { ticket, enroll: await enrollment(secret, email ?? "staff") } : { ticket };
}

export const readTwoFactorTicket = (ticket: string) => verifyToken<{ sub: string; es?: string }>(ticket, "login_2fa");

/** The person a password-checked ticket is for, once their code is right (finishing setup when the ticket carries a new key); or why not. */
export async function finishTwoFactor(ticket: string, code: string): Promise<{ user: typeof staff.$inferSelect } | { error: string; twoFactor?: TwoFactorPrompt }> {
  const t = await readTwoFactorTicket(ticket);
  if (!t) return { error: "That took too long. Sign in again." };
  const user = await db.query.staff.findFirst({ where: and(eq(staff.id, t.sub), eq(staff.active, true), isNull(staff.removedAt)) });
  if (!user?.passwordHash) return { error: "Email or password is incorrect" };
  const secret = t.es ? open(t.es) : null;
  if (t.es && !secret) return { error: "Sign in again" };
  const r = secret ? await enrollTotp(user.id, secret, code) : await checkTotp(user.id, code);
  if (!r.ok) return { error: r.error, twoFactor: await repeatPrompt(ticket, t, user.email) };
  if (secret) await audit({ staffId: user.id, label: user.displayLabel }, "user.two_factor_setup", "staff", user.id, { via: "sign_in" }, null);
  return { user };
}

type Checked = { ok: true } | { ok: false; error: string };

const locked = (until: Date | null, now: Date) => !!until && until > now;
const LOCKED = `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes, or ask an admin to reset your two-step sign-in.`;

async function failed(staffId: string, failures: number, now: Date): Promise<Checked> {
  const n = failures + 1;
  const lock = n >= TOTP_MAX_FAILURES;
  await db
    .update(staff)
    .set({ totpFailures: lock ? 0 : n, totpLockedUntil: lock ? new Date(now.getTime() + TOTP_LOCK_MINUTES * 60_000) : null })
    .where(eq(staff.id, staffId));
  return { ok: false, error: lock ? LOCKED : "That code didn't work. Check your authenticator app and try the newest code." };
}

/** A code for someone with an authenticator set up. Each code works once; repeated wrong codes pause sign-in. */
export async function checkTotp(staffId: string, code: string, now: Date = new Date()): Promise<Checked> {
  const row = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!row?.totpSecret || !row.totpEnabledAt) return { ok: false, error: "Two-step sign-in isn't set up. Sign in again." };
  if (locked(row.totpLockedUntil, now)) return { ok: false, error: LOCKED };
  const secret = open(row.totpSecret);
  if (!secret) return { ok: false, error: "Your two-step sign-in needs setting up again. Ask an admin to reset it." };
  const step = verifyTotp(secret, code, { now, afterStep: row.totpLastStep });
  if (step === null) return failed(staffId, row.totpFailures, now);
  await db.update(staff).set({ totpLastStep: step, totpFailures: 0, totpLockedUntil: null }).where(eq(staff.id, staffId));
  return { ok: true };
}

/** Finishes setting up an authenticator: the first code proves the app has the key. */
export async function enrollTotp(staffId: string, secret: string, code: string, now: Date = new Date()): Promise<Checked> {
  const row = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { totpFailures: true, totpLockedUntil: true } });
  if (!row) return { ok: false, error: "Sign in again" };
  if (locked(row.totpLockedUntil, now)) return { ok: false, error: LOCKED };
  const step = verifyTotp(secret, code, { now });
  if (step === null) return failed(staffId, row.totpFailures, now);
  const [done] = await db
    .update(staff)
    .set({ totpSecret: seal(secret), totpEnabledAt: now, totpLastStep: step, totpFailures: 0, totpLockedUntil: null })
    .where(and(eq(staff.id, staffId), isNull(staff.totpEnabledAt)))
    .returning({ id: staff.id });
  return done ? { ok: true } : { ok: false, error: "Two-step sign-in is already set up. Sign in again." };
}
