import { and, asc, count, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appointments,
  cashDrawers,
  locationGroupShops,
  locationGroups,
  notificationJobs,
  ownerEntities,
  payGroups,
  products,
  roles,
  sales,
  services,
  shopClosures,
  shopHours,
  shopProducts,
  shopServices,
  shopVendors,
  shops,
  staff,
  staffAccessShops,
  staffSchedules,
  staffShops,
  terminalReaders,
  vendors,
  type ShopStatus,
} from "@/db/schema";
import { findScheduleConflicts } from "@/domain/availability";
import { LocationDraft, type LocationDraftInput } from "@/domain/location-draft";
import { canMove, goLiveBlockers, operational, slugProblem } from "@/domain/location-lifecycle";
import { Grantor } from "@/domain/permissions";
import { endOfLocalDay, startOfLocalDay, todayLocal, type LocalDate } from "@/lib/time";
import { Actor, audit } from "./audit";
import { AppError, forbidden, notFound } from "./errors";
import { locationSetup } from "./location-setup";
import { registerReader } from "./payments/connect";
import { createShopLogin, shopLoginRoles } from "./shop-logins";

/** Adding, opening and retiring locations needs locations.setup, which only people who see every shop can hold. */
export interface LocationAdmin {
  actor: Actor;
  brandWide: boolean;
  shopIds: readonly string[];
  grantor: Grantor;
}

function assertAdmin(m: LocationAdmin) {
  if (!m.brandWide || !m.grantor.permissions.has("locations.setup")) throw forbidden("Only the Brand Owner or a Brand Admin can add, open or archive locations");
}

const LIVE_APPOINTMENTS = ["booked", "confirmed", "checked_in", "in_service"] as const;

/** Everything the wizard offers to copy or assign, brand-wide. */
export async function wizardOptions(g: Grantor) {
  const [shopRows, svc, shopSvc, prod, shopProd, vend, people, links, sched, groups, owners, roleRows, cal] = await Promise.all([
    db.select({ id: shops.id, name: shops.name, status: shops.status, serviceTaxRate: shops.serviceTaxRate, productTaxRate: shops.productTaxRate, state: shops.state }).from(shops).orderBy(asc(shops.name)),
    db
      .select({ id: services.id, name: services.name, kind: services.kind, category: services.category, priceCents: services.defaultPriceCents, durationMin: services.defaultDurationMin })
      .from(services)
      .where(eq(services.active, true))
      .orderBy(asc(services.sortOrder), asc(services.name)),
    db.select().from(shopServices),
    db
      .select({ id: products.id, sku: products.sku, name: products.name, brand: products.brand, priceCents: products.priceCents, parLevel: products.parLevel, lowStockThreshold: products.lowStockThreshold })
      .from(products)
      .where(eq(products.active, true))
      .orderBy(asc(products.brand), asc(products.name)),
    db
      .select({ shopId: shopProducts.shopId, productId: shopProducts.productId, priceCents: shopProducts.priceCents, parLevel: shopProducts.parLevel, lowStockThreshold: shopProducts.lowStockThreshold })
      .from(shopProducts)
      .where(eq(shopProducts.active, true)),
    db.select({ id: vendors.id, name: vendors.name, accountNumber: vendors.accountNumber }).from(vendors).where(eq(vendors.active, true)).orderBy(asc(vendors.name)),
    db
      .select({ id: staff.id, label: staff.displayLabel, scope: staff.shopScope, isBookable: staff.isBookable, roleId: staff.roleId })
      .from(staff)
      .where(and(eq(staff.active, true), eq(staff.kind, "person")))
      .orderBy(asc(staff.displayLabel)),
    db.select({ staffId: staffShops.staffId, shopId: staffShops.shopId }).from(staffShops),
    db.select({ staffId: staffSchedules.staffId, shopId: staffSchedules.shopId, weekday: staffSchedules.weekday, startMin: staffSchedules.startMin, endMin: staffSchedules.endMin }).from(staffSchedules),
    db.select({ id: locationGroups.id, name: locationGroups.name }).from(locationGroups).orderBy(asc(locationGroups.name)),
    db.select({ id: ownerEntities.id, name: ownerEntities.name, kind: ownerEntities.kind }).from(ownerEntities).orderBy(asc(ownerEntities.kind), asc(ownerEntities.name)),
    db.select().from(roles).orderBy(asc(roles.sortOrder)),
    db.select({ shopId: payGroups.shopId, anchorStart: payGroups.anchorStart, anchorNumber: payGroups.anchorNumber, periodDays: payGroups.periodDays }).from(payGroups),
  ]);
  const name = (id: string) => shopRows.find((s) => s.id === id)?.name ?? "";
  return {
    shops: shopRows.filter((s) => s.status !== "archived").map((s) => ({ ...s, serviceTaxRate: Number(s.serviceTaxRate), productTaxRate: Number(s.productTaxRate) })),
    services: svc,
    shopServices: shopSvc.map((r) => ({ shopId: r.shopId, serviceId: r.serviceId, enabled: r.enabled, bookableOnline: r.bookableOnline, priceCents: r.priceCents, durationMin: r.durationMin })),
    products: prod,
    shopProducts: shopProd,
    vendors: vend,
    staff: people.map((p) => ({
      ...p,
      shops: links.filter((l) => l.staffId === p.id).map((l) => name(l.shopId)).filter(Boolean),
      schedule: sched.filter((s) => s.staffId === p.id).map((s) => ({ shop: name(s.shopId), shopId: s.shopId, weekday: s.weekday, startMin: s.startMin, endMin: s.endMin })),
    })),
    groups,
    owners,
    loginRoles: shopLoginRoles(g, roleRows).map((r) => ({ id: r.id, name: r.name, key: r.key })),
    payCalendars: cal.map((c) => ({ ...c, shop: name(c.shopId) })).filter((c) => c.shop),
  };
}

