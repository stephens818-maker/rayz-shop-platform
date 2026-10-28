import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, closeDb } from "@/db";
import * as t from "@/db/schema";
import { computeCheckout, CartLine } from "@/domain/checkout";
import { DEFAULT_LOYALTY, accrue, rewardExpiry } from "@/domain/loyalty";
import { ROLE_TEMPLATES, templateFor, templateRow } from "@/domain/permissions";
import { appointmentCode, giftCardCode, slugify, staffPublicSlug } from "@/lib/ids";
import { simulateConnectHistory } from "@/server/payments/connect";
import { DEFAULT_BLOCK_REASONS } from "@/domain/block-reasons";
import { offSchedule } from "@/domain/time-clock";
import { rederive } from "@/server/time-clock";
import { recordOpeningTips, syncTipLedger } from "@/server/tips/ledger";
import { computeDailyStats } from "@/server/rollups";
import { anniversaryDate } from "@/domain/milestones";
import { DEFAULT_STAFF_TIME_RULES, SERIES_HORIZON_DAYS, seriesOccurrences, timeOffSpan } from "@/domain/staff-time";
import { LocalDate, addDays, diffDays, localDateOf, localMinutesOf, startOfLocalDay, todayLocal, weekdayOf, zonedWallTime } from "@/lib/time";
import { BARBER_GROUPS, COLORS, DEMO_LOGINS, FIRST_NAMES, LAST_NAMES, LOCATION_GROUPS, MENUS, REGIONS, PRODUCTS, SERVICES, SHOPS, SHOP_DESCRIPTION, STAFF } from "./seed-data";

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "rayz2026!";
const HISTORY_DAYS = Number(process.env.SEED_HISTORY_DAYS ?? 56);
const FUTURE_DAYS = 14;
const MAKENNA_LUNCH = 12 * 60 + 30;

