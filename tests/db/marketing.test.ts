/**
 * The Campaign Center against a real database: coupons at checkout and from online booking (limits,
 * single-use codes, first visit only, stacking, free add-ons, auto-apply, refunds giving them back,
 * loyalty on the net), the engine (consent from the customer app's columns, once per occasion,
 * quiet hours, frequency caps, the email footer, coupon codes issued per client), STOP, START, HELP
 * and the unsubscribe link, each automated campaign's audience, blasts with the segment builder and
 * the preview, location scoping, the report and the contact export's permission.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";
import { BRAND_CAMPAIGN_CENTER } from "@/domain/permissions";
import { DEFAULT_LAPSED_STEPS, LAPSED_BUCKETS, SKIP_LABEL, TRIGGERS, type TriggerKey, lapsedBetween, lapsedOver } from "@/domain/marketing";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let E: typeof import("@/server/marketing/engine");
let CP: typeof import("@/server/marketing/campaigns");
let C: typeof import("@/server/marketing/consent");
let LK: typeof import("@/server/marketing/links");
let CO: typeof import("@/server/coupons");
let LINE: typeof import("@/server/shop-line");
let L: typeof import("@/server/report-data");
let S: typeof import("@/app/admin/reports/scope");
let clickRoute: typeof import("@/app/m/[token]/route").GET;
let exportRoute: typeof import("@/app/admin/campaign-center/export/route").GET;
const fx = { cv: "", cvSlug: "coralville", cvLine: "", other: "", michelle: "", owner: "", barber: "", cut: "", cutCents: 0, addon: "", addonCents: 0, marketing: {} as Record<string, unknown>, michelleOverrides: {} as Record<string, boolean> };
let seq = 0;

/** A week the seed never reaches; Chicago is on CST (-06:00) in February. */
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00-06:00`);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = at("2028-02-16", "11:00");
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ADDRESS = "100 First Ave, Coralville, IA 52241";

const s = () => m.schema;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const exec = (q: ReturnType<Mods["drizzle"]["sql"]>) => m.db.db.execute(q);
const sql = Object.assign((...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a), { raw: (q: string) => m.drizzle.sql.raw(q) });

beforeAll(async () => {
  m = await loadModules();
  E = await import("@/server/marketing/engine");
  CP = await import("@/server/marketing/campaigns");
  C = await import("@/server/marketing/consent");
  LK = await import("@/server/marketing/links");
  CO = await import("@/server/coupons");
  LINE = await import("@/server/shop-line");
  L = await import("@/server/report-data");
  S = await import("@/app/admin/reports/scope");
  clickRoute = (await import("@/app/m/[token]/route")).GET;
  exportRoute = (await import("@/app/admin/campaign-center/export/route")).GET;
  const shops = await m.db.db.query.shops.findMany({ where: eq(s().shops.active, true) });
  const cv = shops.find((x) => x.slug === "coralville")!;
  fx.cv = cv.id;
  fx.cvLine = cv.twilioNumber!;
  fx.other = shops.find((x) => x.id !== cv.id)!.id;
  fx.michelle = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.displayLabel, "Michelle") }))!.id;
  fx.owner = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, "owner@rayz.test") }))!.id;
  // The Campaign Center is the brand's; this brand grants Michelle, a shop manager, everything but the contact export.
  const [mi] = await m.db.db.select({ o: s().staff.permissionOverrides }).from(s().staff).where(eq(s().staff.id, fx.michelle));
  fx.michelleOverrides = mi.o;
  const grant = [...BRAND_CAMPAIGN_CENTER].filter((p) => p !== "campaign_center.export" && p !== "report.campaign_center.export");
  await m.db.db.update(s().staff).set({ permissionOverrides: { ...mi.o, ...Object.fromEntries(grant.map((p) => [p, true])) } }).where(eq(s().staff.id, fx.michelle));
  const links = await m.db.db
    .select({ id: s().staffShops.staffId })
    .from(s().staffShops)
    .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
    .where(and(eq(s().staffShops.shopId, fx.cv), eq(s().staff.isBookable, true), eq(s().staff.active, true)));
  fx.barber = links.find((l) => l.id !== fx.michelle)?.id ?? fx.michelle;
  const menu = await m.catalog.shopCatalog(fx.cv);
  const cut = menu.find((x) => x.slug === "rayz-cut-shampoo") ?? menu.find((x) => x.kind === "service")!;
  const addon = menu.find((x) => x.kind === "addon")!;
  [fx.cut, fx.cutCents, fx.addon, fx.addonCents] = [cut.id, cut.priceCents, addon.id, addon.priceCents];
  const [b] = await m.db.db.select({ marketing: s().brandSettings.marketing }).from(s().brandSettings).limit(1);
  fx.marketing = (b?.marketing as Record<string, unknown>) ?? {};
  await m.db.db.update(s().brandSettings).set({ marketing: { address: ADDRESS } });
  await CP.ensureTriggerCampaigns();
}, 180_000);

afterAll(async () => {
  if (m) {
    await consent(false);
    await m.db.db.update(s().brandSettings).set({ marketing: fx.marketing });
    await m.db.db.update(s().staff).set({ permissionOverrides: fx.michelleOverrides }).where(eq(s().staff.id, fx.michelle));
    await m.db.closeDb();
  }
});

/** The customer app's marketing consent columns (PR #8). Core reads them and never writes them. */
async function consent(on: boolean) {
  if (on) {
    await exec(sql`alter table customers add column if not exists sms_marketing_opt_in boolean not null default false`);
    await exec(sql`alter table customers add column if not exists email_marketing_opt_in boolean not null default false`);
    await exec(sql`alter table customers add column if not exists push_marketing boolean not null default false`);
    await exec(sql`create table if not exists customer_devices (id uuid primary key default gen_random_uuid(), customer_id uuid not null references customers(id) on delete cascade, push_enabled boolean not null default true, revoked_at timestamptz, last_seen_at timestamptz)`);
  } else {
    await exec(sql`drop table if exists customer_devices`);
    for (const c of ["sms_marketing_opt_in", "email_marketing_opt_in", "push_marketing"]) await exec(sql.raw(`alter table customers drop column if exists ${c}`));
  }
  C.resetConsentCache();
}

type ClientOpts = { sms?: boolean; email?: boolean; push?: boolean; first?: string; last?: string; birthday?: string; home?: string; noPhone?: boolean; preferred?: string };
async function client(o: ClientOpts = {}) {
  const n = String(1000 + ((++seq * 37) % 9000)).padStart(4, "0");
  const [c] = await m.db.db
    .insert(s().customers)
    .values({
      firstName: o.first ?? "Mark",
      lastName: o.last ?? "Etting",
      preferredStaffId: o.preferred ?? null,
      phone: o.noPhone ? null : `+1319556${n}`,
      email: `mark${n}.${seq}@example.com`,
      smsOptIn: true,
      emailOptIn: true,
      birthday: o.birthday ?? null,
      homeShopId: o.home ?? fx.cv,
    })
    .returning();
  if (o.sms || o.email || o.push) {
    await exec(sql`update customers set sms_marketing_opt_in = ${!!o.sms}, email_marketing_opt_in = ${!!o.email}, push_marketing = ${!!o.push} where id = ${c.id}`);
    if (o.push) await exec(sql`insert into customer_devices (customer_id, push_enabled, last_seen_at) values (${c.id}, true, now())`);
  }
  return c;
}

async function visit(customerId: string, when: Date, o: { shop?: string; staff?: string; status?: "completed" | "no_show" | "booked" | "cancelled"; createdAt?: Date } = {}) {
  const [a] = await m.db.db
    .insert(s().appointments)
    .values({
      code: `M${crypto.randomUUID().slice(0, 7).toUpperCase()}`,
      shopId: o.shop ?? fx.cv,
      staffId: o.staff ?? fx.michelle,
      customerId,
      startsAt: when,
      endsAt: new Date(when.getTime() + 30 * 60_000),
      status: o.status ?? "completed",
      source: "staff",
      completedAt: (o.status ?? "completed") === "completed" ? new Date(when.getTime() + 30 * 60_000) : null,
      createdAt: o.createdAt ?? new Date(when.getTime() - DAY),
    })
    .returning();
  return a;
}

type PromoOpts = Partial<typeof import("@/db/schema").promoCodes.$inferInsert>;
async function promo(o: PromoOpts) {
  const [p] = await m.db.db
    .insert(s().promoCodes)
    .values({ type: "amount", value: 500, appliesTo: "services", ...o, code: o.code ?? `T${++seq}X${Math.random().toString(36).slice(2, 6).toUpperCase()}` })
    .returning();
  return p;
}

async function pay(o: { customerId: string | null; codes?: string[]; addon?: boolean; now?: Date; saleId?: string }) {
  const saleId = o.saleId ?? (await m.checkout.openBlankSale(fx.cv, actor, fx.michelle)).id;
  if (o.customerId) await m.db.db.update(s().sales).set({ customerId: o.customerId }).where(eq(s().sales.id, saleId));
  await m.checkout.finalizeSale({
    saleId,
    lines: [{ kind: "service", refId: fx.cut, qty: 1 }, ...(o.addon ? [{ kind: "addon" as const, refId: fx.addon, qty: 1 }] : [])],
    promoCode: o.codes?.[0] ?? null,
    promoCodes: o.codes?.slice(1) ?? null,
    tipCents: 0,
    tender: { method: "card", paymentMethodId: "pm_card_visa", entryMode: "keyed" },
    actor,
    now: o.now ?? NOW,
  });
  return (await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, saleId) }))!;
}

const redemptions = (saleId: string) => m.db.db.select().from(s().couponRedemptions).where(eq(s().couponRedemptions.saleId, saleId));
const campaign = async (trigger: string) => (await m.db.db.query.marketingCampaigns.findFirst({ where: and(eq(s().marketingCampaigns.kind, "trigger"), eq(s().marketingCampaigns.trigger, trigger)) }))!;
const sendsFor = (customerId: string) => m.db.db.select().from(s().marketingSends).where(eq(s().marketingSends.customerId, customerId));
const job = async (id: string | null) => (await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.id, id!)))[0];
async function turnOn(trigger: string, shopId = fx.cv, settings: Record<string, number> | null = null) {
  const c = await campaign(trigger);
  await m.db.db
    .insert(s().marketingLocationSettings)
    .values({ campaignId: c.id, shopId, enabled: true, settings })
    .onConflictDoUpdate({ target: [s().marketingLocationSettings.campaignId, s().marketingLocationSettings.shopId], set: { enabled: true, settings } });
  return c;
}
const ctxOf = async () => (await (await import("@/server/auth/staff")).getStaffContext())!;

describe("coupons at checkout", () => {
  it("percent off one service, at one location, with a minimum spend and dates; loyalty earns on the net", async () => {
    const p = await promo({ type: "percent", value: 20, serviceIds: [fx.cut], shopIds: [fx.cv], minSpendCents: 1000, startsOn: "2028-01-01", endsOn: "2028-12-31" });
    const c = await client();
    const sale = await pay({ customerId: c.id, codes: [p.code], addon: true });
    const off = Math.round(fx.cutCents * 0.2);
    expect(sale.discountCents).toBe(off);
    expect(sale.serviceNetCents).toBe(fx.cutCents + fx.addonCents - off);
    const [r] = await redemptions(sale.id);
    expect(r).toMatchObject({ promoId: p.id, discountCents: off, via: "code", customerId: c.id, shopId: fx.cv });
    expect((await m.db.db.query.promoCodes.findFirst({ where: eq(s().promoCodes.id, p.id) }))!.redemptions).toBe(1);
    await expect(CO.resolveCoupon(p.code, { shopId: fx.other, today: "2028-02-16" })).rejects.toThrow(/location/i);
    await expect(CO.resolveCoupon(p.code, { shopId: fx.cv, today: "2027-12-31" })).rejects.toThrow();
  });

  it("limits uses per client and first visits only", async () => {
    const once = await promo({ maxPerCustomer: 1 });
    const c = await client();
    await pay({ customerId: c.id, codes: [once.code] });
    await expect(pay({ customerId: c.id, codes: [once.code] })).rejects.toThrow();
    const first = await promo({ firstVisitOnly: true });
    await expect(pay({ customerId: c.id, codes: [first.code] })).rejects.toThrow(/first/i);
    const fresh = await client();
    expect((await pay({ customerId: fresh.id, codes: [first.code] })).discountCents).toBe(500);
  });

  it("single-use codes work once, for their client, and come back when the ticket is voided", async () => {
    const p = await promo({ codeMode: "unique", code: `SOLO${++seq}`, validDays: 14 });
    const c = await client();
    const [code] = await m.db.db.insert(s().couponCodes).values({ promoId: p.id, code: `${p.code}-AB${seq}CD`, customerId: c.id, expiresOn: "2028-03-01" }).returning();
    const other = await client();
    await expect(pay({ customerId: other.id, codes: [code.code] })).rejects.toThrow();
    const sale = await pay({ customerId: c.id, codes: [code.code] });
    expect(sale.discountCents).toBe(500);
    await expect(pay({ customerId: c.id, codes: [code.code] })).rejects.toThrow();
    await m.checkout.voidSale(sale.id, "Rang up wrong", actor, NOW);
    const [r] = await redemptions(sale.id);
    expect(r.reversedAt).not.toBeNull();
    expect((await m.db.db.query.couponCodes.findFirst({ where: eq(s().couponCodes.id, code.id) }))!.redeemedAt).toBeNull();
    expect((await pay({ customerId: c.id, codes: [code.code] })).discountCents).toBe(500);
  });

  it("stacks only coupons that allow it; a free add-on needs the add-on on the ticket", async () => {
    const a = await promo({ value: 300 });
    const b = await promo({ value: 200 });
    const solo = await promo({ value: 100, stackable: false });
    const c = await client();
    expect((await pay({ customerId: c.id, codes: [a.code, b.code] })).discountCents).toBe(500);
    await expect(pay({ customerId: c.id, codes: [a.code, solo.code] })).rejects.toThrow(/combine|stack/i);
    const free = await promo({ type: "free_item", value: 0, freeItemKind: "addon", freeItemId: fx.addon, appliesTo: "all" });
    await expect(pay({ customerId: c.id, codes: [free.code] })).rejects.toThrow(/Add /);
    expect((await pay({ customerId: c.id, codes: [free.code], addon: true })).discountCents).toBe(fx.addonCents);
  });

  it("auto-apply coupons are on the ticket for clients who qualify", async () => {
    const p = await promo({ autoApply: true, firstVisitOnly: true, value: 700 });
    const c = await client();
    const sale = await m.checkout.openBlankSale(fx.cv, actor, fx.michelle);
    await m.db.db.update(s().sales).set({ customerId: c.id }).where(eq(s().sales.id, sale.id));
    const t = await CO.ticketCoupons({ id: sale.id, shopId: fx.cv, customerId: c.id, appointmentId: null });
    expect(t.auto.map((r) => r.promoId)).toContain(p.id);
    expect(t.auto.find((r) => r.promoId === p.id)!.via).toBe("auto");
    await m.db.db.update(s().promoCodes).set({ active: false }).where(eq(s().promoCodes.id, p.id));
  });

  it("a coupon entered when booking online is held for checkout and applied there", async () => {
    const p = await promo({ value: 400, code: `BOOK${++seq}` });
    expect((await CO.checkBookingCoupon(fx.cvSlug, p.code)).summary).toMatch(/\$4/);
    const c = await client();
    const now = new Date();
    // Just after midnight in Iowa, clear of the seeded appointments whatever time the test runs.
    const day = new Date(now.getTime() + 2 * DAY);
    const appt = await visit(c.id, new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 6, 5)), { status: "booked", createdAt: now });
    await CO.holdBookingCoupon(appt.code, p.code, now);
    const sale = await m.checkout.openSaleForAppointment(appt.id, actor);
    const t = await CO.ticketCoupons({ id: sale.id, shopId: fx.cv, customerId: c.id, appointmentId: appt.id });
    expect(t.held?.rule?.via).toBe("booking");
    const done = await pay({ customerId: c.id, codes: [p.code], saleId: sale.id, now });
    expect(done.discountCents).toBe(400);
    expect((await redemptions(sale.id))[0].via).toBe("booking");
    expect(await m.db.db.select().from(s().appointmentCoupons).where(eq(s().appointmentCoupons.appointmentId, appt.id))).toHaveLength(0);
    await expect(CO.holdBookingCoupon(appt.code, p.code, new Date(now.getTime() + HOUR))).rejects.toThrow();
  });

  it("the coupon editor saves every rule, keeps a used code as it is, and keeps locations to their own coupons", async () => {
    const A = await import("@/app/admin/promos/actions");
    await signInAs(fx.owner);
    const code = `FREEBEARD${++seq}`;
    const base = { code, type: "free_item", value: 0, freeItemKind: "addon", freeItemId: fx.addon, shopIds: [fx.cv], minSpendCents: 2000, maxPerCustomer: 1, codeMode: "unique", validDays: 14, firstVisitOnly: false, stackable: true };
    expect(await A.saveCouponAction(null, base)).toEqual({ ok: true, data: null });
    const p = (await m.db.db.query.promoCodes.findFirst({ where: eq(s().promoCodes.code, code) }))!;
    expect(p).toMatchObject({ type: "free_item", freeItemKind: "addon", freeItemId: fx.addon, shopIds: [fx.cv], shopId: fx.cv, minSpendCents: 2000, maxPerCustomer: 1, codeMode: "unique", validDays: 14, stackable: true, autoApply: false });
    expect(await A.saveCouponAction(null, { ...base, code })).toMatchObject({ ok: false, error: /already exists/ });
    expect(await A.saveCouponAction(null, { ...base, code: `${code}B`, freeItemKind: "product", freeItemId: fx.addon })).toMatchObject({ ok: false, error: /not found/i });
    expect(await A.saveCouponAction(p.id, { ...base, minSpendCents: null, endsOn: "2028-12-31" })).toMatchObject({ ok: true });
    await m.db.db.insert(s().couponCodes).values({ promoId: p.id, code: `${code}-ABC123` });
    expect(await A.saveCouponAction(p.id, { ...base, code: `${code}X` })).toMatchObject({ ok: false, error: /stay as they are/ });
    expect(await A.saveCouponAction(p.id, { ...base, maxPerCustomer: 2 })).toMatchObject({ ok: true });

    await signInAs(fx.michelle);
    expect(await A.saveCouponAction(null, { ...base, code: `${code}ALL`, shopIds: [] })).toMatchObject({ ok: false, error: /every shop/ });
    expect(await A.saveCouponAction(null, { ...base, code: `${code}OTHER`, shopIds: [fx.other] })).toMatchObject({ ok: false });
    expect(await A.saveCouponAction(p.id, { ...base, maxPerCustomer: 3 })).toMatchObject({ ok: true });
    const everywhere = await promo({ code: `EVERY${++seq}` });
    expect(await A.togglePromoAction(everywhere.id, false)).toMatchObject({ ok: false, error: /outside your access/ });
    await m.db.db.update(s().promoCodes).set({ active: false }).where(eq(s().promoCodes.id, everywhere.id));
  });
});

describe("the marketing engine", () => {
  it("sends nothing until the customer app's marketing consent exists, then only to clients who agreed", async () => {
    await consent(false);
    const lapsed = await turnOn("lapsed");
    const c = await client();
    await visit(c.id, new Date(NOW.getTime() - 45 * DAY));
    await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["lapsed"] });
    expect(await sendsFor(c.id)).toHaveLength(0);

    await consent(true);
    const yes = await client({ sms: true });
    const no = await client();
    for (const x of [yes, no]) await visit(x.id, new Date(NOW.getTime() - 45 * DAY));
    await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["lapsed"] });
    expect(await sendsFor(no.id)).toHaveLength(0);
    const [send] = await sendsFor(yes.id);
    expect(send).toMatchObject({ campaignId: lapsed.id, channel: "sms", status: "queued", shopId: fx.cv, staffId: fx.michelle });
    const j = await job(send.jobId);
    expect(j).toMatchObject({ kind: "marketing", channel: "sms", to: yes.phone, shopId: fx.cv });
    expect(j.body).toMatch(/STOP/);
    expect(j.body).toContain(`/m/${send.token}`);
    expect(j.runAt.getTime()).toBe(NOW.getTime());

    // Idempotent: the same occasion never goes twice.
    const again = await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["lapsed"] });
    expect(await sendsFor(yes.id)).toHaveLength(1);
    expect(again.queued).toBe(0);
  });

  it("holds marketing due in quiet hours until they end in the location's time zone", async () => {
    await consent(true);
    await turnOn("lapsed");
    const c = await client({ sms: true });
    const late = at("2028-02-16", "22:30");
    await visit(c.id, new Date(late.getTime() - 43 * DAY));
    await E.runTriggers(late, { shopIds: [fx.cv], keys: ["lapsed"] });
    const [send] = await sendsFor(c.id);
    expect((await job(send.jobId)).runAt.toISOString()).toBe(at("2028-02-17", "09:00").toISOString());
  });

  it("emails carry the brand's address and an unsubscribe link, and go only with an address on file", async () => {
    await consent(true);
    await turnOn("lapsed");
    const c = await client({ email: true });
    await visit(c.id, new Date(NOW.getTime() - 44 * DAY));
    await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["lapsed"] });
    const [send] = await sendsFor(c.id);
    const j = await job(send.jobId);
    expect(j.channel).toBe("email");
    expect(j.body).toContain(ADDRESS);
    expect(j.body).toContain(`/m/${send.token}/unsubscribe`);

    await m.db.db.update(s().brandSettings).set({ marketing: {} });
    const d = await client({ email: true });
    await visit(d.id, new Date(NOW.getTime() - 44 * DAY));
    await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["lapsed"] });
    expect(await sendsFor(d.id)).toHaveLength(0);
    await m.db.db.update(s().brandSettings).set({ marketing: { address: ADDRESS } });
  });

  it("caps marketing per client per week across campaigns", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const c = await client({ sms: true });
    await m.db.db.insert(s().customerTags).values({ customerId: c.id, tag: `cap-${c.id.slice(0, 6)}` });
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      ids.push(
        await CP.saveBlast(ctx, {
          name: `Cap ${n}`,
          channels: ["sms"],
          templates: { sms: `{shop}: offer ${n} for {first_name}. Reply STOP to opt out.` },
          segment: { tags: [`cap-${c.id.slice(0, 6)}`] },
          shopIds: [fx.cv],
        }),
      );
    }
    for (const [i, id] of ids.entries()) await CP.scheduleBlast(ctx, id, null, new Date(NOW.getTime() + i * HOUR));
    const rows = await sendsFor(c.id);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(2);
    expect(rows.find((r) => r.status === "skipped")?.skipped).toBe("cap_week");
  });

  it("STOP turns marketing texts off (and counts against the campaign), START turns them back on, HELP answers", async () => {
    await consent(true);
    const lapsed = await turnOn("lapsed");
    const c = await client({ sms: true });
    await visit(c.id, new Date(NOW.getTime() - 46 * DAY));
    const late = at("2028-02-16", "23:00");
    await E.runTriggers(late, { shopIds: [fx.cv], keys: ["lapsed"] });
    const [send] = await sendsFor(c.id);
    expect((await job(send.jobId)).status).toBe("pending");

    await LINE.handleInboundSms({ from: c.phone!, to: fx.cvLine, body: "STOP" }, late);
    const [u] = await m.db.db.select().from(s().marketingUnsubscribes).where(eq(s().marketingUnsubscribes.sendId, send.id));
    expect(u).toMatchObject({ channel: "sms", source: "stop", campaignId: lapsed.id });
    expect((await job(send.jobId)).status).toBe("cancelled");
    expect((await C.contactsFor([c.id])).get(c.id)!.reach.sms).toBe(false);

    await LINE.handleInboundSms({ from: c.phone!, to: fx.cvLine, body: "START" }, late);
    expect((await C.contactsFor([c.id])).get(c.id)!.reach.sms).toBe(true);

    await LINE.handleInboundSms({ from: c.phone!, to: fx.cvLine, body: "HELP" }, late);
    const help = await m.db.db
      .select()
      .from(s().notificationJobs)
      .where(and(eq(s().notificationJobs.to, c.phone!), eq(s().notificationJobs.kind, "shop_reply")));
    expect(help.some((h) => /Reply STOP to opt out/.test(h.body) && /Msg & data rates/.test(h.body))).toBe(true);
  });

  it("the tracked link counts real clicks and goes to the booking page; the unsubscribe link stops that channel", async () => {
    await consent(true);
    await turnOn("lapsed");
    const c = await client({ email: true });
    await visit(c.id, new Date(NOW.getTime() - 47 * DAY));
    await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["lapsed"] });
    const [send] = await sendsFor(c.id);
    const open = (ua: string) => clickRoute(new Request(`http://x/m/${send.token}`, { headers: { "user-agent": ua } }), { params: Promise.resolve({ token: send.token }) });
    const r = await open(IPHONE);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/^\/book\/coralville/);
    await open("Mimecast Email Security");
    expect((await sendsFor(c.id))[0].clicks).toBe(1);

    expect((await LK.unsubscribeView(send.token))?.channel).toBe("email");
    expect(await LK.unsubscribeByToken(send.token)).toBe(true);
    const reach = (await C.contactsFor([c.id])).get(c.id)!.reach;
    expect(reach.email).toBe(false);
    expect(await LK.unsubscribeView("not-a-token")).toBeNull();
  });

  it("issues a single-use code per client when the campaign's coupon has them, and credits the redemption to the campaign", async () => {
    await consent(true);
    const p = await promo({ codeMode: "unique", code: `MISS${++seq}`, validDays: 10, value: 600 });
    const lapsed = await turnOn("lapsed");
    await m.db.db.update(s().marketingCampaigns).set({ promoId: p.id, templates: { sms: "{shop}: {first_name}, {coupon_code} takes $6 off until {expiry}. {book_link} Reply STOP to opt out." } }).where(eq(s().marketingCampaigns.id, lapsed.id));
    const c = await client({ sms: true });
    await visit(c.id, new Date(NOW.getTime() - 48 * DAY));
    await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["lapsed"] });
    const [send] = await sendsFor(c.id);
    const [code] = await m.db.db.select().from(s().couponCodes).where(eq(s().couponCodes.id, send.couponCodeId!));
    expect(code).toMatchObject({ customerId: c.id, campaignId: lapsed.id, expiresOn: "2028-02-26" });
    expect((await job(send.jobId)).body).toContain(code.code);
    expect((await job(send.jobId)).body).toContain("Feb 26");
    expect(send.bookPath).toContain(`coupon=${code.code}`);
    const sale = await pay({ customerId: c.id, codes: [code.code], now: new Date(NOW.getTime() + 2 * DAY) });
    expect((await redemptions(sale.id))[0].campaignId).toBe(lapsed.id);
    await m.db.db.update(s().marketingCampaigns).set({ promoId: null, templates: lapsed.templates }).where(eq(s().marketingCampaigns.id, lapsed.id));
  });
});

