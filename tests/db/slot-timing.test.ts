/**
 * Booking times against a real database: interval precedence (barber at shop, barber, shop, brand),
 * a barber with a different interval at each shop, per-barber and per-shop durations, prep and
 * cleanup buffers, changing an interval under existing bookings, the staff-only squeeze-in, the
 * database constraints behind it, who may change what, and DST days.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let timing: typeof import("@/app/admin/booking-times/actions");
let calendar: typeof import("@/app/admin/calendar/actions");
let serverTiming: typeof import("@/server/timing");
let cal: typeof import("@/server/calendar");

beforeAll(async () => {
  m = await loadModules();
  timing = await import("@/app/admin/booking-times/actions");
  calendar = await import("@/app/admin/calendar/actions");
  serverTiming = await import("@/server/timing");
  cal = await import("@/server/calendar");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);

const barber = async (label: string) => (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.displayLabel, label) }))!;
const shopOf = (slug: string) => m.catalog.getShop(slug);
const service = async (slug: string) => (await m.db.db.query.services.findFirst({ where: eq(m.schema.services.slug, slug) }))!;

async function login(email: string, shop?: string) {
  const s = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, email) }))!;
  await signInAs(s.id, shop);
}

/** The next `weekday` (0 = Sunday) at least `ahead` days out; each test uses its own week so bookings never meet. */
function dayOn(weekday: number, ahead: number) {
  let d = m.time.addDays(m.time.todayLocal(), ahead);
  while (m.time.weekdayOf(d) !== weekday) d = m.time.addDays(d, 1);
  return d;
}

let phoneSeq = 0;
async function client(firstName: string) {
  const [c] = await m.db.db
    .insert(m.schema.customers)
    .values({ firstName, lastName: "Timing", phone: `+1319555${String(6100 + ++phoneSeq)}` })
    .returning();
  return c;
}

async function starts(shopSlug: string, staffId: string, date: string, serviceSlug: string, addonSlugs: string[] = [], staffOverride = false) {
  const svc = await service(serviceSlug);
  const addonIds = await Promise.all(addonSlugs.map(async (s) => (await service(s)).id));
  const a = await m.booking.getAvailability({ shopRef: shopSlug, date, serviceId: svc.id, addonIds, barberRef: staffId, staffOverride });
  return { ...a, mins: a.slots.map((s) => m.time.localMinutesOf(s.startsAt)) };
}

async function column(shopSlug: string, date: string, staffId: string) {
  const shop = await shopOf(shopSlug);
  const day = await cal.loadDayCalendar(shop.id, date, null, { shopIds: [shop.id], brandWide: true }, { show: (_f, raw) => raw ?? null, stars: () => null }, { staffId: null, seesPrivate: true });
  return day.columns.find((c) => c.id === staffId)!;
}

/** Every start sits on the grid: a whole number of intervals after the start of one of the barber's stretches. */
const offGrid = (mins: number[], interval: number, origins: number[]) => mins.filter((t) => !origins.some((o) => t >= o && (t - o) % interval === 0));

async function staffBook(o: { shop: string; staffId: string; date: string; startMin: number; service: string; addons?: string[]; squeezeIn?: boolean; source?: "staff" | "online" }) {
  const svc = await service(o.service);
  const addonIds = await Promise.all((o.addons ?? []).map(async (s) => (await service(s)).id));
  const c = await client("Booked");
  return m.booking.createAppointment({
    shopRef: o.shop,
    serviceId: svc.id,
    addonIds,
    barberRef: o.staffId,
    startsAt: m.booking.staffWallTime(o.date, o.startMin),
    customerId: c.id,
    source: o.source ?? "staff",
    squeezeIn: o.squeezeIn,
    actor,
  });
}

const row = async (code: string) => (await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.code, code) }))!;
const cancel = (code: string) => m.booking.cancelAppointment(code, { actor, byCustomer: false });

