/**
 * Block and time off reasons against a real database. Makenna blocks out time with a private
 * reason, a public one, and a private time off with notes that carry unique markers. The front desk
 * (who can't see private reasons) opens every page and export that lists blocks and time off and
 * must get "Blocked" or "Time off" for the private ones, never their label or note, while the
 * public one shows in full. Her manager and Makenna herself see everything. Customers booking
 * online never get a reason at all. Every entry's reason is in the audit log, hidden the same way.
 * Managers edit the list: renames carry to existing entries, archived reasons can't be picked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { found, get, open, propsOf, textOf } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let mine: typeof import("@/app/admin/my-time/actions");
let decide: typeof import("@/app/admin/time-off/actions");
let admin: typeof import("@/app/admin/block-reasons/actions");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const PRIVATE_LABEL = "Quokka Visit";
const MARK = { secret: "QUOKKA-NOTE-7731", doctor: "DOC-OFF-5521", bank: "BANK-NOTE-4410" };
const HIDDEN = [PRIVATE_LABEL, MARK.secret, MARK.doctor];

const people: Record<string, string> = {};
const as = (who: string) => signInAs(people[who]);
let cv: { id: string; name: string; slug: string };
let day: string;
let reasons = new Map<string, string>();
const rid = (key: string) => reasons.get(key)!;
const ids = {} as { secretBlock: string; bankBlock: string; request: string; quokka: string };

function ok<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error!);
const blocksOf = async (staffId: string) => m.db.db.select().from(m.schema.timeBlocks).where(eq(m.schema.timeBlocks.staffId, staffId));

beforeAll(async () => {
  m = await loadModules();
  mine = await import("@/app/admin/my-time/actions");
  decide = await import("@/app/admin/time-off/actions");
  admin = await import("@/app/admin/block-reasons/actions");
  for (const who of ["owner", "michelle", "makenna", "frontdesk"]) people[who] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${who}@rayz.test`) }))!.id;
  cv = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!;
  reasons = new Map((await m.db.db.select().from(m.schema.blockReasons)).map((r) => [r.key, r.id]));

  // A day soon that Makenna works at Coralville and the shop is open.
  const hours = await m.db.db.select().from(m.schema.staffSchedules).where(m.drizzle.and(eq(m.schema.staffSchedules.staffId, people.makenna), eq(m.schema.staffSchedules.shopId, cv.id)));
  const closed = new Set((await m.db.db.select().from(m.schema.shopClosures)).map((c) => c.date));
  day = m.time.addDays(m.time.todayLocal(), 1);
  while (!hours.some((h) => h.weekday === m.time.weekdayOf(day)) || closed.has(day)) day = m.time.addDays(day, 1);
  // The sample bookings can fill a busy day; clear hers so the online check has open time either side of the blocks.
  await m.db.db
    .update(m.schema.appointments)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(
      m.drizzle.and(
        eq(m.schema.appointments.staffId, people.makenna),
        m.drizzle.gte(m.schema.appointments.startsAt, m.time.startOfLocalDay(day)),
        m.drizzle.lt(m.schema.appointments.startsAt, m.time.endOfLocalDay(day)),
      ),
    );

  await as("owner");
  ids.quokka = ok(
    await admin.saveReasonAction({ id: null, label: PRIVATE_LABEL, color: "#ef4444", usedFor: "blocks", countsAsLunch: false, noticeExempt: false, private: true }),
  ).id;

  await as("makenna");
  ok(await mine.quickBlockAction({ reasonId: ids.quokka, note: MARK.secret, date: day, startMin: 13 * 60, minutes: 45, confirm: true }));
  ok(await mine.quickBlockAction({ reasonId: rid("bank"), note: MARK.bank, date: day, startMin: 14 * 60, minutes: 30, confirm: true }));
  const blocks = await blocksOf(people.makenna);
  ids.secretBlock = blocks.find((b) => b.note === MARK.secret)!.id;
  ids.bankBlock = blocks.find((b) => b.note === MARK.bank)!.id;

  const st = await import("@/server/staff-time");
  const r = (await st.requestTimeOff(
    { staffId: people.makenna, shopId: null, range: { fromDate: day, toDate: day, startMin: 16 * 60, endMin: 17 * 60 }, reasonId: rid("doctor"), note: MARK.doctor },
    { actor: { staffId: people.makenna, label: "Makenna" }, confirm: true, enforceNotice: false },
  )) as { requestId: string };
  ids.request = r.requestId;
  await as("michelle");
  ok(await decide.decideTimeOffAction(ids.request, "approve", ""));
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

type Shown = { label: string; color: string; note: string | null; reasonId: string | null; hidden: boolean; startMin: number };

describe("the calendar writes the reason on the block", () => {
  it("in the day view, private reasons are just Blocked for the front desk, in full for the manager and the barber herself", async () => {
    const { DayCalendar } = await import("@/app/admin/calendar/day-calendar");
    const { NEUTRAL_COLOR } = await import("@/domain/block-reasons");
    const blocksFor = async (who: string) => {
      await as(who);
      const [p] = await propsOf<{ data: { columns: { id: string; blocks: Shown[] }[] } }>(DayCalendar, "/admin/calendar", {}, { date: day, shop: cv.id });
      return p.data.columns.find((c) => c.id === people.makenna)!.blocks;
    };

    const desk = await blocksFor("frontdesk");
    expect(desk.find((b) => b.startMin === 13 * 60)).toMatchObject({ label: "Blocked", color: NEUTRAL_COLOR, note: null, reasonId: null, hidden: true });
    expect(desk.find((b) => b.startMin === 14 * 60)).toMatchObject({ label: "Bank", note: MARK.bank, reasonId: rid("bank"), hidden: false });
    expect(desk.find((b) => b.startMin === 16 * 60)).toMatchObject({ label: "Time off", note: null, reasonId: null, hidden: true });

    for (const who of ["michelle", "makenna"]) {
      const full = await blocksFor(who);
      expect(full.find((b) => b.startMin === 13 * 60), who).toMatchObject({ label: PRIVATE_LABEL, color: "#ef4444", note: MARK.secret, reasonId: ids.quokka, hidden: false });
      expect(full.find((b) => b.startMin === 16 * 60), who).toMatchObject({ label: "Doctor", note: MARK.doctor, reasonId: rid("doctor"), hidden: false });
    }
  });

  it("in the week view too", async () => {
    const { WeekCalendar } = await import("@/app/admin/calendar/week-calendar");
    const week = async (who: string) => {
      await as(who);
      const [p] = await propsOf<{ data: { days: { date: string; blocks: Shown[] }[] } }>(WeekCalendar, "/admin/calendar", {}, { view: "week", date: day, staff: people.makenna, shop: cv.id });
      return p.data.days.find((d) => d.date === day)!.blocks;
    };
    const desk = await week("frontdesk");
    expect(desk.map((b) => b.label).sort()).toEqual(expect.arrayContaining(["Bank", "Blocked", "Time off"]));
    expect(found(JSON.stringify(desk), HIDDEN)).toEqual([]);
    expect(JSON.stringify(await week("michelle"))).toContain(MARK.secret);
  });
});

describe("the private reason never reaches people who can't see it", () => {
  const pages = (): [string, Record<string, string>, Record<string, string>][] => [
    ["/admin", {}, {}],
    ["/admin/calendar", {}, { date: day, shop: cv.id }],
    ["/admin/calendar", {}, { view: "week", date: day, staff: people.makenna, shop: cv.id }],
    ["/admin/time-off", {}, { month: day.slice(0, 7), shop: cv.id }],
    ["/admin/reports/staffing", {}, { shop: cv.id, from: day, to: day }],
    ["/admin/staff/[id]", { id: people.makenna }, {}],
    ["/admin/audit", {}, {}],
  ];

  it("not on any page the front desk opens, but the public reason and its note are there", async () => {
    await as("frontdesk");
    let opened = 0;
    for (const [route, params, sp] of pages()) {
      const r = await open(route, params, sp);
      if (r.kind !== "ok") continue;
      opened++;
      // The calendar's new block form lists every reason (picking one isn't private), but no entry's note.
      const never = route === "/admin/calendar" && !sp.view ? [MARK.secret, MARK.doctor] : HIDDEN;
      expect(found(r.text, never), route).toEqual([]);
    }
    expect(opened).toBeGreaterThanOrEqual(3);
    const report = await open("/admin/reports/staffing", {}, { shop: cv.id, from: day, to: day });
    expect(report.kind).toBe("ok");
    expect(report.text).toContain(MARK.bank);
  });

  it("the manager and the barber herself see it", async () => {
    await as("michelle");
    for (const [route, params, sp] of [pages()[3], pages()[4]]) {
      const r = await open(route, params, sp);
      expect(r.kind, route).toBe("ok");
      expect(found(r.text!, [PRIVATE_LABEL, MARK.doctor]).length, route).toBeGreaterThan(0);
    }
    const report = await open("/admin/reports/staffing", {}, { shop: cv.id, from: day, to: day });
    expect(found(report.text!, [PRIVATE_LABEL, MARK.secret, "Doctor"])).toEqual([PRIVATE_LABEL, MARK.secret, "Doctor"]);

    await as("makenna");
    const own = await open("/admin/my-time");
    expect(own.kind).toBe("ok");
    expect(found(own.text!, [PRIVATE_LABEL, MARK.secret, MARK.doctor])).toEqual([PRIVATE_LABEL, MARK.secret, MARK.doctor]);
  });

  it("not in the staffing CSV for a manager without the permission; in full with it", async () => {
    const route = await import("@/app/admin/reports/export/route");
    const url = `/admin/reports/export?type=staffing&table=days&shop=${cv.id}&from=${day}&to=${day}`;
    await as("michelle");
    const full = await get(route.GET as never, url);
    expect(full.status).toBe(200);
    expect(found(full.text, [PRIVATE_LABEL, MARK.secret, "Doctor", MARK.doctor])).toEqual([PRIVATE_LABEL, MARK.secret, "Doctor", MARK.doctor]);

    const role = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "shop_manager") }))!;
    await m.db.db.update(m.schema.roles).set({ permissions: role.permissions.filter((p) => p !== "blocks.private") }).where(eq(m.schema.roles.id, role.id));
    try {
      const masked = await get(route.GET as never, url);
      expect(masked.status).toBe(200);
      expect(found(masked.text, HIDDEN)).toEqual([]);
      expect(found(masked.text, ["Blocked", "Time off", "Bank", MARK.bank])).toEqual(["Blocked", "Time off", "Bank", MARK.bank]);
    } finally {
      await m.db.db.update(m.schema.roles).set({ permissions: role.permissions }).where(eq(m.schema.roles.id, role.id));
    }
  });

  it("customers booking online only see that the time is taken", async () => {
    const availability = await import("@/app/api/v1/shops/[shop]/availability/route");
    const days = await import("@/app/api/v1/shops/[shop]/available-days/route");
    const barbers = await import("@/app/api/v1/shops/[shop]/barbers/route");
    const shopRoute = await import("@/app/api/v1/shops/[shop]/route");
    const book = await import("@/app/(public)/book/[shop]/page");
    const svc = (await m.public.publicServices("coralville")).services.find((s) => s.kind === "service")!;
    await signInAs(null);
    const texts = [
      (await get(availability.GET as never, `/api/v1/shops/coralville/availability?date=${day}&serviceId=${svc.id}&barber=${people.makenna}`, { shop: "coralville" })).text,
      (await get(days.GET as never, `/api/v1/shops/coralville/available-days?from=${day}&days=7&serviceId=${svc.id}&barber=${people.makenna}`, { shop: "coralville" })).text,
      (await get(barbers.GET as never, "/api/v1/shops/coralville/barbers", { shop: "coralville" })).text,
      (await get(shopRoute.GET as never, "/api/v1/shops/coralville", { shop: "coralville" })).text,
      await textOf(await book.default({ params: Promise.resolve({ shop: "coralville" }) }), new Set()),
    ];
    const slots = JSON.parse(texts[0]) as { slots: { startsAt: string }[] };
    expect(slots.slots.length).toBeGreaterThan(0);
    expect(slots.slots.some((s) => m.time.localMinutesOf(new Date(s.startsAt)) === 13 * 60)).toBe(false);
    for (const t of texts) expect(found(t, [...HIDDEN, MARK.bank, "Bank", "Doctor", "Blocked"])).toEqual([]);
  });
});

describe("the audit log keeps the reason", () => {
  it("records reason and note on every entry, hidden and unsearchable for people who can't see private reasons", async () => {
    const { auditRows } = await import("@/server/report-data");
    const { LOCKED_POLICY } = await import("@/server/client-privacy");
    const rows = async (seesPrivate: boolean, q?: string) =>
      (
        await auditRows({
          viewer: { brandWide: true, currentShopId: null, shopIds: [cv.id] },
          client: LOCKED_POLICY,
          reasons: { staffId: people.frontdesk, seesPrivate },
          loc: { view: "combined", shops: [{ id: cv.id, name: cv.name }] } as never,
          q,
          limit: 1000,
          offset: 0,
        })
      )
        .map((r) => r.a)
        .filter((a) => a.entity !== "block_reason");
    const raw = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.inArray(m.schema.auditLog.entityId, [ids.secretBlock, ids.bankBlock, ids.request]));
    const secret = raw.find((a) => a.entityId === ids.secretBlock && a.action === "block.create")!;
    expect(secret.details).toMatchObject({ reasonId: ids.quokka, reason: PRIVATE_LABEL, note: MARK.secret, private: true });
    expect(raw.find((a) => a.entityId === ids.bankBlock)!.details).toMatchObject({ reason: "Bank", note: MARK.bank, private: false });
    expect(raw.filter((a) => a.entityId === ids.request).map((a) => [a.action, (a.details as { reason: string }).reason]).sort()).toEqual([
      ["time_off.approve", "Doctor"],
      ["time_off.request", "Doctor"],
    ]);

    const desk = await rows(false);
    expect(desk.find((a) => a.id === secret.id)!.details).toMatchObject({ reason: "Blocked", note: null, reasonId: null });
    expect(desk.filter((a) => a.entityId === ids.request).every((a) => (a.details as { reason: string }).reason === "Time off")).toBe(true);
    expect(found(JSON.stringify(desk), HIDDEN)).toEqual([]);
    expect(JSON.stringify(desk)).toContain(MARK.bank);
    expect(await rows(false, "QUOKKA")).toEqual([]);
    expect((await rows(false, "BANK-NOTE")).map((a) => a.entityId)).toContain(ids.bankBlock);
    expect((await rows(true, "QUOKKA")).map((a) => a.entityId)).toContain(ids.secretBlock);
  });
});

describe("managers edit the list", () => {
  it("barbers and the desk can't; a rename carries to existing entries; duplicates are refused; an archived reason can't be picked until restored", async () => {
    await as("makenna");
    expect(err(await admin.saveReasonAction({ id: rid("bank"), label: "Banking", color: "#6366f1", usedFor: "blocks", countsAsLunch: false, noticeExempt: false, private: false }))).toMatch(
      /can't edit the block reasons/,
    );
    await as("frontdesk");
    expect((await open("/admin/block-reasons")).kind).toBe("denied");

    await as("michelle");
    expect((await open("/admin/block-reasons")).kind).toBe("ok");
    expect(err(await admin.saveReasonAction({ id: null, label: "doctor", color: "#ef4444", usedFor: "both", countsAsLunch: false, noticeExempt: false, private: false }))).toMatch(/already/i);
    ok(await admin.saveReasonAction({ id: rid("bank"), label: "Bank run", color: "#0ea5e9", usedFor: "blocks", countsAsLunch: false, noticeExempt: false, private: false }));
    expect((await m.db.db.query.timeBlocks.findFirst({ where: eq(m.schema.timeBlocks.id, ids.bankBlock) }))!.reason).toBe("Bank run");

    ok(await admin.archiveReasonAction(rid("bank"), true));
    await as("makenna");
    const later = m.time.addDays(day, 7);
    expect(err(await mine.quickBlockAction({ reasonId: rid("bank"), date: later, startMin: 10 * 60, minutes: 15, confirm: true }))).toMatch(/no longer on the reasons list/);
    expect(err(await mine.quickBlockAction({ reasonId: rid("vacation"), date: later, startMin: 10 * 60, minutes: 15, confirm: true }))).toMatch(/time off only/i);
    await as("michelle");
    ok(await admin.archiveReasonAction(rid("bank"), false));
    await as("makenna");
    expect(ok(await mine.quickBlockAction({ reasonId: rid("bank"), date: later, startMin: 10 * 60, minutes: 15, confirm: true })).saved).toBe(true);

    const log = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, rid("bank")));
    expect(log.map((a) => a.action).sort()).toEqual(["block_reason.archive", "block_reason.restore", "block_reason.update"]);
  });

  it("lunch now uses the brand's lunch reason", async () => {
    await as("makenna");
    let r = ok(await mine.lunchNowAction());
    if (!r.saved) r = ok(await mine.lunchNowAction(true));
    const [b] = await m.db.db
      .select()
      .from(m.schema.timeBlocks)
      .where(m.drizzle.and(eq(m.schema.timeBlocks.staffId, people.makenna), m.drizzle.isNull(m.schema.timeBlocks.seriesId), eq(m.schema.timeBlocks.reasonId, rid("lunch"))))
      .orderBy(m.drizzle.desc(m.schema.timeBlocks.createdAt))
      .limit(1);
    expect([b.category, b.reason]).toEqual(["lunch", "Lunch"]);
  });
});