describe("automated campaigns' audiences", () => {
  const run = (key: TriggerKey, now = NOW) => E.runTriggers(now, { shopIds: [fx.cv], keys: [key] });

  it("birthday, first visit, milestone, no-show, rebook and win-back", async () => {
    await consent(true);
    for (const k of ["birthday", "first_visit", "milestone", "no_show", "rebook", "win_back"]) await turnOn(k);
    const bday = await client({ sms: true, birthday: "1990-02-20" });
    const later = await client({ sms: true, birthday: "1990-03-20" });
    const first = await client({ sms: true });
    await visit(first.id, new Date(NOW.getTime() - 30 * HOUR));
    const tenth = await client({ sms: true });
    for (let i = 0; i < 10; i++) await visit(tenth.id, new Date(NOW.getTime() - 2 * HOUR - i * 21 * DAY));
    const noShow = await client({ sms: true });
    const missed = await visit(noShow.id, new Date(NOW.getTime() - 4 * HOUR), { status: "no_show", createdAt: new Date(NOW.getTime() - 5 * DAY) });
    const regular = await client({ sms: true });
    for (const d of [61, 40, 19]) await visit(regular.id, new Date(NOW.getTime() - d * DAY));
    const gone = await client({ sms: true });
    await visit(gone.id, new Date(NOW.getTime() - 95 * DAY));
    for (const k of ["birthday", "first_visit", "milestone", "no_show", "rebook", "win_back"] as const) await run(k);
    const occ = async (id: string) => (await sendsFor(id)).map((x) => x.dedupeKey.split(":").slice(2).join(":"));
    expect(await occ(bday.id)).toEqual(["birthday:2028"]);
    expect(await occ(later.id)).toEqual([]);
    expect(await occ(first.id)).toEqual(["first_visit"]);
    expect(await occ(tenth.id)).toContain("milestone:10");
    expect(await occ(noShow.id)).toEqual([`no_show:${missed.id}`]);
    expect(await occ(regular.id)).toEqual([expect.stringMatching(/^rebook:/)]);
    expect(await occ(gone.id)).toEqual([expect.stringMatching(/^win_back:/)]);
  });

  it("a booking started online and not finished", async () => {
    await consent(true);
    await turnOn("abandoned_booking");
    const c = await client({ sms: true });
    const left = new Date(NOW.getTime() - 90 * 60_000);
    const [d] = await m.db.db.insert(s().bookingDrafts).values({ token: `draft${++seq}${Date.now()}`, shopId: fx.cv, customerId: c.id, serviceId: fx.cut, staffId: fx.michelle, createdAt: left, updatedAt: left }).returning();
    const done = await client({ sms: true });
    await m.db.db.insert(s().bookingDrafts).values({ token: `draft${++seq}${Date.now()}`, shopId: fx.cv, customerId: done.id, createdAt: left, updatedAt: left });
    await visit(done.id, new Date(NOW.getTime() + 3 * DAY), { status: "booked", createdAt: new Date(left.getTime() + 60_000) });
    await run("abandoned_booking");
    const [send] = await sendsFor(c.id);
    expect(send.dedupeKey).toContain(`abandoned:${d.id}`);
    expect(send.bookPath).toMatch(/service=/);
    expect(await sendsFor(done.id)).toHaveLength(0);
  });

  it("the booking page's draft finds the client by the phone they type, and finishing the booking closes it", async () => {
    const D = await import("@/server/booking-drafts");
    const c = await client({ sms: true });
    const token = `tok-${crypto.randomUUID()}`;
    const t0 = new Date(NOW.getTime() - 3 * HOUR);
    await D.saveBookingDraft({ token, shopSlug: fx.cvSlug, serviceId: fx.cut, barberSlug: "any" }, null, t0);
    let [d] = await m.db.db.select().from(s().bookingDrafts).where(eq(s().bookingDrafts.token, token));
    expect(d).toMatchObject({ shopId: fx.cv, serviceId: fx.cut, staffId: null, customerId: null });
    await D.saveBookingDraft({ token, shopSlug: fx.cvSlug, serviceId: fx.cut, barberSlug: "any", phone: `(${c.phone!.slice(2, 5)}) ${c.phone!.slice(5, 8)}-${c.phone!.slice(8)}` }, null, t0);
    [d] = await m.db.db.select().from(s().bookingDrafts).where(eq(s().bookingDrafts.token, token));
    expect(d.customerId).toBe(c.id);
    await D.saveBookingDraft({ token, shopSlug: fx.cvSlug, serviceId: fx.cut, barberSlug: "any", phone: "(000) 000-0000" }, null, t0);
    [d] = await m.db.db.select().from(s().bookingDrafts).where(eq(s().bookingDrafts.token, token));
    expect(d.customerId).toBe(c.id);
    await expect(D.saveBookingDraft({ token: "short", shopSlug: fx.cvSlug }, null)).rejects.toThrow();

    const appt = await visit(c.id, new Date(NOW.getTime() + 2 * DAY), { status: "booked", createdAt: NOW });
    await D.finishBookingDraft(token, appt.code);
    [d] = await m.db.db.select().from(s().bookingDrafts).where(eq(s().bookingDrafts.token, token));
    expect(d.appointmentId).toBe(appt.id);
    await D.saveBookingDraft({ token, shopSlug: fx.cvSlug, serviceId: null }, null);
    [d] = await m.db.db.select().from(s().bookingDrafts).where(eq(s().bookingDrafts.token, token));
    expect(d.serviceId).toBe(fx.cut);
  });

  it("announces a new location to clients of nearby locations and a new barber to the location's clients", async () => {
    await consent(true);
    const shops = await m.db.db.query.shops.findMany();
    const [utica, kimberly, dubuque] = ["utica", "kimberly", "dubuque"].map((x) => shops.find((y) => y.slug === x)!);
    await turnOn("announcement", utica.id);
    await m.db.db.update(s().shops).set({ wentLiveAt: new Date(NOW.getTime() - 3 * DAY) }).where(eq(s().shops.id, utica.id));
    const near = await client({ sms: true, home: kimberly.id });
    const far = await client({ sms: true, home: dubuque.id });
    await E.runTriggers(NOW, { shopIds: [utica.id], keys: ["announcement"] });
    expect((await sendsFor(near.id)).map((x) => x.dedupeKey)).toEqual([expect.stringContaining(`announce:shop:${utica.id}`)]);
    expect(await sendsFor(far.id)).toHaveLength(0);
    await m.db.db.update(s().shops).set({ wentLiveAt: null }).where(eq(s().shops.id, utica.id));

    await turnOn("announcement");
    const before = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.id, fx.barber) }))!.createdAt;
    await m.db.db.update(s().staff).set({ createdAt: new Date(NOW.getTime() - 2 * DAY) }).where(eq(s().staff.id, fx.barber));
    await m.db.db.update(s().staffShops).set({ visibleOnline: true }).where(and(eq(s().staffShops.staffId, fx.barber), eq(s().staffShops.shopId, fx.cv)));
    const mine = await client({ sms: true });
    await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["announcement"] });
    const [a] = await sendsFor(mine.id);
    expect(a.dedupeKey).toContain(`announce:staff:${fx.barber}`);
    expect(a.staffId).toBe(fx.barber);
    await m.db.db.update(s().staff).set({ createdAt: before }).where(eq(s().staff.id, fx.barber));
  });

  it("fill slow days: a barber's regulars, the afternoon before a quiet day, with a coupon", async () => {
    await consent(true);
    const p = await promo({ codeMode: "unique", code: `FILL${++seq}`, validDays: 2, value: 500 });
    const fill = await turnOn("fill_slow_day", fx.cv, { utilizationPct: 95, maxPerBarber: 50 });
    await m.db.db.update(s().marketingCampaigns).set({ promoId: p.id, templates: { ...TRIGGERS.fill_slow_day.templates } }).where(eq(s().marketingCampaigns.id, fill.id));
    const reg = await client({ sms: true });
    for (const d of [60, 30]) await visit(reg.id, new Date(NOW.getTime() - d * DAY), { staff: fx.michelle });
    const once = await client({ sms: true });
    await visit(once.id, new Date(NOW.getTime() - 20 * DAY), { staff: fx.michelle });
    await run("fill_slow_day", at("2028-02-16", "10:00"));
    expect(await sendsFor(reg.id)).toHaveLength(0);
    await run("fill_slow_day", at("2028-02-16", "13:00"));
    const [send] = await sendsFor(reg.id);
    expect(send.dedupeKey).toContain(`fill:2028-02-17:${fx.michelle}`);
    expect((await job(send.jobId)).body).toMatch(new RegExp(`${p.code}-`));
    expect(await sendsFor(once.id)).toHaveLength(0);
    await m.db.db.update(s().marketingCampaigns).set({ promoId: null, templates: fill.templates }).where(eq(s().marketingCampaigns.id, fill.id));
  });
});

