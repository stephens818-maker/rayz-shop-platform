/**
 * Checkout prompts against a real database: the rebook prompt offering times with the same barber
 * around when the client is due, one tap booking them (a family together, each with their own
 * barber), "not now" with a reason and a reminder that's sent, dropped when they book, or skipped
 * without a way to reach them; the product prompt from what the barber tagged, the brand's
 * service-product suggestions and past purchases, with stock; required prompts holding payment and
 * the hand-off; unanswered prompts settling at payment; the brand, location, role and barber
 * switches; the settings actions; the report; and every prompt shown, taken and declined in the
 * event log.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandAction, brandSet } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let P: typeof import("@/server/checkout-prompts");
let D: typeof import("@/domain/checkout-prompts");
let fam: typeof import("@/server/family");
let cc: typeof import("@/server/combined-checkout");
let today: string;
const fx = { shop: "", makenna: "", michelle: "", owner: "", manager: "", barberRole: "", cut: "", cutCents: 0, products: [] as { id: string; priceCents: number }[] };
const slots = new Map<string, number>();
let seq = 0;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };
const who = { roleId: null, actor };

beforeAll(async () => {
  m = await loadModules();
  P = await import("@/server/checkout-prompts");
  D = await import("@/domain/checkout-prompts");
  fam = await import("@/server/family");
  cc = await import("@/server/combined-checkout");
  today = m.time.todayLocal();
  fx.shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!.id;
  const staff = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, email) }))!;
  fx.makenna = (await staff("makenna@rayz.test")).id;
  fx.michelle = (await staff("michelle@rayz.test")).id;
  fx.owner = (await staff("owner@rayz.test")).id;
  fx.manager = (await staff("manager.moline@rayz.test")).id;
  fx.barberRole = (await staff("makenna@rayz.test")).roleId!;
  const svc = (await m.catalog.shopCatalog(fx.shop)).find((x) => x.slug === "rayz-cut-shampoo")!;
  fx.cut = svc.id;
  fx.cutCents = svc.priceCents;
  const carried = (await m.stock.stockLevels([fx.shop])).filter((l) => l.active && l.priceCents > 0);
  fx.products = carried.slice(0, 4).map((l) => ({ id: l.productId, priceCents: l.priceCents }));
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

beforeEach(async () => {
  await brandSet("checkout_prompts", "brand", D.PROMPT_DEFAULTS);
  await m.db.db.delete(s().checkoutPromptRules);
  await m.db.db.delete(s().serviceProductSuggestions);
  await m.db.db.update(s().services).set({ rebookDays: null }).where(eq(s().services.id, fx.cut));
  // Plenty on the shelf, so only a test's own stock levels decide what shows as low or out.
  for (const p of fx.products) await setStock(p.id, 30, null);
});

async function setStock(productId: string, qty: number, lowAt: number | null) {
  await m.adjust.adjustStock({ actor, name: "test", shopIds: [fx.shop] }, { shopId: fx.shop, productId, mode: "set", qty, reason: "count_correction" });
  await m.db.db.update(s().shopProducts).set({ lowStockThreshold: lowAt }).where(m.drizzle.and(eq(s().shopProducts.shopId, fx.shop), eq(s().shopProducts.productId, productId)));
}

async function customer(firstName: string, o: { contact?: boolean } = {}) {
  const n = String(2000 + ++seq + Math.floor(Math.random() * 7000)).slice(-4);
  const reach = o.contact === false ? { phone: null, email: null, smsOptIn: false, emailOptIn: false } : { phone: `+1319557${n}`, email: `${firstName.toLowerCase()}.${n}@prompts.test`, smsOptIn: true, emailOptIn: true };
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName, lastName: "Prompted", ...reach, homeShopId: fx.shop })
    .returning();
  return c;
}

/** Today's appointment, checked in, each barber's back to back in 5-minute slots before opening (so it never meets the seeded book). */
async function appt(customerId: string, staffId: string, o: { groupId?: string | null; date?: string; status?: "checked_in" | "booked" } = {}) {
  const n = slots.get(staffId) ?? 0;
  slots.set(staffId, n + 1);
  const startsAt = m.time.zonedWallTime(o.date ?? today, 5 + 5 * n).toJSDate();
  const [a] = await m.db.db
    .insert(s().appointments)
    .values({
      code: `P${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: fx.shop,
      staffId,
      customerId,
      groupId: o.groupId ?? null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 5 * 60_000),
      status: o.status ?? "checked_in",
      source: "staff",
      estimateCents: fx.cutCents,
    })
    .returning();
  await m.db.db.insert(s().appointmentItems).values({ appointmentId: a.id, serviceId: fx.cut, kind: "service", name: "Ray'z Cut", priceCents: fx.cutCents, durationMin: 20 });
  return a;
}

/** A client's ticket with Makenna, open at checkout. */
async function ticket(firstName = "Rowan", o: { contact?: boolean; staffId?: string } = {}) {
  const c = await customer(firstName, o);
  const a = await appt(c.id, o.staffId ?? fx.makenna);
  const sale = await m.checkout.openSaleForAppointment(a.id, actor);
  return { c, a, saleId: sale.id };
}

const cutFor = (appointmentId: string) => ({ kind: "service" as const, refId: fx.cut, qty: 1, appointmentId });
const pay = (saleId: string, lines: Parameters<Mods["checkout"]["finalizeSale"]>[0]["lines"]) => m.checkout.finalizeSale({ saleId, lines, tipCents: 0, tender: cash, actor });
const promptRow = async (id: string) => (await m.db.db.select().from(s().checkoutPrompts).where(eq(s().checkoutPrompts.id, id)))[0];
const eventsOf = (promptId: string) =>
  m.db.db
    .select()
    .from(s().analyticsEvents)
    .where(m.drizzle.and(eq(s().analyticsEvents.entity, "checkout_prompt"), eq(s().analyticsEvents.entityId, promptId)))
    .orderBy(m.drizzle.asc(s().analyticsEvents.id));

describe("the rebook prompt", () => {
  it("offers 3 times with the same barber around the brand's default interval, and one tap books the next visit", async () => {
    const { c, a, saleId } = await ticket();
    const t = await P.promptsForTicket(saleId, who);
    expect(t.enabled).toEqual({ rebook: true, product: true });
    const r = t.rebook!;
    expect(r).toMatchObject({ prompt: "rebook", required: false, outcome: null });
    expect(r.suggested).toMatchObject({ intervalDays: 28, intervalSource: "brand", visitDate: today, targetDate: m.time.addDays(today, 28), reason: null, estimateCents: fx.cutCents });
    expect(r.suggested.people).toEqual([expect.objectContaining({ customerId: c.id, appointmentId: a.id, staffId: fx.makenna, serviceId: fx.cut })]);
    const opts = r.suggested.options;
    expect(opts).toHaveLength(3);
    expect(new Set(opts.map((o) => o.date)).size).toBe(3);
    for (const o of opts) {
      expect(o.seats).toEqual([expect.objectContaining({ customerId: c.id, staffId: fx.makenna, startsAt: o.startsAt })]);
      expect(Math.abs(m.time.diffDays(r.suggested.targetDate, o.date))).toBeLessThanOrEqual(D.REBOOK_SPREAD_DAYS);
    }
    expect(opts.map((o) => o.startsAt)).toEqual([...opts.map((o) => o.startsAt)].sort());
    expect(t.waiting).toEqual([]);
    expect(t.reasons).toEqual(D.DEFAULT_REASONS);

    // Shown once, however many times the ticket is opened.
    await P.promptsForTicket(saleId, who);
    expect((await m.db.db.select().from(s().checkoutPrompts).where(eq(s().checkoutPrompts.saleId, saleId))).filter((x) => x.prompt === "rebook")).toHaveLength(1);

    const pick = opts[1];
    const booked = await P.acceptRebook(saleId, r.id, { index: 1, startsAt: pick.startsAt }, actor);
    expect(booked.appointmentIds).toHaveLength(1);
    const next = (await m.db.db.query.appointments.findFirst({ where: eq(s().appointments.id, booked.appointmentIds[0]) }))!;
    expect(next).toMatchObject({ customerId: c.id, staffId: fx.makenna, source: "rebook", rebookedFromId: a.id, status: "booked" });
    expect(next.startsAt.toISOString()).toBe(pick.startsAt);
    await expect(P.acceptRebook(saleId, r.id, { index: 0, startsAt: opts[0].startsAt }, actor)).rejects.toThrow(/already booked/);
    await expect(P.declinePrompt(saleId, r.id, { reason: "Price" }, actor)).rejects.toThrow(/already booked/);

    const after = await P.promptsForTicket(saleId, who);
    expect(after.rebook).toMatchObject({ outcome: "accepted", booked: [expect.objectContaining({ appointmentId: next.id, customerId: c.id })] });
    expect(after.rebook!.suggested.options).toEqual(opts);

    const ev = await eventsOf(r.id);
    expect(ev.map((e) => e.event)).toEqual(["prompt.shown", "prompt.accepted"]);
    expect(ev[0]).toMatchObject({ category: "prompt", shopId: fx.shop, staffId: fx.makenna, customerId: c.id, saleId, subtype: "rebook", quantity: 3 });
    expect(ev[1]).toMatchObject({ subtype: "rebook", quantity: 1, amountCents: fx.cutCents, appointmentId: next.id });

    await pay(saleId, [cutFor(a.id)]);
    expect(await promptRow(r.id)).toMatchObject({ outcome: "accepted", skipped: false, bookedAppointmentIds: [next.id] });
  });

  it("uses the service's own interval, then the client's visit cadence, and refuses a time that's no longer on offer", async () => {
    await brandSet("service_rule", `suggest:${fx.cut}`, { rebookDays: 21 });
    await expect(brandSet("service_rule", `suggest:${fx.cut}`, { rebookDays: 3 })).rejects.toThrow(/7 to 182/);
    const { saleId } = await ticket();
    const r = (await P.promptsForTicket(saleId, who)).rebook!;
    expect(r.suggested).toMatchObject({ intervalDays: 21, intervalSource: "service", targetDate: m.time.addDays(today, 21) });
    await expect(P.acceptRebook(saleId, r.id, { index: 0, startsAt: "2000-01-01T00:00:00.000Z" }, actor)).rejects.toThrow(/changed/);
    await expect(P.acceptRebook(saleId, r.id, { index: 7, startsAt: r.suggested.options[0].startsAt }, actor)).rejects.toThrow(/Pick one/);
    expect((await promptRow(r.id)).outcome).toBeNull();

    // Two visits five weeks apart: the client's own rhythm wins.
    const regular = await customer("Regular");
    for (const back of [70, 35]) {
      const old = await appt(regular.id, fx.makenna, { date: m.time.addDays(today, -back) });
      await m.db.db.update(s().appointments).set({ status: "completed" }).where(eq(s().appointments.id, old.id));
    }
    const a = await appt(regular.id, fx.makenna);
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    const rr = (await P.promptsForTicket(sale.id, who)).rebook!;
    expect(rr.suggested).toMatchObject({ intervalSource: "client", intervalDays: 35, targetDate: m.time.addDays(today, 35) });
  });

  it("doesn't ask a client whose next visit is already booked", async () => {
    const c = await customer("Booked");
    const future = await appt(c.id, fx.makenna, { date: m.time.addDays(today, 20), status: "booked" });
    const a = await appt(c.id, fx.makenna);
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    const t = await P.promptsForTicket(sale.id, who);
    expect(t.rebook).toBeNull();
    expect(t.nextVisits).toEqual([expect.objectContaining({ customerId: c.id, startsAt: future.startsAt.toISOString() })]);
  });

  it("books a family together, each with their own barber, in one tap", async () => {
    const parent = await customer("Dana");
    const kids = [await fam.addChild(parent.id, { firstName: "Milo" }, actor), await fam.addChild(parent.id, { firstName: "Ava" }, actor)];
    const [g] = await m.db.db
      .insert(s().bookingGroups)
      .values({ code: `G${crypto.randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`, shopId: fx.shop, guardianId: parent.id, plan: "custom", source: "staff" })
      .returning();
    const pa = await appt(parent.id, fx.makenna, { groupId: g.id });
    const ka = [await appt(kids[0].id, fx.michelle, { groupId: g.id }), await appt(kids[1].id, fx.michelle, { groupId: g.id })];
    const { saleId } = await cc.sendToCheckout(pa.id, actor);
    for (const k of ka) expect((await cc.sendToCheckout(k.id, actor)).saleId).toBe(saleId);

    const r = (await P.promptsForTicket(saleId, who)).rebook!;
    expect(r.suggested.people.map((p) => [p.customerId, p.staffId])).toEqual([
      [parent.id, fx.makenna],
      [kids[0].id, fx.michelle],
      [kids[1].id, fx.michelle],
    ]);
    expect(r.suggested.estimateCents).toBe(3 * fx.cutCents);
    expect(r.suggested.options.length).toBeGreaterThanOrEqual(2);
    const o = r.suggested.options[0];
    expect(o.seats.map((x) => x.customerId).sort()).toEqual([parent.id, ...kids.map((k) => k.id)].sort());
    for (const seat of o.seats) expect(seat.staffId).toBe(seat.customerId === parent.id ? fx.makenna : fx.michelle);

    const booked = await P.acceptRebook(saleId, r.id, { index: 0, startsAt: o.startsAt }, actor);
    expect(booked.appointmentIds).toHaveLength(3);
    const rows = await m.db.db.select().from(s().appointments).where(m.drizzle.inArray(s().appointments.id, booked.appointmentIds));
    expect(new Set(rows.map((x) => x.groupId)).size).toBe(1);
    expect(rows.every((x) => x.groupId && x.status === "booked")).toBe(true);
    const from = new Map([[parent.id, pa.id], [kids[0].id, ka[0].id], [kids[1].id, ka[1].id]]);
    for (const x of rows) expect(x.rebookedFromId).toBe(from.get(x.customerId!));
    const group = (await m.db.db.query.bookingGroups.findFirst({ where: eq(s().bookingGroups.id, rows[0].groupId!) }))!;
    expect(group.guardianId).toBe(parent.id);
    expect((await eventsOf(r.id)).find((e) => e.event === "prompt.accepted")).toMatchObject({ quantity: 3, amountCents: 3 * fx.cutCents });
  });

  it("not now: a reason from the brand's list and a reminder, sent to the client when it's due", async () => {
    const { c, saleId } = await ticket("Remy");
    const r = (await P.promptsForTicket(saleId, who)).rebook!;
    await expect(P.declinePrompt(saleId, r.id, { reason: "Because" }, actor)).rejects.toThrow(/reason/i);
    await P.declinePrompt(saleId, r.id, { reason: "Traveling", remind: true }, actor);
    const row = await promptRow(r.id);
    expect(row).toMatchObject({ outcome: "declined", skipped: false, declineReason: "Traveling" });
    const [rem] = await P.scheduledReminders(c.id);
    expect(rem).toMatchObject({ id: row.reminderId, shopId: fx.shop, staffId: fx.makenna, serviceId: fx.cut, saleId, status: "scheduled" });
    const day = D.reminderDay(r.suggested.targetDate, 3, today);
    expect(rem.runAt.toISOString()).toBe(m.time.zonedWallTime(day, D.REMINDER_HOUR * 60).toJSDate().toISOString());
    expect((await P.promptsForTicket(saleId, who)).rebook).toMatchObject({ outcome: "declined", declineReason: "Traveling", reminderAt: rem.runAt.toISOString() });
    const ev = (await eventsOf(r.id)).find((e) => e.event === "prompt.declined");
    expect(ev).toMatchObject({ subtype: "rebook", reason: "Traveling", value: 1 });

    // Nothing goes before it's due; then one message on each channel the client agreed to.
    await P.sendDueRebookReminders(new Date(rem.runAt.getTime() - 60_000));
    expect((await P.scheduledReminders(c.id)).length).toBe(1);
    const stats = await P.sendDueRebookReminders(new Date(rem.runAt.getTime() + 60_000));
    expect(stats.queued).toBeGreaterThanOrEqual(1);
    const jobs = await m.db.db.select().from(s().notificationJobs).where(m.drizzle.and(eq(s().notificationJobs.customerId, c.id), eq(s().notificationJobs.kind, "rebook_reminder")));
    expect(jobs.map((j) => j.channel).sort()).toEqual(["email", "sms"]);
    expect(jobs.find((j) => j.channel === "sms")!.body).toMatch(/Hi Remy, you're due back with Makenna soon\. Book your next visit: .*\/book\/coralville/);
    expect(await m.db.db.query.rebookReminders.findFirst({ where: eq(s().rebookReminders.id, rem.id) })).toMatchObject({ status: "sent", outcome: "queued" });
    await P.sendDueRebookReminders(new Date(rem.runAt.getTime() + 120_000));
    expect((await m.db.db.select().from(s().notificationJobs).where(m.drizzle.and(eq(s().notificationJobs.customerId, c.id), eq(s().notificationJobs.kind, "rebook_reminder")))).length).toBe(2);
  });

  it("a reminder is dropped once the client books, and skipped when there's no way to reach them", async () => {
    const one = await ticket("Booker");
    const r1 = (await P.promptsForTicket(one.saleId, who)).rebook!;
    await P.declinePrompt(one.saleId, r1.id, { remind: true }, actor);
    expect((await promptRow(r1.id)).declineReason).toBeNull();
    const pick = r1.suggested.options[0].seats[0];
    await m.booking.createAppointment({ shopRef: fx.shop, serviceId: fx.cut, addonIds: [], barberRef: pick.staffId, startsAt: pick.startsAt, customerId: one.c.id, source: "staff", actor });

    const two = await ticket("Quiet", { contact: false });
    const r2 = (await P.promptsForTicket(two.saleId, who)).rebook!;
    await P.declinePrompt(two.saleId, r2.id, { reason: "Price", remind: true }, actor);

    const later = m.time.zonedWallTime(m.time.addDays(today, 60), 12 * 60).toJSDate();
    const stats = await P.sendDueRebookReminders(later);
    expect(stats.booked).toBeGreaterThanOrEqual(1);
    expect(stats.noContact).toBeGreaterThanOrEqual(1);
    const rem = async (id: string | null) => m.db.db.query.rebookReminders.findFirst({ where: eq(s().rebookReminders.id, id!) });
    expect(await rem((await promptRow(r1.id)).reminderId)).toMatchObject({ status: "cancelled", outcome: "booked" });
    expect(await rem((await promptRow(r2.id)).reminderId)).toMatchObject({ status: "skipped", outcome: "no_contact" });
    const jobs = await m.db.db.select().from(s().notificationJobs).where(m.drizzle.inArray(s().notificationJobs.customerId, [one.c.id, two.c.id]));
    expect(jobs.filter((j) => j.kind === "rebook_reminder")).toEqual([]);
  });

  it("booking after all, from the prompt, cancels the reminder", async () => {
    const { c, saleId } = await ticket("Changed");
    const r = (await P.promptsForTicket(saleId, who)).rebook!;
    await P.declinePrompt(saleId, r.id, { reason: "Not sure of their schedule", remind: true }, actor);
    const reminderId = (await promptRow(r.id)).reminderId;
    await P.acceptRebook(saleId, r.id, { index: 0, startsAt: r.suggested.options[0].startsAt }, actor);
    expect(await promptRow(r.id)).toMatchObject({ outcome: "accepted", declineReason: null, reminderId: null });
    expect(await m.db.db.query.rebookReminders.findFirst({ where: eq(s().rebookReminders.id, reminderId!) })).toMatchObject({ status: "cancelled", outcome: "booked" });
    expect(await P.scheduledReminders(c.id)).toEqual([]);
  });
});

describe("the product prompt", () => {
  it("shows what the barber used, the brand's picks for the service and what the client bought before, with stock, and one tap adds it", async () => {
    const [used, mapped, past, other] = fx.products;
    const c = await customer("Shopper");
    // An earlier visit where they bought a product.
    const first = await appt(c.id, fx.makenna);
    const s1 = await m.checkout.openSaleForAppointment(first.id, actor);
    await pay(s1.id, [cutFor(first.id), { kind: "product", refId: past.id, qty: 1 }]);

    await brandSet("service_rule", `suggest:${fx.cut}`, { productIds: [mapped.id, used.id] });
    await expect(brandSet("service_rule", `suggest:${fx.cut}`, { productIds: [crypto.randomUUID()] })).rejects.toThrow(/not found/i);
    await setStock(used.id, 12, 3);
    await setStock(mapped.id, 2, 3);
    await setStock(past.id, 0, 3);

    const a = await appt(c.id, fx.makenna);
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    await P.tagUsedProduct(sale.id, used.id, actor);
    await P.tagUsedProduct(sale.id, used.id, actor);
    const t = await P.promptsForTicket(sale.id, who);
    expect(t.used.map((u) => u.productId)).toEqual([used.id]);
    const p = t.product!;
    expect(p.suggested.products.map((x) => [x.productId, x.sources, x.stock])).toEqual([
      [used.id, ["used", "service"], "in_stock"],
      [mapped.id, ["service"], "low"],
      [past.id, ["past"], "out"],
    ]);
    expect(p.suggested.products.find((x) => x.productId === used.id)).toMatchObject({ available: 12, priceCents: used.priceCents });
    expect(p.suggested.products.some((x) => x.productId === other.id)).toBe(false);

    // Untagging moves it back to the brand's order; the list keeps up while the ticket is open.
    await P.untagUsedProduct(sale.id, used.id, actor);
    expect((await P.promptsForTicket(sale.id, who)).product!.suggested.products.map((x) => x.productId)).toEqual([mapped.id, used.id, past.id]);
    await P.tagUsedProduct(sale.id, used.id, actor);

    await expect(P.addPromptProduct(sale.id, p.id, other.id, actor)).rejects.toThrow(/isn't one of the suggestions/);
    await P.addPromptProduct(sale.id, p.id, used.id, actor);
    await P.addPromptProduct(sale.id, p.id, used.id, actor);
    await P.addPromptProduct(sale.id, p.id, mapped.id, actor);
    expect(await promptRow(p.id)).toMatchObject({ outcome: "accepted", addedProductIds: [used.id, mapped.id] });

    // Paid with one of the two it added (the other came off the ticket) and something else.
    await pay(sale.id, [cutFor(a.id), { kind: "product", refId: used.id, qty: 2 }, { kind: "product", refId: other.id, qty: 1 }]);
    const row = await promptRow(p.id);
    const lines = await m.db.db.select().from(s().saleItems).where(eq(s().saleItems.saleId, sale.id));
    expect(row.paidProductIds).toEqual([used.id]);
    expect(row.paidProductCents).toBe(lines.filter((l) => l.refId === used.id).reduce((x, l) => x + l.netCents, 0));
    expect(row.paidProductCents).toBeGreaterThan(0);
    const ev = await eventsOf(p.id);
    expect(ev.filter((e) => e.event === "prompt.shown")).toHaveLength(1);
    expect(ev.filter((e) => e.event === "prompt.accepted").map((e) => [e.amountCents, (e.props as { product?: string }).product])).toEqual([
      [used.priceCents, used.id],
      [mapped.priceCents, mapped.id],
    ]);
    await expect(P.tagUsedProduct(sale.id, other.id, actor)).rejects.toThrow(/closed/);
  });

  it("leaves past purchases out when the brand says so, and doesn't show at all with nothing to suggest", async () => {
    const [, , past] = fx.products;
    const c = await customer("Former");
    const first = await appt(c.id, fx.makenna);
    const s1 = await m.checkout.openSaleForAppointment(first.id, actor);
    await pay(s1.id, [cutFor(first.id), { kind: "product", refId: past.id, qty: 1 }]);
    const a = await appt(c.id, fx.makenna);
    const sale = await m.checkout.openSaleForAppointment(a.id, actor);
    await brandSet("checkout_prompts", "brand", { ...D.PROMPT_DEFAULTS, product: { ...D.PROMPT_DEFAULTS.product, pastPurchases: false } });
    const t = await P.promptsForTicket(sale.id, who);
    expect(t.product).toBeNull();
    expect(t.enabled.product).toBe(true);
    await brandSet("checkout_prompts", "brand", D.PROMPT_DEFAULTS);
    expect((await P.promptsForTicket(sale.id, who)).product!.suggested.products.map((x) => x.productId)).toEqual([past.id]);
  });
});

describe("required prompts and paying", () => {
  it("a required prompt holds payment and the hand-off until it's answered", async () => {
    await brandSet("checkout_prompts", "brand", { rebook: { ...D.PROMPT_DEFAULTS.rebook, mode: "acknowledge" }, product: { ...D.PROMPT_DEFAULTS.product, mode: "acknowledge" } });
    await brandSet("service_rule", `suggest:${fx.cut}`, { productIds: [fx.products[0].id] });
    const { a, saleId } = await ticket("Required");
    const t = await P.promptsForTicket(saleId, who);
    expect(t.rebook!.required && t.product!.required).toBe(true);
    expect(t.waiting).toEqual(["rebook", "product"]);
    await expect(pay(saleId, [cutFor(a.id)])).rejects.toThrow("Answer the rebook prompt and the product suggestions before taking payment.");
    const H = await import("@/server/handoff");
    const handOver = () =>
      H.startHandoff(
        saleId,
        { lines: [{ kind: "service", refId: fx.cut, qty: 1 }], promoCode: null, manualDiscount: null, loyaltyRewardId: null, giftCard: null, rebookInWeeks: null, tipSplit: null },
        { actor: { staffId: fx.makenna, label: "test" }, staffId: fx.makenna, canDiscount: false, canOverridePrice: false, maxManualDiscountPct: 0 },
      );
    await expect(handOver()).rejects.toThrow(/Answer the rebook prompt and the product suggestions/);

    await P.declinePrompt(saleId, t.product!.id, { reason: "Ignored for products" }, actor);
    expect((await promptRow(t.product!.id)).declineReason).toBeNull();
    expect((await P.promptsForTicket(saleId, who)).waiting).toEqual(["rebook"]);
    await expect(pay(saleId, [cutFor(a.id)])).rejects.toThrow("Answer the rebook prompt before taking payment.");
    await P.declinePrompt(saleId, t.rebook!.id, {}, actor);
    expect((await P.promptsForTicket(saleId, who)).waiting).toEqual([]);
    await pay(saleId, [cutFor(a.id)]);
    expect((await m.db.db.query.sales.findFirst({ where: eq(s().sales.id, saleId) }))!.status).toBe("paid");
  });

  it("a required rebook counts as answered once the next visit is booked some other way, and settles as booked", async () => {
    await brandSet("checkout_prompts", "brand", { ...D.PROMPT_DEFAULTS, rebook: { ...D.PROMPT_DEFAULTS.rebook, mode: "acknowledge" } });
    const { c, a, saleId } = await ticket("Elsewhere");
    const r = (await P.promptsForTicket(saleId, who)).rebook!;
    await expect(P.assertPromptsAnswered(saleId)).rejects.toThrow(/rebook prompt/);
    const seat = r.suggested.options[2].seats[0];
    const next = await m.booking.createAppointment({ shopRef: fx.shop, serviceId: fx.cut, addonIds: [], barberRef: seat.staffId, startsAt: seat.startsAt, customerId: c.id, source: "staff", actor });
    await expect(P.assertPromptsAnswered(saleId)).resolves.toBeUndefined();
    expect((await P.promptsForTicket(saleId, who)).waiting).toEqual([]);
    await pay(saleId, [cutFor(a.id)]);
    expect(await promptRow(r.id)).toMatchObject({ outcome: "accepted", skipped: false, bookedAppointmentIds: [next.id] });
    expect((await eventsOf(r.id)).find((e) => e.event === "prompt.accepted")).toMatchObject({ appointmentId: next.id, props: expect.objectContaining({ elsewhere: true }) });
  });

  it("prompts paid past without an answer settle as declined (skipped)", async () => {
    await brandSet("service_rule", `suggest:${fx.cut}`, { productIds: [fx.products[0].id] });
    const { a, saleId } = await ticket("Skipper");
    const t = await P.promptsForTicket(saleId, who);
    await pay(saleId, [cutFor(a.id)]);
    for (const id of [t.rebook!.id, t.product!.id]) {
      expect(await promptRow(id)).toMatchObject({ outcome: "declined", skipped: true, paidProductIds: [] });
      expect((await eventsOf(id)).map((e) => [e.event, (e.props as { skipped?: boolean }).skipped ?? null])).toEqual([
        ["prompt.shown", null],
        ["prompt.declined", true],
      ]);
    }
    expect((await eventsOf(t.rebook!.id))[1].value).toBe(0);
    // A paid ticket shows what was asked, and asks nothing new.
    const closed = await P.promptsForTicket(saleId, who);
    expect(closed.enabled).toEqual({ rebook: false, product: false });
    expect(closed.rebook).toMatchObject({ outcome: "declined", skipped: true });
    await expect(P.declinePrompt(saleId, t.rebook!.id, {}, actor)).rejects.toThrow(/closed/);
  });
});

describe("who sees the prompts", () => {
  it("brand off, a location on, a role off, a barber on: the closest setting wins", async () => {
    await brandSet("service_rule", `suggest:${fx.cut}`, { productIds: [fx.products[0].id] });
    const show = async (roleId: string | null = null, staffId = fx.makenna) => {
      const { saleId } = await ticket("Rule", { staffId });
      const t = await P.promptsForTicket(saleId, { roleId, actor });
      return { enabled: t.enabled, rebook: !!t.rebook, product: !!t.product };
    };
    await brandSet("checkout_prompts", "brand", { rebook: { ...D.PROMPT_DEFAULTS.rebook, enabled: false }, product: { ...D.PROMPT_DEFAULTS.product, enabled: false } });
    expect(await show()).toEqual({ enabled: { rebook: false, product: false }, rebook: false, product: false });

    await P.setPromptRule({ prompt: "rebook", target: "location", targetId: fx.shop, enabled: true }, actor);
    expect(await show()).toMatchObject({ enabled: { rebook: true, product: false }, rebook: true, product: false });

    await brandSet("prompt_rule", fx.barberRole, { rebook: false });
    expect((await show(fx.barberRole)).enabled.rebook).toBe(false);
    expect((await show(null)).enabled.rebook).toBe(true);

    await P.setPromptRule({ prompt: "rebook", target: "barber", targetId: fx.makenna, enabled: true }, actor);
    await P.setPromptRule({ prompt: "rebook", target: "barber", targetId: fx.makenna, enabled: true }, actor);
    expect((await show(fx.barberRole)).enabled.rebook).toBe(true);
    expect((await show(fx.barberRole, fx.michelle)).enabled.rebook).toBe(false);
    expect((await P.promptRules()).filter((r) => r.prompt === "rebook")).toHaveLength(3);

    await P.setPromptRule({ prompt: "rebook", target: "barber", targetId: fx.makenna, enabled: null }, actor);
    expect((await show(fx.barberRole)).enabled.rebook).toBe(false);
    await expect(P.setPromptRule({ prompt: "tip", target: "barber", targetId: fx.makenna, enabled: true }, actor)).rejects.toThrow(/Unknown prompt/);
    await expect(P.setPromptRule({ prompt: "rebook", target: "location", targetId: crypto.randomUUID(), enabled: true }, actor)).rejects.toThrow(/Location not found/i);
  });

  it("a prompt already on a ticket stays for whoever opens it next", async () => {
    const { saleId } = await ticket("Sticky");
    const shown = (await P.promptsForTicket(saleId, who)).rebook!;
    await brandSet("prompt_rule", fx.barberRole, { rebook: false });
    const t = await P.promptsForTicket(saleId, { roleId: fx.barberRole, actor });
    expect(t.enabled.rebook).toBe(false);
    expect(t.rebook?.id).toBe(shown.id);
  });

  it("the settings page's actions: the brand's managers only", async () => {
    const actions = await import("@/app/admin/checkout-prompts/actions");
    await signInAs(fx.manager);
    expect(await brandAction("checkout_prompts", "brand", D.PROMPT_DEFAULTS)).toMatchObject({ ok: false });
    expect(await actions.setPromptRuleAction({ prompt: "rebook", target: "barber", targetId: fx.makenna, enabled: false })).toMatchObject({ ok: false });
    expect(await brandAction("service_rule", `suggest:${fx.cut}`, { rebookDays: 30 })).toMatchObject({ ok: false });

    await signInAs(fx.owner);
    const saved = await brandAction("checkout_prompts", "brand", { ...D.PROMPT_DEFAULTS, rebook: { ...D.PROMPT_DEFAULTS.rebook, options: 2, reasons: ["Price", "Price", "Moving"] } });
    expect(saved).toMatchObject({ ok: true });
    expect((await P.loadPromptSettings()).rebook).toMatchObject({ options: 2, reasons: ["Price", "Moving"] });
    expect(await brandAction("checkout_prompts", "brand", { rebook: { options: 5 } })).toMatchObject({ ok: false, error: "2 or 3 times" });
    expect(await brandAction("service_rule", `suggest:${fx.cut}`, { rebookDays: 30 })).toMatchObject({ ok: true });
    expect(await brandAction("service_rule", `suggest:${fx.cut}`, { productIds: [fx.products[1].id] })).toMatchObject({ ok: true });
    expect(await actions.setPromptRuleAction({ prompt: "product", target: "location", targetId: fx.shop, enabled: false })).toMatchObject({ ok: true });
    const setup = await P.promptSetup();
    expect(setup.services.find((x) => x.id === fx.cut)).toMatchObject({ rebookDays: 30, productIds: [fx.products[1].id] });
    expect(setup.rules).toEqual([expect.objectContaining({ prompt: "product", shopId: fx.shop, enabled: false })]);
    const audits = await m.db.db.select({ action: s().auditLog.action }).from(s().auditLog).where(m.drizzle.inArray(s().auditLog.action, ["brand.checkout_prompts", "checkout_prompts.rule", "service.suggestions"]));
    expect(new Set(audits.map((x) => x.action))).toEqual(new Set(["brand.checkout_prompts", "checkout_prompts.rule", "service.suggestions"]));
    const { saleId } = await ticket("Narrow");
    expect((await P.promptsForTicket(saleId, who)).rebook!.suggested.options).toHaveLength(2);
    await signInAs(null);
  });
});

describe("the report", () => {
  it("rebook rate and product attach rate by barber and location, from paid tickets", async () => {
    const R = await import("@/server/checkout-prompts-report");
    const { segKey, TOTAL } = await import("@/domain/report-views");
    const scope = { shopIds: [fx.shop], from: today, to: today };
    const at = async () => {
      const c = await R.promptCountsAt(scope, [{}, { byShop: true, byStaff: true }]);
      return { total: c[TOTAL], michelle: c[segKey(fx.shop, fx.michelle)] };
    };
    const before = await at();
    await brandSet("service_rule", `suggest:${fx.cut}`, { productIds: [fx.products[0].id] });

    // Michelle: one rebooked with a product paid, one declined with a reminder, one skipped, one shown but not paid yet.
    const one = await ticket("ReportA", { staffId: fx.michelle });
    const t1 = await P.promptsForTicket(one.saleId, who);
    await P.acceptRebook(one.saleId, t1.rebook!.id, { index: 0, startsAt: t1.rebook!.suggested.options[0].startsAt }, actor);
    await P.addPromptProduct(one.saleId, t1.product!.id, fx.products[0].id, actor);
    await pay(one.saleId, [cutFor(one.a.id), { kind: "product", refId: fx.products[0].id, qty: 1 }]);

    const two = await ticket("ReportB", { staffId: fx.michelle });
    const t2 = await P.promptsForTicket(two.saleId, who);
    await P.declinePrompt(two.saleId, t2.rebook!.id, { reason: "Price", remind: true }, actor);
    await pay(two.saleId, [cutFor(two.a.id)]);

    const three = await ticket("ReportC", { staffId: fx.michelle });
    await P.promptsForTicket(three.saleId, who);
    await pay(three.saleId, [cutFor(three.a.id)]);

    const open = await ticket("ReportD", { staffId: fx.michelle });
    await P.promptsForTicket(open.saleId, who);

    const after = await at();
    const delta = (k: keyof import("@/server/checkout-prompts-report").PromptCounts, x: "total" | "michelle") => (after[x]?.[k] ?? 0) - (before[x]?.[k] ?? 0);
    for (const x of ["total", "michelle"] as const) {
      expect(delta("rebookShown", x)).toBe(3);
      expect(delta("rebookAccepted", x)).toBe(1);
      expect(delta("rebookDeclined", x)).toBe(1);
      expect(delta("rebookSkipped", x)).toBe(1);
      expect(delta("reminders", x)).toBe(1);
      expect(delta("productShown", x)).toBe(3);
      expect(delta("productAccepted", x)).toBe(1);
      expect(delta("productPaid", x)).toBe(1);
      expect(delta("productsPaid", x)).toBe(1);
      expect(delta("productCents", x)).toBeGreaterThan(0);
    }
    const reasons = await R.declineReasons(scope, { byStaff: true });
    expect(reasons.find((r) => r.staff_id === fx.michelle && r.reason === "Price")?.n).toBeGreaterThanOrEqual(1);
    expect(reasons.find((r) => r.staff_id === fx.michelle && r.reason === "Paid without answering")?.n).toBeGreaterThanOrEqual(1);

    const data = await R.checkoutPromptsData(scope, { view: "combined", byBarber: true, shops: [{ id: fx.shop, name: "Coralville" }] } as never);
    expect(data.stats.map((x) => x.label)).toEqual(["Rebook rate at checkout", "Product attach rate", "Prompted product sales", "Rebook reminders set"]);
    expect(data.tables.map((x) => x.id)).toEqual(["rebook", "product", "reasons"]);
  });
});
