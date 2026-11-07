/**
 * Self-service locations: a shop added through the Add Location wizard shows up everywhere a shop
 * can (booking, calendar, POS, reports, permissions, location groups) once it goes live, with
 * nothing in code naming it. Archiving it takes it out of booking and the pickers, and its history
 * stays in every report. Also staff offboarding and brand-editable messages and picklists.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let setup: typeof import("@/app/admin/setup/actions");
let exportCsv: typeof import("@/app/admin/reports/export/route").GET;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const cash = { method: "cash" as const, cashTenderedCents: null };
const ids: Record<string, string> = {};
const NAME = "Bettendorf";
const SLUG = "bettendorf";
const DAYS = [1, 4, 5, 6];
let shopId = "";
let groupId = "";
let bookDate = "";
let serviceId = "";
let loginEmail = "";

const staffBy = async (where: ReturnType<typeof eq>) => (await m.db.db.query.staff.findFirst({ where }))!;
const context = async (staffId: string, shop?: string) => {
  await signInAs(staffId, shop);
  const { getStaffContext } = await import("@/server/auth/staff");
  return getStaffContext();
};
const csv = async (q: Record<string, string>) => {
  const res = await exportCsv(new Request(`http://localhost/admin/reports/export?${new URLSearchParams({ type: "sales_summary", table: "summary", view: "shops", ...q })}`));
  return { status: res.status, rows: (await res.text()).trim().split("\n").map((l) => l.split(",")) };
};

beforeAll(async () => {
  m = await loadModules();
  setup = await import("@/app/admin/setup/actions");
  exportCsv = (await import("@/app/admin/reports/export/route")).GET;
  for (const k of ["owner", "admin", "regional", "makenna"]) ids[k] = (await staffBy(eq(m.schema.staff.email, `${k}@rayz.test`))).id;
  ids.casey = (await staffBy(eq(m.schema.staff.displayLabel, "Casey"))).id;
  groupId = (await m.db.db.query.locationGroups.findFirst({ where: eq(m.schema.locationGroups.name, "Quad Cities") }))!.id;
  const today = m.time.todayLocal();
  for (let i = 2; i < 14 && !bookDate; i++) {
    const d = m.time.addDays(today, i);
    if (m.time.weekdayOf(d) === 4) bookDate = d;
  }
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("a location added through the wizard", () => {
  it("is saved in setup, hidden from clients, with a checklist that blocks go-live", async () => {
    await signInAs(ids.owner);
    const { wizardOptions } = await import("@/server/location-admin");
    const { draftDefaults } = await import("@/domain/location-draft");
    const { staffGrantor, getStaffContext } = await import("@/server/auth/staff");
    const opts = await wizardOptions(staffGrantor((await getStaffContext())!));
    const moline = opts.shops.find((s) => s.name === "Moline")!;
    const menu = opts.shopServices.filter((s) => s.shopId === moline.id && s.enabled);
    serviceId = opts.services.find((s) => s.kind === "service" && menu.some((x) => x.serviceId === s.id))!.id;
    const product = opts.shopProducts.find((p) => p.shopId === moline.id)!;
    const frontDesk = opts.loginRoles[0];
    loginEmail = `${SLUG}-desk@rayz.test`;

    const made = await setup.createLocationAction(
      draftDefaults({
        name: NAME,
        slug: SLUG,
        address: "2200 Kimberly Rd",
        city: "Bettendorf",
        state: "IA",
        zip: "52722",
        phone: "5635550199",
        serviceTaxRate: 0.07,
        productTaxRate: 0.07,
        taxRatesVerified: true,
        services: menu.map((s) => ({ serviceId: s.serviceId, enabled: true, bookableOnline: s.bookableOnline, priceCents: s.serviceId === serviceId ? 3300 : null, durationMin: null })),
        products: [{ productId: product.productId, priceCents: product.priceCents, parLevel: 6, lowStockThreshold: 2 }],
        vendors: opts.vendors.slice(0, 1).map((v) => ({ vendorId: v.id, accountNumber: "BTF-001" })),
        staff: [{ staffId: ids.casey, bookable: true, access: true, primary: false, schedule: DAYS.map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) }],
        locationGroupIds: [groupId],
        payCalendarFromShopId: moline.id,
        login: { label: "Bettendorf desk", email: loginEmail, roleId: frontDesk.id },
        readers: [{ label: "Front counter", serialNumber: "WSC-1", stripeReaderId: null }],
        accentColor: "#0f766e",
      }),
    );
    expect(made).toMatchObject({ ok: true, data: { slug: SLUG, login: { email: loginEmail } } });
    shopId = (made as { data: { id: string } }).data.id;

    const s = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, shopId) }))!;
    expect(s).toMatchObject({ status: "setup", timezone: "America/Chicago", active: true });
    const hours = await m.db.db.select().from(m.schema.shopHours).where(eq(m.schema.shopHours.shopId, shopId));
    expect(hours.map((h) => h.weekday).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await m.public.publicShops()).map((x) => x.slug)).not.toContain(SLUG);
    await expect(m.public.publicShop(SLUG)).rejects.toMatchObject({ code: "not_found" });

    const { locationSetup } = await import("@/server/location-setup");
    expect((await locationSetup(shopId))!.blockers).toEqual(["payments"]);
    expect(await setup.goLiveAction(shopId, false)).toMatchObject({ ok: false, error: expect.stringMatching(/Finish these first/) });
  });

  it("goes live and then shows in booking, the calendar, POS, reports, permissions and groups", async () => {
    await signInAs(ids.owner);
    expect(await setup.startPaymentsOnboardingAction(shopId)).toMatchObject({ ok: true });
    expect(await setup.completeSimulatedOnboardingAction(shopId, true)).toMatchObject({ ok: true });
    expect(await setup.goLiveAction(shopId, false)).toEqual({ ok: true, data: null });

    // Booking
    expect((await m.public.publicShops()).map((x) => x.slug)).toContain(SLUG);
    const avail = await m.booking.getAvailability({ shopRef: SLUG, date: bookDate, serviceId, barberRef: "any" });
    expect(avail.slots.length).toBeGreaterThan(0);
    const appt = await m.booking.createAppointment({
      shopRef: SLUG,
      serviceId,
      barberRef: "any",
      startsAt: avail.slots[0].startsAt,
      customer: { firstName: "Quinn", lastName: "Tester", phone: "5635550142", email: null },
      source: "online",
      actor,
    });
    expect(appt.code).toBeTruthy();

    // Calendar
    const cal = await open("/admin/calendar", {}, { date: bookDate, shop: shopId });
    expect(cal.kind).toBe("ok");
    expect(cal.text).toContain("Casey");
    expect(cal.text).toContain(appt.code);

    // POS
    const sale = await m.checkout.openBlankSale(shopId, actor, ids.casey);
    const r = await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: serviceId, qty: 1 }], tipCents: 500, tender: cash, actor });
    expect(r.totals.serviceGrossCents).toBe(3300);

    // Reports: the brand and the location group pick it up
    await signInAs(ids.admin);
    const today = m.time.todayLocal();
    const all = await csv({ shop: "all", from: today, to: today });
    expect(all.rows.find((x) => x[0] === NAME)?.[1]).toBe("1");
    const group = await csv({ shop: `group:${groupId}`, from: today, to: today });
    expect(group.rows.map((x) => x[0])).toContain(NAME);

    // Permissions: everyone with every shop sees it, a regional manager doesn't, its login sees only it
    expect((await context(ids.owner))!.shopIds).toContain(shopId);
    expect((await context(ids.admin))!.assignedShops.map((s) => s.id)).toContain(shopId);
    expect((await context(ids.regional))!.shopIds).not.toContain(shopId);
    const login = await staffBy(eq(m.schema.staff.email, loginEmail));
    expect((await context(login.id))!.shopIds).toEqual([shopId]);
    await signInAs(ids.admin);
    const people = await open("/admin/permissions/people/[id]", { id: ids.makenna });
    expect(people.text).toContain(NAME);
    const caseyAt = await m.db.db.select().from(m.schema.staffShops).where(eq(m.schema.staffShops.staffId, ids.casey));
    expect(caseyAt.length).toBeGreaterThan(2);
  });

  it("archives: out of booking, the switcher and pickers, logins off; its history stays in reports", async () => {
    await signInAs(ids.owner);
    const blocked = await setup.archiveLocationAction(shopId, NAME);
    expect(blocked).toMatchObject({ ok: false, error: expect.stringMatching(/upcoming appointment/) });
    const [a] = await m.db.db.select().from(m.schema.appointments).where(eq(m.schema.appointments.shopId, shopId));
    await m.booking.cancelAppointment(a.code, { actor, byCustomer: false, reason: "test" });
    expect(await setup.archiveLocationAction(shopId, "wrong name")).toMatchObject({ ok: false });
    const done = await setup.archiveLocationAction(shopId, NAME);
    expect(done).toMatchObject({ ok: true, data: { loginsDisabled: 1 } });

    expect((await m.public.publicShops()).map((x) => x.slug)).not.toContain(SLUG);
    await expect(m.public.publicShop(SLUG)).rejects.toMatchObject({ code: "not_found" });
    await expect(m.checkout.openBlankSale(shopId, actor)).rejects.toThrow(/archived/);
    const login = await staffBy(eq(m.schema.staff.email, loginEmail));
    expect(login.active).toBe(false);
    expect(await context(login.id)).toBeNull();

    const admin = (await context(ids.admin))!;
    expect(admin.shopIds).toContain(shopId);
    expect(admin.assignedShops.map((s) => s.id)).not.toContain(shopId);
    const { openShops } = await import("@/server/auth/staff");
    expect(openShops(admin).map((s) => s.id)).not.toContain(shopId);
    expect(await m.db.db.select().from(m.schema.staffSchedules).where(eq(m.schema.staffSchedules.shopId, shopId))).toEqual([]);

    await signInAs(ids.admin);
    const today = m.time.todayLocal();
    const all = await csv({ shop: "all", from: today, to: today });
    expect(all.rows.find((x) => x[0] === NAME)?.[1]).toBe("1");
    expect((await csv({ shop: shopId, from: today, to: today })).status).toBe(200);
    const group = await m.db.db.select().from(m.schema.locationGroupShops).where(eq(m.schema.locationGroupShops.shopId, shopId));
    expect(group).toHaveLength(1);
    const audits = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, shopId));
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(["shop.create", "shop.go_live", "shop.archive"]));
    expect((await open("/admin/permissions/people/[id]", { id: ids.makenna })).text).toContain(`${NAME} (archived)`);
  });
});

describe("staff offboarding", () => {
  it("signs them out at once, takes them off booking and schedules, and lists what's still booked", async () => {
    const coralville = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
    const before = await m.booking.getAvailability({ shopRef: "coralville", date: bookDate, serviceId: (await m.catalog.shopCatalog(coralville.id)).find((s) => s.kind === "service")!.id, barberRef: "any" });
    const slot = before.slots.find((s) => s.barberIds.includes(ids.makenna));
    const svc = (await m.catalog.shopCatalog(coralville.id)).find((s) => s.kind === "service")!;
    const booked = slot
      ? await m.booking.createAppointment({ shopRef: "coralville", serviceId: svc.id, barberRef: ids.makenna, startsAt: slot.startsAt, customer: { firstName: "Robin", lastName: "Case", phone: "3195550188", email: null }, source: "staff", actor })
      : null;

    await signInAs(ids.makenna);
    const { getStaffContext } = await import("@/server/auth/staff");
    expect(await getStaffContext()).not.toBeNull();
    const makennaJar = await import("./session").then((s) => ({ ...s.jar }));
    await new Promise((r) => setTimeout(r, 1100));

    await signInAs(ids.admin);
    const staff = await import("@/app/admin/staff/actions");
    expect(await staff.offboardStaffAction(ids.makenna, "Wrong", "")).toMatchObject({ ok: false, error: expect.stringMatching(/to confirm/) });
    expect(await staff.offboardStaffAction(ids.admin, "Admin", "")).toMatchObject({ ok: false });
    const r = await staff.offboardStaffAction(ids.makenna, "makenna", "Moved away");
    expect(r.ok).toBe(true);
    expect((r as { data: { schedules: number } }).data.schedules).toBeGreaterThan(0);

    const s = await import("./session");
    s.jar.token = makennaJar.token;
    expect(await getStaffContext()).toBeNull();
    await m.db.db.update(m.schema.staff).set({ active: true }).where(eq(m.schema.staff.id, ids.makenna));
    expect(await getStaffContext()).toBeNull();
    await m.db.db.update(m.schema.staff).set({ active: false }).where(eq(m.schema.staff.id, ids.makenna));

    const p = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, ids.makenna) }))!;
    expect(p).toMatchObject({ active: false, isBookable: false });
    expect(await m.db.db.select().from(m.schema.staffSchedules).where(eq(m.schema.staffSchedules.staffId, ids.makenna))).toEqual([]);
    const after = await m.booking.getAvailability({ shopRef: "coralville", date: bookDate, serviceId: svc.id, barberRef: "any" });
    expect(after.slots.some((x) => x.barberIds.includes(ids.makenna))).toBe(false);
    const { futureBookings } = await import("@/server/offboarding");
    const ahead = await futureBookings(ids.makenna);
    expect(ahead.length).toBe((r as { data: { bookings: number } }).data.bookings);
    if (booked) expect(ahead.map((b) => b.code)).toContain(booked.code);
    await signInAs(ids.admin);
    const page = await open("/admin/staff/[id]", { id: ids.makenna });
    if (booked) expect(page.text).toContain("Still booked with them");
    const audit = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, ids.makenna));
    expect(audit.map((x) => x.action)).toContain("staff.offboard");
  });
});

describe("brand-editable messages and picklists", () => {
  it("a saved reminder wording is what the next booking's messages use; reset puts the default back", async () => {
    await signInAs(ids.admin);
    expect(await brandAction("setting", "message.confirmation", { subject: "{shop}", body: "Booked {when} {nope}" })).toMatchObject({ ok: false, error: expect.stringMatching(/\{nope\}/) });
    expect(await brandAction("setting", "message.confirmation", { subject: "{shop}: booked", body: "{shop}: See you {when}, {first_name}! Change it: {link}" })).toMatchObject({ ok: true });
    const avail = await m.booking.getAvailability({ shopRef: "moline", date: bookDate, serviceId, barberRef: "any" });
    const a = await m.booking.createAppointment({
      shopRef: "moline",
      serviceId,
      barberRef: "any",
      startsAt: avail.slots[0].startsAt,
      customer: { firstName: "Avery", lastName: "Msg", phone: "3095550177", email: null, smsOptIn: true },
      source: "online",
      actor,
    });
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.appointmentId, a.id));
    const conf = jobs.find((j) => j.kind === "confirmation")!;
    expect(conf.body).toMatch(/^Ray'z Moline: See you .+, Avery! Change it: .+\/a\//);
    expect(jobs.find((j) => j.kind === "reminder_2h")?.body).toMatch(/up to 30 min before/);
    expect(await brandAction("setting", "message.confirmation", null)).toMatchObject({ ok: true });

    await signInAs(ids.regional);
    expect(await brandAction("setting", "message.confirmation", { subject: "x", body: "{link}" })).toMatchObject({ ok: false });
  });

  it("picklists save cleaned and show up as suggestions at checkout and refunds", async () => {
    await signInAs(ids.admin);
    expect(await brandAction("setting", "lookup.discountReasons", [" Veteran ", "veteran", "Teacher"])).toMatchObject({ ok: true });
    const { lookups } = await import("@/server/lookups");
    const l = await lookups();
    expect(l.discountReasons).toEqual(["Veteran", "Teacher"]);
    expect(l.serviceCategories.length).toBeGreaterThan(0);
    await signInAs(ids.regional);
    expect(await brandAction("setting", "lookup.discountReasons", ["x"])).toMatchObject({ ok: false });
  });
});
