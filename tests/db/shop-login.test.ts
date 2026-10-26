/**
 * Shop login parity with Squire, tighter: the drawer's opening balance and history, manager PINs
 * for refunds and reassigning tickets, the shop login's caps on client and staff details, shop
 * settings gated part by part, and the phone operator on the shop line.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";
import { open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const staffBy = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!;
const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, slug) }))!;
const as = async (email: string) => signInAs((await staffBy(email)).id);

beforeAll(async () => {
  m = await loadModules();
  const tc = await import("@/server/time-clock");
  await tc.setPin((await staffBy("michelle@rayz.test")).id, "4826", actor);
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("cash drawer", () => {
  it("opens with a counted balance, records paid in and out, and closes against the running balance", async () => {
    const drawer = await import("@/app/admin/drawer/actions");
    const server = await import("@/server/drawer");
    const cv = await shop("coralville");
    expect(cv.drawerOpeningCents).toBe(30_000);
    const date = m.time.addDays(m.time.todayLocal(), 5);
    await as("coralville@rayz.test");
    ok(await drawer.openDrawerAction({ shopId: cv.id, date, openingCents: 30_000 }));
    expect(await drawer.openDrawerAction({ shopId: cv.id, date, openingCents: 30_000 })).toMatchObject({ ok: false, error: expect.stringMatching(/already open/) });
    ok(await drawer.drawerMoveAction({ shopId: cv.id, date, kind: "paid_out", amountCents: 2_500, reason: "Towels" }));
    ok(await drawer.drawerMoveAction({ shopId: cv.id, date, kind: "paid_in", amountCents: 1_000, reason: "Change from the bank" }));
    expect(await drawer.drawerMoveAction({ shopId: cv.id, date, kind: "paid_out", amountCents: 500, reason: "" })).toMatchObject({ ok: false });

    const history = await server.drawerBalanceHistory(cv.id, date);
    expect(history.map((l) => [l.kind, l.balanceCents, l.by ?? null])).toEqual([
      ["open", 30_000, "Coralville desk"],
      ["paid_out", 27_500, "Coralville desk"],
      ["paid_in", 28_500, "Coralville desk"],
    ]);
    const closed = ok(await drawer.closeDrawerAction({ shopId: cv.id, date, openingFloatCents: 99_999, payoutsCents: 0, countedCents: 28_000, notes: "" }));
    expect(closed).toEqual({ expectedCents: 28_500, varianceCents: -500 });
    const after = await server.drawerBalanceHistory(cv.id, date);
    expect(after.at(-1)).toMatchObject({ kind: "close", cents: 28_000, varianceCents: -500 });
    expect(await drawer.drawerMoveAction({ shopId: cv.id, date, kind: "paid_out", amountCents: 500, reason: "Late coffee" })).toMatchObject({ ok: false, error: expect.stringMatching(/closed/) });
  });

  it("the drawer page shows the balance history for today", async () => {
    await as("coralville@rayz.test");
    const page = await open("/admin/drawer");
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Balance history");
  });
});

describe("refunds and reassigning need a manager's PIN at the shop login", () => {
  const paidSale = async (shopId: string, withTip = false) => {
    const [s] = await m.db.db
      .select()
      .from(m.schema.sales)
      .where(and(eq(m.schema.sales.shopId, shopId), eq(m.schema.sales.status, "paid"), eq(m.schema.sales.isImported, false), withTip ? m.drizzle.gt(m.schema.sales.tipCents, 0) : undefined))
      .orderBy(m.drizzle.desc(m.schema.sales.createdAt))
      .limit(1);
    const items = await m.db.db.select().from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, s.id));
    return { s, items };
  };

  it("refuses without a PIN or with a wrong one, and records the approving manager", async () => {
    const sales = await import("@/app/admin/sales/actions");
    const cv = await shop("coralville");
    const michelle = await staffBy("michelle@rayz.test");
    const { s, items } = await paidSale(cv.id);
    const input = { saleId: s.id, items: [{ saleItemId: items[0].id, qty: 1 }], tipCents: 0, refundCardFee: false, reason: "Wrong service rung up", restock: false };
    await as("coralville@rayz.test");
    expect(await sales.refundAction(input)).toMatchObject({ ok: false, error: expect.stringMatching(/manager's PIN/) });
    expect(await sales.refundAction(input, { staffId: michelle.id, pin: "0000" })).toMatchObject({ ok: false });
    const desk = await staffBy("coralville@rayz.test");
    expect(await sales.refundAction(input, { staffId: desk.id, pin: "4826" })).toMatchObject({ ok: false, error: expect.stringMatching(/Pick a manager/) });
    ok(await sales.refundAction(input, { staffId: michelle.id, pin: "4826" }));
    const [refund] = await m.db.db.select().from(m.schema.refunds).where(eq(m.schema.refunds.saleId, s.id));
    expect(refund.approvedBy).toBe(michelle.id);
    const [log] = await m.db.db
      .select()
      .from(m.schema.auditLog)
      .where(and(eq(m.schema.auditLog.entityId, s.id), eq(m.schema.auditLog.actorStaffId, desk.id)))
      .orderBy(m.drizzle.desc(m.schema.auditLog.at))
      .limit(1);
    expect(JSON.stringify(log)).toContain(michelle.displayLabel);
  });

  it("a shop manager reassigns a paid ticket to another barber without a PIN", async () => {
    const sales = await import("@/app/admin/sales/actions");
    const cv = await shop("coralville");
    const { s } = await paidSale(cv.id, true);
    const team = await m.db.db
      .select({ id: m.schema.staff.id })
      .from(m.schema.staff)
      .innerJoin(m.schema.staffShops, eq(m.schema.staffShops.staffId, m.schema.staff.id))
      .where(and(eq(m.schema.staffShops.shopId, cv.id), eq(m.schema.staff.kind, "person"), eq(m.schema.staff.isBookable, true)));
    const lines = await m.db.db.select({ staffId: m.schema.saleItems.staffId }).from(m.schema.saleItems).where(eq(m.schema.saleItems.saleId, s.id));
    const to = team.find((t) => t.id !== s.staffId && !lines.some((l) => l.staffId === t.id))!;
    await as("coralville@rayz.test");
    expect(await sales.reassignAction({ saleId: s.id, toStaffId: to.id, reason: "Rang up under the wrong barber" })).toMatchObject({ ok: false, error: expect.stringMatching(/manager's PIN/) });
    await as("michelle@rayz.test");
    expect(await sales.reassignAction({ saleId: s.id, toStaffId: to.id, reason: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/Say why/) });
    ok(await sales.reassignAction({ saleId: s.id, toStaffId: to.id, reason: "Rang up under the wrong barber" }));
    const after = (await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, s.id) }))!;
    expect(after.staffId).toBe(to.id);
    const [r] = await m.db.db.select().from(m.schema.saleReassignments).where(eq(m.schema.saleReassignments.saleId, s.id));
    expect([r.fromStaffId, r.toStaffId, r.approvedBy]).toEqual([s.staffId, to.id, null]);
    const tips = async (staffId: string) =>
      (await m.db.db.select().from(m.schema.tipLedger).where(and(eq(m.schema.tipLedger.saleId, s.id), eq(m.schema.tipLedger.staffId, staffId)))).reduce((a, t) => a + t.amountCents, 0);
    expect(await tips(s.staffId!)).toBe(0);
    expect(r.tipCents).toBeGreaterThan(0);
    expect(await tips(to.id)).toBe(r.tipCents);
  });
});

describe("the shop login's caps", () => {
  it("never exports or reveals clients and never sees staff contact details, whatever its role says", async () => {
    const access = await import("@/server/auth/access");
    const desk = await staffBy("coralville@rayz.test");
    const role = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.id, desk.roleId) }))!;
    expect(role.key).toBe("shop_login");
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "clients.export": true, "clients.reveal": true, "staff.contact": true, "sales.refund": true } }).where(eq(m.schema.staff.id, desk.id));
    const a = (await access.loadStaffAccess(desk.id))!;
    for (const p of ["clients.export", "clients.reveal", "staff.contact", "sales.refund"] as const) expect(a.permissions.has(p)).toBe(false);
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, desk.id));
  });

  it("client contact details are masked at most, and nobody can lift the cap, not even the Brand Owner", async () => {
    const privacy = await import("@/server/client-privacy");
    const auth = await import("@/server/auth/staff");
    expect(await privacy.shopLoginCap()).toBe("masked");
    await as("coralville@rayz.test");
    const policy = await privacy.clientPolicy(await auth.requireStaff());
    expect(policy.show("phone", "+13195551234")).not.toContain("555-1234");
    for (const who of ["admin@rayz.test", "owner@rayz.test"]) {
      await as(who);
      expect(await brandAction("setting", "shop_login_contact", "role"), who).toMatchObject({ ok: false, error: expect.stringMatching(/never in full/) });
    }
    await as("admin@rayz.test");
    ok(await brandAction("setting", "shop_login_contact", "hidden"));
    expect(await privacy.shopLoginCap()).toBe("hidden");
    await as("owner@rayz.test");
    ok(await brandAction("setting", "shop_login_contact", "masked"));
    const stored = (v: string) => m.db.db.update(m.schema.brandSettings).set({ shopLogin: m.drizzle.sql`${m.schema.brandSettings.shopLogin} || ${JSON.stringify({ clientContact: v })}::jsonb` });
    await stored("role");
    expect(await privacy.shopLoginCap()).toBe("masked");
    await stored("masked");
  });

  it("staff contact is masked for people without the permission, and a save keeps it", async () => {
    const staffActions = await import("@/app/admin/staff/actions");
    const michelle = await staffBy("michelle@rayz.test");
    const makenna = await staffBy("makenna@rayz.test");
    await m.db.db.update(m.schema.staff).set({ phone: "+13195557777" }).where(eq(m.schema.staff.id, makenna.id));
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "staff.contact": false } }).where(eq(m.schema.staff.id, michelle.id));
    await as("michelle@rayz.test");
    const page = await open("/admin/staff/[id]", { id: makenna.id });
    expect(page.kind).toBe("ok");
    expect(page.text).not.toContain("makenna@rayz.test");
    expect(page.text).not.toContain("5557777");
    expect(page.text).toContain("m***@rayz.test");
    const own = await open("/admin/staff/[id]", { id: michelle.id });
    expect(own.text).toContain("michelle@rayz.test");
    const links = await m.db.db.select({ shopId: m.schema.staffShops.shopId }).from(m.schema.staffShops).where(eq(m.schema.staffShops.staffId, makenna.id));
    ok(
      await staffActions.saveProfileAction({
        id: makenna.id,
        firstName: makenna.firstName,
        lastName: makenna.lastName ?? "",
        displayLabel: makenna.displayLabel,
        email: "",
        phone: "",
        color: makenna.color,
        isBookable: makenna.isBookable,
        active: true,
        squireName: makenna.squireName ?? "",
        shopIds: links.map((l) => l.shopId),
      }),
    );
    const kept = await staffBy("makenna@rayz.test");
    expect([kept.email, kept.phone]).toEqual(["makenna@rayz.test", "+13195557777"]);
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, michelle.id));
  });
});

describe("shop settings, part by part", () => {
  it("someone who may only change booking rules can't rename the shop", async () => {
    const settings = await import("@/app/admin/settings/actions");
    const frankie = await staffBy("frontdesk@rayz.test");
    const cv = await shop("coralville");
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "settings.shop_booking": true } }).where(eq(m.schema.staff.id, frankie.id));
    await as("frontdesk@rayz.test");
    const info = {
      name: cv.name,
      address: cv.address ?? "",
      city: cv.city ?? "",
      state: cv.state ?? "IA",
      zip: cv.zip ?? "",
      phone: cv.phone ?? "",
      email: cv.email ?? "",
      description: cv.description ?? "",
      bookingEnabled: cv.bookingEnabled,
      cancelCutoffMinutes: cv.cancelCutoffMinutes,
      minLeadMinutes: cv.minLeadMinutes,
      bookingWindowDays: cv.bookingWindowDays,
      bufferMinutes: cv.bufferMinutes,
    };
    expect(await settings.saveShopInfoAction(cv.id, { ...info, name: "Frankie's" })).toMatchObject({ ok: false, error: expect.stringMatching(/shop's name/) });
    expect(await settings.saveShopInfoAction(cv.id, { ...info, minLeadMinutes: cv.minLeadMinutes + 15 })).toMatchObject({ ok: false, error: expect.stringMatching(/set by the brand/) });
    await m.db.db.insert(m.schema.brandSyncControls).values({ type: "location_default", shopsCanEdit: true }).onConflictDoUpdate({ target: m.schema.brandSyncControls.type, set: { shopsCanEdit: true } });
    ok(await settings.saveShopInfoAction(cv.id, { ...info, minLeadMinutes: cv.minLeadMinutes + 15 }));
    expect((await shop("coralville")).minLeadMinutes).toBe(cv.minLeadMinutes + 15);
    expect(await settings.saveDrawerOpeningAction(cv.id, 20_000)).toMatchObject({ ok: false });
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, frankie.id));
    await m.db.db.update(m.schema.shops).set({ minLeadMinutes: cv.minLeadMinutes }).where(eq(m.schema.shops.id, cv.id));
    await m.db.db.delete(m.schema.brandSyncControls).where(eq(m.schema.brandSyncControls.type, "location_default"));
  });
});

describe("phone operator", () => {
  const at = (date: string, min: number) => m.time.zonedWallTime(date, min).toJSDate();
  const said = (xml: string) => xml.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  it("answers after hours, texts a booking link on 1, and the report counts the booking that follows", async () => {
    const settings = await import("@/app/admin/settings/actions");
    const line = await import("@/server/shop-line");
    const cv = await shop("coralville");
    await as("michelle@rayz.test");
    ok(await settings.savePhoneOperatorAction(cv.id, { enabled: true, answer: "fallback", minutesPerCall: 4, greeting: "" }));

    let mon = m.time.addDays(m.time.todayLocal(), 1);
    while (m.time.weekdayOf(mon) !== 1) mon = m.time.addDays(mon, 1);
    const from = "+13195550142";
    const menu = said(await line.handleIncomingCall({ from, to: cv.twilioNumber!, callSid: "CA-op-1" }, at(mon, 22 * 60)));
    expect(menu).toContain("We're closed right now.");
    expect(menu).toContain("Press 1");
    expect(menu).not.toContain("Press 3");
    expect(menu).toContain("voice/operator");

    const hours = said(await line.handleOperatorChoice({ callSid: "CA-op-1", digits: "2" }, at(mon, 22 * 60 + 1)));
    expect(hours).toMatch(/We're open .*Closed/);
    const booked = said(await line.handleOperatorChoice({ callSid: "CA-op-1", digits: "1" }, at(mon, 22 * 60 + 2)));
    expect(booked).toContain("We've texted you a link to book");
    const log = (await m.db.db.query.callLogs.findFirst({ where: eq(m.schema.callLogs.providerCallId, "CA-op-1") }))!;
    expect([log.operator, log.operatorChoice, log.autoTextSent, log.status]).toEqual([true, "book", true, "after_hours"]);

    const r = await open("/admin/reports/phone-operator", {}, { preset: "custom", from: m.time.addDays(mon, -1), to: m.time.addDays(mon, 1), shop: cv.id });
    expect(r.kind).toBe("ok");
    expect(r.text).toContain("Texted a booking link");
    ok(await settings.savePhoneOperatorAction(cv.id, { enabled: false, answer: "fallback", minutesPerCall: 3, greeting: "" }));
  });

  it("can't be turned on without a Twilio number", async () => {
    const settings = await import("@/app/admin/settings/actions");
    const dq = await shop("dubuque");
    await as("owner@rayz.test");
    if (dq.twilioNumber) return;
    expect(await settings.savePhoneOperatorAction(dq.id, { enabled: true, answer: "first", minutesPerCall: 3, greeting: "" })).toMatchObject({ ok: false, error: expect.stringMatching(/Twilio number/) });
  });
});

describe("new reports", () => {
  it("each loads for the shop login with the barber picker, and refuses export", async () => {
    await as("coralville@rayz.test");
    for (const href of ["end-of-day", "leaderboard", "sales-tax", "retention", "acquisition", "phone-operator"]) {
      const page = await open(`/admin/reports/${href}`);
      expect(page.kind, href).toBe("ok");
    }
    const exportCsv = (await import("@/app/admin/reports/export/route")).GET;
    const res = await exportCsv(new Request("http://localhost/admin/reports/export?type=end_of_day&table=sales"));
    expect(res.status).toBe(403);
  });

  it("the reports hub lists the saved reports, with each state's sales tax", async () => {
    await as("owner@rayz.test");
    const hub = await open("/admin/reports");
    expect(hub.kind).toBe("ok");
    for (const label of ["End of day", "Tips", "Gross and net sales", "Employee summary", "Total collected", "Iowa monthly sales tax"]) expect(hub.text).toContain(label);
  });
});
