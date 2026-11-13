import "server-only";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffAppTokens, staffWebSessions } from "@/db/schema";
import { STEP_UP_MESSAGE, deviceLabel, stepUpFresh, type StepUpAction } from "@/domain/staff-auth";
import { endOfLocalDay, todayLocal } from "@/lib/time";
import { AppError } from "@/server/errors";
import { sha256 } from "./tokens";

/**
 * Staff sessions after sign-in (ST-C0c): one row per browser for the web, listed and signed out one
 * at a time like the staff app's; step-up before reveal, export and refund; and an email the first
 * time someone signs in on a browser or app install they haven't used.
 */

export const WEB_SESSION_TTL_SECONDS = 60 * 60 * 12;
const TOUCH_EVERY_MS = 5 * 60_000;

/** A shop login stays signed in through the business day: at least 12 hours, and until 4 hours after local midnight. */
export function shopStaySeconds(now = new Date()) {
  const throughClose = endOfLocalDay(todayLocal(now)).getTime() + 4 * 60 * 60_000;
  return Math.max(WEB_SESSION_TTL_SECONDS, Math.ceil((throughClose - now.getTime()) / 1000));
}

export type SessionRef = { kind: "web" | "app"; id: string };

export async function openWebSession(staffId: string, o: { ip: string | null; userAgent: string | null; deviceKey: string | null }, now = new Date()) {
  const who = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { isDemo: true, kind: true } });
  if (who?.isDemo) throw new AppError("unauthorized", "The app review login works in the Ray'z Staff app only.");
  const ttl = who?.kind === "shop" ? shopStaySeconds(now) : WEB_SESSION_TTL_SECONDS;
  const [row] = await db
    .insert(staffWebSessions)
    .values({
      staffId,
      deviceHash: o.deviceKey ? sha256(`web:${o.deviceKey}`) : null,
      deviceLabel: deviceLabel(o.userAgent),
      ip: o.ip,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + ttl * 1000),
      stepUpAt: now,
    })
    .returning({ id: staffWebSessions.id });
  return row.id;
}

/** The web session a cookie names, while it's open; marks it seen every few minutes. */
export async function liveWebSession(id: string, staffId: string, now = new Date()) {
  const [hit] = await db
    .select({ session: staffWebSessions, kind: staff.kind })
    .from(staffWebSessions)
    .innerJoin(staff, eq(staff.id, staffWebSessions.staffId))
    .where(and(eq(staffWebSessions.id, id), eq(staffWebSessions.staffId, staffId), isNull(staffWebSessions.revokedAt), gt(staffWebSessions.expiresAt, now)));
  if (!hit) return null;
  const row = hit.session;
  if (hit.kind === "shop") {
    const until = new Date(now.getTime() + shopStaySeconds(now) * 1000);
    if (until.getTime() > row.expiresAt.getTime() || now.getTime() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      await db.update(staffWebSessions).set({ lastSeenAt: now, expiresAt: until > row.expiresAt ? until : row.expiresAt }).where(eq(staffWebSessions.id, id));
    }
    return row;
  }
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) await db.update(staffWebSessions).set({ lastSeenAt: now }).where(eq(staffWebSessions.id, id));
  return row;
}

export async function myWebSessions(staffId: string, current: string | null, now = new Date()) {
  const rows = await db
    .select()
    .from(staffWebSessions)
    .where(and(eq(staffWebSessions.staffId, staffId), isNull(staffWebSessions.revokedAt), gt(staffWebSessions.expiresAt, now)))
    .orderBy(desc(staffWebSessions.lastSeenAt));
  return rows.map((r) => ({ id: r.id, device: r.deviceLabel ?? "Unknown browser", ip: r.ip, signedInAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.id === current }));
}

export async function endWebSession(staffId: string, id: string, now = new Date()) {
  const n = await db
    .update(staffWebSessions)
    .set({ revokedAt: now })
    .where(and(eq(staffWebSessions.id, id), eq(staffWebSessions.staffId, staffId), isNull(staffWebSessions.revokedAt)))
    .returning({ id: staffWebSessions.id });
  return n.length;
}

/** Every web session but this one, or all of them (offboarding, a reset password). */
export async function endOtherWebSessions(staffId: string, keep: string | null, now = new Date()) {
  const n = await db
    .update(staffWebSessions)
    .set({ revokedAt: now })
    .where(and(eq(staffWebSessions.staffId, staffId), isNull(staffWebSessions.revokedAt), keep ? ne(staffWebSessions.id, keep) : undefined))
    .returning({ id: staffWebSessions.id });
  return n.length;
}

// ───────────────────────────── Step-up ─────────────────────────────

async function steppedUpAt(s: SessionRef): Promise<Date | null> {
  if (s.kind === "web") return (await db.query.staffWebSessions.findFirst({ where: eq(staffWebSessions.id, s.id), columns: { stepUpAt: true } }))?.stepUpAt ?? null;
  const row = await db.query.staffAppTokens.findFirst({ where: eq(staffAppTokens.id, s.id), columns: { stepUpAt: true, createdAt: true } });
  return row ? (row.stepUpAt ?? row.createdAt) : null;
}

/** Reveal, export and refund need a sign-in or step-up in the last 15 minutes on this session. */
export async function assertSteppedUp(c: { session?: SessionRef | null }, action: StepUpAction, now = new Date()) {
  if (!(await isSteppedUp(c, now))) throw new AppError("forbidden", STEP_UP_MESSAGE, { stepUpRequired: action });
}

export async function isSteppedUp(c: { session?: SessionRef | null }, now = new Date()) {
  return !!c.session && stepUpFresh(await steppedUpAt(c.session), now);
}

/** Where a download that needs a fresh sign-in sends them first: confirm, then back to the download. */
export const stepUpPage = (action: StepUpAction, next: string) => `/admin/verify?${new URLSearchParams({ for: action, next })}`;

export function stepUpRedirect(req: Request, action: StepUpAction) {
  const u = new URL(req.url);
  return new Response(null, { status: 303, headers: { location: stepUpPage(action, u.pathname + u.search) } });
}
