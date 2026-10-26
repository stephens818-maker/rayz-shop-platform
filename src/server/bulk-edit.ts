import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  products,
  scheduleTemplates,
  services,
  shopServices,
  shops,
  staff,
  staffSchedules,
  staffShops,
} from "@/db/schema";
import { findScheduleConflicts } from "@/domain/availability";
import {
  BulkResult,
  PriceChange,
  ScheduleTemplateInput,
  TemplateRow,
  applyPriceChange,
  templateProblem,
} from "@/domain/bulk-edit";
import { highProblem, levelsProblem } from "@/domain/inventory";
import {
  BOOKING_OPTION_KEYS,
  BookingOptionKey,
  cleanBookingOptions,
} from "@/domain/staff-booking";
import { WEEKDAYS, minutesToLabel } from "@/lib/time";
import { Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";
import {
  SettingsViewer,
  saveBookingOptions,
  setVisibleOnline,
} from "./staff-settings";

const ids = z.array(z.uuid()).min(1, "Pick at least one").max(500);
const changed = <T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
) =>
  Object.fromEntries(
    Object.entries(after)
      .filter(([k, v]) => before[k] !== v)
      .map(([k, v]) => [k, { from: before[k], to: v }]),
  );

// ───────────────────────────── Services ─────────────────────────────

export const BulkServicesInput = z.object({
  ids,
  category: z.string().trim().min(1).max(60).optional(),
  active: z.boolean().optional(),
  price: PriceChange.optional(),
  durationMin: z.number().int().min(5).max(480).optional(),
});

/**
 * The same bulk edit as brand changes for the sync dialog, so the admin picks which shops get the new
 * prices and lengths. Nothing is saved here; services that wouldn't change are left out.
 */
export async function bulkServiceChanges(
  raw: z.input<typeof BulkServicesInput>,
): Promise<{
  changes: { type: "service"; item: string; value: unknown }[];
  results: BulkResult[];
}> {
  const v = BulkServicesInput.parse(raw);
  if (
    v.category === undefined &&
    v.active === undefined &&
    !v.price &&
    v.durationMin === undefined
  )
    throw new AppError("bad_request", "Pick something to change");
  const rows = await db
    .select()
    .from(services)
    .where(inArray(services.id, v.ids));
  if (rows.length !== new Set(v.ids).size) throw notFound("Service");
  const changes: { type: "service"; item: string; value: unknown }[] = [];
  for (const s of rows) {
    const next = {
      name: s.name,
      kind: s.kind,
      category: v.category ?? s.category,
      description: s.description,
      defaultPriceCents: v.price
        ? applyPriceChange(s.defaultPriceCents, v.price)
        : s.defaultPriceCents,
      defaultDurationMin: v.durationMin ?? s.defaultDurationMin,
      active: v.active ?? s.active,
      sortOrder: s.sortOrder,
    };
    if (
      Object.keys(changed(s as unknown as Record<string, unknown>, next)).length
    )
      changes.push({ type: "service", item: s.id, value: next });
  }
  return {
    changes,
    results: rows.map((s) => ({ id: s.id, label: s.name, ok: true })),
  };
}

export const BulkShopServicesInput = z.object({
  shopId: z.uuid(),
  ids,
  enabled: z.boolean().optional(),
  bookableOnline: z.boolean().optional(),
});