async function surnames() {
  const rows = await db.select({ n: staff.lastName }).from(staff).where(sql`${staff.lastName} is not null`);
  return rows.map((r) => r.n);
}

/** Why this booking link name can't be used, or null. */
export async function checkSlug(slug: string, exceptShopId?: string): Promise<string | null> {
  const problem = slugProblem(slug, await surnames());
  if (problem) return problem;
  const taken = await db.query.shops.findFirst({ where: exceptShopId ? and(eq(shops.slug, slug), ne(shops.id, exceptShopId)) : eq(shops.slug, slug), columns: { id: true } });
  return taken ? "Another location already uses that booking link" : null;
}

/**
 * A new location from the wizard, in setup: hidden from clients and online booking until it goes
 * live. Everything is saved together, or nothing is. A shop login, if asked for, comes back with its
 * one-time password.
 */
export async function createLocation(m: LocationAdmin, raw: LocationDraftInput) {
  assertAdmin(m);
  const d = LocationDraft.parse(raw);
  if ((d.paymentsMode !== "connected" || d.statementDescriptor) && !m.grantor.permissions.has("payments.banking"))
    throw forbidden("Choosing where a shop's card money goes needs the banking permission. Leave Payments and banking on the defaults, or ask the Brand Owner.");
  if (d.networkAccess.enabled && !m.grantor.permissions.has("network.settings"))
    throw forbidden("Limiting where staff can sign in needs \u201cSet where staff can sign in from\u201d. Leave it off here, or ask the brand.");
  const slugIssue = await checkSlug(d.slug);
  if (slugIssue) throw new AppError("bad_request", slugIssue);
  if (d.twilioNumber && (await db.query.shops.findFirst({ where: eq(shops.twilioNumber, d.twilioNumber), columns: { id: true } })))
    throw new AppError("conflict", "That Twilio number is already another shop's line");
  for (const r of d.readers)
    if (r.stripeReaderId && (await db.query.terminalReaders.findFirst({ where: eq(terminalReaders.stripeReaderId, r.stripeReaderId), columns: { id: true } })))
      throw new AppError("conflict", `Reader ${r.stripeReaderId} is already registered to a shop`);

  const staffIds = [...new Set(d.staff.map((s) => s.staffId))];
  const people = staffIds.length ? await db.select({ id: staff.id, label: staff.displayLabel, scope: staff.shopScope, kind: staff.kind }).from(staff).where(inArray(staff.id, staffIds)) : [];
  if (people.length !== staffIds.length || people.some((p) => p.kind !== "person")) throw new AppError("bad_request", "Pick team members from the staff list");
  if (staffIds.length) {
    const existing = await db.select().from(staffSchedules).where(inArray(staffSchedules.staffId, staffIds));
    const NEW = "new-location";
    for (const s of d.staff) {
      for (const r of s.schedule) if (r.endMin <= r.startMin) throw new AppError("bad_request", `${people.find((p) => p.id === s.staffId)?.label}: a shift ends before it starts`);
      const rows = [...existing.filter((e) => e.staffId === s.staffId), ...s.schedule.map((r) => ({ ...r, staffId: s.staffId, shopId: NEW }))];
      if (findScheduleConflicts(rows).length)
        throw new AppError("conflict", `${people.find((p) => p.id === s.staffId)?.label}'s hours here overlap their hours at another shop. A barber can't be at two shops at once.`);
    }
  }
  const serviceIds = d.services.map((s) => s.serviceId);
  if (serviceIds.length && (await db.select({ n: count() }).from(services).where(inArray(services.id, serviceIds)))[0].n !== new Set(serviceIds).size)
    throw new AppError("bad_request", "One of the services no longer exists");
  const productIds = d.products.map((p) => p.productId);
  const productRows = productIds.length ? await db.select({ id: products.id, cost: products.costCents }).from(products).where(inArray(products.id, productIds)) : [];
  if (productRows.length !== new Set(productIds).size) throw new AppError("bad_request", "One of the products no longer exists");

  const id = await db.transaction(async (tx) => {
    const owner =
      d.ownerEntityId ?? (await tx.query.ownerEntities.findFirst({ where: eq(ownerEntities.kind, "brand"), orderBy: asc(ownerEntities.createdAt), columns: { id: true } }))?.id ?? null;
    const [s] = await tx
      .insert(shops)
      .values({
        slug: d.slug,
        name: d.name,
        address: d.address,
        city: d.city,
        state: d.state,
        zip: d.zip,
        phone: d.phone || null,
        email: d.email || null,
        timezone: d.timezone,
        ownerEntityId: owner,
        description: d.description || null,
        status: "setup",
        active: true,
        bookingEnabled: d.bookingEnabled,
        serviceTaxRate: String(d.serviceTaxRate),
        productTaxRate: String(d.productTaxRate),
        taxRatesVerified: d.taxRatesVerified,
        cardFeeEnabled: d.cardFeeEnabled,
        cardFeeRate: String(d.cardFeeRate),
        cardFeeAppliesToTip: d.cardFeeAppliesToTip,
        tipPresets: d.tipPresets,
        paymentsMode: d.paymentsMode,
        statementDescriptor: d.statementDescriptor,
        receipt: d.receipt,
        slotIntervalMinutes: d.slotIntervalMinutes,
        minLeadMinutes: d.minLeadMinutes,
        bookingWindowDays: d.bookingWindowDays,
        cancelCutoffMinutes: d.cancelCutoffMinutes,
        twilioNumber: d.twilioNumber || null,
        accentColor: d.accentColor,
        logoUrl: d.logoUrl,
        networkAccess: { ...d.networkAccess },
      })
      .returning({ id: shops.id });
    if (d.hours.length) await tx.insert(shopHours).values(d.hours.map((h) => ({ shopId: s.id, ...h })));
    if (d.holidays.length) await tx.insert(shopClosures).values(d.holidays.map((h) => ({ shopId: s.id, date: h.date, reason: h.reason }))).onConflictDoNothing();
    if (d.services.length) await tx.insert(shopServices).values(d.services.map((x) => ({ shopId: s.id, ...x })));
    if (d.products.length)
      await tx.insert(shopProducts).values(
        d.products.map((p) => ({ shopId: s.id, productId: p.productId, costCents: productRows.find((r) => r.id === p.productId)!.cost, priceCents: p.priceCents, parLevel: p.parLevel, lowStockThreshold: p.lowStockThreshold })),
      );
    if (d.vendors.length) await tx.insert(shopVendors).values(d.vendors.map((v) => ({ shopId: s.id, vendorId: v.vendorId, accountNumber: v.accountNumber || null })));
    for (const p of d.staff) {
      await tx.insert(staffShops).values({ staffId: p.staffId, shopId: s.id, visibleOnline: p.bookable, isPrimary: p.primary });
      if (p.primary) await tx.update(staffShops).set({ isPrimary: false }).where(and(eq(staffShops.staffId, p.staffId), ne(staffShops.shopId, s.id)));
      if (p.access && people.find((x) => x.id === p.staffId)!.scope !== "all") await tx.insert(staffAccessShops).values({ staffId: p.staffId, shopId: s.id }).onConflictDoNothing();
      if (p.schedule.length) await tx.insert(staffSchedules).values(p.schedule.map((r) => ({ ...r, staffId: p.staffId, shopId: s.id })));
    }
    if (d.payCalendarFromShopId) {
      const from = await tx.query.payGroups.findFirst({ where: eq(payGroups.shopId, d.payCalendarFromShopId) });
      if (from)
        await tx.insert(payGroups).values({
          shopId: s.id,
          label: d.name,
          legalEntity: from.legalEntity,
          exportTab: d.name,
          anchorStart: from.anchorStart,
          anchorNumber: from.anchorNumber,
          periodDays: from.periodDays,
          checkOffsetDays: from.checkOffsetDays,
          numberResetsYearly: from.numberResetsYearly,
        });
    }
    if (d.locationGroupIds.length) await tx.insert(locationGroupShops).values(d.locationGroupIds.map((groupId) => ({ groupId, shopId: s.id }))).onConflictDoNothing();
    const placeholders = d.readers.filter((r) => !r.registrationCode);
    if (placeholders.length)
      await tx.insert(terminalReaders).values(placeholders.map((r) => ({ shopId: s.id, label: r.label, serialNumber: r.serialNumber || null, stripeReaderId: r.stripeReaderId || null })));
    await audit(
      m.actor,
      "shop.create",
      "shop",
      s.id,
      {
        name: d.name,
        slug: d.slug,
        services: d.services.filter((x) => x.enabled).length,
        products: d.products.length,
        team: d.staff.map((x) => x.staffId),
        taxRatesVerified: d.taxRatesVerified,
        paymentsMode: d.paymentsMode,
        statementDescriptor: d.statementDescriptor,
        networkAccess: d.networkAccess,
      },
      s.id,
      tx,
    );
    return s.id;
  });

  const readerProblems: string[] = [];
  for (const r of d.readers.filter((x) => x.registrationCode))
    await registerReader(id, { label: r.label, registrationCode: r.registrationCode!, serialNumber: r.serialNumber }, m.actor).catch((e: unknown) => {
      readerProblems.push(`${r.label}: ${e instanceof Error ? e.message : String(e)}`);
    });
  const login = d.login ? await createShopLogin({ shopIds: [...m.shopIds, id], brandWide: m.brandWide, actor: m.actor, grantor: { ...m.grantor, shopIds: [...m.grantor.shopIds, id] } }, { shopId: id, ...d.login }) : null;
  return { id, slug: d.slug, paymentsMode: d.paymentsMode, readerProblems, login: login ? { email: d.login!.email, password: login.password } : null };
}

