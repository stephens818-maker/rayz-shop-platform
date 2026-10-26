import { and, desc, eq, isNull, ne, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { customerDevices } from "@/db/schema";
import { AppError, notFound } from "./errors";

/**
 * The customer app's devices (C3): each signed-in phone registers its push token, updates it when the
 * OS rotates it, and revokes it on sign-out. A token belongs to one account at a time: signing in as
 * someone else on the same phone moves it. Revoked devices never get push.
 */

const MAX_DEVICES = 10;

export interface DeviceInput {
  platform: "ios" | "android";
  provider: "apns" | "fcm" | "expo";
  token: string;
  appVersion?: string | null;
  osVersion?: string | null;
  locale?: string | null;
  pushEnabled?: boolean;
}

const view = (d: typeof customerDevices.$inferSelect) => ({
  id: d.id,
  platform: d.platform,
  provider: d.provider,
  appVersion: d.appVersion,
  osVersion: d.osVersion,
  pushEnabled: d.pushEnabled,
  lastSeenAt: d.lastSeenAt.toISOString(),
  createdAt: d.createdAt.toISOString(),
});
export type DeviceView = ReturnType<typeof view>;

export async function registerDevice(customerId: string, input: DeviceInput, now = new Date()): Promise<DeviceView> {
  if (input.platform === "ios" && input.provider === "fcm") throw new AppError("bad_request", "iOS devices register an APNs token", { field: "provider" });
  if (input.platform === "android" && input.provider === "apns") throw new AppError("bad_request", "Android devices register an FCM token", { field: "provider" });
  const fields = {
    customerId,
    platform: input.platform,
    provider: input.provider,
    appVersion: input.appVersion ?? null,
    osVersion: input.osVersion ?? null,
    locale: input.locale ?? null,
    pushEnabled: input.pushEnabled ?? true,
    lastSeenAt: now,
    revokedAt: null,
  };
  return db.transaction(async (tx) => {
    const [d] = await tx
      .insert(customerDevices)
      .values({ ...fields, token: input.token })
      .onConflictDoUpdate({ target: customerDevices.token, set: fields })
      .returning();
    const keep = await tx
      .select({ id: customerDevices.id })
      .from(customerDevices)
      .where(and(eq(customerDevices.customerId, customerId), isNull(customerDevices.revokedAt)))
      .orderBy(desc(customerDevices.lastSeenAt))
      .limit(MAX_DEVICES);
    await tx
      .update(customerDevices)
      .set({ revokedAt: now })
      .where(
        and(
          eq(customerDevices.customerId, customerId),
          isNull(customerDevices.revokedAt),
          notInArray(
            customerDevices.id,
            keep.map((k) => k.id),
          ),
        ),
      );
    return view(d);
  });
}

export async function listDevices(customerId: string) {
  const rows = await db
    .select()
    .from(customerDevices)
    .where(and(eq(customerDevices.customerId, customerId), isNull(customerDevices.revokedAt)))
    .orderBy(desc(customerDevices.lastSeenAt));
  return rows.map(view);
}

async function own(customerId: string, id: string) {
  const d = await db.query.customerDevices.findFirst({ where: and(eq(customerDevices.id, id), eq(customerDevices.customerId, customerId), isNull(customerDevices.revokedAt)) });
  if (!d) throw notFound("Device");
  return d;
}

/** A rotated token, the phone's notification permission, or the app version after an update. */
export async function updateDevice(
  customerId: string,
  id: string,
  patch: { token?: string; pushEnabled?: boolean; appVersion?: string | null; osVersion?: string | null; locale?: string | null },
  now = new Date(),
) {
  await own(customerId, id);
  if (patch.token) {
    const clash = await db.query.customerDevices.findFirst({ where: and(eq(customerDevices.token, patch.token), ne(customerDevices.id, id)) });
    if (clash) await db.delete(customerDevices).where(eq(customerDevices.id, clash.id));
  }
  const [d] = await db
    .update(customerDevices)
    .set({ ...patch, lastSeenAt: now })
    .where(eq(customerDevices.id, id))
    .returning();
  return view(d);
}

export async function revokeDevice(customerId: string, id: string, now = new Date()) {
  await own(customerId, id);
  await db.update(customerDevices).set({ revokedAt: now }).where(eq(customerDevices.id, id));
}
