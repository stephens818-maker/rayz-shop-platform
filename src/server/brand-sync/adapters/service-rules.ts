import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx } from "@/db";
import {
  products,
  serviceProductSuggestions,
  services,
  shopServices,
  staff,
  staffServiceDurations,
  shops,
} from "@/db/schema";
import {
  BUFFER_MAX,
  DURATION_STEPS,
  bufferProblem,
  durationProblem,
  intervalProblem,
} from "@/domain/timing";
import { audit } from "../../audit";
import { AppError, notFound } from "../../errors";
import { localValues } from "../store";
import type { SyncAdapter } from "../types";

/**
 * A service's rules beyond its price and length: booking timing ("timing:<service id>": the booking
 * increment and buffers) and what checkout suggests after it ("suggest:<service id>": rebook days
 * and suggested products). A shop can have its own of either; the duration step stays the
 * brand's, since every shop's and barber's length for the service is in that step.
 */
export interface ServiceTiming {
  bookingIncrementMin: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}
export interface ServiceSuggest {
  rebookDays: number | null;
  productIds: string[];
}
type Brand = (ServiceTiming & { durationStepMin: number }) | ServiceSuggest;
type Value = ServiceTiming | ServiceSuggest;

const TimingInput = z.object({
  durationStepMin: z
    .number()
    .int()
    .refine(
      (n) => (DURATION_STEPS as readonly number[]).includes(n),
      `The step must be ${DURATION_STEPS.join(", ")} minutes`,
    ),
  bookingIncrementMin: z.number().int().nullable(),
  bufferBeforeMin: z.number().int().min(0).max(BUFFER_MAX),
  bufferAfterMin: z.number().int().min(0).max(BUFFER_MAX),
});
const SuggestInput = z.object({
  rebookDays: z
    .number()
    .int()
    .min(7, "7 to 182 days, or blank for the brand's default")
    .max(182, "7 to 182 days, or blank for the brand's default")
    .nullable(),
  productIds: z.array(z.uuid()).max(12),
});

const split = (item: string) => {
  const i = item.indexOf(":");
  return {
    part: item.slice(0, i) as "timing" | "suggest",
    serviceId: item.slice(i + 1),
  };
};
export const timingItem = (serviceId: string) => `timing:${serviceId}`;
export const suggestItem = (serviceId: string) => `suggest:${serviceId}`;

async function suggestionsOf(tx: DBorTx, serviceIds: readonly string[]) {
  const rows = serviceIds.length
    ? await tx
        .select()
        .from(serviceProductSuggestions)
        .where(inArray(serviceProductSuggestions.serviceId, [...serviceIds]))
        .orderBy(asc(serviceProductSuggestions.sortOrder))
    : [];
  const out = new Map<string, string[]>();
  for (const r of rows)
    out.set(r.serviceId, [...(out.get(r.serviceId) ?? []), r.productId]);
  return out;
}