async function loadShop(id: string) {
  const s = await db.query.shops.findFirst({ where: eq(shops.id, id) });
  if (!s) throw notFound("Location");
  return s;
}

function assertMove(from: ShopStatus, to: ShopStatus) {
  if (!canMove(from, to)) throw new AppError("conflict", from === "archived" ? "This location is archived" : `A location that's ${from} can't be moved to ${to}`);
}

/** Opens a location to clients. Blocked until the required checklist items are done; card payments can be waived to open cash-only. */
export async function goLive(m: LocationAdmin, shopId: string, o: { cashOnly?: boolean; now?: Date } = {}) {
  assertAdmin(m);
  const s = await loadShop(shopId);
  assertMove(s.status, "live");
  if (s.status === "setup") {
    const setup = (await locationSetup(shopId))!;
    const blockers = goLiveBlockers(setup.steps, { cashOnly: o.cashOnly });
    if (blockers.length) {
      const titles = blockers.map((k) => setup.steps.find((x) => x.key === k)?.title ?? k);
      throw new AppError("conflict", `Finish these first: ${titles.join(", ")}`);
    }
  }
  const now = o.now ?? new Date();
  await db
    .update(shops)
    .set({ status: "live", closedUntil: null, closedNote: null, wentLiveAt: s.wentLiveAt ?? now })
    .where(eq(shops.id, shopId));
  await audit(m.actor, s.status === "closed" ? "shop.reopen" : "shop.go_live", "shop", shopId, { cashOnly: !!o.cashOnly, paymentsMode: s.paymentsMode }, shopId);
}

