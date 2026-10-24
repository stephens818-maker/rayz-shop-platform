/**
 * A family booked together, against a real database: the slot finder's plans and total window; one
 * transaction for everyone (a seat taken books nobody, retried at the same times or answered with
 * alternatives); two families racing for the same seats; one confirmation and one set of reminders,
 * which move when the first person is cancelled; cancelling and moving everyone with one link;
 * checking the group in, one ticket or a ticket each with tips per barber; one deposit, applied at
 * checkout or kept on a no-show; each child's cut counted on its own; and the parent's endpoints.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let fam: typeof import("@/server/family");
let groups: typeof import("@/server/booking-groups");
let today: string;
const fx = { shop: "", makenna: "", michelle: "", cut: "", cutCents: 0 };
let seq = 0;
let day = 3;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const inArray = (...a: Parameters<Mods["drizzle"]["inArray"]>) => m.drizzle.inArray(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };
const DEFAULTS = { maxChildren: 6, loyalty: "household" as const, splitAge: 13, groupDepositCents: 0, groupDepositFrom: 3, groupNoShowForfeit: true };
type Options = Awaited<ReturnType<typeof groups.planGroup>>;
type Option = Options["plans"][number]["options"][number];

beforeAll(async () => {
  m = await loadModules();
  fam = await import("@/server/family");
  groups = await import("@/server/booking-groups");
  today = m.time.todayLocal();
  fx.shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!.id;
  const staff = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, email) }))!.id;
  fx.makenna = await staff("makenna@rayz.test");
  fx.michelle = await staff("michelle@rayz.test");
  const svc = (await m.catalog.shopCatalog(fx.shop)).find((x) => x.slug === "rayz-cut-shampoo")!;
  fx.cut = svc.id;
  fx.cutCents = svc.priceCents;
}, 180_000);

afterAll(async () => {
  await fam?.saveFamilySettings(DEFAULTS, actor).catch(() => {});
  await m?.db.closeDb();
});

async function parent(firstName = "Dana") {
  const n = String(2000 + ++seq + Math.floor(Math.random() * 7000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName, lastName: "Group", phone: `+1319557${n}`, email: `${firstName.toLowerCase()}.${n}@groups.test`, smsOptIn: true, emailOptIn: true, homeShopId: fx.shop })
    .returning();
  return c;
}

async function family(kids: string[], name = "Dana") {
  const p = await parent(name);
  const children = [];
  for (const k of kids) children.push(await fam.addChild(p.id, { firstName: k }, actor));
  return { p, kids: children, ids: [p.id, ...children.map((c) => c.id)] };
}

const people = (ids: string[], staffId: string | null = null) => ids.map((customerId) => ({ customerId, serviceId: fx.cut, addonIds: [], staffId }));

/** The next day (from 3 days out) with an option for `plan`, and the options. */
async function findDay(ids: string[], plan: "same_barber" | "together" | "earliest_finish", staffId: string | null = null) {
  for (; day < 40; day++) {
    const date = m.time.addDays(today, day);
    const opts = await groups.planGroup({ shopId: "coralville", date, people: people(ids, staffId) }, { guardianId: ids[0], staff: true });
    const o = opts.plans.find((x) => x.plan === plan)!.options[0];
    if (o) return { date, opts, option: o };
  }
  throw new Error(`no day with a ${plan} option`);
}

const seatsOf = (o: Option) => o.seats.map((x) => ({ customerId: x.customerId, staffId: x.staffId, startsAt: x.startsAt }));
const book = (ids: string[], o: Option, extra: { idempotencyKey?: string } = {}) =>
  groups.bookGroup({ shopId: "coralville", plan: o.plan, people: people(ids), seats: seatsOf(o) }, { guardianId: ids[0], source: "staff", actor, ...extra });
const apptsOf = async (ids: string[]) => m.db.db.select().from(s().appointments).where(inArray(s().appointments.customerId, ids));
const jobsOf = async (apptIds: string[]) => m.db.db.select().from(s().notificationJobs).where(inArray(s().notificationJobs.appointmentId, apptIds));