/** One shop's menu: turn many services on or off there, or on or off for online booking. */
export async function bulkShopServices(
  actor: Actor,
  raw: z.input<typeof BulkShopServicesInput>,
): Promise<BulkResult[]> {
  const v = BulkShopServicesInput.parse(raw);
  if (v.enabled === undefined && v.bookableOnline === undefined)
    throw new AppError("bad_request", "Pick something to change");
  return db.transaction(async (tx) => {
    const list = await tx
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(inArray(services.id, v.ids));
    const existing = await tx
      .select()
      .from(shopServices)
      .where(
        and(
          eq(shopServices.shopId, v.shopId),
          inArray(shopServices.serviceId, v.ids),
        ),
      );
    const set = {
      ...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
      ...(v.bookableOnline !== undefined
        ? { bookableOnline: v.bookableOnline }
        : {}),
    };
    for (const s of list) {
      const before = existing.find((e) => e.serviceId === s.id);
      await tx
        .insert(shopServices)
        .values({
          shopId: v.shopId,
          serviceId: s.id,
          enabled: v.enabled ?? false,
          ...set,
        })
        .onConflictDoUpdate({
          target: [shopServices.shopId, shopServices.serviceId],
          set,
        });
      await audit(
        actor,
        "service.bulk_shop",
        "service",
        s.id,
        {
          shopId: v.shopId,
          before: before
            ? { enabled: before.enabled, bookableOnline: before.bookableOnline }
            : null,
          after: set,
        },
        v.shopId,
        tx,
      );
    }
    return list.map((s) => ({ id: s.id, label: s.name, ok: true }));
  });
}

// ───────────────────────────── Products ─────────────────────────────

const units = z.number().int().min(0).max(100_000);
export const BulkProductsInput = z.object({
  ids,
  category: z.string().trim().min(1).max(60).optional(),
  brand: z.string().trim().min(1).max(60).optional(),
  active: z.boolean().optional(),
  cost: PriceChange.optional(),
  price: PriceChange.optional(),
  lowStockThreshold: units.optional(),
  parLevel: units.optional(),
  highStockThreshold: units.nullable().optional(),
});

/** As bulkServiceChanges, for products: brand changes for the sync dialog; ones whose levels wouldn't hold are skipped with why. */
export async function bulkProductChanges(
  raw: z.input<typeof BulkProductsInput>,
): Promise<{
  changes: { type: "product"; item: string; value: unknown }[];
  results: BulkResult[];
}> {
  const v = BulkProductsInput.parse(raw);
  const { ids: _, ...fields } = v;
  if (Object.values(fields).every((x) => x === undefined))
    throw new AppError("bad_request", "Pick something to change");
  const rows = await db
    .select()
    .from(products)
    .where(inArray(products.id, v.ids));
  if (rows.length !== new Set(v.ids).size) throw notFound("Product");
  const changes: { type: "product"; item: string; value: unknown }[] = [];
  const results: BulkResult[] = [];
  for (const p of rows) {
    const next = {
      sku: p.sku,
      brand: v.brand ?? p.brand,
      category: v.category ?? p.category,
      active: v.active ?? p.active,
      costCents: v.cost ? applyPriceChange(p.costCents, v.cost) : p.costCents,
      priceCents: v.price
        ? applyPriceChange(p.priceCents, v.price)
        : p.priceCents,
      lowStockThreshold: v.lowStockThreshold ?? p.lowStockThreshold,
      parLevel: v.parLevel ?? p.parLevel,
      highStockThreshold:
        v.highStockThreshold !== undefined
          ? v.highStockThreshold
          : p.highStockThreshold,
    };
    const label = `${p.brand} ${p.name}`;
    const problem =
      levelsProblem(next.lowStockThreshold, next.parLevel) ??
      highProblem(next.parLevel, next.highStockThreshold);
    if (problem) {
      results.push({ id: p.id, label, ok: false, error: problem });
      continue;
    }
    if (
      Object.keys(changed(p as unknown as Record<string, unknown>, next)).length
    )
      changes.push({ type: "product", item: p.id, value: next });
    results.push({ id: p.id, label, ok: true });
  }
  return { changes, results };
}

// ───────────────────────────── Staff ─────────────────────────────

export const BulkStaffInput = z.object({
  staffIds: ids,
  /** "all" for every shop they work at, else one shop ("this shop only"). */
  scope: z.union([z.literal("all"), z.uuid()]),
  visibleOnline: z.boolean().optional(),
  /** Booking options to set; null puts a key back on following the next level. */
  options: z
    .record(z.string(), z.union([z.boolean(), z.number(), z.null()]))
    .optional(),
});

/**
 * Visible online and booking options for many barbers, at all their shops or one shop. Each person
 * goes through the same checks as their own page, so one they can't change is reported, not fatal.
 */