/** Booked appointments at the shop from `from` (a local date) through `to` (or forever). */
export async function bookedBetween(shopId: string, from: LocalDate, to: LocalDate | null) {
  return db
    .select({ id: appointments.id, startsAt: appointments.startsAt, code: appointments.code })
    .from(appointments)
    .where(
      and(
        eq(appointments.shopId, shopId),
        inArray(appointments.status, [...LIVE_APPOINTMENTS]),
        gte(appointments.startsAt, startOfLocalDay(from)),
        to ? lt(appointments.startsAt, endOfLocalDay(to)) : undefined,
      ),
    )
    .orderBy(asc(appointments.startsAt));
}

/**
 * Temporarily closed: clients still see the shop with the note, but can't book. Appointments inside
 * the closure have to be moved or cancelled first, so no client turns up to a locked door.
 */
export async function closeTemporarily(m: LocationAdmin, shopId: string, o: { from?: LocalDate; until: LocalDate | null; note: string | null; now?: Date }) {
  assertAdmin(m);
  const s = await loadShop(shopId);
  assertMove(s.status, "closed");
  const from = o.from ?? todayLocal(o.now);
  if (o.until && o.until < from) throw new AppError("bad_request", "The reopening date is before today");
  const booked = await bookedBetween(shopId, from, o.until);
  if (booked.length) throw new AppError("conflict", `${booked.length} appointment${booked.length === 1 ? " is" : "s are"} booked while it's closed. Move or cancel ${booked.length === 1 ? "it" : "them"} first.`);
  await db.update(shops).set({ status: "closed", closedUntil: o.until, closedNote: o.note?.trim() || null }).where(eq(shops.id, shopId));
  await audit(m.actor, "shop.close", "shop", shopId, { until: o.until, note: o.note }, shopId);
}

