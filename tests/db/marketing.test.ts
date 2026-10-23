/**
 * Marketing / Engage against a real database: coupons at checkout and from online booking (limits,
 * single-use codes, first visit only, stacking, free add-ons, auto-apply, refunds giving them back,
 * loyalty on the net), the engine (consent from the customer app's columns, once per occasion,
 * quiet hours, frequency caps, the email footer, coupon codes issued per client), STOP, START, HELP
 * and the unsubscribe link, each automated campaign's audience, blasts with the segment builder and
 * the preview, location scoping, the report and the contact export's permission.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";
import { TRIGGERS, type TriggerKey } from "@/domain/marketing";

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
let exportRoute: typeof import("@/app/admin/marketing/export/route").GET;
const fx = { cv: "", cvSlug: "coralville", cvLine: "", other: "", michelle: "", owner: "", barber: "", cut: "", cutCents: 0, addon: "", addonCents: 0, marketing: {} as Record<string, unknown> };
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
  exportRoute = (await import("@/app/admin/marketing/export/route")).GET;
  const shops = await m.db.db.query.shops.findMany({ where: eq(s().shops.active, true) });
  const cv = shops.find((x) => x.slug === "coralville")!;
  fx.cv = cv.id;
  fx.cvLine = cv.twilioNumber!;
  fx.other = shops.find((x) => x.id !== cv.id)!.id;
  fx.michelle = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.displayLabel, "Michelle") }))!.id;
  fx.owner = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, "owner@rayz.test") }))!.id;
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

type ClientOpts = { sms?: boolean; email?: boolean; push?: boolean; first?: string; birthday?: string; home?: string; noPhone?: boolean };
async function client(o: ClientOpts = {}) {
  const n = String(1000 + ((++seq * 37) % 9000)).padStart(4, "0");
  const [c] = await m.db.db
    .insert(s().customers)
    .values({
      firstName: o.first ?? "Mark",
      lastName: "Etting",
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

async function visit(customerId: string, when: Date, o: { shop?: string; staff?: string; status?: "completed" | "no_show" | "booked"; createdAt?: Date } = {}) {
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
    const appt = await visit(c.id, new Date(now.getTime() + 2 * DAY), { status: "booked", createdAt: now });
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

    const scope = await S.resolveScope(ctx, { from: "2028-02-21", to: "2028-02-21", shop: fx.cv }, "marketing");
    const data = await L.REPORT_LOADERS.marketing({ scope, loc: scope.loc, viewer: ctx, params: {} });
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
    expect((await exportRoute(new Request("http://x/admin/marketing/export"))).status).toBe(403);
    await signInAs(fx.owner);
    const c = await client({ sms: true, first: "Exportable" });
    const r = await exportRoute(new Request("http://x/admin/marketing/export"));
    expect(r.status).toBe(200);
    const csv = await r.text();
    expect(csv.split("\n")[0]).toMatch(/First name,Last name,Phone,Email,Marketing texts/);
    expect(csv).toContain("Exportable");
    const [a] = await m.db.db
      .select()
      .from(s().auditLog)
      .where(eq(s().auditLog.action, "marketing.export"))
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
