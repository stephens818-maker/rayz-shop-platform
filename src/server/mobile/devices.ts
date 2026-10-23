import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customerDevices } from "@/db/schema";
import { AppError } from "@/server/errors";

export async function registerDevice(
  customerId: string,
  input: { platform: "ios" | "android"; provider: "apns" | "fcm" | "expo"; token: string; appVersion?: string | null; osVersion?: string | null; locale?: string | null },
) {
  const token = input.token.trim();
  if (token.length < 8 || token.length > 4096) throw new AppError("bad_request", "Device token is invalid.");
  const now = new Date();
  const [row] = await db
    .insert(customerDevices)
    .values({
      customerId,
      platform: input.platform,
      provider: input.provider,
      token,
      appVersion: input.appVersion ?? null,
      osVersion: input.osVersion ?? null,
      locale: input.locale ?? null,
      lastSeenAt: now,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: customerDevices.token,
      set: {
        customerId,
        platform: input.platform,
        provider: input.provider,
        appVersion: input.appVersion ?? null,
        osVersion: input.osVersion ?? null,
        locale: input.locale ?? null,
        pushEnabled: true,
        lastSeenAt: now,
        revokedAt: null,
      },
    })
    .returning();
  return {
    id: row.id,
    platform: row.platform,
    provider: row.provider,
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export async function listDevices(customerId: string) {
  const rows = await db
    .select()
    .from(customerDevices)
    .where(and(eq(customerDevices.customerId, customerId), isNull(customerDevices.revokedAt)));
  return {
    devices: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      provider: r.provider,
      lastSeenAt: r.lastSeenAt.toISOString(),
    })),
  };
}

export async function revokeDevice(customerId: string, deviceId: string) {
  const [row] = await db
    .update(customerDevices)
    .set({ revokedAt: new Date(), pushEnabled: false })
    .where(and(eq(customerDevices.id, deviceId), eq(customerDevices.customerId, customerId)))
    .returning({ id: customerDevices.id });
  if (!row) throw new AppError("not_found", "Device not found");
}