describe("finding times for a family", () => {
  it("offers back to back with one barber, together with several, and done soonest, with the total window", async () => {
    const f = await family(["Milo", "Ava"]);
    const { opts } = await findDay(f.ids, "earliest_finish");
    expect(opts.plans.map((p) => p.plan)).toEqual(["same_barber", "together", "earliest_finish"]);
    for (const p of opts.plans) {
      for (const o of p.options) {
        expect(o.seats.map((x) => x.customerId).sort()).toEqual([...f.ids].sort());
        expect(o.minutes).toBe(Math.round((Date.parse(o.endsAt) - Date.parse(o.startsAt)) / 60_000));
        expect(o.seats.map((x) => x.firstName).sort()).toEqual(["Ava", "Dana", "Milo"]);
      }
      if (!p.options.length) expect(p.reason).toBeTruthy();
    }
    const same = opts.plans[0].options[0];
    if (same) {
      expect(new Set(same.seats.map((x) => x.staffId)).size).toBe(1);
      expect(same.minutes).toBeGreaterThanOrEqual(90);
    }
    expect(opts.depositCents).toBe(0);
  });

  it("only for people on the parent's account", async () => {
    const f = await family(["Kai"]);
    const stranger = await parent("Stranger");
    await expect(groups.planGroup({ shopId: "coralville", date: m.time.addDays(today, 5), people: people([f.p.id, stranger.id]) }, { guardianId: f.p.id })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("booking a family as one group", () => {
  it("books everyone linked to one group, with one confirmation and one set of reminders to the parent", async () => {
    const f = await family(["Milo", "Ava"]);
    const { option } = await findDay(f.ids, "earliest_finish");
    const g = await book(f.ids, option);
    expect(g.members).toHaveLength(3);
    expect(g.status).toBe("booked");
    expect(g.minutes).toBe(option.minutes);
    expect(g.startsAt).toBe(option.startsAt);
    const rows = await apptsOf(f.ids);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
    const jobs = await jobsOf(rows.map((r) => r.id));
    const lead = g.members[0].appointmentId;
    expect(new Set(jobs.map((j) => j.appointmentId))).toEqual(new Set([lead]));
    expect(jobs.filter((j) => j.kind === "confirmation").map((j) => j.channel).sort()).toEqual(["email", "sms"]);
    const conf = jobs.find((j) => j.kind === "confirmation" && j.channel === "sms")!;
    expect(conf.to).toBe(f.p.phone);
    expect(conf.body).toMatch(/Milo/);
    expect(conf.body).toMatch(/Ava/);
    expect(conf.body).toContain(`/g/${g.code}`);
    expect(conf.body).toMatch(/everyone done by/);
  });

  it("books nobody when a seat is taken, and answers with times that still work", async () => {
    const f = await family(["Rex"]);
    const { option } = await findDay(f.ids, "same_barber");
    const taken = option.seats[1];
    const other = await parent("Walkup");
    await m.booking.createAppointment({ shopRef: "coralville", serviceId: fx.cut, barberRef: taken.staffId, startsAt: taken.startsAt, customerId: other.id, source: "staff", actor });
    const err = await groups.bookGroup({ shopId: "coralville", plan: "custom", people: people(f.ids), seats: seatsOf(option) }, { guardianId: f.p.id, source: "staff", actor }).catch((e) => e);
    expect(err).toMatchObject({ code: "slot_unavailable" });
    expect(err.details.alternatives.plans).toHaveLength(3);
    expect(await apptsOf(f.ids)).toHaveLength(0);
    expect(await m.db.db.select().from(s().bookingGroups).where(eq(s().bookingGroups.guardianId, f.p.id))).toHaveLength(0);
  });

  it("retries at the same times with another barber when someone who didn't ask for one loses theirs", async () => {
    const f = await family(["Ivy"]);
    const { option } = await findDay(f.ids, "together");
    const kidSeat = option.seats.find((x) => x.customerId !== f.p.id)!;
    const momSeat = option.seats.find((x) => x.customerId === f.p.id)!;
    // Both barbers free at that time: take the kid's barber, then give the parent's seat to the other free barber if there is one.
    const other = await parent("Sniper");
    await m.booking.createAppointment({ shopRef: "coralville", serviceId: fx.cut, barberRef: kidSeat.staffId, startsAt: kidSeat.startsAt, customerId: other.id, source: "staff", actor });
    const r = await groups.bookGroup({ shopId: "coralville", plan: "together", people: people(f.ids), seats: seatsOf(option) }, { guardianId: f.p.id, source: "staff", actor }).catch((e) => e);
    if (r instanceof Error) {
      // Not enough barbers left at that time: nothing booked, alternatives offered.
      expect(r).toMatchObject({ code: "slot_unavailable" });
      expect(await apptsOf(f.ids)).toHaveLength(0);
    } else {
      expect(r.members.every((x: { startsAt: string }) => x.startsAt === momSeat.startsAt)).toBe(true);
      expect(r.members.find((x: { customerId: string | null }) => x.customerId !== f.p.id)!.barber.id).not.toBe(kidSeat.staffId);
    }
  });

  it("two families racing for the same seats: exactly one is booked, the other has nothing", async () => {
    const a = await family(["Ann"], "Alpha");
    const b = await family(["Bob"], "Bravo");
    const { option } = await findDay(a.ids, "same_barber");
    const seatsFor = (ids: string[]) => option.seats.map((x, i) => ({ customerId: ids[i], staffId: x.staffId, startsAt: x.startsAt }));
    const go = (f: typeof a) => groups.bookGroup({ shopId: "coralville", plan: "custom", people: people(f.ids), seats: seatsFor(f.ids) }, { guardianId: f.p.id, source: "staff", actor });
    const out = await Promise.allSettled([go(a), go(b)]);
    expect(out.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = out.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "slot_unavailable" });
    const loser = out[0].status === "rejected" ? a : b;
    expect(await apptsOf(loser.ids)).toHaveLength(0);
    expect(await m.db.db.select().from(s().bookingGroups).where(eq(s().bookingGroups.guardianId, loser.p.id))).toHaveLength(0);
    const winner = loser === a ? b : a;
    expect((await apptsOf(winner.ids)).every((r) => r.status === "booked")).toBe(true);
  });

  it("the same request sent twice at once books once", async () => {
    const f = await family(["Dot"]);
    const { option } = await findDay(f.ids, "earliest_finish");
    const key = `grp-${crypto.randomUUID()}`;
    const out = await Promise.allSettled([book(f.ids, option, { idempotencyKey: key }), book(f.ids, option, { idempotencyKey: key })]);
    const codes = out.filter((x) => x.status === "fulfilled").map((x) => (x as PromiseFulfilledResult<{ code: string }>).value.code);
    expect(new Set(codes).size).toBe(1);
    expect(await apptsOf(f.ids)).toHaveLength(2);
  });
});

describe("one link for the group", () => {
  it("cancelling the first person moves the group's reminders to whoever is next; one person changes alone", async () => {
    const f = await family(["Lou", "Max"]);
    const { option } = await findDay(f.ids, "same_barber");
    const g = await book(f.ids, option);
    const [lead, second] = g.members;
    await m.booking.cancelAppointment(lead.appointmentCode, { actor, byCustomer: false });
    const v = await groups.groupView(g.code);
    expect(v.status).toBe("partly_cancelled");
    expect(v.members.filter((x) => x.status === "booked")).toHaveLength(2);
    const pending = (await jobsOf(g.members.map((x) => x.appointmentId))).filter((j) => j.status === "pending" && j.kind.startsWith("reminder"));
    expect(new Set(pending.map((j) => j.appointmentId))).toEqual(new Set([second.appointmentId]));
    expect(pending.find((j) => j.channel === "sms")!.body).not.toMatch(new RegExp(lead.firstName!));
  });

  it("cancels everyone with one message; online, not past the cutoff; only the parent", async () => {
    const f = await family(["Ned"]);
    const { option } = await findDay(f.ids, "earliest_finish");
    const g = await book(f.ids, option);
    const stranger = await parent("Nosy");
    await expect(groups.cancelGroup(g.code, { actor, byCustomer: true, customerId: stranger.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(groups.cancelGroup(g.code, { actor, byCustomer: true, customerId: f.p.id, now: new Date(Date.parse(g.startsAt) - 60_000) })).rejects.toMatchObject({ code: "cutoff_passed" });
    const v = await groups.cancelGroup(g.code, { actor, byCustomer: true, customerId: f.kids[0].id });
    expect(v.status).toBe("cancelled");
    const jobs = await jobsOf(g.members.map((x) => x.appointmentId));
    expect(jobs.filter((j) => j.kind === "cancellation")).toHaveLength(2);
    expect(new Set(jobs.filter((j) => j.kind === "cancellation").map((j) => j.appointmentId)).size).toBe(1);
    expect(jobs.filter((j) => j.status === "pending" && j.kind.startsWith("reminder"))).toHaveLength(0);
  });

  it("moves everyone to another option in one go, swapping seats inside its own time", async () => {
    const f = await family(["Pia"]);
    const { option, date } = await findDay(f.ids, "together");
    const g = await book(f.ids, option);
    // Seats swapped: each person takes the other's barber and time, which only works if the old seats are let go first.
    const swapped = g.members.map((x, i) => ({ customerId: x.customerId!, staffId: g.members[1 - i].barber.id, startsAt: g.members[1 - i].startsAt }));
    const v = await groups.rescheduleGroup(g.code, { plan: "together", seats: swapped }, { actor, byCustomer: false });
    const byCode = new Map(v.members.map((x) => [x.customerId, x]));
    for (const x of swapped) expect(byCode.get(x.customerId)).toMatchObject({ barber: { id: x.staffId }, startsAt: x.startsAt });
    expect(v.members.map((x) => x.appointmentCode).sort()).toEqual(g.members.map((x) => x.appointmentCode).sort());
    // Another day's option, with the group's own seats counted free.
    let next: Option | undefined;
    for (let i = 1; i < 10 && !next; i++) next = (await groups.groupRescheduleOptions(g.code, m.time.addDays(date, i), { staff: true })).plans.flatMap((p) => p.options)[0];
    expect(next).toBeDefined();
    if (!next) return;
    const moved = await groups.rescheduleGroup(g.code, { plan: next.plan, seats: seatsOf(next) }, { actor, byCustomer: false });
    expect(moved.startsAt).toBe(next.startsAt);
    const jobs = await jobsOf(g.members.map((x) => x.appointmentId));
    expect(jobs.filter((j) => j.kind === "reschedule" && j.status === "pending").length).toBeGreaterThan(0);
    const reminders = jobs.filter((j) => j.status === "pending" && j.kind.startsWith("reminder"));
    expect(new Set(reminders.map((j) => j.appointmentId)).size).toBe(1);
  });
});

describe("at the shop", () => {
  it("checks the group in at once, one ticket with the tip split per barber, and counts each child's cut", async () => {
    const f = await family(["Quin", "Rae"]);
    const { option } = await findDay(f.ids, "earliest_finish");
    const g = await book(f.ids, option);
    expect(await groups.checkInGroup(g.id, actor)).toBe(3);
    const saleId = await groups.openGroupTicket(g.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(saleId);
    expect(ctx.sale.customerId).toBe(f.p.id);
    expect(ctx.family.members).toHaveLength(2);
    expect(await groups.openGroupTicket(g.id, actor)).toBe(saleId);
    await m.checkout.finalizeSale({
      saleId,
      lines: g.members.map((x) => ({ kind: "service" as const, refId: fx.cut, qty: 1, appointmentId: x.appointmentId, staffId: x.barber.id })),
      tipCents: 1200,
      tender: cash,
      actor,
    });
    const barbers = new Set(g.members.map((x) => x.barber.id));
    const shares = await m.db.db.select().from(s().saleTipShares).where(eq(s().saleTipShares.saleId, saleId));
    expect(new Set(shares.map((x) => x.staffId))).toEqual(barbers);
    const rows = await apptsOf(f.ids);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect((await groups.groupView(g.code)).status).toBe("done");
    const d = rows[0].startsAt;
    const date = m.time.localDateOf(d);
    const kids = await m.db.db.select().from(s().appointments).where(inArray(s().appointments.customerId, f.kids.map((k) => k.id)));
    expect(kids).toHaveLength(2);
    const kpi = await m.reports.kpis({ shopIds: [fx.shop], from: date, to: date });
    expect(kpi.kidsCuts).toBeGreaterThanOrEqual(2);
  });

  it("or a ticket each", async () => {
    const f = await family(["Sol"]);
    const { option } = await findDay(f.ids, "earliest_finish");
    const g = await book(f.ids, option);
    const tickets = await groups.openGroupSplitTickets(g.id, actor);
    expect(tickets).toHaveLength(2);
    expect(new Set(tickets.map((t) => t.saleId)).size).toBe(2);
    expect((await groups.openGroupSplitTickets(g.id, actor)).map((t) => t.saleId)).toEqual(tickets.map((t) => t.saleId));
  });
});

describe("one deposit and one no-show rule for the group", () => {
  it("takes one deposit at the desk, holds it, and applies it on the group's ticket", async () => {
    await fam.saveFamilySettings({ ...DEFAULTS, groupDepositCents: 2000, groupDepositFrom: 3 }, actor);
    try {
      const f = await family(["Tad", "Uli"]);
      const { option, opts } = await findDay(f.ids, "earliest_finish");
      expect(opts.depositCents).toBe(2000);
      const g = await book(f.ids, option);
      expect(g.deposit).toEqual({ cents: 2000, status: "due" });
      const depositSale = await groups.startGroupDeposit(g.id, actor);
      expect(await groups.startGroupDeposit(g.id, actor)).toBe(depositSale);
      const dctx = await m.checkout.loadCheckoutContext(depositSale);
      expect(dctx.items).toEqual([expect.objectContaining({ kind: "gift_card", unitPriceCents: 2000, name: expect.stringContaining(g.code) })]);
      await m.checkout.finalizeSale({ saleId: depositSale, lines: [{ kind: "gift_card", qty: 1, unitPriceCents: 2000 }], tipCents: 0, tender: cash, actor });
      expect((await groups.groupView(g.code)).deposit.status).toBe("held");

      await groups.checkInGroup(g.id, actor);
      const saleId = await groups.openGroupTicket(g.id, actor);
      const ctx = await m.checkout.loadCheckoutContext(saleId);
      expect(ctx.groupDeposit).toMatchObject({ groupCode: g.code, balanceCents: 2000 });
      await m.checkout.finalizeSale({
        saleId,
        lines: g.members.map((x) => ({ kind: "service" as const, refId: fx.cut, qty: 1, appointmentId: x.appointmentId, staffId: x.barber.id })),
        tipCents: 0,
        giftCard: { code: ctx.groupDeposit!.code, amountCents: 2000 },
        tender: cash,
        actor,
      });
      expect((await groups.groupView(g.code)).deposit.status).toBe("applied");
    } finally {
      await fam.saveFamilySettings(DEFAULTS, actor);
    }
  });

  it("a whole-group no-show marks everyone and keeps the one deposit; two people get no deposit", async () => {
    await fam.saveFamilySettings({ ...DEFAULTS, groupDepositCents: 1500, groupDepositFrom: 2 }, actor);
    try {
      const f = await family(["Vic"]);
      const { option } = await findDay(f.ids, "earliest_finish");
      const g = await book(f.ids, option);
      const depositSale = await groups.startGroupDeposit(g.id, actor);
      await m.checkout.finalizeSale({ saleId: depositSale, lines: [{ kind: "gift_card", qty: 1, unitPriceCents: 1500 }], tipCents: 0, tender: cash, actor });
      const r = await groups.groupNoShow(g.id, actor);
      expect(r).toEqual({ noShows: 2, wholeGroup: true, forfeitedCents: 1500 });
      expect((await apptsOf(f.ids)).every((x) => x.status === "no_show")).toBe(true);
      const grp = (await m.db.db.query.bookingGroups.findFirst({ where: eq(s().bookingGroups.id, g.id) }))!;
      expect(grp.depositStatus).toBe("forfeited");
      const card = (await m.db.db.query.giftCards.findFirst({ where: eq(s().giftCards.id, grp.depositGiftCardId!) }))!;
      expect(card).toMatchObject({ status: "void", balanceCents: 0, source: "deposit" });
      await expect(groups.groupNoShow(g.id, actor)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await fam.saveFamilySettings(DEFAULTS, actor);
    }
  });

  it("cancelling in time leaves a taken deposit due back; one never taken is waived", async () => {
    await fam.saveFamilySettings({ ...DEFAULTS, groupDepositCents: 1000, groupDepositFrom: 2 }, actor);
    try {
      const f = await family(["Wes"]);
      const { option } = await findDay(f.ids, "earliest_finish");
      const g = await book(f.ids, option);
      expect((await groups.cancelGroup(g.code, { actor, byCustomer: false })).deposit.status).toBe("waived");
      const f2 = await family(["Xia"]);
      const { option: o2 } = await findDay(f2.ids, "earliest_finish");
      const g2 = await book(f2.ids, o2);
      const ds = await groups.startGroupDeposit(g2.id, actor);
      await m.checkout.finalizeSale({ saleId: ds, lines: [{ kind: "gift_card", qty: 1, unitPriceCents: 1000 }], tipCents: 0, tender: cash, actor });
      expect((await groups.cancelGroup(g2.code, { actor, byCustomer: true, customerId: f2.p.id })).deposit.status).toBe("refund_due");
    } finally {
      await fam.saveFamilySettings(DEFAULTS, actor);
    }
  });
});

describe("the parent's endpoints (web account and the app's /v1/me/family)", () => {
  it("options, book once per Idempotency-Key, 409 with alternatives, list, view, move options and cancel; another parent sees nothing", async () => {
    const f = await family(["Ari"]);
    const token = (await m.auth.issueTokens(f.p.id, null)).accessToken;
    const api = await import("@/server/family-api");
    type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
    const call = (fn: Handler, method: string, body?: object, params: Record<string, string> = {}, headers: Record<string, string> = {}, bearer = token) =>
      fn(
        new Request("http://test/api/v1/me/family/booking-groups", {
          method,
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        { params: Promise.resolve(params) },
      );
    const { date } = await findDay(f.ids, "together");
    const opts = await call(api.postGroupOptions as never, "POST", { shopId: "coralville", date, people: people(f.ids) });
    expect(opts.status).toBe(200);
    const body = (await opts.json()) as Options;
    expect(body.plans.map((p) => p.plan)).toEqual(["same_barber", "together", "earliest_finish"]);
    const option = body.plans.flatMap((p) => p.options)[0];
    expect(option.minutes).toBeGreaterThan(0);

    const req = { shopId: "coralville", people: people(f.ids), plan: option.plan, seats: seatsOf(option) };
    const key = { "idempotency-key": `grp-${Date.now()}-${seq}` };
    const made = await call(api.postBookingGroup as never, "POST", req, {}, key);
    expect(made.status).toBe(201);
    const g = (await made.json()) as { code: string; members: { appointmentCode: string; appointmentId?: string }[]; status: string };
    expect(g.status).toBe("booked");
    expect(g.members).toHaveLength(2);
    expect(g.members[0]).not.toHaveProperty("appointmentId");
    expect(g).not.toHaveProperty("guardianId");
    const again = await call(api.postBookingGroup as never, "POST", req, {}, key);
    expect(((await again.json()) as { code: string }).code).toBe(g.code);

    const other = await family(["Bo"], "Lee");
    const taken = await call(
      api.postBookingGroup as never,
      "POST",
      { shopId: "coralville", people: people(other.ids), plan: "custom", seats: option.seats.map((x, i) => ({ customerId: other.ids[i], staffId: x.staffId, startsAt: x.startsAt })) },
      {},
      {},
      (await m.auth.issueTokens(other.p.id, null)).accessToken,
    );
    expect(taken.status).toBe(409);
    const err = (await taken.json()) as { error: { code: string; details: { alternatives: Options } } };
    expect(err.error.code).toBe("slot_unavailable");
    expect(err.error.details.alternatives.plans).toHaveLength(3);
    expect(await m.db.db.select().from(s().appointments).where(inArray(s().appointments.customerId, other.ids))).toHaveLength(0);

    const list = (await (await call(api.listBookingGroups as never, "GET")).json()) as { groups: { code: string }[] };
    expect(list.groups.map((x) => x.code)).toContain(g.code);
    expect((await call(api.getBookingGroup as never, "GET", undefined, { code: g.code })).status).toBe(200);
    const stranger = (await m.auth.issueTokens(other.p.id, null)).accessToken;
    expect((await call(api.getBookingGroup as never, "GET", undefined, { code: g.code }, {}, stranger)).status).toBe(404);
    expect((await call(api.cancelBookingGroup as never, "POST", {}, { code: g.code }, {}, stranger)).status).toBe(404);

    const moveOpts = await call(api.postGroupRescheduleOptions as never, "POST", { date }, { code: g.code });
    expect(moveOpts.status).toBe(200);
    expect(await groups.groupCodeOf(g.members[0].appointmentCode)).toBe(g.code);

    const cancelled = await call(api.cancelBookingGroup as never, "POST", {}, { code: g.code });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { status: string }).status).toBe("cancelled");
  });
});

describe("walk-ins and the old family booking", () => {
  it("links one family's walk-ins into a group", async () => {
    const f = await family(["Yul"]);
    const { option } = await findDay(f.ids, "together");
    const made = [];
    for (const x of option.seats) made.push(await m.booking.createAppointment({ shopRef: "coralville", serviceId: fx.cut, barberRef: x.staffId, startsAt: x.startsAt, customerId: x.customerId, source: "staff", actor }));
    const code = await groups.linkWalkIns(made.map((a) => a.id), actor);
    expect(code).toBeTruthy();
    expect((await groups.groupView(code!)).members).toHaveLength(2);
    const stranger = await parent("Zed");
    const a3 = await m.booking.createAppointment({ shopRef: "coralville", serviceId: fx.cut, barberRef: option.seats[0].staffId, startsAt: new Date(Date.parse(option.endsAt) + 60 * 60_000).toISOString(), customerId: stranger.id, source: "staff", actor }).catch(() => null);
    if (a3) await expect(groups.linkWalkIns([made[0].id, a3.id], actor)).rejects.toMatchObject({ code: "bad_request" });
  });
});