export const serviceRuleAdapter: SyncAdapter<Brand, Value> = {
  type: "service_rule",
  noun: "Service rules",
  area: "services",
  store: "local",
  live: true,
  brandPerms: ["scheduling.timing", "checkout_prompts.manage"],
  lockable: false,
  paths: [
    "/admin/booking-times",
    "/admin/checkout-prompts",
    "/admin/services",
    "/admin/calendar",
  ],
  async items(tx) {
    const rows = await tx
      .select({ id: services.id, name: services.name, kind: services.kind })
      .from(services)
      .where(eq(services.active, true))
      .orderBy(asc(services.sortOrder), asc(services.name));
    return rows.flatMap((r) => [
      {
        id: timingItem(r.id),
        label: `${r.name}: booking timing`,
        hint: "Booking increment and buffers",
      },
      ...(r.kind === "service"
        ? [
            {
              id: suggestItem(r.id),
              label: `${r.name}: checkout suggestions`,
              hint: "Rebook days and suggested products",
              area: "checkout_prompts" as const,
            },
          ]
        : []),
    ]);
  },
  async brand(tx, ids) {
    const byService = new Map<string, string[]>();
    for (const item of ids) {
      const { serviceId } = split(item);
      byService.set(serviceId, [...(byService.get(serviceId) ?? []), item]);
    }
    if (!byService.size) return new Map();
    const [rows, suggested] = await Promise.all([
      tx
        .select()
        .from(services)
        .where(inArray(services.id, [...byService.keys()])),
      suggestionsOf(tx, [...byService.keys()]),
    ]);
    const out = new Map<string, Brand>();
    for (const s of rows)
      for (const item of byService.get(s.id) ?? []) {
        if (split(item).part === "timing")
          out.set(item, {
            durationStepMin: s.durationStepMin,
            bookingIncrementMin: s.bookingIncrementMin,
            bufferBeforeMin: s.bufferBeforeMin,
            bufferAfterMin: s.bufferAfterMin,
          });
        else if (s.kind === "service")
          out.set(item, {
            rebookDays: s.rebookDays,
            productIds: suggested.get(s.id) ?? [],
          });
      }
    return out;
  },
  view: (b) =>
    "productIds" in b
      ? { rebookDays: b.rebookDays, productIds: b.productIds }
      : {
          bookingIncrementMin: b.bookingIncrementMin,
          bufferBeforeMin: b.bufferBeforeMin,
          bufferAfterMin: b.bufferAfterMin,
        },
  async parse(_who, raw, item, before, tx) {
    if (!before) throw notFound("Service");
    const { part, serviceId } = split(item);
    if (part === "suggest") {
      const v = SuggestInput.parse({ ...before, ...(raw as object) });
      const ids = [...new Set(v.productIds)];
      if (
        ids.length &&
        (
          await tx
            .select({ id: products.id })
            .from(products)
            .where(inArray(products.id, ids))
        ).length !== ids.length
      )
        throw notFound("Product");
      return { rebookDays: v.rebookDays, productIds: ids };
    }
    const v = TimingInput.parse({ ...before, ...(raw as object) });
    const problem =
      (v.bookingIncrementMin === null
        ? null
        : intervalProblem(v.bookingIncrementMin)) ??
      bufferProblem(v.bufferBeforeMin) ??
      bufferProblem(v.bufferAfterMin);
    if (problem) throw new AppError("bad_request", problem);
    if (
      "durationStepMin" in before &&
      v.durationStepMin !== before.durationStepMin
    ) {
      const [svc] = await tx
        .select({ dur: services.defaultDurationMin })
        .from(services)
        .where(eq(services.id, serviceId));
      // A save that changes the length with the step sends the new length too.
      const dur = (raw as { defaultDurationMin?: unknown }).defaultDurationMin;
      const own = durationProblem(
        typeof dur === "number" ? dur : (svc?.dur ?? 0),
        v.durationStepMin,
      );
      if (own) throw new AppError("bad_request", own);
      const [shopRows, barberRows] = await Promise.all([
        tx
          .select({ who: shops.name, min: shopServices.durationMin })
          .from(shopServices)
          .innerJoin(shops, eq(shops.id, shopServices.shopId))
          .where(eq(shopServices.serviceId, serviceId)),
        tx
          .select({
            who: staff.displayLabel,
            min: staffServiceDurations.durationMin,
          })
          .from(staffServiceDurations)
          .innerJoin(staff, eq(staff.id, staffServiceDurations.staffId))
          .where(eq(staffServiceDurations.serviceId, serviceId)),
      ]);
      const misfits = [...shopRows, ...barberRows]
        .filter((r) => r.min !== null && r.min % v.durationStepMin !== 0)
        .map((r) => `${r.who} (${r.min} min)`);
      if (misfits.length)
        throw new AppError(
          "bad_request",
          `These durations aren't in ${v.durationStepMin}-minute steps: ${misfits.slice(0, 4).join(", ")}${misfits.length > 4 ? ", …" : ""}. Change them first.`,
        );
    }
    return v;
  },
  async write(tx, who, item, brand) {
    if (!brand?.to) return;
    const { part, serviceId } = split(item);
    const to = brand.to;
    if ("productIds" in to) {
      await tx
        .update(services)
        .set({ rebookDays: to.rebookDays })
        .where(eq(services.id, serviceId));
      await tx
        .delete(serviceProductSuggestions)
        .where(eq(serviceProductSuggestions.serviceId, serviceId));
      if (to.productIds.length)
        await tx
          .insert(serviceProductSuggestions)
          .values(
            to.productIds.map((productId, i) => ({
              serviceId,
              productId,
              sortOrder: (i + 1) * 10,
              createdBy: who.actor.staffId ?? null,
            })),
          );
    } else {
      await tx
        .update(services)
        .set({
          durationStepMin: to.durationStepMin,
          bookingIncrementMin: to.bookingIncrementMin,
          bufferBeforeMin: to.bufferBeforeMin,
          bufferAfterMin: to.bufferAfterMin,
        })
        .where(eq(services.id, serviceId));
    }
    await audit(
      who.actor,
      part === "timing" ? "timing.service" : "service.suggestions",
      "service",
      serviceId,
      { before: brand.from, after: to, via: "brand_sync" },
      null,
      tx,
    );
  },
  describe: (v): Record<string, string> =>
    "productIds" in v
      ? {
          "Rebook after":
            v.rebookDays === null ? "Brand default" : `${v.rebookDays} days`,
          "Suggested products": String(v.productIds.length),
        }
      : {
          "Booking increment":
            v.bookingIncrementMin === null
              ? "Barber's"
              : `${v.bookingIncrementMin} min`,
          "Buffer before": `${v.bufferBeforeMin} min`,
          "Buffer after": `${v.bufferAfterMin} min`,
        },
  short: (v) =>
    "productIds" in v
      ? `${v.rebookDays === null ? "default" : `${v.rebookDays}d`} · ${v.productIds.length} products`
      : `${v.bookingIncrementMin === null ? "barber" : `${v.bookingIncrementMin}m`} · ${v.bufferBeforeMin}/${v.bufferAfterMin}m`,
  itemPerms: (item) =>
    split(item).part === "timing"
      ? ["scheduling.timing"]
      : ["checkout_prompts.manage"],
  itemNoun: (item) =>
    split(item).part === "timing" ? "Service timing" : "Checkout suggestions",
  itemNote: (item) =>
    split(item).part === "timing"
      ? "The duration step stays the brand's: every shop's and barber's length for the service is in that step."
      : undefined,
  itemPaths: (item) =>
    split(item).part === "timing"
      ? ["/admin/booking-times", "/admin/calendar", "/admin/services"]
      : ["/admin/checkout-prompts"],
};