export async function bulkStaff(
  v: SettingsViewer,
  raw: z.input<typeof BulkStaffInput>,
): Promise<BulkResult[]> {
  const input = BulkStaffInput.parse(raw);
  const optionKeys = Object.keys(input.options ?? {}).filter(
    (k): k is BookingOptionKey =>
      (BOOKING_OPTION_KEYS as readonly string[]).includes(k),
  );
  if (input.visibleOnline === undefined && !optionKeys.length)
    throw new AppError("bad_request", "Pick something to change");
  const people = await db
    .select({
      id: staff.id,
      label: staff.displayLabel,
      all: staff.bookingOptions,
    })
    .from(staff)
    .where(inArray(staff.id, input.staffIds));
  const links =
    input.scope === "all"
      ? []
      : await db
          .select()
          .from(staffShops)
          .where(
            and(
              eq(staffShops.shopId, input.scope),
              inArray(staffShops.staffId, input.staffIds),
            ),
          );
  const out: BulkResult[] = [];
  for (const p of people) {
    try {
      if (optionKeys.length) {
        const current = cleanBookingOptions(
          input.scope === "all"
            ? p.all
            : links.find((l) => l.staffId === p.id)?.bookingOptions,
        );
        const next: Record<string, unknown> = { ...current };
        for (const k of optionKeys) next[k] = input.options![k];
        await saveBookingOptions(v, {
          staffId: p.id,
          scope: input.scope,
          options: next,
        });
      }
      if (input.visibleOnline !== undefined)
        await setVisibleOnline(v, {
          staffId: p.id,
          scope: input.scope,
          visible: input.visibleOnline,
        });
      out.push({ id: p.id, label: p.label, ok: true });
    } catch (e) {
      out.push({
        id: p.id,
        label: p.label,
        ok: false,
        error: e instanceof Error ? e.message : "Couldn't change",
      });
    }
  }
  return out;
}

// ───────────────────────────── Schedule templates ─────────────────────────────

export async function listScheduleTemplates() {
  return db
    .select()
    .from(scheduleTemplates)
    .orderBy(asc(scheduleTemplates.name));
}

const sortRows = (rows: TemplateRow[]) =>
  [...rows].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);

export async function saveScheduleTemplate(
  actor: Actor,
  raw: z.input<typeof ScheduleTemplateInput>,
) {
  const v = ScheduleTemplateInput.parse(raw);
  const problem = templateProblem(v.rows);
  if (problem) throw new AppError("bad_request", problem);
  const clash = await db.query.scheduleTemplates.findFirst({
    where: and(
      sql`lower(${scheduleTemplates.name}) = lower(${v.name})`,
      v.id ? ne(scheduleTemplates.id, v.id) : undefined,
    ),
  });
  if (clash)
    throw new AppError(
      "conflict",
      `There's already a template called ${clash.name}`,
    );
  const rows = sortRows(v.rows);
  return db.transaction(async (tx) => {
    if (v.id) {
      const [before] = await tx
        .select()
        .from(scheduleTemplates)
        .where(eq(scheduleTemplates.id, v.id));
      if (!before) throw notFound("Template");
      await tx
        .update(scheduleTemplates)
        .set({ name: v.name, rows, updatedAt: new Date() })
        .where(eq(scheduleTemplates.id, v.id));
      await audit(
        actor,
        "schedule_template.update",
        "schedule_template",
        v.id,
        {
          name: v.name,
          rows,
          before: { name: before.name, rows: before.rows },
        },
        null,
        tx,
      );
      return { id: v.id };
    }
    const [t] = await tx
      .insert(scheduleTemplates)
      .values({ name: v.name, rows, createdBy: actor.staffId ?? null })
      .returning({ id: scheduleTemplates.id });
    await audit(
      actor,
      "schedule_template.create",
      "schedule_template",
      t.id,
      { name: v.name, rows },
      null,
      tx,
    );
    return { id: t.id };
  });
}