// Deterministic PRNG so every seed produces the same sample data.
let seedState = 20261003;
function rand() {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let x = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
const chance = (p: number) => rand() < p;

async function chunked<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

async function main() {
  const now = new Date();
  const today = todayLocal(now);
  console.log(`Seeding (today = ${today} America/Chicago)…`);

  await db.execute(sql`TRUNCATE TABLE
    analytics_events, analytics_exports, analytics_customer_moves, visit_satisfaction, client_access_alerts, client_access_log, client_field_rules, client_fields,
    call_logs, messages, message_threads, contact_opt_outs, rebook_links, appointment_outreach, call_ins,
    audit_log, stripe_events, app_payments, customer_cards, shop_cutovers, import_runs, notification_jobs, loyalty_ledger, loyalty_rewards, loyalty_accounts,
    tip_ledger, tip_payouts, tip_payout_batches, staff_payout_accounts, cash_drawers, refunds, payments, sale_items, sales, gift_card_ledger, gift_cards, promo_codes,
    client_ratings, waitlist_entries, appointment_items, appointments, refresh_tokens, otp_codes, identity_help_requests, api_rate_events, consent_events, customer_devices, customer_squire_ids, customers,
    inventory_ledger, po_receipt_lines, po_receipts, purchase_order_lines, purchase_orders, vendor_products, vendors,
    stock_transfer_lines, stock_transfers, stock_count_lines, stock_counts, shop_products, products, shop_services, services, time_blocks, time_block_series, time_off_requests, block_reasons,
    location_group_shops, location_groups, staff_group_members, staff_groups, staff_schedules, staff_shops, staff_access_shops, staff, roles, shop_closures, shop_hours,
    job_tasks, location_daily_stats, shop_payouts, shop_payment_accounts, shops, regions, owner_entities, brand_settings
    RESTART IDENTITY CASCADE`);
  // iSolved's schedule is migration data and stays; periods an admin added past its end are demo data.
  await db.delete(t.paySchedulePeriods).where(eq(t.paySchedulePeriods.source, "admin"));

  const roleRows = await db.insert(t.roles).values(ROLE_TEMPLATES.map(templateRow)).returning();
  const roleId = (key: string) => roleRows.find((r) => r.key === key)!.id;

  // The sample brand shows the surcharge at work; a real brand starts with it off (DEFAULT_CARD_FEE_POLICY).
  await db.insert(t.brandSettings).values({ id: 1, loyalty: DEFAULT_LOYALTY, staffTime: { ...DEFAULT_STAFF_TIME_RULES }, cardFee: { enabled: true } });
  const reasonRows = await db.insert(t.blockReasons).values(DEFAULT_BLOCK_REASONS.map((r) => ({ ...r }))).returning();
  const reason = (key: string) => {
    const r = reasonRows.find((x) => x.key === key)!;
    return { reasonId: r.id, reason: r.label };
  };

  // ── Shops, all owned by Ray'z Corporate, the default owner ──
  const [brandOwner] = await db
    .insert(t.ownerEntities)
    .values({ name: "Ray'z Corporate", legalName: "Ray'z Barber Shop LLC", kind: "brand", isDefault: true, contactEmail: "owner@rayz.test" })
    .returning();
  const shopRows = await db
    .insert(t.shops)
    .values(
      SHOPS.map((s, i) => ({
        slug: s.slug,
        name: s.name,
        address: s.address,
        city: s.city,
        state: s.state,
        zip: s.zip,
        phone: s.phone,
        twilioNumber: `+13195550${900 + i}`,
        email: s.email,
        serviceTaxRate: s.serviceTaxRate,
        productTaxRate: s.productTaxRate,
        description: SHOP_DESCRIPTION,
        ownerEntityId: brandOwner.id,
        cardFeeEnabled: true,
      })),
    )
    .returning();
  const shopBySlug = new Map(shopRows.map((s) => [s.slug, s]));
  // As in Squire: Dubuque isn't assigned to the loyalty program.
  await db.update(t.brandSettings).set({ loyalty: { ...DEFAULT_LOYALTY, shopIds: shopRows.filter((s) => s.slug !== "dubuque").map((s) => s.id) } });
  await db.insert(t.shopHours).values(
    SHOPS.flatMap((s) =>
      Object.entries(s.hours).map(([wd, [o, c]]) => ({ shopId: shopBySlug.get(s.slug)!.id, weekday: Number(wd), openMin: o * 60, closeMin: c * 60 })),
    ),
  );
  // Dubuque runs payroll on its own calendar (period 01 = 10/4–10/17/2026); the other shops get the brand's when payroll first opens.
  const dubuque = shopBySlug.get("dubuque");
  if (dubuque) {
    await db
      .insert(t.payGroups)
      .values({ shopId: dubuque.id, label: dubuque.name, exportTab: dubuque.name, anchorStart: "2026-10-04", anchorNumber: 1, periodDays: 14, checkOffsetDays: 6, numberResetsYearly: true });
  }
  for (const g of REGIONS) {
    const [region] = await db.insert(t.regions).values({ name: g.name, slug: slugify(g.name) }).returning();
    const ids = g.shops.map((slug) => shopBySlug.get(slug)?.id).filter((id): id is string => !!id);
    if (ids.length) await db.update(t.shops).set({ regionId: region.id }).where(inArray(t.shops.id, ids));
  }
  for (const g of LOCATION_GROUPS) {
    const [row] = await db.insert(t.locationGroups).values({ name: g.name }).returning();
    await db.insert(t.locationGroupShops).values(g.shops.map((slug) => ({ groupId: row.id, shopId: shopBySlug.get(slug)!.id })));
  }
  // Thanksgiving: closed everywhere (example of a closure date).
  await db.insert(t.shopClosures).values(shopRows.map((s) => ({ shopId: s.id, date: "2026-11-26", reason: "Thanksgiving" })));

  // ── Catalog ──
  const svcRows = await db
    .insert(t.services)
    .values(
      SERVICES.map((s, i) => ({
        slug: s.slug,
        sku: s.slug.toUpperCase(),
        name: s.name,
        kind: s.kind,
        category: s.category,
        defaultPriceCents: s.price * 100,
        defaultDurationMin: s.duration,
        sortOrder: i * 10,
        active: !s.slug.startsWith("addon-design"),
      })),
    )
    .returning();
  const svcBySlug = new Map(svcRows.map((s) => [s.slug, s]));
  const offers = Object.entries(MENUS).flatMap(([shopSlug, list]) =>
    list.map(([slug, price, duration, nameOverride, enabled]) => {
      const svc = svcBySlug.get(slug)!;
      return {
        shopId: shopBySlug.get(shopSlug)!.id,
        serviceId: svc.id,
        priceCents: price * 100 === svc.defaultPriceCents ? null : price * 100,
        durationMin: duration && duration !== svc.defaultDurationMin ? duration : null,
        nameOverride: nameOverride ?? null,
        enabled: enabled ?? true,
      };
    }),
  );
  await db.insert(t.shopServices).values(offers);

  // ── Staff ──
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const staffRows = await db
    .insert(t.staff)
    .values(
      STAFF.map((s, i) => ({
        staffCode: `S-${String(i + 1).padStart(4, "0")}`,
        firstName: s.firstName,
        displayLabel: s.displayLabel,
        publicSlug: staffPublicSlug(s.firstName),
        squireName: s.squireName ?? null,
        email: s.email ?? null,
        passwordHash: s.email ? hash : null,
        color: COLORS[i % COLORS.length],
        roleId: roleId(s.role ?? "barber"),
        shopScope: templateFor(s.role ?? "barber")!.defaultScope,
        isBookable: s.bookable ?? true,
        active: s.active ?? true,
      })),
    )
    .returning();
  const staffByKey = new Map(STAFF.map((s, i) => [s.key, staffRows[i]]));
  const accessRows = STAFF.flatMap((s) => {
    const scope = templateFor(s.role ?? "barber")!.defaultScope;
    if (scope === "all") return [];
    const list = scope === "one" ? [s.managerShop ?? s.listedAt[0]] : s.listedAt;
    return list.filter(Boolean).map((shop) => ({
      staffId: staffByKey.get(s.key)!.id,
      shopId: shopBySlug.get(shop!)!.id,
      roleId: s.shopRoles?.[shop!] ? roleId(s.shopRoles[shop!]) : null,
    }));
  });
  if (accessRows.length) await db.insert(t.staffAccessShops).values(accessRows);
  await db.insert(t.staffShops).values(
    STAFF.flatMap((s) =>
      s.listedAt.map((shop) => ({
        staffId: staffByKey.get(s.key)!.id,
        shopId: shopBySlug.get(shop)!.id,
        isPrimary: Object.keys(s.schedule)[0] === shop,
      })),
    ),
  );
  const scheduleRows = STAFF.flatMap((s) =>
    Object.entries(s.schedule).flatMap(([shopSlug, days]) => {
      const shop = SHOPS.find((x) => x.slug === shopSlug)!;
      return days.map((wd) => {
        const [o, c] = shop.hours[wd as 0]!;
        return { staffId: staffByKey.get(s.key)!.id, shopId: shopBySlug.get(shopSlug)!.id, weekday: wd, startMin: o * 60, endMin: c * 60 };
      });
    }),
  );
  await db.insert(t.staffSchedules).values(scheduleRows);
  for (const g of BARBER_GROUPS) {
    const [row] = await db.insert(t.staffGroups).values({ name: g.name }).returning();
    await db.insert(t.staffGroupMembers).values(g.staff.map((key) => ({ groupId: row.id, staffId: staffByKey.get(key)!.id })));
  }

  // ── Retail ──
  const productRows = await db
    .insert(t.products)
    .values(
      PRODUCTS.map(([brand, name, price, category], i) => ({
        sku: `${slugify(brand).slice(0, 6)}-${slugify(name).slice(0, 26)}`.replace(/-+$/, "").toUpperCase() + `-${String(i + 1).padStart(3, "0")}`,
        barcode: `850012${String(100000 + i * 37).padStart(6, "0")}`,
        brand,
        name,
        category,
        priceCents: price * 100,
        costCents: Math.round(price * 100 * 0.5),
        lowStockThreshold: category === "Merch" ? 2 : 3,
        parLevel: category === "Merch" ? 6 : 8,
      })),
    )
    .returning();
  // Stock on hand today; posted to the ledger at the end as an opening balance plus the sample sales.
  const targetStock = new Map<string, number>();
  const shopProductRows = shopRows
    .filter((s) => s.slug !== "dubuque")
    .flatMap((s) =>
      productRows
        .filter((_, i) => s.slug === "coralville" || i % 3 !== 1)
        .map((p) => {
          const price = PRODUCTS.find(([b, n]) => b === p.brand && n === p.name)![2] * 100;
          targetStock.set(`${s.id}|${p.id}`, chance(0.3) ? Math.floor(rand() * 3) : 3 + Math.floor(rand() * 10));
          return { shopId: s.id, productId: p.id, priceCents: price, costCents: Math.round(price * (0.48 + rand() * 0.06)) };
        }),
    );
  await db.insert(t.shopProducts).values(shopProductRows);
  // Coralville is the busiest shop, so it keeps more of the best sellers.
  for (const name of ["Blue Pomade 4oz", "Fiber 4oz"]) {
    const p = productRows.find((x) => x.brand === "Reuzel" && x.name === name);
    if (p) await db.update(t.shopProducts).set({ lowStockThreshold: 5, parLevel: 14 }).where(sql`shop_id = ${shopBySlug.get("coralville")!.id} and product_id = ${p.id}`);
  }

  // ── Promos & gift cards ──
  await db.insert(t.promoCodes).values([
    { code: "WELCOME5", description: "$5 off your first visit", type: "amount", value: 500, appliesTo: "services", startsOn: "2026-10-01", endsOn: "2026-12-31" },
    { code: "FALL10", description: "10% off services", type: "percent", value: 10, appliesTo: "services", startsOn: "2026-10-01", endsOn: "2026-11-30", maxRedemptions: 200 },
    { code: "SPRING2026", description: "Spring Break 2026 (expired, 0 redemptions in Squire)", type: "amount", value: 500, appliesTo: "services", startsOn: "2026-03-01", endsOn: "2026-03-31", active: false },
    { code: "NEWYEARS", description: "New Years 2026 (expired)", type: "percent", value: 15, appliesTo: "services", startsOn: "2026-01-01", endsOn: "2026-01-15", active: false },
  ]);
  const [demoGift] = await db
    .insert(t.giftCards)
    .values({ code: "DEMO-GIFT-2500", initialCents: 2500, balanceCents: 2500, issuedShopId: shopBySlug.get("coralville")!.id, source: "promo" })
    .returning();
  await db.insert(t.giftCardLedger).values({ giftCardId: demoGift.id, deltaCents: 2500, kind: "issue" });

  // ── Customers ──
  // Address, birthday and the Instagram custom field come from the row number, not rand(), so the rest of the sample data stays the same.
  const [instagram] = await db.insert(t.clientFields).values({ label: "Instagram", sortOrder: 10 }).returning();
  const STREETS = ["2nd Ave", "Main St", "River Dr", "Oak St", "College St", "5th Ave", "Kirkwood Ave", "Elm St"];
  const customerValues = Array.from({ length: 3000 }, (_, i) => {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const shop = pick(shopRows.filter((s) => s.slug !== "dubuque"));
    const email = chance(0.6) ? `${first}.${last}.${i}@example.test`.toLowerCase() : null;
    return {
      firstName: first,
      lastName: last,
      phone: `+1${pick(["319", "563", "309"])}555${String(1000 + i).slice(-4)}`,
      email,
      smsOptIn: chance(0.8),
      emailOptIn: email !== null && chance(0.5),
      homeShopId: shop.id,
      createdAt: new Date(now.getTime() - (HISTORY_DAYS + 400 * rand()) * 86_400_000),
      address: i % 3 === 0 ? `${100 + ((i * 37) % 900)} ${STREETS[i % STREETS.length]}, ${shop.city}, ${shop.state} ${shop.zip}` : null,
      birthday: i % 2 === 0 ? `${1960 + ((i * 7) % 45)}-${String(((i * 5) % 12) + 1).padStart(2, "0")}-${String(((i * 11) % 28) + 1).padStart(2, "0")}` : null,
      customFields: i % 4 === 0 ? { [instagram.id]: `@${first}${last}${i}`.toLowerCase() } : {},
    };
  });
  const customerRows: (typeof t.customers.$inferSelect)[] = [];
  await chunked(customerValues, 1000, async (c) => customerRows.push(...(await db.insert(t.customers).values(c).returning())));
  // A demo client whose next haircut crosses the $300 loyalty goal.
  const [demoCustomer] = await db
    .insert(t.customers)
    .values({
      firstName: "Jordan",
      lastName: "Demo",
      phone: "+13195550100",
      email: "jordan@example.test",
      smsOptIn: true,
      emailOptIn: true,
      homeShopId: shopBySlug.get("coralville")!.id,
      address: "1701 2nd St, Coralville, IA 52241",
      birthday: "1994-07-14",
      notes: "Skin fade, #2 on top. Likes the hot towel.",
      customFields: { [instagram.id]: "@jordandemo" },
    })
    .returning();
  // Zip centers for "within N miles" (production loads the full Census list: scripts/load-zip-points.ts).
  await db
    .insert(t.zipPoints)
    .values(
      [
        ["52241", 41.6889, -91.5962],
        ["52807", 41.5615, -90.5203],
        ["52753", 41.6213, -90.3817],
        ["61265", 41.4825, -90.4893],
        ["61201", 41.4806, -90.5745],
        ["61282", 41.4998, -90.4119],
        ["52002", 42.5158, -90.7614],
      ].map(([zip, lat, lng]) => ({ zip: zip as string, lat: lat as number, lng: lng as number })),
    )
    .onConflictDoNothing();
  // Squire-import duplicates for the duplicates tool: a typo, a nickname, and a parent and child on one phone.
  {
    const kimberly = shopBySlug.get("kimberly")!;
    const dupes = await db
      .insert(t.customers)
      .values([
        { firstName: "Jonathon", lastName: "Reyes", birthday: "1991-03-08", address: "412 Oak St, Davenport, IA 52807", homeShopId: kimberly.id, createdAt: new Date("2019-05-02T15:00:00Z") },
        { firstName: "Jonathan", lastName: "Reyes", phone: "+15635559801", birthday: "1991-03-08", smsOptIn: true, homeShopId: kimberly.id },
        { firstName: "Mike", lastName: "Kowalski", phone: "+15635559802", homeShopId: kimberly.id, createdAt: new Date("2018-11-20T15:00:00Z") },
        { firstName: "Michael", lastName: "Kowalski", phone: "+15635559802", email: "mkowalski@example.test", homeShopId: kimberly.id },
        { firstName: "Darnell", lastName: "Price", phone: "+15635559803", birthday: "1972-09-14", homeShopId: kimberly.id, createdAt: new Date("2017-08-01T15:00:00Z") },
        { firstName: "Darnell", lastName: "Price", phone: "+15635559803", birthday: "2004-01-30", homeShopId: kimberly.id },
      ])
      .returning();
    await db.insert(t.customerSquireIds).values(
      [0, 2, 4].map((i) => ({ squireId: `SQ-DEMO-${i + 1}`, customerId: dupes[i].id, shopId: kimberly.id })),
    );
  }
  const customersByShop = new Map<string, typeof customerRows>();
  for (const c of customerRows) customersByShop.set(c.homeShopId!, [...(customersByShop.get(c.homeShopId!) ?? []), c]);

  // ── Appointments, sales, payments (sample history + upcoming) ──
  const menus = new Map<string, { svc: typeof svcRows[number]; price: number; duration: number; name: string }[]>();
  for (const o of offers.filter((x) => x.enabled)) {
    const svc = svcRows.find((s) => s.id === o.serviceId)!;
    const list = menus.get(o.shopId) ?? [];
    list.push({ svc, price: o.priceCents ?? svc.defaultPriceCents, duration: o.durationMin ?? svc.defaultDurationMin, name: o.nameOverride ?? svc.name });
    menus.set(o.shopId, list);
  }
  const shopById = new Map(shopRows.map((s) => [s.id, s]));
  const productsByShop = new Map<string, typeof shopProductRows>();
  for (const sp of shopProductRows) productsByShop.set(sp.shopId, [...(productsByShop.get(sp.shopId) ?? []), sp]);

  type ApptRow = typeof t.appointments.$inferInsert & { id: string };
  const appts: ApptRow[] = [];
  const items: (typeof t.appointmentItems.$inferInsert)[] = [];
  const saleRows: (typeof t.sales.$inferInsert & { id: string })[] = [];
  const saleItemRows: (typeof t.saleItems.$inferInsert)[] = [];
  const paymentRows: (typeof t.payments.$inferInsert)[] = [];
  const lastVisit = new Map<string, ApptRow>();
  const earned = new Map<string, number[]>();

  const blocks: (typeof t.timeBlocks.$inferInsert)[] = [];
  const uuid = () => crypto.randomUUID();

  for (let d = -HISTORY_DAYS; d <= FUTURE_DAYS; d++) {
    const date = addDays(today, d);
    const wd = weekdayOf(date);
    for (const sch of scheduleRows.filter((r) => r.weekday === wd)) {
      const shop = shopById.get(sch.shopId)!;
      const menu = menus.get(shop.id)!.filter((m) => m.price > 0);
      const services = menu.filter((m) => m.svc.kind === "service");
      const addons = menu.filter((m) => m.svc.kind === "addon");
      const pool = customersByShop.get(shop.id) ?? customerRows;
      const lunchAt = 12 * 60 + (chance(0.5) ? 0 : 30);
      if (d >= -7) {
        blocks.push({ staffId: sch.staffId, shopId: shop.id, startsAt: zonedWallTime(date, lunchAt).toJSDate(), endsAt: zonedWallTime(date, lunchAt + 30).toJSDate(), category: "lunch", ...reason("lunch") });
      }
      const fill = d < 0 ? 0.62 : d === 0 ? 0.7 : Math.max(0.12, 0.55 - d * 0.03);
      let cursor = sch.startMin;
      while (cursor < sch.endMin - 15) {
        if (cursor >= lunchAt && cursor < lunchAt + 30 && d >= -7) {
          cursor = lunchAt + 30;
          continue;
        }
        const main = pick(services.slice(0, Math.min(services.length, 7)));
        const withAddon = addons.length > 0 && chance(0.18) ? pick(addons) : null;
        const duration = main.duration + (withAddon?.duration ?? 0);
        if (cursor + duration > sch.endMin) break;
        if (!chance(fill)) {
          cursor += 15;
          continue;
        }
        const start = zonedWallTime(date, cursor).toJSDate();
        const end = new Date(start.getTime() + duration * 60_000);
        const customer = chance(0.06) ? null : pick(pool);
        const past = end < now;
        let status: ApptRow["status"] = past ? "completed" : start < now ? "in_service" : "booked";
        const r = rand();
        if (r < 0.04) status = "cancelled";
        else if (r < 0.055 && past) status = "no_show";
        const id = uuid();
        const walkIn = past && chance(0.18);
        const prior = customer ? lastVisit.get(customer.id) : undefined;
        const rebooked = !walkIn && prior && chance(0.35);
        const createdAt = walkIn
          ? start
          : rebooked
            ? new Date(prior!.endsAt!.getTime() + 5 * 60_000)
            : new Date(start.getTime() - (1 + rand() * 10) * 86_400_000);
        const appt: ApptRow = {
          id,
          code: appointmentCode(),
          shopId: shop.id,
          staffId: sch.staffId,
          customerId: customer?.id ?? null,
          startsAt: start,
          endsAt: end,
          status,
          source: walkIn ? "walk_in" : rebooked ? "rebook" : chance(0.75) ? "online" : "staff",
          estimateCents: main.price + (withAddon?.price ?? 0),
          createdAt: createdAt > now ? now : createdAt,
          completedAt: status === "completed" ? end : null,
          cancelledAt: status === "cancelled" ? new Date(start.getTime() - 3_600_000) : null,
          rebookedFromId: rebooked ? prior!.id : null,
          notes: customer ? null : "Walk-in",
        };
        appts.push(appt);
        items.push({ appointmentId: id, serviceId: main.svc.id, kind: "service", name: main.name, priceCents: main.price, durationMin: main.duration });
        if (withAddon) items.push({ appointmentId: id, serviceId: withAddon.svc.id, kind: "addon", name: withAddon.name, priceCents: withAddon.price, durationMin: withAddon.duration });

        if (status === "completed") {
          if (customer) lastVisit.set(customer.id, appt);
          const lines: CartLine[] = [{ key: "s", kind: "service", name: main.name, unitPriceCents: main.price, qty: 1, refId: main.svc.id }];
          if (withAddon) lines.push({ key: "a", kind: "addon", name: withAddon.name, unitPriceCents: withAddon.price, qty: 1, refId: withAddon.svc.id });
          const retail = productsByShop.get(shop.id) ?? [];
          if (retail.length && chance(0.1)) {
            const p = pick(retail);
            const prod = productRows.find((x) => x.id === p.productId)!;
            lines.push({ key: "p", kind: "product", name: `${prod.brand} ${prod.name}`, unitPriceCents: p.priceCents, qty: 1, refId: p.productId });
          }
          const serviceGross = lines.filter((l) => l.kind !== "product").reduce((a, l) => a + l.unitPriceCents, 0);
          const tip = Math.round((serviceGross * pick([0, 15, 18, 20, 20, 25, 25, 30])) / 100 / 25) * 25;
          const card = chance(0.74);
          const funding = card ? (chance(0.55) ? "credit" : "debit") : null;
          const discount = chance(0.04) ? [{ source: "manual" as const, label: "Discount: regular", type: "amount" as const, value: 300, appliesTo: "services" as const }] : [];
          const totals = computeCheckout({
            lines,
            discounts: discount,
            taxRates: { serviceRate: Number(shop.serviceTaxRate), productRate: Number(shop.productTaxRate) },
            tipCents: tip,
            cardFee: { enabled: shop.cardFeeEnabled, rate: Number(shop.cardFeeRate), appliesToTip: false },
            tender: { method: card ? "card" : "cash", cardFunding: funding },
            loyalty: { on: shop.slug !== "dubuque", includeProducts: false, includeTips: false },
          });
          const saleId = uuid();
          const businessDate = localDateOf(end);
          saleRows.push({
            id: saleId,
            shopId: shop.id,
            appointmentId: id,
            customerId: customer?.id ?? null,
            staffId: sch.staffId,
            status: "paid",
            businessDate,
            serviceGrossCents: totals.serviceGrossCents,
            productGrossCents: totals.productGrossCents,
            discountCents: totals.discountCents,
            serviceNetCents: totals.serviceNetCents,
            productNetCents: totals.productNetCents,
            serviceTaxCents: totals.serviceTaxCents,
            productTaxCents: totals.productTaxCents,
            tipCents: totals.tipCents,
            cardFeeCents: totals.cardFeeCents,
            totalCents: totals.totalCents,
            loyaltyEarnedCents: customer ? totals.loyaltyEligibleCents : 0,
            paidAt: end,
            createdAt: start,
          });
          for (const l of totals.lines) {
            saleItemRows.push({
              saleId,
              kind: l.kind,
              refId: l.refId ?? null,
              name: l.name,
              staffId: l.kind === "product" ? null : sch.staffId,
              qty: l.qty,
              unitPriceCents: l.unitPriceCents,
              grossCents: l.grossCents,
              discountCents: l.discountCents,
              netCents: l.netCents,
              taxCents: l.taxCents,
            });
          }
          paymentRows.push({
            saleId,
            shopId: shop.id,
            businessDate,
            method: card ? "card" : "cash",
            status: "succeeded",
            amountCents: totals.primaryChargeCents,
            tipCents: totals.tipCents,
            cardFeeCents: totals.cardFeeCents,
            processor: card ? "simulator" : null,
            stripePaymentIntentId: card ? `sim_pi_seed_${saleId}` : null,
            cardBrand: card ? pick(["visa", "visa", "mastercard", "amex", "discover"]) : null,
            cardLast4: card ? String(1000 + Math.floor(rand() * 9000)) : null,
            cardFunding: funding,
            entryMode: card ? "terminal" : null,
            cashTenderedCents: card ? null : Math.ceil(totals.primaryChargeCents / 500) * 500,
            createdAt: end,
          });
          if (customer && totals.loyaltyEligibleCents > 0) earned.set(customer.id, [...(earned.get(customer.id) ?? []), totals.loyaltyEligibleCents]);
        }
        cursor += duration + (chance(0.3) ? 15 : 0);
      }
    }
  }

  // Time off examples: a full day off next week and a training block today.
  const michelle = staffByKey.get("michelle")!;
  const makenna = staffByKey.get("makenna")!;
  const nextThu = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1)).find((d) => weekdayOf(d) === 4)!;
  const startOff = startOfLocalDay(nextThu);
  const endOff = startOfLocalDay(addDays(nextThu, 1));
  blocks.push({ staffId: michelle.id, shopId: null, startsAt: startOff, endsAt: endOff, kind: "day_off", category: "time_off", ...reason("vacation") });
  blocks.push({
    staffId: makenna.id,
    shopId: shopBySlug.get("coralville")!.id,
    startsAt: zonedWallTime(today, 15 * 60).toJSDate(),
    endsAt: zonedWallTime(today, 16 * 60).toJSDate(),
    ...reason("training"),
    note: "Product training",
  });
  // Appointments that collide with the new day off / training are cancelled in the sample.
  for (const a of appts) {
    const collides = blocks.some(
      (b) => (b.kind === "day_off" || b.note === "Product training") && b.staffId === a.staffId && a.startsAt < b.endsAt && a.endsAt! > b.startsAt,
    );
    if (collides && a.status === "booked") a.status = "cancelled";
  }

  // ── Families: a parent and kids on one phone, booked back to back with one barber ──
  const FAMILIES = [
    { shop: "coralville", last: "Hayes", phone: "+13195550201", email: "chris.hayes@example.test", members: ["Chris", "Mason", "Lily"], note: "Mason: #3 on the sides, scissors on top. Lily: trim only." },
    { shop: "moline", last: "Nguyen", phone: "+13095550202", email: "linh.nguyen@example.test", members: ["Linh", "Bao", "Minh"], note: "Bao and Minh come in together after school." },
    { shop: "kimberly", last: "Carter", phone: "+15635550203", email: null, members: ["Jess", "Eli", "Owen"], note: "Twins. Eli has a cowlick on the left." },
  ];
  for (const f of FAMILIES) {
    const shop = shopBySlug.get(f.shop)!;
    const members = await db
      .insert(t.customers)
      .values(
        f.members.map((first, i) => ({
          firstName: first,
          lastName: f.last,
          phone: f.phone,
          email: i === 0 ? f.email : null,
          smsOptIn: i === 0,
          emailOptIn: i === 0 && f.email !== null,
          homeShopId: shop.id,
          notes: i === 0 ? f.note : null,
          createdAt: new Date(now.getTime() - 200 * 86_400_000),
        })),
      )
      .returning();
    const menu = menus.get(shop.id)!.filter((m) => m.svc.kind === "service" && m.price > 0);
    const kids = menu.find((m) => m.svc.slug === "kidz-cut") ?? menu[0];
    const adult = menu.find((m) => m.svc.slug !== "kidz-cut") ?? menu[0];
    const visits = members.map((c, i) => ({ c, m: i === 0 ? adult : kids }));
    const total = visits.reduce((a, v) => a + v.m.duration, 0);
    const busy = (staffId: string, s: Date, e: Date) =>
      appts.some((a) => a.staffId === staffId && a.startsAt < e && a.endsAt! > s) || blocks.some((b) => b.staffId === staffId && b.startsAt < e && b.endsAt > s);
    let placed = false;
    for (let d = 2; d <= FUTURE_DAYS && !placed; d++) {
      const date = addDays(today, d);
      for (const sch of scheduleRows.filter((r) => r.shopId === shop.id && r.weekday === weekdayOf(date))) {
        for (let at = sch.startMin; at + total <= sch.endMin && !placed; at += 15) {
          const start = zonedWallTime(date, at).toJSDate();
          if (busy(sch.staffId, start, new Date(start.getTime() + total * 60_000))) continue;
          let cursor = start;
          for (const v of visits) {
            const id = uuid();
            const end = new Date(cursor.getTime() + v.m.duration * 60_000);
            appts.push({
              id,
              code: appointmentCode(),
              shopId: shop.id,
              staffId: sch.staffId,
              customerId: v.c.id,
              startsAt: cursor,
              endsAt: end,
              status: "booked",
              source: "online",
              estimateCents: v.m.price,
              createdAt: new Date(now.getTime() - 2 * 86_400_000),
            });
            items.push({ appointmentId: id, serviceId: v.m.svc.id, kind: "service", name: v.m.name, priceCents: v.m.price, durationMin: v.m.duration });
            cursor = end;
          }
          placed = true;
        }
        if (placed) break;
      }
    }
  }

  console.log(`  ${appts.length} appointments, ${saleRows.length} sales`);
  await chunked(appts, 1000, (c) => db.insert(t.appointments).values(c));
  await chunked(items, 2000, (c) => db.insert(t.appointmentItems).values(c));
  await chunked(saleRows, 1000, (c) => db.insert(t.sales).values(c));
  await chunked(saleItemRows, 2000, (c) => db.insert(t.saleItems).values(c));
  await chunked(paymentRows, 2000, (c) => db.insert(t.payments).values(c));
  await chunked(blocks, 2000, (c) => db.insert(t.timeBlocks).values(c));

  // ── Loyalty from sample history (+ Jordan, $290 imported from Squire) ──
  const accounts: (typeof t.loyaltyAccounts.$inferInsert)[] = [];
  const rewards: (typeof t.loyaltyRewards.$inferInsert)[] = [];
  for (const [customerId, list] of earned) {
    let progress = Math.floor(rand() * 25_000); // Squire carry-over progress
    let lifetime = 0;
    for (const e of list) {
      const r = accrue(progress, e, DEFAULT_LOYALTY);
      progress = r.progressCents;
      lifetime += e;
      for (let k = 0; k < r.rewardsIssued; k++) {
        const issuedAt = new Date(now.getTime() - rand() * 20 * 86_400_000);
        rewards.push({ customerId, amountCents: 1500, issuedAt, expiresAt: rewardExpiry(issuedAt, DEFAULT_LOYALTY) });
      }
    }
    accounts.push({ customerId, progressCents: progress, lifetimeEarnedCents: lifetime, lastEarnAt: now });
  }
  accounts.push({ customerId: demoCustomer.id, progressCents: 29_000, lifetimeEarnedCents: 29_000, lastEarnAt: now });
  await chunked(accounts, 1000, (c) => db.insert(t.loyaltyAccounts).values(c));
  if (rewards.length) await chunked(rewards, 1000, (c) => db.insert(t.loyaltyRewards).values(c));

  // A few gift cards sold in Squire, imported with balances.
  await db.insert(t.giftCards).values(
    Array.from({ length: 6 }, () => {
      const initial = pick([2500, 5000, 5000, 10000]);
      return { code: giftCardCode(), initialCents: initial, balanceCents: Math.round(initial * rand()), source: "import", issuedShopId: pick(shopRows).id };
    }),
  );

  // Today's walk-in waitlist at Coralville.
  const coralville = shopBySlug.get("coralville")!;
  await db.insert(t.waitlistEntries).values([
    { shopId: coralville.id, name: "Chris W.", phone: "+13195550111", serviceId: svcBySlug.get("rayz-cut")!.id, quotedWaitMin: 20, joinedAt: new Date(now.getTime() - 12 * 60_000) },
    { shopId: coralville.id, name: "Dad + 2 kids", serviceId: svcBySlug.get("kidz-cut")!.id, quotedWaitMin: 35, joinedAt: new Date(now.getTime() - 4 * 60_000), notes: "3 cuts" },
  ]);

  // Sample staff ratings on some past visits, by the barber who did the cut. Last, so the random
  // sequence for everything above is unchanged.
  const ratingNotes: Record<number, string[]> = {
    1: ["No-call no-show twice", "Rude to the front desk"],
    2: ["20 min late", "Difficult, redid the fade twice"],
    3: ["Running late", "Particular about the line-up"],
    4: ["Easy cut", "On time"],
    5: ["Great tipper", "Regular, always on time", "Brings his son too"],
  };
  const ratingRows = appts
    .filter((a) => a.customerId && a.status === "completed" && chance(0.18))
    .map((a) => {
      const stars = pick([5, 5, 5, 4, 4, 4, 3, 2, 1]);
      return {
        customerId: a.customerId!,
        shopId: a.shopId,
        appointmentId: a.id!,
        staffId: a.staffId,
        stars,
        note: chance(0.4) ? pick(ratingNotes[stars]) : null,
        createdAt: a.endsAt!,
        updatedAt: a.endsAt!,
      };
    });
  await chunked(ratingRows, 2000, (c) => db.insert(t.clientRatings).values(c));
  console.log(`  ${ratingRows.length} sample staff ratings`);

  await seedInventory({ now, shopBySlug, productRows, shopProductRows, targetStock, saleRows, saleItemRows, owner: staffByKey.get("michelle")! });

  // ── Stripe Connect: each shop has its own (simulated) connected account, onboarded, with its card history routed there ──
  await simulateConnectHistory({ shopIds: shopRows.map((s) => s.id) });
  console.log("  Stripe Connect: one simulated connected account per shop, card history routed there, daily payouts");

  // ── Booking times (set after the history, as if changed today: booked appointments keep their times) ──
  await db.update(t.shops).set({ slotIntervalMinutes: 20 }).where(eq(t.shops.slug, "le-claire"));
  await db.update(t.staff).set({ slotIntervalMinutes: 20 }).where(eq(t.staff.id, staffByKey.get("delaney")!.id));
  await db
    .update(t.staffShops)
    .set({ slotIntervalMinutes: 30 })
    .where(and(eq(t.staffShops.staffId, staffByKey.get("casey")!.id), eq(t.staffShops.shopId, shopBySlug.get("le-claire")!.id)));
  await db.update(t.services).set({ bufferBeforeMin: 5, bufferAfterMin: 10 }).where(eq(t.services.slug, "hot-towel-shave"));
  await db.update(t.services).set({ durationStepMin: 15, bookingIncrementMin: 30, bufferAfterMin: 10 }).where(eq(t.services.slug, "gray-blending"));
  await db.update(t.services).set({ durationStepMin: 15, bufferAfterMin: 5 }).where(eq(t.services.slug, "camo-color"));
  await db.insert(t.staffServiceDurations).values([
    { staffId: staffByKey.get("casey")!.id, serviceId: svcBySlug.get("specialty-fade")!.id, shopId: null, durationMin: 40 },
    { staffId: staffByKey.get("skylar")!.id, serviceId: svcBySlug.get("rayz-cut-shampoo")!.id, shopId: shopBySlug.get("le-claire")!.id, durationMin: 30 },
  ]);
  console.log("  booking times: Le Claire on 20 minutes, Delaney 20, Casey 30 at Le Claire, Casey's specialty fade 40, Skylar's cut w/ shampoo 30 at Le Claire");

  // ── Demo logins for the other role templates (not bookable, no history) ──
  for (const [i, d] of DEMO_LOGINS.entries()) {
    const tpl = templateFor(d.role)!;
    const [row] = await db
      .insert(t.staff)
      .values({
        staffCode: `S-${String(STAFF.length + i + 1).padStart(4, "0")}`,
        firstName: d.firstName,
        displayLabel: d.displayLabel,
        publicSlug: staffPublicSlug(d.firstName),
        email: d.email,
        passwordHash: hash,
        color: COLORS[(STAFF.length + i) % COLORS.length],
        roleId: roleId(d.role),
        shopScope: tpl.defaultScope,
        isBookable: false,
      })
      .returning();
    if (d.shops.length) await db.insert(t.staffAccessShops).values(d.shops.map((s) => ({ staffId: row.id, shopId: shopBySlug.get(s)!.id })));
  }
  // One shared front-desk login per shop (<slug>@rayz.test): sees only that shop.
  for (const [i, s] of SHOPS.entries()) {
    const shop = shopBySlug.get(s.slug)!;
    const [row] = await db
      .insert(t.staff)
      .values({
        kind: "shop",
        staffCode: `S-${String(STAFF.length + DEMO_LOGINS.length + i + 1).padStart(4, "0")}`,
        firstName: shop.name,
        displayLabel: `${shop.name} desk`,
        publicSlug: staffPublicSlug(`${s.slug}-desk`),
        email: `${s.slug}@rayz.test`,
        passwordHash: hash,
        roleId: roleId("shop_login"),
        shopScope: "one",
        isBookable: false,
      })
      .returning();
    await db.insert(t.staffAccessShops).values({ staffId: row.id, shopId: shop.id });
  }

  await seedPayroll({ now, staffByKey, shopBySlug, scheduleRows });
  await seedServiceTimes({ now, appts, items, staffByKey });
  await seedStaffTime({ now, staffByKey, shopBySlug, scheduleRows, appts });
  await seedTips({ today, staffByKey, shopBySlug });
  await seedMilestones({ today, now, staffByKey });
  for (const shop of shopRows) for (let d = addDays(today, -HISTORY_DAYS); d < today; d = addDays(d, 1)) await computeDailyStats(shop.id, d);

  console.log("Seed complete.");
  console.log(`  Logins (password: ${DEMO_PASSWORD}):`);
  console.log("    owner@rayz.test      Brand Owner, every shop");
  console.log("    admin@rayz.test      Brand Admin, every shop");
  console.log("    regional@rayz.test   Regional Manager, Moline + Rock Island");
  console.log("    michelle@rayz.test   Shop Manager, Coralville");
  console.log("    frontdesk@rayz.test  Front Desk, Coralville");
  console.log("    makenna@rayz.test    Barber, Coralville");
  console.log("    manager.moline@rayz.test  Shop Manager, Moline");
  console.log("    kat@rayz.test        Barber at Moline and Silvis, Shop Manager at Rock Island (one shop at a time)");
  console.log(`    <shop>@rayz.test     Shop login (front desk) for one shop: ${SHOPS.map((s) => s.slug).join(", ")}`);
}

