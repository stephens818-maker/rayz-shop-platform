/**
 * Today: the alerts the dashboard raises on its own for a shop's day, the one-click fixes behind
 * them. The clock is fixed at 10:00 shop time on a coming day Makenna works
 * at Coralville, with her day cleared and rebuilt so every alert has a known cause.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let today: typeof import("@/server/today");
let actions: typeof import("@/app/admin/today/actions");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const fx: Record<string, string> = {};
let day = "";
let now = new Date();
let consentColumn = false;
let seq = 0;

const at = (d: string, min: number) => m.time.zonedWallTime(d, min).toJSDate();
const alertsFor = async (staffId: string, shopSlug?: string) => {
  await signInAs(staffId, shopSlug ? shop[shopSlug] : undefined);
  const { getStaffContext } = await import("@/server/auth/staff");
  return today.todayAlerts(today.viewerOf((await getStaffContext())!), new Date());
};
const find = async (staffId: string, key: string) => (await alertsFor(staffId)).find((a) => a.key === key);

async function customer(first: string, o: { phone?: string; email?: string } = {}) {
  const [c] = await m.db.db
    .insert(m.schema.customers)
    .values({ firstName: first, lastName: "Todaytest", phone: o.phone ?? null, email: o.email ?? null, smsOptIn: !!o.phone, emailOptIn: !!o.email, homeShopId: shop.coralville })
    .returning();
  return c.id;
}
async function appt(customerId: string, d: string, startMin: number, len: number, status: "booked" | "checked_in" | "completed" | "no_show") {
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({
      code: `TODAY${++seq}`,
      shopId: shop.coralville,
      staffId: ids.makenna,
      customerId,
      startsAt: at(d, startMin),
      endsAt: at(d, startMin + len),
      status,
      source: "staff",
      completedAt: status === "completed" ? at(d, startMin + len) : null,
      checkedInAt: status === "checked_in" ? at(d, startMin - 5) : null,
    })
    .returning();
  return a.id;
}

beforeAll(async () => {
  m = await loadModules();
  for (const k of ["owner", "michelle", "makenna"]) ids[k] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  const scheds = await m.db.db.select().from(m.schema.staffSchedules).where(m.drizzle.and(eq(m.schema.staffSchedules.staffId, ids.makenna), eq(m.schema.staffSchedules.shopId, shop.coralville)));
  const base = m.time.todayLocal();
  for (let i = 3; i < 12 && !day; i++) {
    const d = m.time.addDays(base, i);
    if (scheds.some((s) => s.weekday === m.time.weekdayOf(d) && s.startMin <= 9 * 60 && s.endMin >= 17 * 60)) day = d;
  }
  now = at(day, 10 * 60);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  today = await import("@/server/today");
  actions = await import("@/app/admin/today/actions");

  // Clear Makenna's day, then: a client checked in at 9:30 and not started, a client with a
  // no-show habit at 11:30, a client at 4 PM inside her afternoon off, and a regular due for a cut.
  const { and, gte, lt } = m.drizzle;
  await m.db.db
    .update(m.schema.appointments)
    .set({ status: "cancelled", cancelledAt: now })
    .where(and(eq(m.schema.appointments.staffId, ids.makenna), gte(m.schema.appointments.startsAt, at(day, 0)), lt(m.schema.appointments.startsAt, at(day, 24 * 60))));
  await m.db.db.delete(m.schema.timeBlocks).where(and(eq(m.schema.timeBlocks.staffId, ids.makenna), lt(m.schema.timeBlocks.startsAt, at(day, 24 * 60)), gte(m.schema.timeBlocks.endsAt, at(day, 0))));
  fx.walkedIn = await customer("Waiting", { email: "waiting@today.test" });
  fx.walkedInAppt = await appt(fx.walkedIn, day, 9 * 60 + 30, 30, "checked_in");
  // The seed's own no-shows depend on the hour it ran; only this test's client has a history.
  await m.db.db.update(m.schema.appointments).set({ status: "completed" }).where(eq(m.schema.appointments.status, "no_show"));
  fx.risky = await customer("Risky", { email: "risky@today.test" });
  for (const back of [30, 60, 90]) await appt(fx.risky, m.time.addDays(day, -back), 13 * 60, 30, "no_show");
  fx.riskyAppt = await appt(fx.risky, day, 11 * 60 + 30, 30, "booked");
  fx.offDay = await customer("Offday", { email: "offday@today.test" });
  fx.offDayAppt = await appt(fx.offDay, day, 16 * 60, 30, "booked");
  await m.db.db.insert(m.schema.timeBlocks).values({ staffId: ids.makenna, shopId: null, startsAt: at(day, 16 * 60), endsAt: at(day, 17 * 60), kind: "block", category: "time_off", reason: "Doctor" });
  fx.regular = await customer("Regular", { phone: "+15635550991" });
  for (const back of [90, 60, 30]) await appt(fx.regular, m.time.addDays(day, -back), 10 * 60, 30, "completed");
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  if (consentColumn) await m.db.db.execute(m.drizzle.sql`update customers set sms_marketing_opt_in = false where sms_marketing_opt_in`);
  await m?.db.closeDb();
});

describe("Today alerts", () => {
  it("finds the open chair time, who's running behind, the no-show risk and the client booked during time off", async () => {
    const alerts = await alertsFor(ids.michelle);
    const idle = alerts.find((a) => a.key === `idle_chairs:${shop.coralville}:${day}`)!;
    expect(idle.items?.map((i) => i.label)).toContain("Makenna");
    expect(idle.detail).toMatch(/none agreed to marketing texts. Call them through the shop line/);
    expect(idle.action).toBeUndefined();

    const behind = alerts.find((a) => a.type === "running_behind" && a.key.includes(ids.makenna))!;
    expect(behind).toMatchObject({ severity: "high", title: "Makenna is about 30m behind" });
    expect(behind.action).toMatchObject({ kind: "running_late", payload: { appointmentIds: [fx.riskyAppt], delayMin: 30 } });

    const risk = alerts.find((a) => a.key === `no_show_risk:${shop.coralville}:${day}`)!;
    expect(risk.items?.[0].sub).toMatch(/3 no-shows/);
    expect(risk.action).toMatchObject({ kind: "no_show_reminder", payload: { appointmentIds: [fx.riskyAppt] } });

    const off = alerts.find((a) => a.key === `off_but_booked:${shop.coralville}:${day}`)!;
    expect(off).toMatchObject({ severity: "high" });
    expect(off.items?.map((i) => i.href)).toContain(`/admin/calendar?appt=${fx.offDayAppt}`);
  });

  it("sends the extra reminder and the running-late note once each", async () => {
    await signInAs(ids.michelle);
    const r = await actions.runAlertAction(`no_show_risk:${shop.coralville}:${day}`);
    expect(r).toMatchObject({ ok: true, data: { message: "Sent to 1 client." } });
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.appointmentId, fx.riskyAppt));
    expect(jobs.filter((j) => j.kind === "no_show_reminder").map((j) => j.to)).toEqual(["risky@today.test"]);
    const again = (await find(ids.michelle, `no_show_risk:${shop.coralville}:${day}`))!;
    expect(again.action).toBeUndefined();
    expect(again.detail).toBe("All of them have had an extra reminder.");
    expect(await actions.runAlertAction(again.key)).toMatchObject({ ok: false, error: "Nothing to do for this one" });

    const behind = (await alertsFor(ids.michelle)).find((a) => a.type === "running_behind" && a.key.includes(ids.makenna))!;
    await signInAs(ids.michelle);
    expect(await actions.runAlertAction(behind.key)).toMatchObject({ ok: true, data: { message: "Sent to 1 client." } });
    const late = await m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.and(eq(m.schema.notificationJobs.appointmentId, fx.riskyAppt), eq(m.schema.notificationJobs.kind, "running_late")));
    expect(late).toHaveLength(1);
    expect(late[0].body).toMatch(/30m/);
    expect((await find(ids.michelle, behind.key))!.action).toBeUndefined();
  });

  it("drafts the suggested purchase order for low stock", async () => {
    const [p] = await m.db.db.insert(m.schema.products).values({ sku: "TODAY-POMADE", name: "Today Pomade", brand: "Testco", category: "Styling", costCents: 900, priceCents: 1800, lowStockThreshold: 3, parLevel: 8 }).returning();
    await m.db.db.insert(m.schema.shopProducts).values({ shopId: shop.coralville, productId: p.id, costCents: 900, priceCents: 1800 });
    const [v] = await m.db.db.insert(m.schema.vendors).values({ name: "Today Vendor", email: "orders@today.test", leadTimeDays: 5 }).returning();
    await m.db.db.insert(m.schema.vendorProducts).values({ vendorId: v.id, productId: p.id, vendorSku: "TV-1", casePack: 1, costCents: 900, preferred: true });
    await m.db.db.transaction((tx) => m.ledger.setOnHand(tx, { shopId: shop.coralville, productId: p.id, to: 1, kind: "adjust", reason: "count_correction" }, { actor, negative: "allow" }));

    const suggested = async () => (await m.purchasing.suggestionsFor([shop.coralville]))[0].orders.flatMap((o) => o.lines).some((l) => l.productId === p.id);
    expect(await suggested()).toBe(true);
    const low = (await find(ids.michelle, `low_stock:${shop.coralville}:${day}`))!;
    expect(low.action?.kind).toBe("draft_po");
    expect(low.action?.payload.vendorIds).toContain(v.id);
    await signInAs(ids.michelle);
    const r = await actions.runAlertAction(low.key);
    expect(r).toMatchObject({ ok: true, data: { message: expect.stringMatching(/^Drafted /) } });
    const line = await m.db.db.query.purchaseOrderLines.findFirst({ where: eq(m.schema.purchaseOrderLines.productId, p.id) });
    expect(line?.qtyOrdered).toBe(7);
    const po = await m.db.db.query.purchaseOrders.findFirst({ where: eq(m.schema.purchaseOrders.id, line!.purchaseOrderId) });
    expect(po).toMatchObject({ status: "draft", shopId: shop.coralville });
    expect(await suggested()).toBe(false);
    const after = await alertsFor(ids.michelle);
    expect(after.find((a) => a.type === "draft_pos" && a.shopId === shop.coralville)?.items?.map((i) => i.label).join()).toContain(`PO ${po!.number}`);
  });

  it("retries failed messages", async () => {
    const [job] = await m.db.db
      .insert(m.schema.notificationJobs)
      .values({ shopId: shop.coralville, customerId: fx.regular, kind: "staff_text", channel: "sms", to: "+15635550991", body: "Your clippers are ready", runAt: now, status: "failed", attempts: 3, lastError: "Carrier unreachable", createdAt: new Date(now.getTime() - 3_600_000) })
      .returning();
    const failed = (await alertsFor(ids.owner)).find((a) => a.type === "failed_notifications")!;
    expect(failed.detail).toMatch(/Carrier unreachable/);
    expect(failed.action?.payload.jobIds).toContain(job.id);
    await signInAs(ids.owner);
    expect(await actions.runAlertAction(failed.key)).toMatchObject({ ok: true, data: { message: expect.stringMatching(/^Retried: /) } });
    const row = await m.db.db.query.notificationJobs.findFirst({ where: eq(m.schema.notificationJobs.id, job.id) });
    expect(row).toMatchObject({ status: expect.stringMatching(/^(sent|suppressed)$/), lastError: null });
  });

  it("flags drawer variances and unconfirmed tax rates, each person seeing only their own shops; dismissing hides it for everyone", async () => {
    const yesterday = m.time.addDays(day, -1);
    for (const slug of ["coralville", "moline"])
      await m.db.db
        .insert(m.schema.cashDrawers)
        .values({ shopId: shop[slug], businessDate: yesterday, expectedCents: 30_000, countedCents: 27_500, varianceCents: -2_500, closedAt: at(yesterday, 19 * 60) })
        .onConflictDoUpdate({ target: [m.schema.cashDrawers.shopId, m.schema.cashDrawers.businessDate], set: { varianceCents: -2_500, closedAt: at(yesterday, 19 * 60) } });
    await m.db.db.update(m.schema.shops).set({ taxRatesVerified: false }).where(eq(m.schema.shops.id, shop.moline));

    const owner = await alertsFor(ids.owner);
    expect(owner.map((a) => a.key)).toEqual(expect.arrayContaining([`drawer_variance:${shop.coralville}:${yesterday}`, `drawer_variance:${shop.moline}:${yesterday}`]));
    expect(owner.find((a) => a.key === `drawer_variance:${shop.moline}:${yesterday}`)).toMatchObject({ severity: "high", title: expect.stringMatching(/^Drawer short \$25\.00/) });
    expect(owner.find((a) => a.type === "tax_unverified")?.title).toMatch(/Moline/);

    const michelle = await alertsFor(ids.michelle);
    expect(michelle.map((a) => a.key)).toContain(`drawer_variance:${shop.coralville}:${yesterday}`);
    for (const a of michelle) {
      expect([null, shop.coralville]).toContain(a.shopId);
      expect(JSON.stringify(a)).not.toMatch(/Moline/);
    }
    expect(await alertsFor(ids.makenna)).toEqual([]);

    await signInAs(ids.michelle);
    expect(await actions.dismissAlertAction(`drawer_variance:${shop.moline}:${yesterday}`, 1)).toMatchObject({ ok: false });
    expect(await actions.dismissAlertAction(`drawer_variance:${shop.coralville}:${yesterday}`, 1)).toMatchObject({ ok: true });
    expect((await alertsFor(ids.michelle)).map((a) => a.key)).not.toContain(`drawer_variance:${shop.coralville}:${yesterday}`);
    const ownerAfter = (await alertsFor(ids.owner)).map((a) => a.key);
    expect(ownerAfter).not.toContain(`drawer_variance:${shop.coralville}:${yesterday}`);
    expect(ownerAfter).toContain(`drawer_variance:${shop.moline}:${yesterday}`);
  });

  it("texts clients due for a cut about the open chair only once they've agreed to marketing, once a week", async () => {
    consentColumn = true;
    await m.db.db.execute(m.drizzle.sql`update customers set sms_marketing_opt_in = true where id = ${fx.regular}`);
    now = new Date(now.getTime() + 2 * 60_000);
    vi.setSystemTime(now);

    const key = `idle_chairs:${shop.coralville}:${day}`;
    const idle = (await find(ids.michelle, key))!;
    expect(idle.detail).toMatch(/^1 client due for a cut agreed to marketing texts/);
    expect(idle.action).toMatchObject({ kind: "fill", payload: { shopId: shop.coralville } });
    await signInAs(ids.michelle);
    expect(await actions.runAlertAction(key)).toMatchObject({ ok: true, data: { message: "Texted 1 client about today's openings." } });
    const [job] = await m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.and(eq(m.schema.notificationJobs.customerId, fx.regular), eq(m.schema.notificationJobs.kind, "fill_offer")));
    expect(job).toMatchObject({ channel: "sms", to: "+15635550991", shopId: shop.coralville });
    expect(job.body).toMatch(/Regular/);
    expect(job.body).toMatch(/Makenna/);
    expect(job.body).toMatch(/STOP/);
    expect((await find(ids.michelle, key))!.action).toBeUndefined();

    const { sendFillCampaign } = await import("@/server/outreach-campaigns");
    expect(await sendFillCampaign(shop.coralville, ["Makenna"], { actor, staffId: ids.michelle }, now)).toEqual({ sent: 0 });
    await expect(sendFillCampaign(shop.coralville, ["Makenna"], { actor, staffId: ids.michelle }, at(day, 19 * 60 + 30))).rejects.toMatchObject({ code: "conflict" });
  });
});