describe("which interval applies", () => {
  it("barber at this shop beats barber, which beats shop, which beats the brand default", async () => {
    const [casey, skylar, delaney, makenna] = await Promise.all(["Casey", "Skylar", "Delaney", "Makenna"].map(barber));
    const leClaire = await serverTiming.staffIntervals(await shopOf("le-claire"), [casey.id, skylar.id]);
    expect(leClaire.get(casey.id)).toEqual({ minutes: 30, source: "barber_at_shop" });
    expect(leClaire.get(skylar.id)).toEqual({ minutes: 20, source: "shop" });
    const coralville = await serverTiming.staffIntervals(await shopOf("coralville"), [delaney.id, makenna.id, casey.id]);
    expect(coralville.get(delaney.id)).toEqual({ minutes: 20, source: "barber" });
    expect(coralville.get(makenna.id)).toEqual({ minutes: 15, source: "brand" });
    expect(coralville.get(casey.id)).toEqual({ minutes: 15, source: "brand" });
  });

  it("the day calendar gives each barber their own grid, side by side", async () => {
    const date = dayOn(3, 21);
    const [delaney, makenna] = await Promise.all(["Delaney", "Makenna"].map(barber));
    const d = await column("coralville", date, delaney.id);
    const k = await column("coralville", date, makenna.id);
    expect([d.intervalMin, d.intervalSource, k.intervalMin, k.intervalSource]).toEqual([20, "barber", 15, "brand"]);
    expect(d.gridStarts).toEqual([9 * 60]);
    const dStarts = (await starts("coralville", delaney.id, date, "rayz-cut")).mins;
    const kStarts = (await starts("coralville", makenna.id, date, "rayz-cut")).mins;
    expect(offGrid(dStarts, 20, d.gridStarts)).toEqual([]);
    expect(offGrid(kStarts, 15, k.gridStarts)).toEqual([]);
    expect(dStarts).toContain(9 * 60 + 20);
    expect(kStarts).toContain(9 * 60 + 15);
    expect(dStarts).not.toContain(9 * 60 + 15);
  });
});

describe("a barber who works at two shops", () => {
  it("has each shop's own interval online and at the front desk", async () => {
    await login("owner@rayz.test");
    const daisey = await barber("Daisey");
    const utica = dayOn(1, 22); // Mondays at Utica (9–6 hours)
    const leClaire = dayOn(5, 22); // Fridays at Le Claire, which runs on 20 minutes
    const uticaShop = await shopOf("utica");
    expect(await timing.saveBarberIntervalAction(daisey.id, uticaShop.id, 30)).toMatchObject({ ok: true });

    const u = await starts("utica", daisey.id, utica, "rayz-cut");
    const l = await starts("le-claire", daisey.id, leClaire, "rayz-cut");
    const uCol = await column("utica", utica, daisey.id);
    const lCol = await column("le-claire", leClaire, daisey.id);
    expect([uCol.intervalMin, uCol.intervalSource, lCol.intervalMin, lCol.intervalSource]).toEqual([30, "barber_at_shop", 20, "shop"]);
    expect(u.mins.length).toBeGreaterThan(5);
    expect(l.mins.length).toBeGreaterThan(5);
    expect(offGrid(u.mins, 30, uCol.gridStarts)).toEqual([]);
    expect(offGrid(l.mins, 20, lCol.gridStarts)).toEqual([]);
    const uOrigin = uCol.gridStarts[0];
    const lOrigin = lCol.gridStarts[0];

    // The front desk sees the same starts, and booking follows each shop's grid.
    await login("owner@rayz.test");
    const desk = await calendar.staffOpeningsAction({ shopId: uticaShop.id, staffId: daisey.id, date: utica, serviceId: (await service("rayz-cut")).id, addonIds: [] });
    expect(desk.ok && desk.data.starts.slice(0, 3)).toEqual([uOrigin, uOrigin + 30, uOrigin + 60]);
    await expect(staffBook({ shop: "utica", staffId: daisey.id, date: utica, startMin: uOrigin + 20, service: "rayz-cut" })).rejects.toMatchObject({ details: { offGrid: true } });
    const atUtica = await staffBook({ shop: "utica", staffId: daisey.id, date: utica, startMin: uOrigin + 30, service: "rayz-cut" });
    const atLeClaire = await staffBook({ shop: "le-claire", staffId: daisey.id, date: leClaire, startMin: lOrigin + 20, service: "rayz-cut" });
    expect(m.time.localMinutesOf((await row(atLeClaire.code)).startsAt)).toBe(lOrigin + 20);

    // Her everywhere setting beats Le Claire's, but not her own setting at Utica.
    expect(await timing.saveBarberIntervalAction(daisey.id, null, 15)).toMatchObject({ ok: true });
    expect((await column("le-claire", leClaire, daisey.id)).intervalMin).toBe(15);
    expect((await column("utica", utica, daisey.id)).intervalMin).toBe(30);
    expect((await starts("le-claire", daisey.id, leClaire, "rayz-cut")).mins).toContain(lOrigin + 45);

    expect(await timing.saveBarberIntervalAction(daisey.id, null, null)).toMatchObject({ ok: true });
    expect(await timing.saveBarberIntervalAction(daisey.id, uticaShop.id, null)).toMatchObject({ ok: true });
    expect((await column("utica", utica, daisey.id)).intervalSource).toBe("brand");
    await cancel(atUtica.code);
    await cancel(atLeClaire.code);
  });
});