/** Each service's timing at a shop: its own where it has one, else the brand's (the services row). */
export async function timingAt(
  shopId: string,
  tx: DBorTx = db,
): Promise<Map<string, ServiceTiming>> {
  const own = await localValues<ServiceTiming>("service_rule", [shopId], tx);
  return new Map(
    [...own]
      .filter(([k]) => k.startsWith(`${shopId}|timing:`))
      .map(([k, v]) => [k.slice(`${shopId}|timing:`.length), v]),
  );
}

/** Each service's checkout suggestions at a shop, for the services given. */
export async function suggestAt(
  shopId: string | null | undefined,
  serviceIds: readonly string[],
  tx: DBorTx = db,
): Promise<Map<string, ServiceSuggest>> {
  const ids = [...new Set(serviceIds)];
  if (!ids.length) return new Map();
  const [rows, suggested, own] = await Promise.all([
    tx
      .select({ id: services.id, rebookDays: services.rebookDays })
      .from(services)
      .where(inArray(services.id, ids)),
    suggestionsOf(tx, ids),
    shopId
      ? localValues<ServiceSuggest>("service_rule", [shopId], tx)
      : new Map<string, ServiceSuggest>(),
  ]);
  return new Map(
    rows.map((r) => [
      r.id,
      own.get(`${shopId}|${suggestItem(r.id)}`) ?? {
        rebookDays: r.rebookDays,
        productIds: suggested.get(r.id) ?? [],
      },
    ]),
  );
}