describe("blasts, location scope and the preview", () => {
  it("the segment builder picks clients; the preview shows counts and first names, never contacts", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const tag = `vip${++seq}`;
    const a = await client({ sms: true, first: "Avery" });
    const b = await client({ email: true, first: "Blake" });
    const z = await client({ first: "Zed" });
    for (const x of [a, b, z]) {
      await m.db.db.insert(s().customerTags).values({ customerId: x.id, tag });
      for (const d of [50, 20]) await visit(x.id, new Date(NOW.getTime() - d * DAY));
    }
    const few = await client({ sms: true });
    await m.db.db.insert(s().customerTags).values({ customerId: few.id, tag });
    const input = { channels: ["sms", "email"], segment: { tags: [tag], minVisits: 2 }, shopIds: [fx.cv] };
    const p = await CP.previewBlast(ctx, input, NOW);
    expect(p).toMatchObject({ matched: 3, byChannel: { sms: 1, email: 1, push: 0 }, unreachable: 1 });
    expect(p.sample.sort()).toEqual(["Avery", "Blake", "Zed"]);
    expect(JSON.stringify(p)).not.toMatch(/@example\.com|\+1319/);
    const smsOnly = await CP.previewBlast(ctx, { ...input, segment: { ...input.segment, channel: "sms" } }, NOW);
    expect(smsOnly.byChannel).toEqual({ sms: 1, email: 0, push: 0 });

    const id = await CP.saveBlast(ctx, { name: "VIP night", templates: { sms: "{shop}: VIP night, {first_name}! {book_link} Reply STOP to opt out.", emailSubject: "VIP night", emailBody: "Hi {first_name}, come by. {book_link}" }, ...input });
    await CP.scheduleBlast(ctx, id, new Date(NOW.getTime() + DAY), NOW);
    expect((await E.runBlasts(NOW, { ids: [id] })).queued).toBe(0);
    const r = await E.runBlasts(new Date(NOW.getTime() + DAY + 60_000), { ids: [id] });
    expect(r).toMatchObject({ queued: 2, skipped: 1 });
    expect((await m.db.db.query.marketingCampaigns.findFirst({ where: eq(s().marketingCampaigns.id, id) }))!.status).toBe("sent");
    expect((await sendsFor(z.id))[0]).toMatchObject({ status: "skipped", skipped: "no_consent" });
    expect(await sendsFor(few.id)).toHaveLength(0);
  });

  it("a location manager sends only to their own locations and switches automations on only there", async () => {
    await signInAs(fx.michelle);
    const ctx = await ctxOf();
    const base = { name: "Coralville only", channels: ["sms"], templates: { sms: "{shop}: hi {first_name}. Reply STOP to opt out." }, segment: {} };
    await expect(CP.saveBlast(ctx, { ...base, shopIds: [fx.other] })).rejects.toThrow();
    const id = await CP.saveBlast(ctx, { ...base, shopIds: [] });
    expect((await m.db.db.query.marketingCampaigns.findFirst({ where: eq(s().marketingCampaigns.id, id) }))!.shopIds).toEqual(ctx.shopIds);
    const birthday = await campaign("birthday");
    await CP.setLocationAutomation(ctx, { campaignId: birthday.id, shopId: fx.cv, enabled: true, templates: { sms: "{shop}: happy birthday {first_name}! Reply STOP to opt out." } });
    await expect(CP.setLocationAutomation(ctx, { campaignId: birthday.id, shopId: fx.other, enabled: true })).rejects.toThrow();
    await expect(CP.setLocationAutomation(ctx, { campaignId: birthday.id, shopId: fx.cv, enabled: true, templates: { sms: "no opt-out line" } })).rejects.toThrow(/STOP/);
    await expect(CP.saveAutomation(ctx, birthday.id, { name: "x", channels: ["sms"], templates: { sms: "Reply STOP" } })).rejects.toThrow();
  });

  it("create writes and drafts, send switches and sends; neither alone does the other's job", async () => {
    await signInAs(fx.michelle);
    const full = await ctxOf();
    expect([...full.permissions].filter((p) => p.startsWith("campaign_center.")).sort()).toEqual(["campaign_center.create", "campaign_center.openings", "campaign_center.own_clients", "campaign_center.send", "campaign_center.view"]);
    const without = (p: string) => ({ ...full, permissions: new Set([...full.permissions].filter((x) => x !== p)) });
    const writer = without("campaign_center.send");
    const sender = without("campaign_center.create");
    const viewer = { ...full, permissions: new Set([...full.permissions].filter((x) => !x.startsWith("campaign_center.") || x === "campaign_center.view")) };
    const sms = "{shop}: hi {first_name}. Reply STOP to opt out.";
    const lapsed = await campaign("lapsed");
    await CP.setLocationAutomation(full, { campaignId: lapsed.id, shopId: fx.cv, enabled: false });

    await expect(CP.setLocationAutomation(writer, { campaignId: lapsed.id, shopId: fx.cv, enabled: true })).rejects.toThrow(/send/);
    await CP.setLocationAutomation(writer, { campaignId: lapsed.id, shopId: fx.cv, enabled: false, templates: { sms } });
    await expect(CP.setLocationAutomation(sender, { campaignId: lapsed.id, shopId: fx.cv, enabled: false, templates: null })).rejects.toThrow(/create/);
    await CP.setLocationAutomation(sender, { campaignId: lapsed.id, shopId: fx.cv, enabled: true, templates: { sms } });
    const [row] = await m.db.db.select().from(s().marketingLocationSettings).where(and(eq(s().marketingLocationSettings.campaignId, lapsed.id), eq(s().marketingLocationSettings.shopId, fx.cv)));
    expect(row).toMatchObject({ enabled: true, templates: { sms } });
    await CP.setLocationAutomation(full, { campaignId: lapsed.id, shopId: fx.cv, enabled: false });

    const base = { name: "Split duties", channels: ["sms"], templates: { sms }, segment: {}, shopIds: [fx.cv] };
    await expect(CP.saveBlast(sender, base)).rejects.toThrow(/create/);
    const id = await CP.saveBlast(writer, base);
    await expect(CP.scheduleBlast(writer, id, new Date(NOW.getTime() + DAY), NOW)).rejects.toThrow(/send/);
    await CP.scheduleBlast(sender, id, new Date(NOW.getTime() + DAY), NOW);
    await expect(CP.cancelBlast(writer, id)).rejects.toThrow(/send/);
    await CP.cancelBlast(sender, id);
    const draft = await CP.saveBlast(writer, { ...base, name: "Draft only" });
    await expect(CP.cancelBlast(sender, draft)).rejects.toThrow(/create/);
    await CP.cancelBlast(writer, draft);

    expect((await CP.listBlasts(viewer)).find((b) => b.id === id)).toBeTruthy();
    await expect(CP.previewBlast(viewer, { channels: ["sms"], segment: {}, shopIds: [fx.cv] }, NOW)).rejects.toThrow();
    await expect(CP.sendTest(viewer, { campaignId: lapsed.id, shopId: fx.cv, channel: "sms" })).rejects.toThrow();
    await expect(CP.setLocationAutomation(viewer, { campaignId: lapsed.id, shopId: fx.cv, enabled: true })).rejects.toThrow();
  });

  it("only brand-wide create changes the brand's version and the settings", async () => {
    const A = await import("@/app/admin/campaign-center/actions");
    const birthday = await campaign("birthday");
    const input = { name: birthday.name, channels: ["sms"], templates: { sms: "{shop}: happy birthday {first_name}! Reply STOP to opt out." } };
    await signInAs(fx.michelle);
    const local = await ctxOf();
    expect(local.brandWide).toBe(false);
    expect(local.permissions.has("campaign_center.create")).toBe(true);
    await expect(CP.saveAutomation(local, birthday.id, input)).rejects.toThrow(/brand/);
    expect(await A.saveMarketingSettingsAction({})).toMatchObject({ ok: false, error: expect.stringMatching(/brand/) });
    await signInAs(fx.owner);
    await CP.saveAutomation(await ctxOf(), birthday.id, { ...input, templates: birthday.templates, channels: birthday.channels, name: birthday.name });
  });

  it("a filter on a detail the person can't see is refused", async () => {
    await signInAs(fx.michelle);
    const ctx = await ctxOf();
    const policy = await (await import("@/server/client-privacy")).clientPolicy(ctx);
    const seg = { segment: { birthdayMonths: [2] }, shopIds: [fx.cv], channels: ["sms"] };
    if (policy.level("birthday") === "hidden") await expect(CP.previewBlast(ctx, seg, NOW)).rejects.toThrow(/birthday/);
    else expect((await CP.previewBlast(ctx, seg, NOW)).matched).toBeGreaterThanOrEqual(0);
  });

  it("tags set on the client page are what the segment's tag filter matches", async () => {
    const A = await import("@/app/admin/customers/actions");
    await signInAs(fx.owner);
    const c = await client({ sms: true });
    const tag = `Student${++seq}`;
    expect(await A.setClientTagsAction(c.id, [tag, ` ${tag} `, "Regular"])).toEqual({ ok: true, data: null });
    const rows = await m.db.db.select().from(s().customerTags).where(eq(s().customerTags.customerId, c.id));
    expect(rows.map((r) => r.tag).sort()).toEqual(["Regular", tag].sort());
    const p = await CP.previewBlast(await ctxOf(), { channels: ["sms"], segment: { tags: [tag] }, shopIds: [fx.cv] }, NOW);
    expect(p.matched).toBe(1);
    expect(await A.setClientTagsAction(c.id, [])).toMatchObject({ ok: true });
    expect(await m.db.db.select().from(s().customerTags).where(eq(s().customerTags.customerId, c.id))).toHaveLength(0);
  });
});