describe("changing an interval", () => {
  it("leaves existing appointments where they are; only new openings move to the new grid", async () => {
    await login("owner@rayz.test");
    const makenna = await barber("Makenna");
    const cv = await shopOf("coralville");
    const date = dayOn(4, 23);
    const origin = (await column("coralville", date, makenna.id)).gridStarts[0];
    const booked = await staffBook({ shop: "coralville", staffId: makenna.id, date, startMin: origin + 15, service: "rayz-cut" });
    const before = await row(booked.code);

    expect(await timing.saveBarberIntervalAction(makenna.id, cv.id, 20)).toMatchObject({ ok: true });
    const after = await row(booked.code);
    expect([after.startsAt, after.endsAt, after.status]).toEqual([before.startsAt, before.endsAt, before.status]);
    const col = await column("coralville", date, makenna.id);
    expect(col.intervalMin).toBe(20);
    expect(col.appts.find((a) => a.id === after.id)?.startMin).toBe(origin + 15);

    // New openings are on the 20-minute grid and stay clear of the 9:15 booking (rayz cut is 20 minutes).
    const { mins } = await starts("coralville", makenna.id, date, "rayz-cut");
    expect(offGrid(mins, 20, col.gridStarts)).toEqual([]);
    expect(mins.slice(0, 2)).toEqual([origin + 40, origin + 60]);
    expect(mins).not.toContain(origin + 20);

    // The booking itself still works: confirm it; a move has to land on the new grid.
    await m.booking.setAppointmentStatus(after.id, "confirmed", actor);
    await expect(m.booking.rescheduleAppointment(booked.code, { startsAt: m.booking.staffWallTime(date, origin + 75), actor, byCustomer: false })).rejects.toMatchObject({
      details: { offGrid: true },
    });
    await m.booking.rescheduleAppointment(booked.code, { startsAt: m.booking.staffWallTime(date, origin + 80), actor, byCustomer: false });
    expect(m.time.localMinutesOf((await row(booked.code)).startsAt)).toBe(origin + 80);

    expect(await timing.saveBarberIntervalAction(makenna.id, cv.id, null)).toMatchObject({ ok: true });
    await cancel(booked.code);
  });
});