/**
 * Staff milestones: hire dates for all but the last two (so Setup lists who's missing one), with
 * Casey's 5-year anniversary five days out and Makenna's first yesterday, and a Squire total for
 * Jamie from before the imported history so his latest cut is his 1,000th. The worker records them.
 */
async function seedMilestones(o: { today: LocalDate; now: Date; staffByKey: Map<string, typeof t.staff.$inferSelect> }) {
  const { today, now, staffByKey } = o;
  const keys = STAFF.map((s) => s.key);
  for (const [i, key] of keys.slice(0, -2).entries()) {
    const hire =
      key === "casey" ? addDays(anniversaryDate(today, -5), 5) : key === "makenna" ? addDays(anniversaryDate(today, -1), -1) : addDays(anniversaryDate(today, -(1 + ((i * 7) % 9))), -(10 + ((i * 37) % 300)));
    await db.update(t.staff).set({ hireDate: hire }).where(eq(t.staff.id, staffByKey.get(key)!.id));
  }
  const jamie = staffByKey.get("jamie");
  if (!jamie) return;
  const [{ n, first }] = await db
    .select({ n: sql<number>`count(*)::int`, first: sql<string>`min((${t.appointments.startsAt} at time zone 'America/Chicago')::date)::text` })
    .from(t.appointments)
    .where(and(eq(t.appointments.staffId, jamie.id), eq(t.appointments.status, "completed"), sql`${t.appointments.startsAt} <= ${now.toISOString()}`));
  if (n > 0 && n < 1000 && first) await db.insert(t.staffMilestoneBaselines).values({ staffId: jamie.id, metric: "services", count: 1000 - n, asOf: first, setBy: staffByKey.get("michelle")?.id ?? null });
}