describe("marketing report and export", () => {
  it("credits bookings, revenue and redemptions to the last message before them, by campaign, location and barber", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const p = await promo({ code: `SPRING${++seq}`, value: 500 });
    const c = await client({ sms: true });
    const tag = `rep${seq}`;
    await m.db.db.insert(s().customerTags).values({ customerId: c.id, tag });
    const sentAt = at("2028-02-21", "11:00");
    const id = await CP.saveBlast(ctx, { name: "Spring", channels: ["sms"], templates: { sms: "{shop}: {coupon_code} for $5 off. {book_link} Reply STOP to opt out." }, segment: { tags: [tag] }, promoId: p.id, shopIds: [fx.cv] });
    await CP.scheduleBlast(ctx, id, null, sentAt);
    const [send] = await sendsFor(c.id);
    await clickRoute(new Request(`http://x/m/${send.token}`, { headers: { "user-agent": IPHONE } }), { params: Promise.resolve({ token: send.token }) });
    const appt = await visit(c.id, at("2028-02-23", "10:00"), { status: "booked", createdAt: new Date(sentAt.getTime() + HOUR) });
    const sale = await m.checkout.openSaleForAppointment(appt.id, actor);
    const paid = await pay({ customerId: c.id, codes: [p.code], saleId: sale.id, now: at("2028-02-23", "10:40") });
    expect((await redemptions(paid.id))[0].campaignId).toBe(id);

    const scope = await S.resolveScope(ctx, { from: "2028-02-21", to: "2028-02-21", shop: fx.cv }, "campaign_center");
    const data = await L.REPORT_LOADERS.campaign_center({ scope, loc: scope.loc, viewer: ctx, params: {} });
    const t = data.tables.find((x) => x.id === "campaigns")!;
    const row = t.rows.find((r) => r[0] === "Spring (blast)")!;
    const col = (label: string) => row[t.columns.findIndex((x) => x.label === label)];
    expect(col("Sends")).toBe(1);
    expect(col("Clicks")).toBe(1);
    expect(col("Bookings")).toBe(1);
    expect(col("Redemptions")).toBe(1);
    expect(col("Attributed revenue")).toBe(paid.serviceNetCents + paid.productNetCents);
    expect(Number(col("Cost"))).toBeCloseTo(501, 5);
    expect(data.tables.map((x) => x.id)).toEqual(["campaigns", "locations", "barbers"]);
  });

  it("only people with the export permission get contact lists, and each export is audited", async () => {
    await consent(true);
    await signInAs(fx.michelle);
    expect((await exportRoute(new Request("http://x/admin/campaign-center/export"))).status).toBe(403);
    await signInAs(fx.owner);
    const c = await client({ sms: true, first: "Exportable" });
    const r = await exportRoute(new Request("http://x/admin/campaign-center/export"));
    expect(r.status).toBe(200);
    const csv = await r.text();
    expect(csv.split("\n")[0]).toMatch(/First name,Last name,Phone,Email,Marketing texts/);
    expect(csv).toContain("Exportable");
    const [a] = await m.db.db
      .select()
      .from(s().auditLog)
      .where(eq(s().auditLog.action, "campaign_center.export"))
      .orderBy(m.drizzle.desc(s().auditLog.at))
      .limit(1);
    expect((a.details as { customerIds: string[] }).customerIds).toContain(c.id);
  });

  it("a test send goes to the person's own email and isn't counted", async () => {
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const lapsed = await campaign("lapsed");
    const r = await CP.sendTest(ctx, { campaignId: lapsed.id, shopId: fx.cv, channel: "email" });
    expect(r.to).toBe("owner@rayz.test");
    const [t] = await m.db.db.select().from(s().marketingSends).where(and(eq(s().marketingSends.campaignId, lapsed.id), eq(s().marketingSends.status, "test")));
    expect(t.customerId).toBeNull();
    expect((await job(t.jobId)).subject).toMatch(/^\[Test\]/);
  });
});