describe("service timing", () => {
  it("prep and cleanup are kept clear around the service, and stored on the booking", async () => {
    const jilane = await barber("Jilane");
    const moline = await shopOf("moline");
    const shaveSvc = await service("hot-towel-shave");
    const onMenu = and(eq(m.schema.shopServices.shopId, moline.id), eq(m.schema.shopServices.serviceId, shaveSvc.id));
    await m.db.db.update(m.schema.shopServices).set({ enabled: true }).where(onMenu);
    const date = dayOn(2, 24);
    const origin = (await column("moline", date, jilane.id)).gridStarts[0];
    const shave = await staffBook({ shop: "moline", staffId: jilane.id, date, startMin: origin + 60, service: "hot-towel-shave" });
    const r = await row(shave.code);
    expect([r.bufferBeforeMinutes, r.bufferMinutes]).toEqual([5, 10]);
    expect(r.busyFrom!.getTime()).toBe(r.startsAt.getTime() - 5 * 60_000);
    expect(r.busyUntil!.getTime()).toBe(r.endsAt!.getTime() + 10 * 60_000);

    // A 20-minute cut can end at the shave's prep, and start once its cleanup is done.
    const { mins } = await starts("moline", jilane.id, date, "rayz-cut");
    expect(mins).toContain(origin + 30); // ends 9:50, before the 9:55 prep
    expect(mins).not.toContain(origin + 45); // would end in the prep
    expect(mins).not.toContain(origin + 90); // shave ends 10:30, cleanup until 10:40
    expect(mins).toContain(origin + 105);

    // A second shave needs its own prep clear of the first one's cleanup.
    const shaves = (await starts("moline", jilane.id, date, "hot-towel-shave")).mins;
    expect(shaves).not.toContain(origin + 100);
    expect(shaves).toContain(origin + 105);
    await cancel(shave.code);
    await m.db.db.update(m.schema.shopServices).set({ enabled: false }).where(onMenu);
  });

  it("add-ons add to the service; a service's own increment beats the barber's grid", async () => {
    const delaney = await barber("Delaney");
    const date = dayOn(5, 25);
    const withTinsel = await starts("coralville", delaney.id, date, "rayz-cut", ["addon-tinsel"]);
    expect(withTinsel.durationMin).toBe(30);
    const b = await staffBook({ shop: "coralville", staffId: delaney.id, date, startMin: 9 * 60 + 20, service: "rayz-cut", addons: ["addon-tinsel"] });
    const r = await row(b.code);
    expect((r.endsAt!.getTime() - r.startsAt.getTime()) / 60_000).toBe(30);
    await cancel(b.code);

    // Gray blending books every 30 minutes even for Delaney, who is on 20.
    const gray = await starts("coralville", delaney.id, date, "gray-blending");
    expect(gray.mins.length).toBeGreaterThan(3);
    expect(offGrid(gray.mins, 30, [9 * 60])).toEqual([]);
    // 45 minutes plus 10 cleanup has to fit before the 6pm close.
    expect(Math.max(...gray.mins)).toBe(17 * 60);
  });

  it("a barber's own duration beats the shop's, at one shop or everywhere", async () => {
    await login("owner@rayz.test");
    const [casey, skylar, audra] = await Promise.all(["Casey", "Skylar", "Audra"].map(barber));
    const lc = await shopOf("le-claire");
    const cut = await service("rayz-cut-shampoo");
    const date = dayOn(3, 26);
    const length = async (staffId: string) => (await starts("le-claire", staffId, date, "rayz-cut-shampoo", [], true)).durationMin;
    // Seeded: Skylar does it in 30 at Le Claire; everyone else takes the brand's 40.
    expect([await length(casey.id), await length(skylar.id), await length(audra.id)]).toEqual([40, 30, 40]);

    expect(await timing.saveShopDurationAction(lc.id, cut.id, 45)).toMatchObject({ ok: true });
    expect([await length(casey.id), await length(skylar.id), await length(audra.id)]).toEqual([45, 30, 45]);
    expect(await timing.saveBarberDurationAction(casey.id, cut.id, null, 50)).toMatchObject({ ok: true });
    expect(await length(casey.id)).toBe(50);
    expect(await timing.saveBarberDurationAction(casey.id, cut.id, lc.id, 35)).toMatchObject({ ok: true });
    expect(await length(casey.id)).toBe(35);

    // Saving the everywhere duration again updates the one row rather than adding a second.
    expect(await timing.saveBarberDurationAction(casey.id, cut.id, null, 55)).toMatchObject({ ok: true });
    const rows = await m.db.db
      .select()
      .from(m.schema.staffServiceDurations)
      .where(and(eq(m.schema.staffServiceDurations.staffId, casey.id), eq(m.schema.staffServiceDurations.serviceId, cut.id)));
    expect(rows.map((r) => `${r.shopId}:${r.durationMin}`).sort()).toEqual([`${lc.id}:35`, "null:55"].sort());

    // A booking takes the barber's length, and their grid: Casey is on 30 at Le Claire.
    const origin = (await column("le-claire", date, casey.id)).gridStarts[0];
    const b = await staffBook({ shop: "le-claire", staffId: casey.id, date, startMin: origin + 60, service: "rayz-cut-shampoo" });
    const r = await row(b.code);
    expect((r.endsAt!.getTime() - r.startsAt.getTime()) / 60_000).toBe(35);
    await cancel(b.code);

    expect(await timing.saveBarberDurationAction(casey.id, cut.id, lc.id, null)).toMatchObject({ ok: true });
    expect(await timing.saveBarberDurationAction(casey.id, cut.id, null, null)).toMatchObject({ ok: true });
    expect(await timing.saveShopDurationAction(lc.id, cut.id, null)).toMatchObject({ ok: true });
    expect([await length(casey.id), await length(skylar.id), await length(audra.id)]).toEqual([40, 30, 40]);
  });

  it("durations follow the service's step, and the step can't strand an existing duration", async () => {
    await login("owner@rayz.test");
    const cv = await shopOf("coralville");
    const gray = await service("gray-blending");
    const fade = await service("specialty-fade");
    const casey = await barber("Casey");
    expect(await timing.saveShopDurationAction(cv.id, gray.id, 50)).toMatchObject({ ok: false, error: expect.stringMatching(/15/) });
    expect(await timing.saveBarberDurationAction(casey.id, gray.id, null, 40)).toMatchObject({ ok: false });
    expect(await timing.saveShopDurationAction(cv.id, gray.id, 60)).toMatchObject({ ok: true });
    expect(await timing.saveShopDurationAction(cv.id, gray.id, null)).toMatchObject({ ok: true });

    const fadeTiming = { defaultDurationMin: 45, durationStepMin: 15, bookingIncrementMin: null, bufferBeforeMin: 0, bufferAfterMin: 0 };
    const r = await timing.saveServiceTimingAction(fade.id, fadeTiming);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Casey (40 min)") });
    expect(await timing.saveServiceTimingAction(fade.id, { ...fadeTiming, durationStepMin: 5, bufferAfterMin: 5 })).toMatchObject({ ok: true });
    const log = await m.db.db.query.auditLog.findFirst({ where: and(eq(m.schema.auditLog.action, "timing.service"), eq(m.schema.auditLog.entityId, fade.id)) });
    expect(log?.details).toMatchObject({ changed: { bufferAfterMin: { from: 0, to: 5 } } });
    expect(await timing.saveServiceTimingAction(fade.id, { ...fadeTiming, durationStepMin: 5 })).toMatchObject({ ok: true });
  });
});

