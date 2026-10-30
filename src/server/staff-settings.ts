import { and, asc, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff, staffDaysOn, staffShops, timeBlocks } from "@/db/schema";
import { BOOKING_OPTION_KEYS, EffectiveOptions, StaffBookingOptions, cleanBookingOptions, effectiveBookingOptions } from "@/domain/staff-booking";
import { StaffNotificationPrefs, cleanNotificationPrefs } from "@/domain/staff-notifications";
import { LocalDate, addDays, isValidLocalDate, todayLocal } from "@/lib/time";
import { Actor, audit } from "./audit";
import { AppError, forbidden, notFound } from "./errors";

/** Who is changing a barber's settings: their shops, and whether they reach every shop. */
export interface SettingsViewer {
  actor: Actor;
  staffId: string;
  shopIds: string[];
  brandWide: boolean;
}

async function links(staffId: string) {
  return db.select().from(staffShops).where(eq(staffShops.staffId, staffId));
}

/**
 * "All shops" settings change the barber everywhere they work, so they need access to every one of
 * those shops; "this shop only" needs that shop. A barber's own notification settings are theirs.
 */
async function assertScope(v: SettingsViewer, staffId: string, scope: "all" | string) {
  const person = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { id: true, kind: true } });
  if (!person || person.kind !== "person") throw notFound("Staff member");
  const ls = await links(staffId);
  if (scope === "all") {
    if (!v.brandWide && ls.some((l) => !v.shopIds.includes(l.shopId))) throw forbidden("They work at shops you don't manage: change their all-shops settings from an account with every one of those shops, or set this shop only");
    return ls;
  }
  if (!ls.some((l) => l.shopId === scope)) throw new AppError("bad_request", "They don't work at that shop");
  if (!v.brandWide && !v.shopIds.includes(scope)) throw forbidden("That shop isn't one of yours");
  return ls;
}

export interface BookingOptionsView {
  all: StaffBookingOptions;
  shops: { shopId: string; shopName: string; visibleOnline: boolean; here: StaffBookingOptions; effective: EffectiveOptions; editable: boolean }[];
  canSetAll: boolean;
}

export async function loadBookingOptions(v: Pick<SettingsViewer, "shopIds" | "brandWide">, staffId: string): Promise<BookingOptionsView | null> {
  const person = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { bookingOptions: true, kind: true } });
  if (!person || person.kind !== "person") return null;
  const rows = await db
    .select({ l: staffShops, shop: shops })
    .from(staffShops)
    .innerJoin(shops, eq(shops.id, staffShops.shopId))
    .where(eq(staffShops.staffId, staffId))
    .orderBy(asc(shops.name));
  const all = cleanBookingOptions(person.bookingOptions);
  const visible = rows.filter((r) => v.brandWide || v.shopIds.includes(r.shop.id));
  return {
    all,
    canSetAll: v.brandWide || rows.every((r) => v.shopIds.includes(r.shop.id)),
    shops: visible.map((r) => {
      const here = cleanBookingOptions(r.l.bookingOptions);
      return { shopId: r.shop.id, shopName: r.shop.name, visibleOnline: r.l.visibleOnline, here, effective: effectiveBookingOptions(r.shop, all, here), editable: true };
    }),
  };
}

/**
 * Saves booking options for all shops or one shop. A key left out (or null) goes back to following
 * the next level: this shop → all shops → the shop.
 */
export async function saveBookingOptions(v: SettingsViewer, input: { staffId: string; scope: "all" | string; options: unknown }) {
  await assertScope(v, input.staffId, input.scope);
  const options = cleanBookingOptions(input.options);
  const raw = (input.options && typeof input.options === "object" ? input.options : {}) as Record<string, unknown>;
  const rejected = BOOKING_OPTION_KEYS.filter((k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== "" && options[k] === undefined);
  if (rejected.length) throw new AppError("bad_request", `Check ${rejected.join(", ")}: whole numbers within the limits`);
  await db.transaction(async (tx) => {
    if (input.scope === "all") {
      const before = await tx.query.staff.findFirst({ where: eq(staff.id, input.staffId), columns: { bookingOptions: true } });
      await tx.update(staff).set({ bookingOptions: options }).where(eq(staff.id, input.staffId));
      await audit(v.actor, "staff.booking_options", "staff", input.staffId, { scope: "all_shops", before: before?.bookingOptions ?? {}, after: options }, null, tx);
    } else {
      const [before] = await tx.select({ o: staffShops.bookingOptions }).from(staffShops).where(and(eq(staffShops.staffId, input.staffId), eq(staffShops.shopId, input.scope)));
      await tx.update(staffShops).set({ bookingOptions: options }).where(and(eq(staffShops.staffId, input.staffId), eq(staffShops.shopId, input.scope)));
      await audit(v.actor, "staff.booking_options", "staff", input.staffId, { scope: "this_shop", shopId: input.scope, before: before?.o ?? {}, after: options }, input.scope, tx);
    }
  });
  return options;
}

/** Shown on the booking site and app at one shop, or every shop they work at. Staff can still book them. */
export async function setVisibleOnline(v: SettingsViewer, input: { staffId: string; scope: "all" | string; visible: boolean }) {
  const ls = await assertScope(v, input.staffId, input.scope);
  const shopIds = input.scope === "all" ? ls.map((l) => l.shopId) : [input.scope];
  if (!shopIds.length) return 0;
  await db.transaction(async (tx) => {
    await tx.update(staffShops).set({ visibleOnline: input.visible }).where(and(eq(staffShops.staffId, input.staffId), inArray(staffShops.shopId, shopIds)));
    await audit(v.actor, "staff.visible_online", "staff", input.staffId, { scope: input.scope === "all" ? "all_shops" : "this_shop", shopIds, visible: input.visible }, input.scope === "all" ? null : input.scope, tx);
  });
  return shopIds.length;
}

export async function loadNotificationPrefs(staffId: string): Promise<StaffNotificationPrefs | null> {
  const p = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { notificationPrefs: true } });
  return p ? cleanNotificationPrefs(p.notificationPrefs) : null;
}