describe("lapsed clients: weeks, barbers and sequences", () => {
  let SQ: typeof import("@/server/marketing/sequences");
  let MY: typeof import("@/server/marketing/my-clients");
  let AU: typeof import("@/server/marketing/audiences");
  const ago = (d: number, from = NOW) => new Date(from.getTime() - d * DAY);
  const barber = { first: "", slug: "", label: "" };
  const onlineAtCv = (on: boolean) => m.db.db.update(s().staffShops).set({ visibleOnline: on }).where(and(eq(s().staffShops.staffId, fx.barber), eq(s().staffShops.shopId, fx.cv)));
  beforeAll(async () => {
    SQ = await import("@/server/marketing/sequences");
    MY = await import("@/server/marketing/my-clients");
    AU = await import("@/server/marketing/audiences");
    const [b] = await m.db.db.select().from(s().staff).where(eq(s().staff.id, fx.barber));
    Object.assign(barber, { first: b.firstName, slug: b.publicSlug, label: b.displayLabel });
    await onlineAtCv(true);
  });
  const steps = (promos: (string | null)[] = []) => DEFAULT_LAPSED_STEPS.map((x, i) => ({ afterDays: x.afterDays, templates: x.templates, promoId: promos[i] ?? null }));
  const sequence = (o: Record<string, unknown> = {}) => ({
    name: `Lapsed ${++seq}`,
    channels: ["sms"],
    shopIds: [fx.cv],
    audience: { staffIds: [fx.barber], barberMatch: "primary" },
    settings: { stopAfterDays: 120 },
    ...o,
  });

  it("the segment builder: last visit by weeks or a range, the client's primary, most recent or any barber, nothing booked since", async () => {
    expect(fx.barber).not.toBe(fx.michelle);
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const tag = `lapsed${++seq}`;
    const [B, M] = [fx.barber, fx.michelle];
    const mk = async (first: string, o: ClientOpts, visits: [number, string][], booking?: "booked" | "cancelled") => {
      const c = await client({ sms: true, first, ...o });
      await m.db.db.insert(s().customerTags).values({ customerId: c.id, tag });
      for (const [d, staffId] of visits) await visit(c.id, ago(d), { staff: staffId });
      if (booking) await visit(c.id, new Date(NOW.getTime() + 3 * DAY), { staff: B, status: booking, createdAt: ago(1) });
      return c;
    };
    await mk("Prefers", { preferred: B }, [[150, M]]);
    await mk("Recent", {}, [[200, M], [150, B]]);
    await mk("Once", {}, [[200, B], [150, M]]);
    await mk("Booked", {}, [[150, B]], "booked");
    await mk("Cancelled", {}, [[150, B]], "cancelled");
    await mk("NoText", { sms: false }, [[150, B]]);
    await mk("Lately", {}, [[130, B]]);
    const preview = async (segment: Record<string, unknown>) => {
      const p = await CP.previewBlast(ctx, { channels: ["sms"], shopIds: [fx.cv], segment: { tags: [tag], staffIds: [B], ...segment } }, NOW);
      expect(JSON.stringify(p)).not.toMatch(/@example\.com|\+1319/);
      return { matched: p.matched, optedIn: p.optedIn, names: p.sample.sort() };
    };
    const over20 = lapsedOver(20);
    expect(await preview({ ...over20, barberMatch: "primary" })).toEqual({ matched: 4, optedIn: 3, names: ["Cancelled", "NoText", "Prefers", "Recent"] });
    expect((await preview({ ...over20, notBooked: false, barberMatch: "primary" })).matched).toBe(5);
    expect(await preview({ ...over20, barberMatch: "recent" })).toMatchObject({ matched: 3, names: ["Cancelled", "NoText", "Recent"] });
    expect(await preview({ ...over20, barberMatch: "any" })).toMatchObject({ matched: 4, names: ["Cancelled", "NoText", "Once", "Recent"] });
    expect(await preview({ ...lapsedBetween(126, 133), barberMatch: "any" })).toMatchObject({ matched: 1, names: ["Lately"] });
  });

  it("a lapsed sequence sends each client the step for how long it's been, once per lapse, signed by their barber, and stops when they book", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const B = fx.barber;
    const small = await promo({ codeMode: "unique", code: `BACK${++seq}`, validDays: 14, value: 500 });
    const big = await promo({ codeMode: "unique", code: `MISS${++seq}`, validDays: 14, value: 1000 });
    await expect(SQ.saveSequence(ctx, sequence({ steps: steps() }))).rejects.toThrow(/Step 3 \(4 weeks\): .*pick a coupon/i);
    await expect(SQ.saveSequence(ctx, sequence({ steps: [steps()[0], { ...steps()[1], afterDays: 18 }] }))).rejects.toThrow(/at least a week/);
    const id = await SQ.saveSequence(ctx, sequence({ steps: steps([null, null, small.id, big.id]) }));
    const st = await E.stepsOf(id);
    expect(st.map((x) => x.afterDays)).toEqual([14, 21, 28, 42]);
    const stepOf = (stepId: string | null) => st.find((x) => x.id === stepId)?.afterDays;

    const at = async (d: number, o: ClientOpts = {}) => {
      const c = await client({ sms: true, preferred: B, ...o });
      await visit(c.id, ago(d), { staff: B });
      return c;
    };
    const [c15, c22, c30, c50, c200] = [await at(15), await at(22), await at(30), await at(50), await at(200)];
    const booked = await at(30);
    await visit(booked.id, new Date(NOW.getTime() + 2 * DAY), { staff: B, status: "booked", createdAt: ago(2) });
    const michelles = await at(30, { preferred: fx.michelle });
    const mine = async (c: { id: string }) => (await sendsFor(c.id)).filter((x) => x.campaignId === id);

    const input = { id, ...sequence(), steps: st.map((x) => ({ id: x.id, afterDays: x.afterDays })) };
    const pv = await SQ.previewSequence(ctx, input, NOW);
    expect(pv.steps.map((x) => [x.label, x.matched, x.optedIn, x.due])).toEqual([
      ["2 weeks", 1, 1, 1],
      ["3 weeks", 1, 1, 1],
      ["4 weeks", 1, 1, 1],
      ["6 weeks+", 1, 1, 1],
    ]);
    expect(JSON.stringify(pv)).not.toMatch(/@example\.com|\+1319/);

    expect((await E.runSequences(NOW, { ids: [id] })).queued).toBe(0);
    await SQ.setSequenceEnabled(ctx, id, true);
    expect((await E.runSequences(NOW, { ids: [id] })).queued).toBe(4);
    for (const [c, d] of [[c15, 14], [c22, 21], [c30, 28], [c50, 42]] as const) {
      const [x] = await mine(c);
      expect(stepOf(x.stepId), String(d)).toBe(d);
      expect(x.staffId).toBe(B);
      expect(x.bookPath).toContain(`barber=${barber.slug}`);
      expect((await job(x.jobId)).body).toContain(barber.first);
    }
    const body = async (c: { id: string }) => (await job((await mine(c))[0].jobId)).body;
    expect(await body(c15)).not.toContain(small.code);
    expect(await body(c30)).toContain(`${small.code}-`);
    expect(await body(c50)).toContain(`${big.code}-`);
    for (const c of [c200, booked, michelles]) expect(await mine(c)).toHaveLength(0);
    expect((await E.runSequences(NOW, { ids: [id] })).queued).toBe(0);
    expect((await SQ.previewSequence(ctx, input, NOW)).due).toBe(0);

    const lapsed = await turnOn("lapsed");
    const ctl = await client({ sms: true });
    await visit(ctl.id, ago(50));
    await E.runTriggers(new Date(NOW.getTime() + HOUR), { shopIds: [fx.cv], keys: ["lapsed"] });
    expect((await sendsFor(c50.id)).filter((x) => x.campaignId === lapsed.id)).toHaveLength(0);
    expect((await sendsFor(ctl.id)).map((x) => x.campaignId)).toEqual([lapsed.id]);

    const t1 = new Date(NOW.getTime() + 8 * DAY);
    expect((await E.runSequences(t1, { ids: [id] })).queued).toBe(2);
    expect((await mine(c15)).map((x) => stepOf(x.stepId)).sort()).toEqual([14, 21]);
    expect((await mine(c22)).map((x) => stepOf(x.stepId)).sort()).toEqual([21, 28]);

    const next = await visit(c15.id, new Date(NOW.getTime() + 20 * DAY), { staff: B, status: "booked", createdAt: new Date(t1.getTime() + HOUR) });
    const t2 = new Date(NOW.getTime() + 16 * DAY);
    await E.runSequences(t2, { ids: [id] });
    expect(await mine(c15)).toHaveLength(2);
    await m.db.db.update(s().appointments).set({ status: "cancelled", cancelledAt: t2 }).where(eq(s().appointments.id, next.id));
    await E.runSequences(t2, { ids: [id] });
    expect((await mine(c15)).map((x) => stepOf(x.stepId)).sort()).toEqual([14, 21, 28]);

    const v = (await SQ.listSequences(ctx, t2)).find((x) => x.id === id)!;
    expect(v).toMatchObject({ enabled: true, mayEdit: true, audience: { staffIds: [B], barberMatch: "primary" }, settings: { stopAfterDays: 120 } });
    expect(v.steps.map((x) => x.label)).toEqual(["2 weeks", "3 weeks", "4 weeks", "6 weeks+"]);
    expect(v.sent30).toBeGreaterThanOrEqual(7);
    await SQ.setSequenceEnabled(ctx, id, false);
    await SQ.deleteSequence(ctx, id);
    expect((await SQ.listSequences(ctx)).some((x) => x.id === id)).toBe(false);
  });

  it("signed by the client's barber with a link to book with them, or by 'your barber' when they can't be booked online", async () => {
    const B = fx.barber;
    expect(AU.signedBy((await AU.barberCards([B])).get(B), fx.cv)).toEqual({ values: { barber: barber.first }, link: { barber: barber.slug } });
    expect(AU.signedBy(undefined, fx.cv)).toEqual({ values: { barber: "your barber" } });
    await onlineAtCv(false);
    try {
      expect(AU.signedBy((await AU.barberCards([B])).get(B), fx.cv)).toEqual({ values: { barber: barber.first }, link: undefined });
    } finally {
      await onlineAtCv(true);
    }
  });

  it("create writes sequences and send switches them; a location manager only for their own locations", async () => {
    await signInAs(fx.michelle);
    const full = await ctxOf();
    const without = (p: string) => ({ ...full, permissions: new Set([...full.permissions].filter((x) => x !== p)) });
    const writer = without("campaign_center.send");
    const sender = without("campaign_center.create");
    const base = sequence({ audience: { staffIds: [] }, steps: steps().slice(0, 2) });
    await expect(SQ.saveSequence(full, { ...base, shopIds: [fx.other] })).rejects.toThrow();
    await expect(SQ.saveSequence(sender, base)).rejects.toThrow(/create/);
    const id = await SQ.saveSequence(writer, base);
    expect(await m.db.db.query.marketingCampaigns.findFirst({ where: eq(s().marketingCampaigns.id, id) })).toMatchObject({ kind: "sequence", enabled: false, shopIds: [fx.cv] });
    await expect(SQ.setSequenceEnabled(writer, id, true)).rejects.toThrow(/send/);
    await SQ.setSequenceEnabled(sender, id, true);
    await expect(SQ.deleteSequence(writer, id)).rejects.toThrow(/Turn it off/);
    await expect(SQ.deleteSequence(sender, id)).rejects.toThrow(/create/);
    await SQ.setSequenceEnabled(sender, id, false);
    await SQ.deleteSequence(writer, id);
    await expect(SQ.setSequenceEnabled(sender, id, true)).rejects.toThrow(/deleted/);
  });

  it("a barber allowed to sees their own lapsed clients without contact details and sends them the barber's message", async () => {
    await consent(true);
    const B = fx.barber;
    const [person] = await m.db.db.select().from(s().staff).where(eq(s().staff.id, B));
    const outreach = await campaign("barber_outreach");
    try {
      await signInAs(B);
      const plain = await ctxOf();
      expect(plain.permissions.has("campaign_center.own_clients")).toBe(false);
      await expect(MY.myLapsedClients(plain, NOW)).rejects.toThrow(/own lapsed clients/);
      await m.db.db
        .update(s().staff)
        .set({ permissionOverrides: { ...(person.permissionOverrides ?? {}), "campaign_center.own_clients": true } })
        .where(eq(s().staff.id, B));
      const ctx = await ctxOf();
      const mk = async (first: string, d: number, o: ClientOpts = {}) => {
        const c = await client({ sms: true, first, last: "Ortiz", preferred: B, ...o });
        await visit(c.id, ago(d), { staff: o.preferred ?? B });
        return c;
      };
      const mine = await mk("Jamal", 20);
      const quiet = await mk("Quinn", 25, { sms: false });
      const again = await mk("Remy", 30);
      const theirs = await mk("Theo", 20, { preferred: fx.michelle });

      let list = await MY.myLapsedClients(ctx, NOW);
      const row = (id: string) => list.clients.find((x) => x.customerId === id);
      expect(list.shops.find((x) => x.id === fx.cv)?.on).toBe(false);
      expect(row(mine.id)).toMatchObject({ name: "Jamal O.", sinceDays: 20, bucket: "2–3 wks", channel: "sms", sentAt: null, blocked: expect.stringMatching(/switched on/) });
      expect(row(theirs.id)).toBeUndefined();
      expect(JSON.stringify(list)).not.toMatch(/@example\.com|\+1319|Ortiz/);
      await expect(MY.sendToMyClients(ctx, [mine.id], NOW)).rejects.toThrow(/switched on/);

      await turnOn("barber_outreach");
      expect((await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["barber_outreach"] })).queued).toBe(0);
      list = await MY.myLapsedClients(ctx, NOW);
      expect(row(mine.id)?.blocked).toBeNull();
      expect(row(quiet.id)).toMatchObject({ channel: null, blocked: SKIP_LABEL.no_consent });
      await expect(MY.sendToMyClients(ctx, [mine.id, theirs.id], NOW)).rejects.toThrow(/own lapsed clients/);
      await expect(MY.sendToMyClients(ctx, [quiet.id], NOW)).rejects.toThrow(/agreed/);
      expect(await sendsFor(mine.id)).toHaveLength(0);

      expect(await MY.sendToMyClients(ctx, [mine.id], NOW)).toEqual({ queued: 1, skipped: [] });
      const [send] = (await sendsFor(mine.id)).filter((x) => x.campaignId === outreach.id);
      expect(send).toMatchObject({ staffId: B, status: "queued" });
      expect(send.bookPath).toContain(`barber=${barber.slug}`);
      expect((await job(send.jobId)).body).toContain(`it's ${barber.first}`);
      list = await MY.myLapsedClients(ctx, NOW);
      expect(row(mine.id)?.blocked).toMatch(/already sent/);
      expect(list.sentToday).toBe(1);

      await m.db.db.update(s().marketingCampaigns).set({ settings: { maxPerDay: 1 } }).where(eq(s().marketingCampaigns.id, outreach.id));
      await expect(MY.sendToMyClients(ctx, [again.id], NOW)).rejects.toThrow(/today's limit of 1/);
      const [a] = await m.db.db
        .select()
        .from(s().auditLog)
        .where(eq(s().auditLog.action, "campaign_center.own_clients_sent"))
        .orderBy(m.drizzle.desc(s().auditLog.at))
        .limit(1);
      expect(a.details).toMatchObject({ picked: 1, queued: 1 });
    } finally {
      await m.db.db.update(s().staff).set({ permissionOverrides: person.permissionOverrides }).where(eq(s().staff.id, B));
      await m.db.db.update(s().marketingCampaigns).set({ settings: outreach.settings }).where(eq(s().marketingCampaigns.id, outreach.id));
    }
  });

  it("the report: each barber's lapsed clients by weeks since the last visit, lapsed messages and the rebook rate", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const LR = await import("@/server/marketing/lapsed-report");
    const B = fx.barber;
    const later = new Date(NOW.getTime() + 400 * DAY);
    const at = async (d: number) => {
      const c = await client({ sms: true, preferred: B });
      await visit(c.id, ago(d, later), { staff: B });
      return c;
    };
    const [a] = [await at(16), await at(30), await at(50)];
    const booked = await at(30);
    await visit(booked.id, new Date(later.getTime() + 2 * DAY), { staff: B, status: "booked", createdAt: ago(1, later) });
    const p = await promo({ codeMode: "unique", code: `REP${++seq}`, validDays: 14 });
    const all = steps([null, null, p.id, p.id]);
    const name = `Report sequence ${++seq}`;
    const id = await SQ.saveSequence(ctx, sequence({ name, steps: [all[0], all[2], all[3]] }));
    await SQ.setSequenceEnabled(ctx, id, true);
    expect((await E.runSequences(later, { ids: [id] })).queued).toBe(3);
    await visit(a.id, new Date(later.getTime() + 5 * DAY), { staff: B, status: "booked", createdAt: new Date(later.getTime() + DAY) });

    const day = m.time.todayLocal(later);
    const scope = await S.resolveScope(ctx, { from: day, to: day, shop: fx.cv }, "lapsed_clients");
    const data = await LR.lapsedReportData(scope, scope.loc, later);
    const t = data.tables.find((x) => x.id === "barbers")!;
    const row = t.rows.find((r) => r[0] === barber.label)!;
    const col = (label: string) => row[t.columns.findIndex((x) => x.label === label)];
    expect(LAPSED_BUCKETS.map((x) => col(x.label))).toEqual([1, 0, 1, 0, 1, 0, 0]);
    expect(["Lapsed", "Lapsed messages", "Clients messaged", "Rebooked"].map(col)).toEqual([3, 3, 3, 1]);
    expect(Number(col("Rebook rate"))).toBeCloseTo(1 / 3, 5);
    const steps30 = data.tables.find((x) => x.id === "campaigns")!;
    expect(steps30.rows.map((r) => r[0]).sort()).toEqual([`${name} · 2 weeks`, `${name} · 4 weeks`, `${name} · 6 weeks+`, "Total"]);
    expect(data.stats.find((x) => x.label === "Rebook rate")?.value).toBe("33%");
    await SQ.setSequenceEnabled(ctx, id, false);
  });

  it("brand admins have the lapsed list and the report; managers and barbers only when the brand allows it", async () => {
    const roles = await m.db.db.select().from(s().roles);
    const perms = (k: string) => roles.find((r) => r.key === k)?.permissions ?? [];
    expect(perms("brand_admin")).toEqual(expect.arrayContaining(["campaign_center.own_clients", "report.lapsed_clients.view", "report.lapsed_clients.export"]));
    for (const k of ["shop_manager", "regional_manager", "barber"]) for (const p of ["campaign_center.own_clients", "report.lapsed_clients.view"]) expect(perms(k), `${k} ${p}`).not.toContain(p);
  });
});