export async function deleteScheduleTemplate(actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const [t] = await tx
      .delete(scheduleTemplates)
      .where(eq(scheduleTemplates.id, id))
      .returning();
    if (!t) throw notFound("Template");
    await audit(
      actor,
      "schedule_template.delete",
      "schedule_template",
      id,
      { name: t.name, rows: t.rows },
      null,
      tx,
    );
  });
}

export const ApplyTemplateInput = z.object({
  templateId: z.uuid(),
  shopId: z.uuid(),
  staffIds: ids,
});

/**
 * Replaces each barber's weekly hours at this shop with the template. Their hours at other shops
 * stay, and a barber whose hours elsewhere would overlap is skipped with the clash named.
 */
export async function applyScheduleTemplate(
  actor: Actor,
  raw: z.input<typeof ApplyTemplateInput>,
  canSchedule: (staffId: string) => Promise<void>,
): Promise<BulkResult[]> {
  const v = ApplyTemplateInput.parse(raw);
  const [t, shop] = await Promise.all([
    db.query.scheduleTemplates.findFirst({
      where: eq(scheduleTemplates.id, v.templateId),
    }),
    db.query.shops.findFirst({
      where: eq(shops.id, v.shopId),
      columns: { id: true, name: true },
    }),
  ]);
  if (!t) throw notFound("Template");
  if (!shop) throw notFound("Shop");
  const rows = sortRows(t.rows);
  const people = await db
    .select({ id: staff.id, label: staff.displayLabel })
    .from(staff)
    .where(inArray(staff.id, v.staffIds));
  const names = await db.select({ id: shops.id, name: shops.name }).from(shops);
  const nm = (id: string) =>
    names.find((n) => n.id === id)?.name ?? "another shop";
  const out: BulkResult[] = [];
  for (const p of people) {
    try {
      await canSchedule(p.id);
      const link = await db.query.staffShops.findFirst({
        where: and(
          eq(staffShops.staffId, p.id),
          eq(staffShops.shopId, v.shopId),
        ),
      });
      if (!link)
        throw new AppError("bad_request", `They don't work at ${shop.name}`);
      const elsewhere = await db
        .select()
        .from(staffSchedules)
        .where(
          and(
            eq(staffSchedules.staffId, p.id),
            ne(staffSchedules.shopId, v.shopId),
          ),
        );
      const next = rows.map((r) => ({ ...r, staffId: p.id, shopId: v.shopId }));
      if (findScheduleConflicts([...elsewhere, ...next]).length) {
        const o = elsewhere.find((e) =>
          next.some(
            (n) =>
              n.weekday === e.weekday &&
              n.startMin < e.endMin &&
              e.startMin < n.endMin,
          ),
        )!;
        throw new AppError(
          "conflict",
          `${WEEKDAYS[o.weekday]} overlaps their ${minutesToLabel(o.startMin)}–${minutesToLabel(o.endMin)} at ${nm(o.shopId)}`,
        );
      }
      await db.transaction(async (tx) => {
        const before = await tx
          .select()
          .from(staffSchedules)
          .where(
            and(
              eq(staffSchedules.staffId, p.id),
              eq(staffSchedules.shopId, v.shopId),
            ),
          );
        await tx
          .delete(staffSchedules)
          .where(
            and(
              eq(staffSchedules.staffId, p.id),
              eq(staffSchedules.shopId, v.shopId),
            ),
          );
        if (next.length) await tx.insert(staffSchedules).values(next);
        await audit(
          actor,
          "staff.schedule",
          "staff",
          p.id,
          {
            template: t.name,
            shopId: v.shopId,
            rows: next.map(({ weekday, startMin, endMin }) => ({
              weekday,
              startMin,
              endMin,
            })),
            before: before.map(({ weekday, startMin, endMin }) => ({
              weekday,
              startMin,
              endMin,
            })),
          },
          v.shopId,
          tx,
        );
      });
      out.push({ id: p.id, label: p.label, ok: true });
    } catch (e) {
      out.push({
        id: p.id,
        label: p.label,
        ok: false,
        error: e instanceof Error ? e.message : "Couldn't apply",
      });
    }
  }
  return out;
}