/** Their own, or anyone's on your shops with "Manage staff". */
export async function saveNotificationPrefs(v: SettingsViewer & { canManage: boolean }, input: { staffId: string; prefs: unknown }) {
  if (input.staffId !== v.staffId) {
    if (!v.canManage) throw forbidden("You can change your own notifications only");
    const ls = await links(input.staffId);
    if (!v.brandWide && !ls.some((l) => v.shopIds.includes(l.shopId))) throw forbidden("That person isn't on your shops' team");
  }
  const prefs = cleanNotificationPrefs(input.prefs);
  await db.transaction(async (tx) => {
    await tx.update(staff).set({ notificationPrefs: { ...prefs } }).where(eq(staff.id, input.staffId));
    await audit(v.actor, "staff.notification_prefs", "staff", input.staffId, { prefs }, null, tx);
  });
  return prefs;
}

export async function addDayOn(v: SettingsViewer, input: { staffId: string; shopId: string; date: LocalDate; startMin: number; endMin: number; note?: string | null }, now = new Date()) {
  await assertScope(v, input.staffId, input.shopId);
  if (!isValidLocalDate(input.date) || input.date < todayLocal(now)) throw new AppError("bad_request", "Pick today or a later date");
  if (!Number.isInteger(input.startMin) || !Number.isInteger(input.endMin) || input.startMin < 0 || input.endMin > 1440 || input.endMin <= input.startMin) throw new AppError("bad_request", "The end has to be after the start");
  const clash = await db
    .select({ id: staffDaysOn.id })
    .from(staffDaysOn)
    .where(and(eq(staffDaysOn.staffId, input.staffId), eq(staffDaysOn.date, input.date), isNull(staffDaysOn.removedAt), lt(staffDaysOn.startMin, input.endMin), gte(staffDaysOn.endMin, input.startMin + 1)));
  if (clash.length) throw new AppError("conflict", "They already have a day on then");
  const note = input.note?.trim().slice(0, 200) || null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(staffDaysOn)
      .values({ staffId: input.staffId, shopId: input.shopId, date: input.date, startMin: input.startMin, endMin: input.endMin, note, createdBy: v.staffId, createdAt: now })
      .returning({ id: staffDaysOn.id });
    await audit(v.actor, "staff.day_on.add", "staff", input.staffId, { id: row.id, date: input.date, startMin: input.startMin, endMin: input.endMin, note }, input.shopId, tx);
    return row.id;
  });
}

export async function removeDayOn(v: SettingsViewer, id: string, now = new Date()) {
  const row = await db.query.staffDaysOn.findFirst({ where: eq(staffDaysOn.id, id) });
  if (!row || row.removedAt) throw notFound("Day on");
  await assertScope(v, row.staffId, row.shopId);
  await db.transaction(async (tx) => {
    await tx.update(staffDaysOn).set({ removedAt: now, removedBy: v.staffId }).where(eq(staffDaysOn.id, id));
    await audit(v.actor, "staff.day_on.remove", "staff", row.staffId, { id, date: row.date }, row.shopId, tx);
  });
}

export interface DayHistoryRow {
  kind: "on" | "off";
  id: string;
  date: LocalDate;
  shopId: string | null;
  startMin: number | null;
  endMin: number | null;
  /** Days off: the end date when it runs over several days. */
  through: LocalDate | null;
  note: string | null;
  removed: boolean;
  upcoming: boolean;
}

/** Days on and days off from 90 days back on, newest first: what was added, what was removed. */
export async function dayHistory(staffId: string, shopIds: string[] | null, now = new Date()): Promise<DayHistoryRow[]> {
  const today = todayLocal(now);
  const since = addDays(today, -90);
  const [on, off] = await Promise.all([
    db
      .select()
      .from(staffDaysOn)
      .where(and(eq(staffDaysOn.staffId, staffId), gte(staffDaysOn.date, since), shopIds ? inArray(staffDaysOn.shopId, shopIds) : undefined))
      .orderBy(desc(staffDaysOn.date)),
    db
      .select()
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.staffId, staffId),
          or(eq(timeBlocks.kind, "day_off"), eq(timeBlocks.category, "time_off")),
          gte(timeBlocks.endsAt, new Date(`${since}T00:00:00Z`)),
          shopIds ? or(isNull(timeBlocks.shopId), inArray(timeBlocks.shopId, shopIds)) : undefined,
        ),
      )
      .orderBy(desc(timeBlocks.startsAt)),
  ]);
  const local = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  return [
    ...on.map((d) => ({ kind: "on" as const, id: d.id, date: d.date, shopId: d.shopId, startMin: d.startMin, endMin: d.endMin, through: null, note: d.note, removed: !!d.removedAt, upcoming: d.date >= today })),
    ...off.map((b) => {
      const end = local(new Date(b.endsAt.getTime() - 1));
      return { kind: "off" as const, id: b.id, date: local(b.startsAt), shopId: b.shopId, startMin: null, endMin: null, through: end !== local(b.startsAt) ? end : null, note: null, removed: false, upcoming: end >= today };
    }),
  ].sort((a, b) => b.date.localeCompare(a.date));
}