describe("renamed to the Campaign Center", () => {
  it("the migration moves roles and overrides to the new permission names, keeping what each could do", async () => {
    const { readFileSync } = await import("node:fs");
    const name = `Old marketing role ${++seq}`;
    const [role] = await m.db.db
      .insert(s().roles)
      .values({ name, permissions: ["calendar.manage", "marketing.view", "marketing.location", "marketing.manage", "report.marketing.view", "report.marketing.export"] })
      .returning();
    const [person] = await m.db.db.select().from(s().staff).where(eq(s().staff.id, fx.barber));
    await m.db.db
      .update(s().staff)
      .set({ permissionOverrides: { "marketing.export": true, "marketing.location": true, "marketing.manage": false, "sales.view": true } })
      .where(eq(s().staff.id, fx.barber));
    for (const q of readFileSync("drizzle/core_0042_campaign_center.sql", "utf8").split("--> statement-breakpoint")) await exec(sql.raw(q));
    const [after] = await m.db.db.select().from(s().roles).where(eq(s().roles.id, role.id));
    expect(after.permissions).toEqual(["calendar.manage", "campaign_center.view", "campaign_center.create", "campaign_center.send", "report.campaign_center.view", "report.campaign_center.export"]);
    const [p] = await m.db.db.select().from(s().staff).where(eq(s().staff.id, fx.barber));
    expect(p.permissionOverrides).toEqual({ "campaign_center.export": true, "campaign_center.create": false, "campaign_center.send": false, "sales.view": true });
    await m.db.db.update(s().staff).set({ permissionOverrides: person.permissionOverrides }).where(eq(s().staff.id, fx.barber));
    await m.db.db.delete(s().roles).where(eq(s().roles.id, role.id));
  });
});

