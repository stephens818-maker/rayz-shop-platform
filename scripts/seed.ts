import "dotenv/config";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, closeDb } from "@/db";
import * as t from "@/db/schema";
import { computeCheckout, CartLine } from "@/domain/checkout";
import { DEFAULT_LOYALTY, accrue, rewardExpiry } from "@/domain/loyalty";
import { appointmentCode, giftCardCode, slugify, staffPublicSlug } from "@/lib/ids";
import { addDays, localDateOf, startOfLocalDay, todayLocal, weekdayOf, zonedWallTime } from "@/lib/time";
import { COLORS, FIRST_NAMES, LAST_NAMES, MENUS, PRODUCTS, SERVICES, SHOPS, SHOP_DESCRIPTION, STAFF } from "./seed-data";

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "rayz2026!";
const HISTORY_DAYS = Number(process.env.SEED_HISTORY_DAYS ?? 56);
const FUTURE_DAYS = 14;

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
    audit_log, import_runs, notification_jobs, loyalty_ledger, loyalty_rewards, loyalty_accounts,
    cash_drawers, refunds, payments, sale_items, sales, gift_card_ledger, gift_cards, promo_codes,
    waitlist_entries, appointment_items, appointments, refresh_tokens, otp_codes, customers,
    inventory_adjustments, shop_products, products, shop_services, services, time_blocks,
    staff_schedules, staff_shops, staff, shop_closures, shop_hours, shops, brand_settings
    RESTART IDENTITY CASCADE`);

  await db.insert(t.brandSettings).values({ id: 1, loyalty: DEFAULT_LOYALTY });

  // ── Shops ──
  const shopRows = await db
    .insert(t.shops)
    .values(
      SHOPS.map((s) => ({
        slug: s.slug,
        name: s.name,
        address: s.address,
        city: s.city,
        state: s.state,
        zip: s.zip,
        phone: s.phone,
        email: s.email,
        serviceTaxRate: s.serviceTaxRate,
        productTaxRate: s.productTaxRate,
        description: SHOP_DESCRIPTION,
      })),
    )
    .returning();
  const shopBySlug = new Map(shopRows.map((s) => [s.slug, s]));
  await db.insert(t.shopHours).values(
    SHOPS.flatMap((s) =>
      Object.entries(s.hours).map(([wd, [o, c]]) => ({ shopId: shopBySlug.get(s.slug)!.id, weekday: Number(wd), openMin: o * 60, closeMin: c * 60 })),
    ),
  );
  // Thanksgiving: closed everywhere (example of a closure date).
  await db.insert(t.shopClosures).values(shopRows.map((s) => ({ shopId: s.id, date: "2026-11-26", reason: "Thanksgiving" })));

  // ── Catalog ──
  const svcRows = await db
    .insert(t.services)
    .values(
      SERVICES.map((s, i) => ({
        slug: s.slug,
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
        role: s.role ?? "barber",
        managerShopId: s.managerShop ? shopBySlug.get(s.managerShop)!.id : null,
        isBookable: s.bookable ?? true,
        active: s.active ?? true,
      })),
    )
    .returning();
  const staffByKey = new Map(STAFF.map((s, i) => [s.key, staffRows[i]]));
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

  // ── Retail ──
  const productRows = await db
    .insert(t.products)
    .values(PRODUCTS.map(([brand, name, , category], i) => ({ sku: `${slugify(brand)}-${slugify(name)}`.slice(0, 40) + `-${i}`, brand, name, category })))
    .returning();
  const shopProductRows = shopRows
    .filter((s) => s.slug !== "dubuque")
    .flatMap((s) =>
      productRows
        .filter((_, i) => s.slug === "coralville" || i % 3 !== 1)
        .map((p) => {
          const price = PRODUCTS.find(([b, n]) => b === p.brand && n === p.name)![2] * 100;
          const stock = chance(0.3) ? Math.floor(rand() * 3) : 3 + Math.floor(rand() * 10);
          return { shopId: s.id, productId: p.id, priceCents: price, costCents: Math.round(price * (0.48 + rand() * 0.06)), stock, lowStockThreshold: 3 };
        }),
    );
  await db.insert(t.shopProducts).values(shopProductRows);

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
  const customerValues = Array.from({ length: 3000 }, (_, i) => {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const shop = pick(shopRows.filter((s) => s.slug !== "dubuque"));
    return {
      firstName: first,
      lastName: last,
      phone: `+1${pick(["319", "563", "309"])}555${String(1000 + i).slice(-4)}`,
      email: chance(0.6) ? `${first}.${last}.${i}@example.test`.toLowerCase() : null,
      homeShopId: shop.id,
      createdAt: new Date(now.getTime() - (HISTORY_DAYS + 400 * rand()) * 86_400_000),
    };
  });
  const customerRows: (typeof t.customers.$inferSelect)[] = [];
  await chunked(customerValues, 1000, async (c) => customerRows.push(...(await db.insert(t.customers).values(c).returning())));
  // A demo client whose next haircut crosses the $300 loyalty goal.
  const [demoCustomer] = await db
    .insert(t.customers)
    .values({ firstName: "Jordan", lastName: "Demo", phone: "+13195550100", email: "jordan@example.test", homeShopId: shopBySlug.get("coralville")!.id })
    .returning();
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
        blocks.push({ staffId: sch.staffId, shopId: shop.id, startsAt: zonedWallTime(date, lunchAt).toJSDate(), endsAt: zonedWallTime(date, lunchAt + 30).toJSDate(), reason: "Lunch" });
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
  blocks.push({ staffId: michelle.id, shopId: null, startsAt: startOff, endsAt: endOff, kind: "day_off", reason: "Vacation day" });
  blocks.push({
    staffId: makenna.id,
    shopId: shopBySlug.get("coralville")!.id,
    startsAt: zonedWallTime(today, 15 * 60).toJSDate(),
    endsAt: zonedWallTime(today, 16 * 60).toJSDate(),
    reason: "Product training",
  });
  // Appointments that collide with the new day off / training are cancelled in the sample.
  for (const a of appts) {
    const collides = blocks.some(
      (b) => (b.kind === "day_off" || b.reason === "Product training") && b.staffId === a.staffId && a.startsAt < b.endsAt && a.endsAt! > b.startsAt,
    );
    if (collides && a.status === "booked") a.status = "cancelled";
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

  console.log("Seed complete.");
  console.log(`  Logins (password: ${DEMO_PASSWORD}): owner@rayz.test (brand admin), michelle@rayz.test (Coralville manager), makenna@rayz.test (barber)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
