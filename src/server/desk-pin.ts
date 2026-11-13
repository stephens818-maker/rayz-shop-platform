import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import type { Actor } from "@/server/audit";
import type { StaffContext } from "@/server/auth/staff";
import { AppError, forbidden } from "@/server/errors";
import { checkPin, onShopTeam } from "@/server/time-clock";

/** The person at the desk, named by their PIN. A personal login is already that person. */
export type DeskPin = { staffId: string; pin: string };

export async function deskActor(ctx: StaffContext, pin: DeskPin | null | undefined): Promise<Actor> {
  if (ctx.staff.kind !== "shop") return ctx.actor;
  if (!pin?.staffId || !pin.pin) throw new AppError("forbidden", "Enter your PIN. The shop stays signed in; your PIN says who did this.");
  const shopId = ctx.currentShopId ?? ctx.shopIds[0];
  if (!shopId) throw forbidden("Pick a shop");
  await onShopTeam(shopId, pin.staffId);
  await checkPin(pin.staffId, pin.pin);
  const [who] = await db.select({ label: staff.displayLabel }).from(staff).where(eq(staff.id, pin.staffId));
  return { staffId: pin.staffId, label: who?.label ?? "Staff" };
}

/** Same permissions as the shop login. The audit actor is the person whose PIN was entered. */
export async function withDesk(ctx: StaffContext, pin: DeskPin | null | undefined): Promise<StaffContext> {
  if (ctx.staff.kind !== "shop") return ctx;
  return { ...ctx, actor: await deskActor(ctx, pin) };
}
