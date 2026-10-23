"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { brandSettings, services, shopServices, shops, staff, staffServiceDurations, staffShops } from "@/db/schema";
import { BUFFER_MAX, DURATION_STEPS, bufferProblem, durationProblem, intervalProblem } from "@/domain/timing";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, assertShopAccess, authorize } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { brandInterval } from "@/server/timing";

const ALL_SHOPS = "That's a brand setting every shop shares, so changing it needs access to all shops";

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

export async function saveBrandIntervalAction(minutes: number) {
  return safe(async () => {
    const ctx = await authorize("scheduling.timing");
    if (!ctx.brandWide) throw forbidden(ALL_SHOPS);
    checkInterval(minutes);
    const before = await brandInterval();
    await db.update(brandSettings).set({ slotIntervalMinutes: minutes, updatedAt: new Date() }).where(eq(brandSettings.id, 1));
    await audit(ctx.actor, "timing.brand_interval", "brand", "1", { from: before, to: minutes }, null);
    refresh();
    return null;
  });
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

const ServiceTiming = z.object({
  defaultDurationMin: z.number().int(),
  durationStepMin: z.number().int().refine((n) => (DURATION_STEPS as readonly number[]).includes(n), `The step must be ${DURATION_STEPS.join(", ")} minutes`),
  bookingIncrementMin: z.number().int().nullable(),
  bufferBeforeMin: z.number().int().min(0).max(BUFFER_MAX),
  bufferAfterMin: z.number().int().min(0).max(BUFFER_MAX),
});

/** Brand catalog timing. Every shop and barber duration for the service has to fit the step too. */
export async function saveServiceTimingAction(serviceId: string, raw: z.input<typeof ServiceTiming>) {
  return safe(async () => {
    const ctx = await authorize("scheduling.timing");
    if (!ctx.brandWide) throw forbidden(ALL_SHOPS);
    const v = ServiceTiming.parse(raw);
    const problem = durationProblem(v.defaultDurationMin, v.durationStepMin) ?? (v.bookingIncrementMin === null ? null : intervalProblem(v.bookingIncrementMin)) ?? bufferProblem(v.bufferBeforeMin) ?? bufferProblem(v.bufferAfterMin);
    if (problem) throw new AppError("bad_request", problem);
    const before = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
    if (!before) throw notFound("Service");
    const shopRows = await db
      .select({ shop: shops.name, min: shopServices.durationMin })
      .from(shopServices)
      .innerJoin(shops, eq(shops.id, shopServices.shopId))
      .where(eq(shopServices.serviceId, serviceId));
    const barberRows = await db
      .select({ barber: staff.displayLabel, min: staffServiceDurations.durationMin })
      .from(staffServiceDurations)
      .innerJoin(staff, eq(staff.id, staffServiceDurations.staffId))
      .where(eq(staffServiceDurations.serviceId, serviceId));
    const misfits = [
      ...shopRows.filter((r) => r.min !== null && r.min % v.durationStepMin !== 0).map((r) => `${r.shop} (${r.min} min)`),
      ...barberRows.filter((r) => r.min % v.durationStepMin !== 0).map((r) => `${r.barber} (${r.min} min)`),
    ];
    if (misfits.length) throw new AppError("bad_request", `These durations aren't in ${v.durationStepMin}-minute steps: ${misfits.slice(0, 4).join(", ")}${misfits.length > 4 ? ", …" : ""}. Change them first.`);
    await db.update(services).set(v).where(eq(services.id, serviceId));
    const changed = Object.fromEntries(Object.entries(v).filter(([k, val]) => before[k as keyof typeof v] !== val).map(([k, val]) => [k, { from: before[k as keyof typeof v], to: val }]));
    await audit(ctx.actor, "timing.service", "service", serviceId, { name: before.name, changed }, null);
    refresh();
    revalidatePath("/admin/services");
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
