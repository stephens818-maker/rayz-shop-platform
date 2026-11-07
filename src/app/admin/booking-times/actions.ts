"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { services, shopServices, shops, staff, staffServiceDurations, staffShops } from "@/db/schema";
import { durationProblem, intervalProblem } from "@/domain/timing";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, assertShopAccess, authorize } from "@/server/auth/staff";
import { noteShopEdit } from "@/server/brand-sync/engine";
import { AppError, forbidden, notFound } from "@/server/errors";

function checkInterval(n: number | null) {
  const problem = n === null ? null : intervalProblem(n);
  if (problem) throw new AppError("bad_request", problem);
}

function refresh() {
  revalidatePath("/admin/booking-times");
  revalidatePath("/admin/settings");
  revalidatePath("/admin/calendar");
  revalidatePath("/admin/staff", "layout");
}

/** The shops this barber works at; changing their all-shops setting needs access to every one of them. */
async function barberScope(ctx: StaffContext, staffId: string, shopId: string | null) {
  const person = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { id: true, displayLabel: true, kind: true } });
  if (!person || person.kind !== "person") throw notFound("Barber");
  const links = (await db.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId))).map((l) => l.shopId);
  if (!links.some((s) => ctx.shopIds.includes(s))) throw notFound("Barber");
  if (shopId) {
    assertShopAccess(ctx, shopId);
    if (!links.includes(shopId)) throw new AppError("bad_request", `${person.displayLabel} doesn't work at that shop`);
  } else if (!ctx.brandWide && links.some((s) => !ctx.shopIds.includes(s))) {
    throw forbidden(`${person.displayLabel} also works at shops outside your access, so set their interval for one of your shops instead`);
  }
  return person;
}

/** Null: follow the brand default. */
export async function saveShopIntervalAction(shopId: string, minutes: number | null) {
  return safe(async () => {
    const ctx = await authorize("scheduling.timing");
    assertShopAccess(ctx, shopId);
    checkInterval(minutes);
    const [before] = await db.select({ n: shops.slotIntervalMinutes }).from(shops).where(eq(shops.id, shopId));
    if (!before) throw notFound("Shop");
    await db.update(shops).set({ slotIntervalMinutes: minutes }).where(eq(shops.id, shopId));
    await audit(ctx.actor, "timing.shop_interval", "shop", shopId, { from: before.n, to: minutes }, shopId);
    await noteShopEdit("setting", ["slot_interval"], shopId);
    refresh();
    return null;
  });
}

/** A barber's interval at one shop, or (shopId null) at every shop. Null minutes: follow the next level up. */
export async function saveBarberIntervalAction(staffId: string, shopId: string | null, minutes: number | null) {
  return safe(async () => {
    const ctx = await authorize("scheduling.timing");
    await barberScope(ctx, staffId, shopId);
    checkInterval(minutes);
    if (shopId) {
      const [before] = await db.select({ n: staffShops.slotIntervalMinutes }).from(staffShops).where(and(eq(staffShops.staffId, staffId), eq(staffShops.shopId, shopId)));
      await db
        .update(staffShops)
        .set({ slotIntervalMinutes: minutes })
        .where(and(eq(staffShops.staffId, staffId), eq(staffShops.shopId, shopId)));
      await audit(ctx.actor, "timing.barber_interval", "staff", staffId, { shopId, from: before?.n ?? null, to: minutes }, shopId);
    } else {
      const [before] = await db.select({ n: staff.slotIntervalMinutes }).from(staff).where(eq(staff.id, staffId));
      await db.update(staff).set({ slotIntervalMinutes: minutes }).where(eq(staff.id, staffId));
      await audit(ctx.actor, "timing.barber_interval", "staff", staffId, { shopId: null, from: before?.n ?? null, to: minutes }, null);
    }
    refresh();
    return null;
  });
}

async function stepFor(serviceId: string) {
  const s = await db.query.services.findFirst({ where: eq(services.id, serviceId), columns: { id: true, name: true, durationStepMin: true } });
  if (!s) throw notFound("Service");
  return s;
}

/** The shop's duration for a service. Null: the brand default. */
export async function saveShopDurationAction(shopId: string, serviceId: string, minutes: number | null) {
  return safe(async () => {
    const ctx = await authorize("scheduling.timing");
    assertShopAccess(ctx, shopId);
    const s = await stepFor(serviceId);
    const problem = minutes === null ? null : durationProblem(minutes, s.durationStepMin);
    if (problem) throw new AppError("bad_request", problem);
    const [row] = await db
      .update(shopServices)
      .set({ durationMin: minutes })
      .where(and(eq(shopServices.shopId, shopId), eq(shopServices.serviceId, serviceId)))
      .returning();
    if (!row) throw new AppError("bad_request", `${s.name} isn't on this shop's menu`);
    await audit(ctx.actor, "timing.shop_duration", "service", serviceId, { shopId, to: minutes }, shopId);
    refresh();
    revalidatePath("/admin/services");
    return null;
  });
}

/** How long a service takes one barber, at one shop or everywhere. Null minutes removes it. */
async function setBarberDuration(ctx: StaffContext, staffId: string, serviceId: string, shopId: string | null, minutes: number | null, extra: Record<string, unknown> = {}) {
  const person = await barberScope(ctx, staffId, shopId);
  const s = await stepFor(serviceId);
  const where = and(eq(staffServiceDurations.staffId, staffId), eq(staffServiceDurations.serviceId, serviceId), shopId ? eq(staffServiceDurations.shopId, shopId) : isNull(staffServiceDurations.shopId));
  if (minutes === null) {
    await db.delete(staffServiceDurations).where(where);
  } else {
    const problem = durationProblem(minutes, s.durationStepMin);
    if (problem) throw new AppError("bad_request", problem);
    await db
      .insert(staffServiceDurations)
      .values({ staffId, serviceId, shopId, durationMin: minutes })
      .onConflictDoUpdate({ target: [staffServiceDurations.staffId, staffServiceDurations.serviceId, staffServiceDurations.shopId], set: { durationMin: minutes, updatedAt: new Date() } });
  }
  await audit(ctx.actor, "timing.barber_duration", "staff", staffId, { barber: person.displayLabel, service: s.name, shopId, to: minutes, ...extra }, shopId);
  refresh();
}

export async function saveBarberDurationAction(staffId: string, serviceId: string, shopId: string | null, minutes: number | null) {
  return safe(async () => {
    await setBarberDuration(await authorize("scheduling.timing"), staffId, serviceId, shopId, minutes);
    return null;
  });
}

/** One click from the service times report: the barber's own time for this service at this shop, with the evidence logged. */
export async function acceptDurationSuggestionAction(input: { staffId: string; serviceId: string; shopId: string; minutes: number; evidence: { n: number; avgMin: number; medianMin: number; fromMin: number } }) {
  return safe(async () => {
    const ctx = await authorize("scheduling.timing");
    const e = input.evidence;
    const round = (x: number) => Math.round(x * 10) / 10;
    await setBarberDuration(ctx, input.staffId, input.serviceId, input.shopId, input.minutes, {
      from: e.fromMin,
      via: "service_times_suggestion",
      evidence: { counted: e.n, avgMin: round(e.avgMin), medianMin: round(e.medianMin) },
    });
    revalidatePath("/admin/reports/service-times");
    return null;
  });
}