describe("Campaign Center v2: A/B, holdout, repeats, opens, attribution, templates, the assistant and the calendar", () => {
  let R: typeof import("@/server/marketing/results");
  let T: typeof import("@/server/marketing/templates");
  let AI: typeof import("@/server/marketing/ai-draft");
  let CAL: typeof import("@/server/marketing/calendar");
  let pixel: typeof import("@/app/m/[token]/o.gif/route").GET;
  const SMS = "{shop}: hi {first_name}, come see us. {book_link} Reply STOP to opt out.";
  const camp = async (id: string) => (await m.db.db.query.marketingCampaigns.findFirst({ where: eq(s().marketingCampaigns.id, id) }))!;
  const sendsOf = (id: string) => m.db.db.select().from(s().marketingSends).where(eq(s().marketingSends.campaignId, id));
  async function tagged(n: number, o: ClientOpts = { sms: true }) {
    const tag = `v2-${++seq}`;
    const list = [];
    for (let i = 0; i < n; i++) {
      const c = await client(o);
      await m.db.db.insert(s().customerTags).values({ customerId: c.id, tag });
      list.push(c);
    }
    return { tag, list };
  }

  beforeAll(async () => {
    R = await import("@/server/marketing/results");
    T = await import("@/server/marketing/templates");
    AI = await import("@/server/marketing/ai-draft");
    CAL = await import("@/server/marketing/calendar");
    pixel = (await import("@/app/m/[token]/o.gif/route")).GET;
  });

  it("an A/B test sends only the test groups, then the winner on its measure to everyone else", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const { tag, list } = await tagged(40);
    const B = "{shop}: {first_name}, a fresh cut is waiting. {book_link} Reply STOP to opt out.";
    const base = { name: "A/B fresh cut", channels: ["sms"], templates: { sms: SMS }, segment: { tags: [tag] }, shopIds: [fx.cv] };
    await expect(CP.saveBlast(ctx, { ...base, ab: { testPct: 50, metric: "click", waitHours: 2, b: { sms: SMS } } })).rejects.toThrow(/different/);
    await expect(CP.saveBlast(ctx, { ...base, recurrence: { freq: "weekly" }, ab: { testPct: 50, metric: "click", waitHours: 2, b: { sms: B } } })).rejects.toThrow(/one-time/);
    const id = await CP.saveBlast(ctx, { ...base, ab: { testPct: 50, metric: "click", waitHours: 2, b: { sms: B } } });
    await CP.scheduleBlast(ctx, id, null, NOW);
    expect((await camp(id)).status).toBe("testing");
    const test = await sendsOf(id);
    expect(test.length).toBeGreaterThan(0);
    expect(test.length).toBeLessThan(40);
    expect(new Set(test.map((x) => x.variant))).toEqual(new Set(["a", "b"]));
    await expect(CP.pauseBlast(ctx, id, NOW)).rejects.toThrow(/A\/B/);
    for (const x of test.filter((x) => x.variant === "b")) await LK.openMarketingLink(x.token, IPHONE, new Date(NOW.getTime() + 30 * 60_000));

    expect((await E.runAbWinners(new Date(NOW.getTime() + HOUR), { ids: [id] })).queued).toBe(0);
    expect((await camp(id)).status).toBe("testing");
    const r = await E.runAbWinners(new Date(NOW.getTime() + 3 * HOUR), { ids: [id] });
    expect(r.queued).toBe(40 - test.length);
    const after = await camp(id);
    expect(after.status).toBe("sent");
    const ab = after.ab as { winner: string; result: { a: { n: number; hits: number }; b: { n: number; hits: number } } };
    expect(ab.winner).toBe("b");
    expect(ab.result.b.hits).toBe(test.filter((x) => x.variant === "b").length);
    expect(ab.result.a.hits).toBe(0);
    const all = await sendsOf(id);
    expect(all).toHaveLength(40);
    expect(new Set(all.map((x) => x.customerId)).size).toBe(list.length);
    const late = all.find((x) => !test.some((t) => t.id === x.id))!;
    expect(late.variant).toBe("b");
    expect((await job(late.jobId)).body).toContain("a fresh cut is waiting");
    const res = await R.campaignResults(ctx, { id, ab: after.ab });
    expect(res.byVariant.map((v) => v.key).sort()).toEqual(["a", "b"]);
  });

  it("a holdout group gets nothing and is the baseline for the campaign's lift", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const { tag } = await tagged(60);
    const id = await CP.saveBlast(ctx, { name: "Holdout test", channels: ["sms"], templates: { sms: SMS }, segment: { tags: [tag] }, shopIds: [fx.cv], holdoutPct: 50 });
    await expect(CP.saveBlast(ctx, { name: "Too many", channels: ["sms"], templates: { sms: SMS }, segment: { tags: [tag] }, shopIds: [fx.cv], holdoutPct: 80 })).rejects.toThrow(/50%/);
    const stats = await CP.scheduleBlast(ctx, id, null, NOW);
    expect(stats.held).toBeGreaterThan(0);
    expect(stats.queued + stats.held!).toBe(60);
    const rows = await sendsOf(id);
    const held = rows.filter((x) => x.status === "holdout");
    expect(held).toHaveLength(stats.held!);
    expect(held.every((x) => x.jobId === null)).toBe(true);
    const treated = rows.filter((x) => x.status === "queued");
    for (const [i, x] of treated.slice(0, Math.ceil(treated.length / 2)).entries())
      await visit(x.customerId!, new Date(at("2028-03-20", "08:00").getTime() + i * 30 * 60_000), { status: "booked", createdAt: new Date(NOW.getTime() + 2 * HOUR) });
    const res = await R.campaignResults(ctx, { id, ab: null });
    expect(res.overall.lift.holdout).toMatchObject({ n: held.length, booked: 0, rate: 0 });
    expect(res.overall.lift.treated.n).toBe(treated.length);
    expect(res.overall.lift.points!).toBeGreaterThan(0.4);
    expect(res.overall.funnel.sent).toBe(treated.length);
  });

  it("a weekly blast sends each week as its own occasion, pauses and resumes, and stops after its end date", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const { tag, list } = await tagged(1);
    const c = list[0];
    const id = await CP.saveBlast(ctx, { name: "Weekly", channels: ["sms"], templates: { sms: SMS }, segment: { tags: [tag] }, shopIds: [fx.cv], recurrence: { freq: "weekly", endsOn: "2028-02-24" } });
    await expect(CP.scheduleBlast(ctx, id, at("2028-02-25", "12:00"), NOW)).rejects.toThrow(/end date/);
    await CP.scheduleBlast(ctx, id, new Date(NOW.getTime() + HOUR), NOW);
    expect((await camp(id)).recurrence).toMatchObject({ freq: "weekly", anchor: new Date(NOW.getTime() + HOUR).toISOString() });
    expect((await E.runBlasts(new Date(NOW.getTime() + HOUR + 60_000), { ids: [id] })).queued).toBe(1);
    expect(await camp(id)).toMatchObject({ status: "scheduled", scheduledAt: at("2028-02-23", "12:00") });

    await CP.pauseBlast(ctx, id, at("2028-02-17", "09:00"));
    expect((await E.runBlasts(at("2028-02-23", "12:01"), { ids: [id] })).queued).toBe(0);
    expect((await CP.resumeBlast(ctx, id, at("2028-02-20", "09:00"))).toISOString()).toBe(at("2028-02-23", "12:00").toISOString());
    expect((await E.runBlasts(at("2028-02-23", "12:01"), { ids: [id] })).queued).toBe(1);
    expect((await camp(id)).status).toBe("sent");
    expect((await sendsFor(c.id)).map((x) => x.dedupeKey.split(":").slice(-2).join(":")).sort()).toEqual(["blast:2028-02-16", "blast:2028-02-23"]);

    const ended = await CP.saveBlast(ctx, { name: "Weekly, short", channels: ["sms"], templates: { sms: SMS }, segment: { tags: [tag] }, shopIds: [fx.cv], recurrence: { freq: "weekly", endsOn: "2028-02-16" } });
    await CP.scheduleBlast(ctx, ended, new Date(NOW.getTime() + HOUR), NOW);
    await CP.pauseBlast(ctx, ended, NOW);
    await expect(CP.resumeBlast(ctx, ended, at("2028-02-18", "09:00"))).rejects.toThrow(/end date/);
  });

  it("the email's open pixel counts real opens once in the open rate, never a mail scanner", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const { tag, list } = await tagged(1, { email: true });
    const id = await CP.saveBlast(ctx, { name: "Opens", channels: ["email"], templates: { sms: SMS, emailSubject: "New hours", emailBody: "Hi {first_name}, we're open later now. {book_link}" }, segment: { tags: [tag] }, shopIds: [fx.cv] });
    await CP.scheduleBlast(ctx, id, null, NOW);
    const [send] = await sendsFor(list[0].id);
    const j = await job(send.jobId);
    expect(j.htmlBody).toContain(`/m/${send.token}/o.gif`);
    expect(j.htmlBody).toContain("Hi Mark, we're open later now.");
    const hit = (ua: string) => pixel(new Request(`http://x/m/${send.token}/o.gif`, { headers: { "user-agent": ua } }), { params: Promise.resolve({ token: send.token }) });
    const r = await hit(IPHONE);
    expect(r.headers.get("content-type")).toBe("image/gif");
    await hit(IPHONE);
    await hit("Mimecast Email Security");
    const [after] = await sendsFor(list[0].id);
    expect(after.opens).toBe(2);
    expect(after.openedAt).not.toBeNull();
    const f = (await R.campaignFunnels([id])).get(id)!.funnel;
    expect(f).toMatchObject({ sent: 1, emailDelivered: 1, uniqueOpens: 1, uniqueClicks: 0 });
    const { ratesOf } = await import("@/domain/campaign-metrics");
    expect(ratesOf(f).openRate).toBe(1);
    expect(ratesOf(f).clickRate).toBe(0);
  });

  it("revenue leaves out clients already booked when it went; the engaged basis counts only after an open or click", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const { tag, list } = await tagged(2);
    const [booked, fresh] = list;
    await visit(booked.id, at("2028-02-19", "10:00"), { status: "booked", createdAt: new Date(NOW.getTime() - DAY) });
    const id = await CP.saveBlast(ctx, { name: "Attribution", channels: ["sms"], templates: { sms: SMS }, segment: { tags: [tag] }, shopIds: [fx.cv] });
    await CP.scheduleBlast(ctx, id, null, NOW);
    const sends = await sendsOf(id);
    expect(sends.find((x) => x.customerId === booked.id)!.alreadyBooked).toBe(true);
    expect(sends.find((x) => x.customerId === fresh.id)!.alreadyBooked).toBe(false);
    const paidA = await pay({ customerId: booked.id, now: new Date(NOW.getTime() + DAY) });
    const paidB = await pay({ customerId: fresh.id, now: new Date(NOW.getTime() + DAY) });
    expect(paidA.serviceNetCents).toBeGreaterThan(0);
    const net = paidB.serviceNetCents + paidB.productNetCents;
    const funnel = async () => (await R.campaignFunnels([id])).get(id)!.funnel;
    expect(await funnel()).toMatchObject({ sent: 2, alreadyBooked: 1, revenueCents: net });

    try {
      await m.db.db.update(s().brandSettings).set({ marketing: { address: ADDRESS, attributeOn: "engaged" } });
      expect((await funnel()).revenueCents).toBe(0);
      await LK.openMarketingLink(sends.find((x) => x.customerId === fresh.id)!.token, IPHONE, new Date(NOW.getTime() + 2 * HOUR));
      expect((await funnel()).revenueCents).toBe(net);
      expect((await R.campaignResults(ctx, { id, ab: null })).definitions.attributedSales.definition).toMatch(/open|click/i);
    } finally {
      await m.db.db.update(s().brandSettings).set({ marketing: { address: ADDRESS } });
    }
  });

  it("the wizard's coupon list has every code with its redemptions and revenue, and an expired one can't go out", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const used = await promo({ value: 300, code: `USED${++seq}` });
    const old = await promo({ value: 300, code: `OLD${++seq}`, endsOn: "2028-01-31" });
    const off = await promo({ value: 300, code: `OFF${++seq}`, active: false });
    const weekdays = await promo({ value: 300, code: `WKD${++seq}`, daysOfWeek: [2, 3], timeFrom: "10:00", timeTo: "14:00", firstVisitOnly: true });
    const c = await client();
    const sale = await pay({ customerId: c.id, codes: [used.code] });
    const usable = await CP.couponOptions("2028-02-16");
    expect(usable.find((x) => x.id === used.id)).toMatchObject({ usable: true, redemptions: 1, revenueCents: sale.serviceNetCents + sale.productNetCents });
    expect(usable.find((x) => x.id === old.id)).toBeUndefined();
    const every = await CP.couponOptions("2028-02-16", { includeUnusable: true });
    const o = every.find((x) => x.id === old.id)!;
    expect(o).toMatchObject({ usable: false, expired: true });
    expect(CP.couponUnusable(o)).toMatch(/expired on 2028-01-31/);
    expect(CP.couponUnusable(every.find((x) => x.id === off.id)!)).toMatch(/switched off/);
    expect(every.find((x) => x.id === weekdays.id)).toMatchObject({ when: expect.stringMatching(/Tue.*Wed.*10/), firstVisitOnly: true });

    const tpl = { sms: "{shop}: {coupon_code} takes $3 off. {book_link} Reply STOP to opt out." };
    const base = { name: "Coupon rules", channels: ["sms"], templates: tpl, segment: { tags: ["nobody-here"] }, shopIds: [fx.cv] };
    await expect(CP.saveBlast(ctx, { ...base, campaignType: "promotion" })).rejects.toThrow(/needs a coupon/);
    await expect(CP.saveBlast(ctx, { ...base, campaignType: "update", promoId: used.id })).rejects.toThrow(/no coupon/);
    const id = await CP.saveBlast(ctx, { ...base, promoId: old.id });
    expect((await camp(id)).campaignType).toBe("promotion");
    await expect(CP.scheduleBlast(ctx, id, null, NOW)).rejects.toThrow(/expired/);
  });

  it("the preview counts clients opted in on each channel, before anything is sent", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const tag = `oi-${++seq}`;
    for (const o of [{ sms: true, email: true }, { email: true, push: true }, {}]) {
      const c = await client(o);
      await m.db.db.insert(s().customerTags).values({ customerId: c.id, tag });
    }
    const p = await CP.previewBlast(ctx, { channels: ["sms", "email", "push"], segment: { tags: [tag] }, shopIds: [fx.cv] }, NOW);
    expect(p.optedInBy).toEqual({ sms: 1, email: 2, push: 1 });
    expect(p).toMatchObject({ matched: 3, optedIn: 2, unreachable: 1 });
  });

  it("duplicates as a draft, renames, and keeps a location manager to their own blasts", async () => {
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const id = await CP.saveBlast(ctx, { name: "Holiday hours", channels: ["sms"], templates: { sms: SMS }, segment: { tags: ["nobody-here"] }, shopIds: [], holdoutPct: 10, sendTimeOpt: true });
    await CP.scheduleBlast(ctx, id, new Date(NOW.getTime() + DAY), NOW);
    const copy = await CP.duplicateBlast(ctx, id);
    expect(await camp(copy)).toMatchObject({ name: "Copy of Holiday hours", status: "draft", holdoutPct: 10, sendTimeOpt: true, scheduledAt: null });
    await CP.renameCampaign(ctx, copy, "  New Year hours ");
    expect((await camp(copy)).name).toBe("New Year hours");
    await expect(CP.renameCampaign(ctx, copy, " ")).rejects.toThrow(/name/);
    await signInAs(fx.michelle);
    const local = await ctxOf();
    await expect(CP.renameCampaign(local, copy, "Mine now")).rejects.toThrow(/outside yours/);
    await expect(CP.duplicateBlast(local, id)).rejects.toThrow(/outside yours/);
    const own = await CP.saveBlast(local, { name: "Coralville hours", channels: ["sms"], templates: { sms: SMS }, segment: {}, shopIds: [fx.cv] });
    const ownCopy = await CP.duplicateBlast(local, own);
    expect((await camp(ownCopy)).shopIds).toEqual([fx.cv]);
  });

  it("the brand's template library: only the brand writes and approves, locations see approved ones, and an edit needs approving again", async () => {
    await signInAs(fx.owner);
    const brand = await ctxOf();
    const seeded = await T.listTemplates(brand);
    expect(seeded.filter((t) => t.status === "approved").length).toBeGreaterThanOrEqual(4);
    const id = await T.saveTemplate(brand, { name: `Snow day ${++seq}`, channels: ["sms"], templates: { sms: "{shop}: we're closed today for snow, {first_name}. {book_link} Reply STOP to opt out." } });
    await signInAs(fx.michelle);
    const local = await ctxOf();
    await expect(T.saveTemplate(local, { name: "Mine", channels: ["sms"], templates: { sms: SMS } })).rejects.toThrow(/brand/);
    await expect(T.setTemplateStatus(local, id, "approved")).rejects.toThrow(/brand/);
    expect((await T.listTemplates(local)).some((t) => t.id === id)).toBe(false);
    await expect(CP.saveBlast(local, { name: "From a draft", channels: ["sms"], templates: { sms: SMS }, segment: {}, shopIds: [fx.cv], templateId: id })).rejects.toThrow(/approved/);

    await signInAs(fx.owner);
    await T.setTemplateStatus(await ctxOf(), id, "approved", NOW);
    await signInAs(fx.michelle);
    const seen = (await T.listTemplates(await ctxOf())).find((t) => t.id === id)!;
    expect(seen).toMatchObject({ status: "approved", approvedBy: expect.any(String) });
    await CP.saveBlast(await ctxOf(), { name: "From the library", channels: ["sms"], templates: seen.templates, segment: {}, shopIds: [fx.cv], templateId: id });

    await signInAs(fx.owner);
    await T.saveTemplate(await ctxOf(), { id, name: seen.name, channels: ["sms"], templates: { sms: "{shop}: closed for snow until noon, {first_name}. {book_link} Reply STOP to opt out." } });
    const [row] = await m.db.db.select().from(s().marketingTemplates).where(eq(s().marketingTemplates.id, id));
    expect(row).toMatchObject({ status: "draft", approvedAt: null });
    await T.setTemplateStatus(await ctxOf(), id, "archived", NOW);
    expect((await T.listTemplates(await ctxOf())).some((t) => t.id === id)).toBe(false);
    expect((await T.listTemplates(await ctxOf(), { archived: true })).find((t) => t.id === id)?.status).toBe("archived");
  });

  it("the assistant drafts from the request alone, saves nothing, and its blast goes only after a person reviews it", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const secret = await client({ sms: true, first: "Quillon", last: "Varga" });
    const count = async () => (await m.db.db.select({ n: sql`count(*)::int` }).from(s().marketingCampaigns))[0].n;
    const before = await count();
    const stub = await AI.draftBlast(ctx, "Bring back clients we haven't seen in two months", { provider: null, now: NOW });
    expect(stub.drafter).toBe("keywords");
    expect(stub.templates.sms).toMatch(/STOP/);
    expect(await count()).toBe(before);
    await expect(AI.draftBlast(ctx, "hi", { provider: null })).rejects.toThrow(/more/);

    let asked = "";
    const fake = {
      id: "openai" as const,
      model: "test",
      retention: "none",
      async complete(r: import("@/server/assistant/providers").CompletionRequest) {
        asked = JSON.stringify(r);
        return {
          text: null,
          toolCalls: [
            {
              id: "1",
              name: "draft_campaign",
              args: {
                name: "Spring beard trims",
                campaignType: "update",
                channels: ["sms"],
                templates: { sms: "{shop}: spring beard trims are in, {first_name}. {book_link} Reply STOP to opt out.", emailSubject: "Spring beard trims", emailBody: "Hi {first_name}, book here: {book_link}", pushTitle: "Beard trims", pushBody: "Book a trim" },
                audience: { lastVisitOverDays: 30 },
                rationale: "Clients away a month.",
              },
            },
          ],
        };
      },
    };
    const d = await AI.draftBlast(ctx, "A spring beard trim push for clients away a month", { provider: fake, now: NOW });
    expect(d).toMatchObject({ drafter: "openai", name: "Spring beard trims", campaignType: "update", segment: expect.objectContaining({ lastVisitOverDays: 30 }) });
    expect(asked).toContain("A spring beard trim push");
    expect(asked).not.toContain("Quillon");
    expect(asked).not.toContain("Varga");
    expect(asked).not.toContain(secret.phone!);
    expect(asked).not.toContain("@example.com");
    expect(await count()).toBe(before);
    const [a] = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "campaign_center.ai_drafted")).orderBy(m.drizzle.desc(s().auditLog.at)).limit(1);
    expect(a.details).toMatchObject({ drafter: "openai" });

    const id = await CP.saveBlast(ctx, { name: d.name, channels: d.channels, templates: d.templates, segment: { tags: ["nobody-here"] }, shopIds: [fx.cv], aiDrafted: true });
    await CP.saveBlast(ctx, { id, name: d.name, channels: d.channels, templates: d.templates, segment: { tags: ["nobody-here"] }, shopIds: [fx.cv] });
    expect((await camp(id)).aiDrafted).toBe(true);
    await expect(CP.scheduleBlast(ctx, id, new Date(NOW.getTime() + DAY), NOW)).rejects.toThrow(/assistant/);
    await CP.scheduleBlast(ctx, id, new Date(NOW.getTime() + DAY), NOW, { reviewed: true });
    expect(await camp(id)).toMatchObject({ status: "scheduled", reviewedBy: fx.owner, reviewedAt: NOW });
    expect((await camp(await CP.duplicateBlast(ctx, id))).aiDrafted).toBe(false);
  });

  it("the calendar shows each week a repeating blast goes and the days it went", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const { tag } = await tagged(1);
    const id = await CP.saveBlast(ctx, { name: `Calendar weekly ${++seq}`, channels: ["sms"], templates: { sms: SMS }, segment: { tags: [tag] }, shopIds: [fx.cv], recurrence: { freq: "weekly", endsOn: null } });
    await CP.scheduleBlast(ctx, id, new Date(NOW.getTime() + HOUR), NOW);
    const mine = async (now: Date) => (await CAL.campaignCalendar(ctx, "2028-02", now)).entries.filter((e) => e.campaignId === id).map((e) => `${e.day} ${e.state}`);
    expect(await mine(NOW)).toEqual(["2028-02-16 scheduled", "2028-02-23 scheduled"]);
    const later = new Date(NOW.getTime() + HOUR + 60_000);
    await E.runBlasts(later, { ids: [id] });
    expect(await mine(later)).toEqual(["2028-02-16 sent", "2028-02-23 scheduled"]);
    expect((await CAL.campaignCalendar(ctx, "2028-03", later)).entries.filter((e) => e.campaignId === id).map((e) => e.day)).toEqual(["2028-03-01", "2028-03-08", "2028-03-15", "2028-03-22", "2028-03-29"]);
    await expect(CAL.campaignCalendar(ctx, "2028-13", NOW)).rejects.toThrow(/month/);
    await CP.pauseBlast(ctx, id, later);
  });

  it("come back for a 2nd visit and after every visit: the right clients, once per visit", async () => {
    await consent(true);
    await turnOn("second_visit");
    await turnOn("post_visit");
    const once = await client({ sms: true });
    const odd = (ms: number) => new Date(NOW.getTime() + ms + 7 * 60_000);
    await visit(once.id, odd(-22 * DAY));
    const onceBooked = await client({ sms: true });
    await visit(onceBooked.id, odd(-22 * DAY + HOUR));
    await visit(onceBooked.id, odd(3 * DAY + 2 * HOUR), { status: "booked" });
    const regular = await client({ sms: true });
    await visit(regular.id, odd(-40 * DAY));
    const last = odd(-4 * HOUR);
    await visit(regular.id, last);
    const firstToday = await client({ sms: true });
    await visit(firstToday.id, last, { staff: fx.barber });
    await E.runTriggers(NOW, { shopIds: [fx.cv], keys: ["second_visit", "post_visit"] });
    const occ = async (id: string) => (await sendsFor(id)).map((x) => x.dedupeKey.split(":").slice(2).join(":"));
    expect(await occ(once.id)).toEqual(["second_visit"]);
    expect(await occ(onceBooked.id)).toEqual([]);
    expect(await occ(regular.id)).toEqual([`post_visit:${last.toISOString().slice(0, 10)}`]);
    expect(await occ(firstToday.id)).toEqual([]);
    await E.runTriggers(new Date(NOW.getTime() + HOUR), { shopIds: [fx.cv], keys: ["second_visit", "post_visit"] });
    expect(await sendsFor(regular.id)).toHaveLength(1);
    for (const k of ["second_visit", "post_visit"]) {
      const c = await campaign(k);
      await m.db.db.update(s().marketingLocationSettings).set({ enabled: false }).where(eq(s().marketingLocationSettings.campaignId, c.id));
    }
  });

  it("send-time optimization holds each message until the client's usual booking time", async () => {
    await consent(true);
    await signInAs(fx.owner);
    const ctx = await ctxOf();
    const { tag, list } = await tagged(2);
    const [usual, unknown] = list;
    await visit(usual.id, new Date(NOW.getTime() - 30 * DAY), { createdAt: at("2028-01-10", "18:00") });
    await visit(usual.id, new Date(NOW.getTime() - 60 * DAY), { createdAt: at("2027-12-10", "18:00") });
    const id = await CP.saveBlast(ctx, { name: "Send time", channels: ["sms"], templates: { sms: SMS }, segment: { tags: [tag] }, shopIds: [fx.cv], sendTimeOpt: true });
    await CP.scheduleBlast(ctx, id, null, NOW);
    expect((await job((await sendsFor(usual.id))[0].jobId)).runAt.toISOString()).toBe(at("2028-02-16", "18:00").toISOString());
    expect((await job((await sendsFor(unknown.id))[0].jobId)).runAt.toISOString()).toBe(NOW.toISOString());
  });

  it("coupons limited to some days and hours work only then at checkout", async () => {
    const tuesday = await promo({ daysOfWeek: [2] });
    const wednesday = await promo({ daysOfWeek: [3] });
    const afternoon = await promo({ timeFrom: "12:00", timeTo: "15:00" });
    const c = await client();
    await expect(pay({ customerId: c.id, codes: [tuesday.code] })).rejects.toThrow(/only works Tue/);
    expect((await pay({ customerId: c.id, codes: [wednesday.code] })).discountCents).toBe(500);
    await expect(pay({ customerId: c.id, codes: [afternoon.code] })).rejects.toThrow(/only works 12/);
    expect((await pay({ customerId: c.id, codes: [afternoon.code], now: at("2028-02-16", "13:00") })).discountCents).toBe(500);
  });
});