describe("who may change booking times", () => {
  it("shop managers set their shop and barbers; only brand-wide staff set the brand default and the catalog", async () => {
    const cv = await shopOf("coralville");
    const moline = await shopOf("moline");
    const [makenna, casey] = await Promise.all(["Makenna", "Casey"].map(barber));
    const fade = await service("specialty-fade");
    const fadeTiming = { defaultDurationMin: 45, durationStepMin: 5, bookingIncrementMin: null, bufferBeforeMin: 0, bufferAfterMin: 0 };

    await login("michelle@rayz.test");
    expect(await timing.saveShopIntervalAction(cv.id, 30)).toMatchObject({ ok: true });
    expect(await timing.saveBarberIntervalAction(makenna.id, cv.id, 20)).toMatchObject({ ok: true });
    expect(await timing.saveBarberIntervalAction(makenna.id, null, 20)).toMatchObject({ ok: true }); // she only works at Coralville
    expect(await timing.saveBarberIntervalAction(casey.id, null, 20)).toMatchObject({ ok: false, error: expect.stringMatching(/outside your access/) });
    expect(await timing.saveShopIntervalAction(moline.id, 30)).toMatchObject({ ok: false });
    expect(await timing.saveBrandIntervalAction(20)).toMatchObject({ ok: false, error: expect.stringMatching(/every shop shares/) });
    expect(await timing.saveServiceTimingAction(fade.id, fadeTiming)).toMatchObject({ ok: false, error: expect.stringMatching(/every shop shares/) });
    expect(await timing.saveShopIntervalAction(cv.id, 7)).toMatchObject({ ok: false, error: expect.stringMatching(/multiple of 5/) });
    expect(await timing.saveShopIntervalAction(cv.id, 25)).toMatchObject({ ok: true });
    const log = await m.db.db.query.auditLog.findMany({ where: and(eq(m.schema.auditLog.action, "timing.shop_interval"), eq(m.schema.auditLog.entityId, cv.id)) });
    expect(log.map((l) => l.details)).toEqual([
      { from: null, to: 30 },
      { from: 30, to: 25 },
    ]);
    for (const [s, b] of [
      [cv.id, makenna.id],
      [null, makenna.id],
    ] as const)
      expect(await timing.saveBarberIntervalAction(b, s, null)).toMatchObject({ ok: true });
    expect(await timing.saveShopIntervalAction(cv.id, null)).toMatchObject({ ok: true });

    await login("makenna@rayz.test");
    expect(await timing.saveShopIntervalAction(cv.id, 30)).toMatchObject({ ok: false });
    expect(await timing.saveBarberIntervalAction(makenna.id, cv.id, 30)).toMatchObject({ ok: false });

    await login("owner@rayz.test");
    expect(await timing.saveBrandIntervalAction(20)).toMatchObject({ ok: true });
    expect((await serverTiming.staffIntervals(cv, [makenna.id])).get(makenna.id)).toEqual({ minutes: 20, source: "brand" });
    expect(await timing.saveBrandIntervalAction(15)).toMatchObject({ ok: true });
    expect(await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, cv.id) })).toMatchObject({ slotIntervalMinutes: null });
  });
});

