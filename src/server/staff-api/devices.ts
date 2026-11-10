import "server-only";
import { and, desc, eq, isNull, ne, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffDevices } from "@/db/schema";
import { STAFF_EVENTS, cleanNotificationPrefs } from "@/domain/staff-notifications";
import { audit } from "@/server/audit";
import { AppError, notFound } from "@/server/errors";
import type { StaffAppContext } from "./http";

/**
 * The staff app's phones, for pushes about their own clients' bookings, changes and cancellations.
 * A token belongs to one person at a time: signing in as someone else on the same phone moves it.
 * Signing out of the app revokes its phone.
 */

const MAX_DEVICES = 5;
/** What a first phone turns on when they've never picked how they hear about bookings. */
const FIRST_DEVICE_EVENTS = ["confirm", "reschedule", "cancel"] as const;

export interface StaffDeviceInput {
  platform: "ios" | "android";
  provider: "apns" | "fcm" | "expo";
  token: string;
  appVersion?: string | null;
  osVersion?: string | null;
  pushEnabled?: boolean;
}

const view = (d: typeof staffDevices.$inferSelect) => ({
  id: d.id,
  platform: d.platform,
  provider: d.provider,
  appVersion: d.appVersion,
  osVersion: d.osVersion,
  pushEnabled: d.pushEnabled,
  lastSeenAt: d.lastSeenAt.toISOString(),
  createdAt: d.createdAt.toISOString(),
});

export async function registerStaffDevice(ctx: StaffAppContext, input: StaffDeviceInput, now = new Date()) {
  if (input.platform === "ios" && input.provider === "fcm") throw new AppError("bad_request", "iOS devices register an APNs token", { field: "provider" });
  if (input.platform === "android" && input.provider === "apns") throw new AppError("bad_request", "Android devices register an FCM token", { field: "provider" });
  const fields = {
    staffId: ctx.staff.id,
    platform: input.platform,
    provider: input.provider,
    appVersion: input.appVersion ?? null,
    osVersion: input.osVersion ?? null,
    pushEnabled: input.pushEnabled ?? true,
    lastSeenAt: now,
    revokedAt: null,
    sessionId: ctx.sessionId,
  };
  const { device, turnedOn } = await db.transaction(async (tx) => {
    const [d] = await tx.insert(staffDevices).values({ ...fields, token: input.token }).onConflictDoUpdate({ target: staffDevices.token, set: fields }).returning();
    const keep = await tx
      .select({ id: staffDevices.id })
      .from(staffDevices)
      .where(and(eq(staffDevices.staffId, ctx.staff.id), isNull(staffDevices.revokedAt)))
      .orderBy(desc(staffDevices.lastSeenAt))
      .limit(MAX_DEVICES);
    await tx
      .update(staffDevices)
      .set({ revokedAt: now })
      .where(and(eq(staffDevices.staffId, ctx.staff.id), isNull(staffDevices.revokedAt), notInArray(staffDevices.id, keep.map((k) => k.id))));
    const [p] = await tx.select({ prefs: staff.notificationPrefs }).from(staff).where(eq(staff.id, ctx.staff.id));
    const prefs = cleanNotificationPrefs(p?.prefs);
    const untouched = STAFF_EVENTS.every((e) => prefs.events[e] === undefined);
    if (!untouched) return { device: d, turnedOn: false };
    const next = { ...prefs, events: Object.fromEntries(FIRST_DEVICE_EVENTS.map((e) => [e, ["push"]])) };
    await tx.update(staff).set({ notificationPrefs: next }).where(eq(staff.id, ctx.staff.id));
    await audit(ctx.actor, "staff.notification_prefs", "staff", ctx.staff.id, { prefs: next, via: "staff_app_first_device" }, null, tx);
    return { device: d, turnedOn: true };
  });
  return { ...view(device), bookingPushTurnedOn: turnedOn };
}

export async function listStaffDevices(staffId: string) {
  const rows = await db
    .select()
    .from(staffDevices)
    .where(and(eq(staffDevices.staffId, staffId), isNull(staffDevices.revokedAt)))
    .orderBy(desc(staffDevices.lastSeenAt));
  return rows.map(view);
}

async function own(staffId: string, id: string) {
  const d = await db.query.staffDevices.findFirst({ where: and(eq(staffDevices.id, id), eq(staffDevices.staffId, staffId), isNull(staffDevices.revokedAt)) });
  if (!d) throw notFound("Device");
  return d;
}

/** A rotated token, the phone's notification permission, or the app version after an update. */
export async function updateStaffDevice(staffId: string, id: string, patch: { token?: string; pushEnabled?: boolean; appVersion?: string | null; osVersion?: string | null }, now = new Date()) {
  await own(staffId, id);
  if (patch.token) {
    const clash = await db.query.staffDevices.findFirst({ where: and(eq(staffDevices.token, patch.token), ne(staffDevices.id, id)) });
    if (clash) await db.delete(staffDevices).where(eq(staffDevices.id, clash.id));
  }
  const [d] = await db
    .update(staffDevices)
    .set({ ...patch, lastSeenAt: now })
    .where(eq(staffDevices.id, id))
    .returning();
  return view(d);
}

export async function revokeStaffDevice(staffId: string, id: string, now = new Date()) {
  await own(staffId, id);
  await db.update(staffDevices).set({ revokedAt: now }).where(eq(staffDevices.id, id));
}