/**
 * Service timings on the sample history: arrival, Start, Finish (or checkout standing in for it) and
 * checkout. Makenna runs long and Delaney runs short, so the report has suggestions to accept, and a
 * few timers were left running. Uses its own hash rather than the shared random stream, so nothing
 * seeded above changes.
 */
async function seedServiceTimes(o: {
  now: Date;
  appts: (typeof t.appointments.$inferInsert)[];
  items: { appointmentId: string; kind: string }[];
  staffByKey: Map<string, typeof t.staff.$inferSelect>;
}) {
  const { now, appts, items, staffByKey } = o;
  const u = (i: number, salt: number) => {
    let x = (Math.imul(i + 1, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 2246822507) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 3266489909) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const pace = new Map([
    [staffByKey.get("makenna")!.id, 1.32],
    [staffByKey.get("delaney")!.id, 0.7],
  ]);
  const withAddon = new Set(items.filter((x) => x.kind === "addon").map((x) => x.appointmentId));
  const minute = 60_000;
  const rows: (typeof t.appointmentTimes.$inferInsert)[] = [];
  appts.forEach((a, i) => {
    if (a.status !== "completed" && !(a.status === "in_service" && a.startsAt < now)) return;
    if (a.status === "completed" && u(i, 1) < 0.12) {
      rows.push({ appointmentId: a.id!, checkedOutAt: new Date(a.endsAt.getTime() + 3 * minute), checkedOutBy: a.staffId });
      return;
    }
    const walkIn = a.source === "walk_in";
    const arrived = walkIn || u(i, 2) < 0.6 ? new Date(a.startsAt.getTime() - Math.round((walkIn ? 5 + u(i, 3) * 20 : 2 + u(i, 3) * 10) * minute)) : null;
    const started = new Date(a.startsAt.getTime() + Math.round((u(i, 4) * 10 - 2) * minute));
    const begin = arrived && started < arrived ? arrived : started;
    if (a.status === "in_service") {
      rows.push({ appointmentId: a.id!, arrivedAt: arrived, arrivedBy: arrived ? a.staffId : null, startedAt: begin, startedBy: a.staffId });
      return;
    }
    const booked = (a.endsAt.getTime() - a.startsAt.getTime()) / minute;
    const base = withAddon.has(a.id!) ? 1 : (pace.get(a.staffId) ?? 1);
    const r = u(i, 5);
    const factor = r < 0.006 ? 4 : r < 0.01 ? 0.15 : base * (0.85 + u(i, 6) * 0.3);
    const actual = Math.max(3, Math.round(booked * factor));
    const viaCheckout = u(i, 7) < 0.3;
    const checkedOut = new Date(begin.getTime() + (actual + 1 + Math.round(u(i, 8) * 4)) * minute);
    const finished = viaCheckout ? checkedOut : new Date(begin.getTime() + actual * minute);
    rows.push({
      appointmentId: a.id!,
      arrivedAt: arrived,
      arrivedBy: arrived ? a.staffId : null,
      startedAt: begin,
      startedBy: a.staffId,
      finishedAt: finished,
      finishedBy: a.staffId,
      finishedVia: viaCheckout ? "checkout" : "finish",
      checkedOutAt: checkedOut,
      checkedOutBy: a.staffId,
    });
  });
  await chunked(rows, 2000, (c) => db.insert(t.appointmentTimes).values(c));
  console.log(`  ${rows.length} service timings (Makenna runs long, Delaney short)`);
}

/**
 * Tip payouts: the ledger synced from the history, everything before the last two days recorded as
 * paid before tip payouts. Coralville pays cash at drawer close; Moline pays daily two days after the
 * tip. Makenna chose Stripe and finished the simulator's payout setup, paid to Stripe's test Visa debit card.
 */
async function seedTips(o: { today: LocalDate; staffByKey: Map<string, typeof t.staff.$inferSelect>; shopBySlug: Map<string, Shop> }) {
  await syncTipLedger();
  const opening = await recordOpeningTips(addDays(o.today, -2));
  await db.update(t.shops).set({ tipPayouts: { schedule: "end_of_night", defaultMethod: "cash" } }).where(eq(t.shops.id, o.shopBySlug.get("coralville")!.id));
  await db.update(t.shops).set({ tipPayouts: { schedule: "daily_delay", cardDelayDays: 2, defaultMethod: "cash" } }).where(eq(t.shops.id, o.shopBySlug.get("moline")!.id));
  const makenna = o.staffByKey.get("makenna");
  if (makenna)
    await db.insert(t.staffPayoutAccounts).values({
      staffId: makenna.id,
      method: "stripe",
      stripeAccountId: `sim_acct_staff_${makenna.id.slice(0, 8)}`,
      simulated: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      instantEligible: true,
      destinationType: "card",
      destinationLast4: "5556",
      destinationName: "Visa",
    });
  console.log(`  tips: ledger synced, ${opening} opening payouts before ${addDays(o.today, -2)}; Coralville end of night, Moline daily after 2 days; Makenna on Stripe (simulated)`);
}

/**
 * Staff time: brand rules (a manager approves, Moline approves automatically), Makenna's recurring
 * lunch, and time off in every state: pending (one at Moline held for a manager because it has
 * bookings), approved for next week and for part of today, denied, and an automatic sick day. Kept
 * off the Coralville days the booking tests use.
 */
async function seedStaffTime(o: {
  now: Date;
  staffByKey: Map<string, typeof t.staff.$inferSelect>;
  shopBySlug: Map<string, Shop>;
  scheduleRows: { staffId: string; shopId: string; weekday: number; startMin: number; endMin: number }[];
  appts: (typeof t.appointments.$inferInsert)[];
}) {
  const { now, staffByKey, shopBySlug, scheduleRows, appts } = o;
  const today = todayLocal(now);
  const id = (key: string) => staffByKey.get(key)!.id;
  const coralville = shopBySlug.get("coralville")!.id;
  const moline = shopBySlug.get("moline")!.id;
  const molineManager = (await db.query.staff.findFirst({ where: eq(t.staff.email, "manager.moline@rayz.test") }))?.id ?? null;
  await db.update(t.shops).set({ staffTime: { timeOffApproval: "auto" } }).where(eq(t.shops.id, moline));
  const reasonRows = await db.select().from(t.blockReasons);
  const reason = (key: string) => {
    const r = reasonRows.find((x) => x.key === key)!;
    return { reasonId: r.id, reason: r.label };
  };

  const lunch = { weekdays: [2, 3, 4, 5, 6], startMin: MAKENNA_LUNCH, endMin: MAKENNA_LUNCH + 30, startsOn: addDays(today, -7), endsOn: null };
  const through = addDays(today, SERIES_HORIZON_DAYS);
  const [series] = await db
    .insert(t.timeBlockSeries)
    .values({ staffId: id("makenna"), shopId: null, category: "lunch", ...reason("lunch"), ...lunch, materializedThrough: through, createdBy: id("makenna"), createdAt: new Date(now.getTime() - 8 * 86_400_000) })
    .returning();
  // The sample history gave her a lunch at 12:00 or 12:30 each day. The 12:30 ones become the series; days she took
  // it at noon keep that one-off block and skip the series, as if she'd removed that occurrence.
  const mk = id("makenna");
  const oneOffs = await db.select().from(t.timeBlocks).where(and(eq(t.timeBlocks.staffId, mk), eq(t.timeBlocks.category, "lunch")));
  const atNoon = new Set(oneOffs.filter((b) => localMinutesOf(b.startsAt) !== MAKENNA_LUNCH).map((b) => localDateOf(b.startsAt)));
  const replaced = oneOffs.filter((b) => localMinutesOf(b.startsAt) === MAKENNA_LUNCH).map((b) => b.id);
  if (replaced.length) await db.delete(t.timeBlocks).where(inArray(t.timeBlocks.id, replaced));
  const occ = seriesOccurrences(lunch, lunch.startsOn, through).filter((x) => !atNoon.has(x.date));
  await chunked(occ, 1000, (c) =>
    db.insert(t.timeBlocks).values(c.map((x) => ({ staffId: series.staffId, shopId: null, startsAt: x.startsAt, endsAt: x.endsAt, category: "lunch" as const, ...reason("lunch"), seriesId: series.id, createdBy: series.createdBy }))),
  );

  const works = (staffId: string, shopId: string, date: LocalDate) => scheduleRows.find((r) => r.staffId === staffId && r.shopId === shopId && r.weekday === weekdayOf(date));
  const booked = (staffId: string, date: LocalDate) =>
    appts.filter((a) => a.staffId === staffId && a.status === "booked" && localDateOf(a.startsAt as Date) === date).length;
  /** The first day from `from` the barber works there, preferring one with bookings. */
  const workday = (staffId: string, shopId: string, from: number, to: number, withBookings: boolean) => {
    let fallback: LocalDate | null = null;
    for (let d = from; d <= to; d++) {
      const date = addDays(today, d);
      if (!works(staffId, shopId, date)) continue;
      fallback ??= date;
      if (!withBookings || booked(staffId, date) > 0) return date;
    }
    return fallback!;
  };
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  type Req = typeof t.timeOffRequests.$inferInsert;
  const request = (r: Omit<Req, "startsAt" | "endsAt">): Req => {
    const span = timeOffSpan({ fromDate: r.fromDate, toDate: r.toDate, startMin: r.startMin ?? null, endMin: r.endMin ?? null });
    if ("problem" in span) throw new Error(span.problem);
    return { ...r, startsAt: span.startsAt, endsAt: span.endsAt };
  };

  const trip = addDays(today, 21 + ((8 - weekdayOf(addDays(today, 21))) % 7));
  const mackenzieDay = workday(id("mackenzie"), moline, 4, 12, true);
  const jenDay = workday(id("jen"), moline, 5, 12, true);
  const partialWho = ["jessica", "delaney", "michelle"].find((k) => works(id(k), coralville, today));
  const partialEnd = partialWho ? works(id(partialWho), coralville, today)!.endMin : 0;
  const rows: Req[] = [
    request({ staffId: id("jessica"), shopId: null, fromDate: trip, toDate: addDays(trip, 4), ...reason("vacation"), note: "Family trip to Colorado", requestedBy: id("jessica"), createdAt: daysAgo(1) }),
    // Moline approves automatically, but this day has bookings, so it waits for a manager.
    request({ staffId: id("mackenzie"), shopId: moline, fromDate: mackenzieDay, toDate: mackenzieDay, ...reason("personal"), note: "Moving apartments", requestedBy: id("mackenzie"), createdAt: daysAgo(2) }),
    request({ staffId: id("jen"), shopId: null, fromDate: jenDay, toDate: jenDay, ...reason("vacation"), requestedBy: id("jen"), status: "approved", decidedVia: "manager", decidedBy: molineManager, decidedAt: daysAgo(3), createdAt: daysAgo(4), decisionNote: "Enjoy! Jilane can take your regulars." }),
    request({ staffId: id("makenna"), shopId: null, fromDate: addDays(today, 15), toDate: addDays(today, 15), ...reason("personal"), requestedBy: id("makenna"), status: "denied", decidedVia: "manager", decidedBy: id("michelle"), decidedAt: daysAgo(2), createdAt: daysAgo(5), decisionNote: "Two out that day already. Can you swap with Delaney?" }),
    request({ staffId: id("sara"), shopId: null, fromDate: addDays(today, -2), toDate: addDays(today, -2), ...reason("sick"), requestedBy: id("sara"), status: "approved", decidedVia: "auto", decidedAt: daysAgo(2), createdAt: daysAgo(2) }),
  ];
  if (partialWho) {
    const decider = partialWho === "michelle" ? id("owner") : id("michelle");
    rows.push(
      request({ staffId: id(partialWho), shopId: coralville, fromDate: today, toDate: today, startMin: partialEnd - 150, endMin: partialEnd, ...reason("doctor"), note: "Dentist", requestedBy: id(partialWho), status: "approved", decidedVia: "manager", decidedBy: decider, decidedAt: daysAgo(6), createdAt: daysAgo(7) }),
    );
  }
  const inserted = await db.insert(t.timeOffRequests).values(rows).returning();
  const approved = inserted.filter((r) => r.status === "approved");
  if (approved.length) {
    await db.insert(t.timeBlocks).values(
      approved.map((r) => ({
        staffId: r.staffId,
        shopId: r.shopId,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        kind: r.startMin === null ? ("day_off" as const) : ("block" as const),
        category: "time_off" as const,
        reasonId: r.reasonId,
        reason: r.reason,
        note: r.note,
        requestId: r.id,
        createdBy: r.decidedBy ?? r.requestedBy,
      })),
    );
  }
  console.log(`  staff time: Makenna's recurring lunch (${occ.length} occurrences), ${inserted.length} time off requests (2 pending), Moline approves automatically`);
}

/**
 * Payroll sample data, all made up: iSolved-style employee numbers, pay rates, and clocked hours from
 * each barber's schedule over the sample history (some long weeks, so cross-shop overtime shows up),
 * a little training and PTO, the owner's hours at $0 (Q17), and one NetComm typed over (Q17).
 * Deterministic, and run last, so nothing above changes.
 */
async function seedPayroll(o: {
  now: Date;
  staffByKey: Map<string, typeof t.staff.$inferSelect>;
  shopBySlug: Map<string, Shop>;
  scheduleRows: { staffId: string; shopId: string; weekday: number; startMin: number; endMin: number }[];
}) {
  const { now, staffByKey, shopBySlug, scheduleRows } = o;
  const today = todayLocal(now);
  const people = STAFF.filter((s) => s.active !== false);
  await db.insert(t.payrollProfiles).values(
    people.map((s, i) => ({
      staffId: staffByKey.get(s.key)!.id,
      employeeNumber: String(910100 + i * 7),
      keyIsText: i % 5 === 2,
      isolvedName: s.displayLabel.toUpperCase(),
      exportPosition: i,
    })),
  );
  await db.insert(t.payrollRates).values(
    people.map((s) =>
      s.key === "charles"
        ? { staffId: staffByKey.get(s.key)!.id, hourlyRate: 0, servicePct: 0, productPct: 0 }
        : { staffId: staffByKey.get(s.key)!.id, hourlyRate: s.key === "casey" ? 25 : s.key === "makenna" ? 16 : 15.5, servicePct: 0.4, productPct: 0.15, trainingRate: s.key === "jamie" ? 12 : null },
    ),
  );

  const entries: (typeof t.timeEntries.$inferInsert)[] = [];
  const staffIndex = new Map(people.map((s, i) => [staffByKey.get(s.key)!.id, i]));
  const clock = await seedTimeClock({ now, shopBySlug, scheduleRows, staffIndex });
  // The owner's 80 hours a period at Rock Island, at $0 (Q17 is with Charles).
  const charles = staffByKey.get("charles")!.id;
  for (let d = -HISTORY_DAYS; d < 0; d++) {
    const date = addDays(today, d);
    if (weekdayOf(date) === 0 || weekdayOf(date) === 6) continue;
    const day = startOfLocalDay(date).getTime();
    entries.push({ staffId: charles, shopId: shopBySlug.get("rock-island")!.id, kind: "worked", source: "import", startsAt: new Date(day + 9 * 3600_000), endsAt: new Date(day + 17 * 3600_000) });
  }
  // Training and PTO.
  const jamie = staffByKey.get("jamie")!.id;
  for (const d of [-20, -13, -6]) {
    const day = startOfLocalDay(addDays(today, d)).getTime();
    entries.push({ staffId: jamie, shopId: shopBySlug.get("moline")!.id, kind: "training", source: "import", startsAt: new Date(day + 7 * 3600_000), endsAt: new Date(day + 8.75 * 3600_000), note: "New-hire training" });
  }
  const makenna = staffByKey.get("makenna")!.id;
  const ptoDay = startOfLocalDay(addDays(today, -9)).getTime();
  entries.push({ staffId: makenna, shopId: shopBySlug.get("coralville")!.id, kind: "pto", source: "manual", startsAt: new Date(ptoDay + 9 * 3600_000), endsAt: new Date(ptoDay + 17 * 3600_000) });
  await chunked(entries, 2000, (c) => db.insert(t.timeEntries).values(c));

  // A NetComm typed over the formula in the last closed period, as in the workbook (Q17): flagged, not fixed.
  const closedStart = addDays("2026-10-18", Math.floor((diffDays(addDays(today, -14), "2026-10-18")) / 14) * 14);
  await db.insert(t.payrollOverrides).values({
    shopId: shopBySlug.get("coralville")!.id,
    periodStart: closedStart,
    staffId: makenna,
    field: "netComm",
    value: 150,
    reason: "Typed in the workbook; pending Charles (Q17)",
  });
  for (const id of clock.staffIds) await rederive(id, startOfLocalDay(addDays(today, -HISTORY_DAYS - 1)), now);
  const [{ n: clocked }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.timeEntries).where(eq(t.timeEntries.source, "clock"));
  console.log(
    `  payroll: ${people.length} profiles with sample employee numbers, ${clock.punches} time clock punches (${clocked} clocked time entries from them, one forgotten clock-out, ${clock.working} on the clock now), ${entries.length} other time entries (owner, training, PTO), one NetComm override`,
  );
  console.log(`  time clock: front-desk PIN for everyone is ${CLOCK_PIN}; punches go in only on a shop's front-desk clock or by scanning its QR code (set CLOCK_HMAC_SECRET)`);
}

/** Rough shop locations for the demo geofence (city-level, not surveyed). */
const SHOP_COORDS: Record<string, [number, number]> = {
  coralville: [41.6766, -91.581],
  kimberly: [41.56, -90.56],
  "le-claire": [41.598, -90.344],
  moline: [41.493, -90.487],
  "rock-island": [41.487, -90.556],
  dubuque: [42.5006, -90.6646],
  silvis: [41.51, -90.415],
  utica: [41.572, -90.518],
};
const CLOCK_PIN = process.env.SEED_CLOCK_PIN ?? "2468";

/**
 * Time clock punches for each barber's scheduled days over the sample history (in, out, a paid rest
 * break or an unpaid meal on some shifts, a few minutes late now and then), one front-desk device per
 * shop, demo PINs, one shift yesterday that was never clocked out, and whoever's already started
 * today on the clock. The time entries are derived from these punches afterwards.
 */
async function seedTimeClock(o: { now: Date; shopBySlug: Map<string, Shop>; scheduleRows: { staffId: string; shopId: string; weekday: number; startMin: number; endMin: number }[]; staffIndex: Map<string, number> }) {
  const { now, shopBySlug, scheduleRows, staffIndex } = o;
  const today = todayLocal(now);
  const coords = new Map<string, [number, number]>();
  for (const [slug, s] of shopBySlug) {
    const c = SHOP_COORDS[slug];
    if (!c) continue;
    coords.set(s.id, c);
    const timeClock = slug === "coralville" ? { methods: ["device", "gps"], radiusM: 150, networks: [], photo: "optional", graceMinutes: null } : { methods: [], radiusM: 150, networks: [], photo: "off", graceMinutes: null };
    await db.update(t.shops).set({ latitude: c[0], longitude: c[1], timeClock }).where(eq(t.shops.id, s.id));
  }
  const devices = await db
    .insert(t.clockDevices)
    .values([...shopBySlug.values()].map((s) => ({ shopId: s.id, label: "Front desk iPad", tokenHash: randomBytes(32).toString("hex"), lastSeenAt: now })))
    .returning({ id: t.clockDevices.id, shopId: t.clockDevices.shopId });
  const deviceOf = new Map(devices.map((d) => [d.shopId, d.id]));
  const pinHash = await bcrypt.hash(CLOCK_PIN, 10);
  await db.update(t.staff).set({ clockPinHash: pinHash }).where(and(eq(t.staff.kind, "person"), eq(t.staff.active, true)));

  type Punch = typeof t.timePunches.$inferInsert;
  const punches: Punch[] = [];
  const at = (date: LocalDate, min: number) => zonedWallTime(date, min).toJSDate();
  let n = 0;
  for (let d = -HISTORY_DAYS; d < 0; d++) {
    const date = addDays(today, d);
    const wd = weekdayOf(date);
    for (const r of scheduleRows) {
      if (r.weekday !== wd) continue;
      const i = staffIndex.get(r.staffId) ?? 0;
      if ((d + i * 3) % 11 === 0) continue;
      const late = ((d * 7 + i) % 4) * 5;
      const sIn = at(date, r.startMin + late);
      const sOut = at(date, r.endMin + [5, 0, 10, -20][(((d * 3 + i) % 4) + 4) % 4]);
      const sched = [{ start: at(date, r.startMin), end: at(date, r.endMin) }];
      const method = (["device", "network", "gps", "device"] as const)[n % 4];
      const c = coords.get(r.shopId);
      const base = {
        staffId: r.staffId,
        shopId: r.shopId,
        source: method === "device" ? ("kiosk" as const) : ("self" as const),
        method,
        deviceId: method === "device" ? (deviceOf.get(r.shopId) ?? null) : null,
        ip: method === "network" ? "203.0.113.10" : null,
        latitude: method === "gps" && c ? c[0] + 0.0002 : null,
        longitude: method === "gps" && c ? c[1] - 0.0002 : null,
        accuracyM: method === "gps" ? 12 : null,
        distanceM: method === "gps" && c ? 28 : null,
        createdBy: r.staffId,
      };
      const mk = (type: Punch["type"], when: Date, flag: { flag: string | null; minutes: number | null } = { flag: null, minutes: null }): Punch => ({
        ...base,
        type,
        at: when,
        originalAt: when,
        flags: flag.flag ? [flag.flag] : [],
        offScheduleMin: flag.minutes,
      });
      punches.push(mk("in", sIn, offSchedule("in", sIn, sched, 5)));
      const len = (sOut.getTime() - sIn.getTime()) / 60_000;
      if (len > 7 * 60 && n % 3 === 0) {
        const bs = new Date(sIn.getTime() + 4 * 3600_000);
        punches.push(mk("break_start", bs), mk("break_end", new Date(bs.getTime() + 30 * 60_000)));
      } else if (len > 5 * 60 && n % 3 === 1) {
        const bs = new Date(sIn.getTime() + 150 * 60_000);
        punches.push(mk("break_start", bs), mk("break_end", new Date(bs.getTime() + 10 * 60_000)));
      }
      punches.push(mk("out", sOut, offSchedule("out", sOut, sched, 5)));
      n++;
    }
  }
  // The most recent shift with no break: it was never clocked out, and a manager has been told.
  const lastIn = [...punches].reverse().find((p) => p.type === "in" && punches[punches.indexOf(p) + 1]?.type === "out");
  if (lastIn) {
    punches.splice(punches.indexOf(lastIn) + 1, 1);
    lastIn.flags = [...(lastIn.flags ?? []), "forgot_out"];
    lastIn.forgotFlaggedAt = now;
  }
  let working = 0;
  for (const r of scheduleRows) {
    if (r.weekday !== weekdayOf(today) || working >= 3) continue;
    const start = at(today, r.startMin + 3);
    if (start >= now || punches.some((p) => p.staffId === r.staffId && p.at >= startOfLocalDay(today))) continue;
    punches.push({ staffId: r.staffId, shopId: r.shopId, type: "in", at: start, originalAt: start, source: "kiosk", method: "device", deviceId: deviceOf.get(r.shopId) ?? null, flags: [], offScheduleMin: 3, createdBy: r.staffId });
    working++;
  }
  await chunked(punches, 2000, (c) => db.insert(t.timePunches).values(c));
  return { punches: punches.length, working, staffIds: [...new Set(punches.map((p) => p.staffId))] };
}

type Shop = typeof t.shops.$inferSelect;
type Product = typeof t.products.$inferSelect;

/**
 * Vendors, a few purchase orders and a transfer in flight, then the stock ledger: an opening balance
 * per product, every sample sale, and the receipts and transfer, in date order, ending at today's
 * stock. Deterministic (no random numbers), so the sample history above is unchanged.
 */
async function seedInventory(o: {
  now: Date;
  shopBySlug: Map<string, Shop>;
  productRows: Product[];
  shopProductRows: { shopId: string; productId: string; costCents: number }[];
  targetStock: Map<string, number>;
  saleRows: (typeof t.sales.$inferInsert & { id: string })[];
  saleItemRows: (typeof t.saleItems.$inferInsert)[];
  owner: typeof t.staff.$inferSelect;
}) {
  const { now, shopBySlug, productRows } = o;
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const key = (shopId: string, productId: string) => `${shopId}|${productId}`;
  const cost = new Map(o.shopProductRows.map((r) => [key(r.shopId, r.productId), r.costCents]));
  const carried = (shop: string, p: Product) => cost.has(key(shopBySlug.get(shop)!.id, p.id));
  const product = (brand: string, name: string) => productRows.find((p) => p.brand === brand && p.name === name)!;

  await db.update(t.brandSettings).set({ poApprovalThresholdCents: 50_000 });
  await db.update(t.shops).set({ negativeStock: "warn" }).where(sql`slug = 'moline'`);

  const vendorRows = await db
    .insert(t.vendors)
    .values([
      {
        name: "Barber Supply Co.",
        contactName: "Dana Kowalski",
        email: "orders@barbersupply.example",
        phone: "(319) 555-0182",
        address: "2200 Industrial Park Rd\nCedar Rapids, IA 52404",
        accountNumber: "RAYZ-4471",
        paymentTerms: "Net 30",
        leadTimeDays: 5,
        minimumOrderCents: 15_000,
        sendCsv: true,
        notes: "Orders in before noon ship the same day.",
      },
      {
        name: "SalonCentric",
        contactName: "Marcus Lee",
        email: "midwest.orders@saloncentric.example",
        phone: "(800) 555-0144",
        address: "1450 Commerce Dr\nDes Moines, IA 50309",
        accountNumber: "SC-88120",
        paymentTerms: "Net 30",
        leadTimeDays: 7,
        minimumOrderCents: 10_000,
      },
      {
        name: "Midwest Beauty Distributors",
        contactName: "Angie Ruiz",
        email: "sales@midwestbeauty.example",
        phone: "(563) 555-0170",
        address: "318 W 3rd St\nDavenport, IA 52801",
        paymentTerms: "Due on receipt",
        leadTimeDays: 3,
        notes: "Backup source for Reuzel when Barber Supply is out. Costs a little more, ships in singles.",
      },
      {
        name: "Hawkeye Print & Embroidery",
        contactName: "Tom Becker",
        email: "tom@hawkeyeprint.example",
        phone: "(319) 555-0127",
        address: "88 Gilbert St\nIowa City, IA 52240",
        paymentTerms: "50% deposit, balance Net 15",
        leadTimeDays: 14,
        minimumOrderCents: 20_000,
      },
    ])
    .returning();
  const [supply, salon, midwest, print] = vendorRows;
  const preferredFor = (brand: string) => (brand === "Ray'z" ? print : brand === "Redken" || brand === "Paul Mitchell" ? salon : supply);
  const casePackOf = (p: Product) => (p.name === "Pocket Comb" ? 24 : p.category === "Merch" ? 12 : 6);
  const vendorSku = (v: typeof supply, p: Product) => `${v.name.replace(/[^A-Z]/g, "")}-${p.sku.slice(-3)}${p.sku.slice(0, 3)}`;
  await db.insert(t.vendorProducts).values([
    ...productRows.map((p) => {
      const v = preferredFor(p.brand);
      return { vendorId: v.id, productId: p.id, vendorSku: vendorSku(v, p), casePack: casePackOf(p), costCents: p.costCents, preferred: true };
    }),
    ...productRows
      .filter((p) => p.brand === "Reuzel")
      .map((p) => ({ vendorId: midwest.id, productId: p.id, vendorSku: vendorSku(midwest, p), casePack: 1, costCents: Math.round(p.costCents * 1.08), preferred: false })),
  ]);

  type Line = { p: Product; qty: number; received?: number };
  const moves: (typeof t.inventoryLedger.$inferInsert)[] = [];
  const shopCost = (shopId: string, p: Product) => cost.get(key(shopId, p.id)) ?? p.costCents;
  async function po(shop: string, vendor: typeof supply, status: (typeof t.purchaseOrders.$inferInsert)["status"], lines: Line[], at: { created: number; sent?: number; received?: number }, notes?: string) {
    const shopId = shopBySlug.get(shop)!.id;
    const list = lines.filter((l) => carried(shop, l.p));
    const [row] = await db
      .insert(t.purchaseOrders)
      .values({
        shopId,
        vendorId: vendor.id,
        status,
        notes: notes ?? null,
        createdBy: o.owner.id,
        createdAt: ago(at.created),
        updatedAt: ago(at.sent ?? at.created),
        approvedAt: at.sent !== undefined ? ago(at.sent) : null,
        sentAt: at.sent !== undefined ? ago(at.sent) : null,
        sentBy: at.sent !== undefined ? o.owner.id : null,
        sentTo: at.sent !== undefined ? vendor.email : null,
        expectedOn: localDateOf(ago((at.sent ?? at.created) - vendor.leadTimeDays)),
        receivedAt: status === "received" && at.received !== undefined ? ago(at.received) : null,
      })
      .returning();
    const lineRows = await db
      .insert(t.purchaseOrderLines)
      .values(list.map((l) => ({ purchaseOrderId: row.id, productId: l.p.id, vendorSku: vendorSku(vendor, l.p), casePack: casePackOf(l.p), qtyOrdered: l.qty, unitCostCents: l.p.costCents, qtyReceived: l.received ?? 0 })))
      .returning();
    const got = list.filter((l) => l.received);
    if (got.length && at.received !== undefined) {
      const [receipt] = await db.insert(t.poReceipts).values({ purchaseOrderId: row.id, shopId, receivedBy: o.owner.id, receivedAt: ago(at.received) }).returning();
      await db.insert(t.poReceiptLines).values(got.map((l) => ({ receiptId: receipt.id, lineId: lineRows.find((x) => x.productId === l.p.id)!.id, productId: l.p.id, qty: l.received!, unitCostCents: l.p.costCents })));
      for (const l of got) moves.push({ shopId, productId: l.p.id, delta: l.received!, kind: "receive", unitCostCents: l.p.costCents, purchaseOrderId: row.id, receiptId: receipt.id, staffId: o.owner.id, createdAt: ago(at.received) });
    }
  }

  const reuzel = (n: string) => product("Reuzel", n);
  await po("coralville", supply, "received", [{ p: reuzel("Blue Pomade 4oz"), qty: 12, received: 12 }, { p: reuzel("Fiber 4oz"), qty: 12, received: 12 }, { p: reuzel("Matte Clay 4oz"), qty: 6, received: 6 }], { created: 7, sent: 6.9, received: 2 });
  await po("coralville", print, "partially_received", [{ p: product("Ray'z", "Snapback Hat"), qty: 24, received: 12 }, { p: product("Ray'z", "Beanie"), qty: 12, received: 12 }], { created: 20, sent: 19.8, received: 1 }, "Black hats with the white logo, same as last run.");
  await po("moline", salon, "sent", [{ p: product("Redken", "Brews Clean Hold Pomade"), qty: 6 }, { p: product("Redken", "Brews Daily Shampoo"), qty: 6 }, { p: product("Paul Mitchell", "Tea Tree Special Shampoo"), qty: 6 }], { created: 1.2, sent: 1 });
  await po("rock-island", supply, "draft", [{ p: product("Johnny B", "Hold Up Pomade"), qty: 6 }, { p: product("Level 3", "Styling Powder"), qty: 6 }], { created: 0.2 });
  await po("coralville", salon, "draft", [{ p: product("Redken", "Brews Maneuver Cream"), qty: 24 }, { p: product("Redken", "Brews Daily Shampoo"), qty: 18 }, { p: product("Paul Mitchell", "Tea Tree Shaping Cream"), qty: 12 }], { created: 0.1 }, "Stocking up for the holidays.");

  // Moline sent spare pomade to Rock Island yesterday; it's in transit.
  const from = shopBySlug.get("moline")!.id;
  const to = shopBySlug.get("rock-island")!.id;
  const moving = [reuzel("Blue Pomade 4oz"), reuzel("Pink Pomade 4oz")].filter((p) => carried("moline", p) && carried("rock-island", p));
  if (moving.length) {
    const [tr] = await db.insert(t.stockTransfers).values({ fromShopId: from, toShopId: to, status: "sent", note: "Rock Island ran out before the weekend", createdBy: o.owner.id, sentBy: o.owner.id, sentAt: ago(1), createdAt: ago(1.1) }).returning();
    await db.insert(t.stockTransferLines).values(moving.map((p) => ({ transferId: tr.id, productId: p.id, qty: 2, unitCostCents: shopCost(from, p) })));
    for (const p of moving) moves.push({ shopId: from, productId: p.id, delta: -2, kind: "transfer_out", unitCostCents: shopCost(from, p), transferId: tr.id, staffId: o.owner.id, createdAt: ago(1) });
  }

  const saleById = new Map(o.saleRows.map((s) => [s.id, s]));
  for (const i of o.saleItemRows) {
    if (i.kind !== "product" || !i.refId) continue;
    const s = saleById.get(i.saleId)!;
    moves.push({ shopId: s.shopId, productId: i.refId, delta: -i.qty!, kind: "sale", unitCostCents: cost.get(key(s.shopId, i.refId)), saleId: s.id, createdAt: s.paidAt! });
  }
  // Opening balance: whatever makes the history end at today's stock, without dipping below zero on the way.
  moves.sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime());
  const net = new Map<string, number>();
  const low = new Map<string, number>();
  for (const m of moves) {
    const k = key(m.shopId, m.productId);
    net.set(k, (net.get(k) ?? 0) + m.delta);
    low.set(k, Math.min(low.get(k) ?? 0, net.get(k)!));
  }
  const firstAt = moves.reduce((a, m) => Math.min(a, m.createdAt!.getTime()), now.getTime());
  const openingAt = new Date(firstAt - 86_400_000);
  for (const r of o.shopProductRows) {
    const k = key(r.shopId, r.productId);
    const opening = Math.max(0, (o.targetStock.get(k) ?? 0) - (net.get(k) ?? 0), -(low.get(k) ?? 0));
    if (opening) moves.push({ shopId: r.shopId, productId: r.productId, delta: opening, kind: "opening", note: "Imported from Squire", unitCostCents: r.costCents, createdAt: openingAt });
  }
  moves.sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime() || Number(b.kind === "opening") - Number(a.kind === "opening"));
  await chunked(moves, 1000, (c) => db.insert(t.inventoryLedger).values(c));
  console.log(`  ${vendorRows.length} vendors, ${moves.length} inventory ledger entries`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