describe("squeeze in", () => {
  it("is for staff with the permission, logged, and still never double-books the chair", async () => {
    const makenna = await barber("Makenna");
    const cv = await shopOf("coralville");
    const date = dayOn(2, 27);
    const rayzCut = await service("rayz-cut");
    const c = await client("Squeeze");
    const book = (startMin: number, squeezeIn?: boolean) =>
      calendar.createStaffAppointmentAction({ shopId: cv.id, staffId: makenna.id, date, startMin, serviceId: rayzCut.id, addonIds: [], customerId: c.id, squeezeIn });

    await login("makenna@rayz.test");
    const own = await calendar.staffOpeningsAction({ shopId: cv.id, staffId: makenna.id, date, serviceId: rayzCut.id, addonIds: [] });
    expect(own).toMatchObject({ ok: true, data: { canSqueeze: false, durationMin: 20 } });
    expect(await book(10 * 60 + 7)).toMatchObject({ ok: false, error: expect.stringMatching(/isn't on Makenna's 15-minute grid/) });
    expect(await book(10 * 60 + 7, true)).toMatchObject({ ok: false, error: expect.stringMatching(/can't squeeze in/) });

    await login("michelle@rayz.test");
    expect(await calendar.staffOpeningsAction({ shopId: cv.id, staffId: makenna.id, date, serviceId: rayzCut.id, addonIds: [] })).toMatchObject({ ok: true, data: { canSqueeze: true } });
    const squeezed = await book(10 * 60 + 7, true);
    expect(squeezed.ok).toBe(true);
    const r = await row((squeezed as { data: { code: string } }).data.code);
    expect([r.squeezed, m.time.localMinutesOf(r.startsAt)]).toEqual([true, 10 * 60 + 7]);
    const log = await m.db.db.query.auditLog.findFirst({ where: and(eq(m.schema.auditLog.action, "appointment.squeeze_in"), eq(m.schema.auditLog.entityId, r.id)) });
    expect(log?.details).toMatchObject({ bypasses: ["off_grid"] });

    // Overlapping its service time is refused even when squeezing.
    expect(await book(10 * 60 + 15, true)).toMatchObject({ ok: false });
    // Before opening is fine for staff who squeeze, and logged as such.
    const early = await book(8 * 60 + 30, true);
    expect(early.ok).toBe(true);
    const earlyRow = await row((early as { data: { code: string } }).data.code);
    const earlyLog = await m.db.db.query.auditLog.findFirst({ where: and(eq(m.schema.auditLog.action, "appointment.squeeze_in"), eq(m.schema.auditLog.entityId, earlyRow.id)) });
    expect(earlyLog?.details).toMatchObject({ bypasses: expect.arrayContaining(["outside_hours"]) });

    // Moving needs the grid too, or a logged squeeze.
    expect(await calendar.moveAppointmentAction(earlyRow.id, makenna.id, date, 11 * 60 + 3)).toMatchObject({ ok: false });
    expect(await calendar.moveAppointmentAction(earlyRow.id, makenna.id, date, 11 * 60 + 3, { squeezeIn: true })).toMatchObject({ ok: true });
    const moveLog = await m.db.db.query.auditLog.findMany({ where: and(eq(m.schema.auditLog.action, "appointment.squeeze_in"), eq(m.schema.auditLog.entityId, earlyRow.id)) });
    expect(moveLog.some((l) => (l.details as { moved?: boolean }).moved)).toBe(true);
    expect(await calendar.moveAppointmentAction(earlyRow.id, makenna.id, date, 12 * 60)).toMatchObject({ ok: true });
    expect((await row(earlyRow.code)).squeezed).toBe(false);

    // Online, squeezing isn't on offer at all.
    await expect(m.booking.createAppointment({ shopRef: "coralville", serviceId: rayzCut.id, barberRef: makenna.id, startsAt: m.booking.staffWallTime(date, 13 * 60 + 7), customerId: c.id, source: "online", squeezeIn: true, actor })).rejects.toMatchObject({
      code: "forbidden",
    });
    await cancel(r.code);
    await cancel(earlyRow.code);
  });

  it("the database lets a squeezed booking into buffer time, but never into another service", async () => {
    const makenna = await barber("Makenna");
    const cv = await shopOf("coralville");
    const date = dayOn(4, 28);
    const at = (min: number) => m.booking.staffWallTime(date, min);
    const base = { staffId: makenna.id, shopId: cv.id, status: "booked" as const, source: "staff" as const };
    const codes = ["TESTSQZ01", "TESTSQZ02", "TESTSQZ03", "TESTSQZ04"];
    await m.db.db.insert(m.schema.appointments).values({ ...base, code: codes[0], startsAt: at(600), endsAt: at(630), bufferMinutes: 10 });
    await expect(m.db.db.insert(m.schema.appointments).values({ ...base, code: codes[1], startsAt: at(635), endsAt: at(660) })).rejects.toThrow();
    await m.db.db.insert(m.schema.appointments).values({ ...base, code: codes[2], startsAt: at(635), endsAt: at(660), squeezed: true });
    await expect(m.db.db.insert(m.schema.appointments).values({ ...base, code: codes[3], startsAt: at(650), endsAt: at(670), squeezed: true })).rejects.toThrow();
    await m.db.db.delete(m.schema.appointments).where(m.drizzle.inArray(m.schema.appointments.code, codes));
  });
});

describe("DST days", () => {
  it("starts stay on the wall-clock grid the day clocks fall back and the day they spring forward", async () => {
    const delaney = await barber("Delaney");
    const cv = await shopOf("coralville");
    const sundays = ["2026-11-01", "2027-03-14"];
    await m.db.db.insert(m.schema.shopHours).values({ shopId: cv.id, weekday: 0, openMin: 9 * 60, closeMin: 13 * 60 });
    await m.db.db.insert(m.schema.staffSchedules).values({ staffId: delaney.id, shopId: cv.id, weekday: 0, startMin: 9 * 60, endMin: 13 * 60 });
    try {
      for (const date of sundays) {
        const { mins, slots } = await starts("coralville", delaney.id, date, "rayz-cut", [], true);
        // 9:00 to 12:40 every 20 minutes: 12 starts, in local time, whatever the UTC offset that day.
        expect(mins, date).toEqual(Array.from({ length: 12 }, (_, i) => 9 * 60 + i * 20));
        const gaps = slots.slice(1).map((s, i) => (new Date(s.startsAt).getTime() - new Date(slots[i].startsAt).getTime()) / 60_000);
        expect(new Set(gaps), date).toEqual(new Set([20]));
        const b = await staffBook({ shop: "coralville", staffId: delaney.id, date, startMin: 9 * 60 + 40, service: "rayz-cut" });
        expect(m.time.localMinutesOf((await row(b.code)).startsAt), date).toBe(9 * 60 + 40);
        await cancel(b.code);
      }
    } finally {
      await m.db.db.delete(m.schema.staffSchedules).where(and(eq(m.schema.staffSchedules.staffId, delaney.id), eq(m.schema.staffSchedules.weekday, 0)));
      await m.db.db.delete(m.schema.shopHours).where(and(eq(m.schema.shopHours.shopId, cv.id), eq(m.schema.shopHours.weekday, 0)));
    }
  });
});