export async function reopen(m: LocationAdmin, shopId: string) {
  return goLive(m, shopId);
}

/**
 * Retires a location. Its sales, appointments, payroll and stock history stay in every report; it
 * leaves booking, the calendar, pickers and the shop switcher. Its shop logins are disabled at once,
 * its barbers' hours there are removed and messages not yet sent are cancelled.
 */
export async function archiveLocation(m: LocationAdmin, shopId: string, o: { now?: Date } = {}) {
  assertAdmin(m);
  const s = await loadShop(shopId);
  assertMove(s.status, "archived");
  const now = o.now ?? new Date();
  const booked = await bookedBetween(shopId, todayLocal(now), null);
  if (booked.length) throw new AppError("conflict", `${booked.length} upcoming appointment${booked.length === 1 ? " is" : "s are"} still booked here. Move or cancel ${booked.length === 1 ? "it" : "them"} first.`);
  const [open] = await db.select({ n: count() }).from(sales).where(and(eq(sales.shopId, shopId), eq(sales.status, "open")));
  if (open.n) throw new AppError("conflict", `${open.n} ticket${open.n === 1 ? " is" : "s are"} still open here. Check out or void ${open.n === 1 ? "it" : "them"} first.`);
  const [drawer] = await db.select({ n: count() }).from(cashDrawers).where(and(eq(cashDrawers.shopId, shopId), sql`${cashDrawers.closedAt} is null`));
  if (drawer.n) throw new AppError("conflict", "The cash drawer is still open here. Close it first.");

  const result = await db.transaction(async (tx) => {
    const logins = await tx
      .select({ id: staff.id })
      .from(staff)
      .innerJoin(staffAccessShops, eq(staffAccessShops.staffId, staff.id))
      .where(and(eq(staff.kind, "shop"), eq(staffAccessShops.shopId, shopId), eq(staff.active, true)));
    if (logins.length)
      await tx
        .update(staff)
        .set({ active: false, sessionsValidAfter: now })
        .where(inArray(staff.id, logins.map((l) => l.id)));
    const removed = await tx.delete(staffSchedules).where(eq(staffSchedules.shopId, shopId)).returning({ id: staffSchedules.id });
    await tx.update(staffShops).set({ visibleOnline: false, isPrimary: false }).where(eq(staffShops.shopId, shopId));
    const cancelled = await tx
      .update(notificationJobs)
      .set({ status: "cancelled", lastError: "The location was archived" })
      .where(and(eq(notificationJobs.shopId, shopId), eq(notificationJobs.status, "pending")))
      .returning({ id: notificationJobs.id });
    await tx.update(terminalReaders).set({ active: false }).where(eq(terminalReaders.shopId, shopId));
    await tx
      .update(shops)
      .set({ status: "archived", active: false, bookingEnabled: false, archivedAt: now, twilioNumber: null })
      .where(eq(shops.id, shopId));
    const r = { loginsDisabled: logins.length, schedulesRemoved: removed.length, messagesCancelled: cancelled.length, releasedNumber: s.twilioNumber };
    await audit(m.actor, "shop.archive", "shop", shopId, r, shopId, tx);
    return r;
  });
  return result;
}

/** Shops staff can still work in (pickers, switchers): everything but archived. */
export async function openShopIds(ids: readonly string[]) {
  if (!ids.length) return [];
  const rows = await db.select({ id: shops.id, status: shops.status }).from(shops).where(inArray(shops.id, [...ids]));
  return ids.filter((id) => rows.some((r) => r.id === id && operational(r)));
}
