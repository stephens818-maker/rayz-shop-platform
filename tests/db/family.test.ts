/**
 * Family accounts against a real database: children under a parent within the brand's limit, with
 * no contact details of their own (messages go to the parent); booking a family in one go, all or
 * nothing; one family ticket paid by the parent with the tip split per barber; household and
 * individual loyalty and their reversal on a void; the kids' cuts KPI, the has-kids filter and a
 * child's name finding the parent; Squire family links after a clients import; attaching from the
 * duplicates page and the merge guards; a teenager's own account keeping their history; the
 * Family and Kid badges; and the parent's family endpoints.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let fam: typeof import("@/server/family");
let ticket: typeof import("@/server/family-ticket");
let booking: typeof import("@/server/family-booking");
let contact: typeof import("@/server/household-contact");
let today: string;
const fx = { shop: "", makenna: "", michelle: "", frontdesk: "", cut: "", cutCents: 0 };
let seq = 0;
let slot = 0;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };
const DEFAULTS = { maxChildren: 6, loyalty: "household" as const, splitAge: 13 };

beforeAll(async () => {
  m = await loadModules();
  fam = await import("@/server/family");
  ticket = await import("@/server/family-ticket");
  booking = await import("@/server/family-booking");
  contact = await import("@/server/household-contact");
  today = m.time.todayLocal();
  fx.shop = (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, "coralville") }))!.id;
  const staff = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, email) }))!.id;
  fx.makenna = await staff("makenna@rayz.test");
  fx.michelle = await staff("michelle@rayz.test");
  fx.frontdesk = await staff("frontdesk@rayz.test");
  const svc = (await m.catalog.shopCatalog(fx.shop)).find((x) => x.slug === "rayz-cut-shampoo")!;
  fx.cut = svc.id;
  fx.cutCents = svc.priceCents;
}, 180_000);

afterAll(async () => {
  await fam?.saveFamilySettings(DEFAULTS, actor).catch(() => {});
  await m?.db.closeDb();
});

/** A parent with a phone and email on file, who agreed to texts and email. */
async function parent(firstName = "Parker") {
  const n = String(2000 + ++seq + Math.floor(Math.random() * 7000)).slice(-4);
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName, lastName: "Family", phone: `+1319556${n}`, email: `${firstName.toLowerCase()}.${n}@family.test`, smsOptIn: true, emailOptIn: true, homeShopId: fx.shop })
    .returning();
  return c;
}

/** Today's appointment before opening (so it never meets the seeded book), checked in. */
async function appt(customerId: string, staffId: string) {
  const startsAt = m.time.zonedWallTime(today, 30 + 35 * slot++).toJSDate();
  const [a] = await m.db.db
    .insert(s().appointments)
    .values({
      code: `F${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: fx.shop,
      staffId,
      customerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: "checked_in",
      source: "staff",
      estimateCents: fx.cutCents,
    })
    .returning();
  await m.db.db.insert(s().appointmentItems).values({ appointmentId: a.id, serviceId: fx.cut, kind: "service", name: "Ray'z Cut", priceCents: fx.cutCents, durationMin: 30 });
  return a;
}

const ledger = (saleId: string) => m.db.db.select().from(s().loyaltyLedger).where(eq(s().loyaltyLedger.saleId, saleId));
const sumFor = (rows: { customerId: string; progressDeltaCents: number }[], id: string) => rows.filter((r) => r.customerId === id).reduce((a, r) => a + r.progressDeltaCents, 0);
const statusOf = async (id: string) => (await m.db.db.query.appointments.findFirst({ where: eq(s().appointments.id, id) }))!.status;

describe("child profiles", () => {
  it("adds children within the brand's limit, with no contact or consent of their own", async () => {
    const p = await parent();
    await fam.saveFamilySettings({ ...DEFAULTS, maxChildren: 2 }, actor);
    try {
      const a = await fam.addChild(p.id, { firstName: "Ava", age: 7, notes: "Loud clippers upset her", preferredStaffId: fx.makenna }, actor);
      expect(a).toMatchObject({ guardianId: p.id, lastName: "Family", birthYear: Number(today.slice(0, 4)) - 7, phone: null, email: null, smsOptIn: false, homeShopId: fx.shop, source: "Family" });
      await fam.addChild(p.id, { firstName: "Ben", birthday: "2018-05-01" }, actor);
      await expect(fam.addChild(p.id, { firstName: "Cal" }, actor)).rejects.toMatchObject({ message: expect.stringMatching(/up to 2 children/) });
      expect((await fam.childrenOf(p.id)).map((c) => c.firstName)).toEqual(["Ava", "Ben"]);
    } finally {
      await fam.saveFamilySettings(DEFAULTS, actor);
    }
  });

  it("the database clears contact details written to a child and refuses grandchildren", async () => {
    const p = await parent();
    const kid = await fam.addChild(p.id, { firstName: "Dee" }, actor);
    const [w] = await m.db.db.update(s().customers).set({ phone: "+13195550999", email: "dee@kid.test", smsOptIn: true }).where(eq(s().customers.id, kid.id)).returning();
    expect(w).toMatchObject({ phone: null, email: null, smsOptIn: false });
    await expect(m.db.db.insert(s().customers).values({ firstName: "Grandkid", guardianId: kid.id })).rejects.toThrow();
    await expect(fam.addChild(kid.id, { firstName: "Nope" }, actor)).rejects.toMatchObject({ message: expect.stringMatching(/child profile/) });
  });

  it("a child's messages go to the parent, under the parent's consent", async () => {
    const p = await parent();
    const kid = await fam.addChild(p.id, { firstName: "Eli" }, actor);
    expect(await contact.contactFor(m.db.db, kid.id)).toEqual({ phone: p.phone, email: p.email, smsOptIn: true, emailOptIn: true });
    await m.db.db.update(s().customers).set({ smsOptIn: false }).where(eq(s().customers.id, p.id));
    expect(await contact.contactFor(m.db.db, kid.id)).toMatchObject({ phone: p.phone, smsOptIn: false });
  });

  it("edits only the parent's own child", async () => {
    const p = await parent();
    const other = await parent("Olive");
    const kid = await fam.addChild(p.id, { firstName: "Fay" }, actor);
    const r = await fam.updateChild(kid.id, { notes: "Likes a fade", age: 9 }, actor, { guardianId: p.id });
    expect(r).toMatchObject({ notes: "Likes a fade", birthYear: Number(today.slice(0, 4)) - 9 });
    await expect(fam.updateChild(kid.id, { notes: "x" }, actor, { guardianId: other.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(fam.detachChild(kid.id, actor, { guardianId: other.id })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("family booking", () => {
  it("books the parent and two kids at once (same time with another barber, then back to back); the confirmations go to the parent", async () => {
    const p = await parent();
    const k1 = await fam.addChild(p.id, { firstName: "Gus" }, actor);
    const k2 = await fam.addChild(p.id, { firstName: "Hal" }, actor);
    let open: { startsAt: string; barberIds: string[] } | undefined;
    for (let i = 3; i < 25 && !open; i++) {
      const av = await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(today, i), serviceId: fx.cut, barberRef: "any" });
      open = av.slots.find((x) => x.barberIds.length >= 2);
    }
    expect(open).toBeDefined();
    const made = await booking.bookFamily(
      {
        shopId: "coralville",
        people: [
          { customerId: p.id, serviceId: fx.cut, staffId: open!.barberIds[0], startsAt: open!.startsAt },
          { customerId: k1.id, serviceId: fx.cut, timing: "same_time" },
          { customerId: k2.id, serviceId: fx.cut, timing: "after" },
        ],
      },
      { guardianId: p.id, source: "staff", actor },
    );
    expect(made).toHaveLength(3);
    const [a, b, c] = made;
    expect(b.startsAt).toBe(a.startsAt);
    expect(b.barber.id).not.toBe(a.barber.id);
    expect(new Date(c.startsAt).getTime()).toBeGreaterThanOrEqual(new Date(b.endsAt).getTime());
    const rows = await m.db.db.select().from(s().appointments).where(m.drizzle.inArray(s().appointments.id, made.map((x) => x.id)));
    expect(rows.map((r) => r.customerId).sort()).toEqual([p.id, k1.id, k2.id].sort());
    const jobs = await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.appointmentId, b.id));
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect([p.phone, p.email]).toContain(j.to);
  });

  it("is all or nothing, and only for people on the account", async () => {
    const p = await parent();
    const kid = await fam.addChild(p.id, { firstName: "Ivy" }, actor);
    const stranger = await parent("Stranger");
    let open: { startsAt: string; barberIds: string[] } | undefined;
    for (let i = 3; i < 25 && !open; i++) open = (await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(today, i), serviceId: fx.cut, barberRef: fx.makenna })).slots[0];
    const count = async () => (await m.db.db.select().from(s().appointments).where(m.drizzle.inArray(s().appointments.customerId, [p.id, kid.id]))).length;
    await expect(
      booking.bookFamily({ shopId: "coralville", people: [{ customerId: stranger.id, serviceId: fx.cut, startsAt: open!.startsAt }] }, { guardianId: p.id, source: "staff", actor }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      booking.bookFamily(
        {
          shopId: "coralville",
          people: [
            { customerId: p.id, serviceId: fx.cut, staffId: fx.makenna, startsAt: open!.startsAt },
            { customerId: kid.id, serviceId: fx.cut, staffId: fx.makenna, timing: "same_time" },
          ],
        },
        { guardianId: p.id, source: "staff", actor },
      ),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    expect(await count()).toBe(0);
  });
});

describe("family ticket", () => {
  it("one ticket for parent and child with two barbers: the tip splits per barber and both visits close", async () => {
    const p = await parent();
    const kid = await fam.addChild(p.id, { firstName: "Jo" }, actor);
    const pa = await appt(p.id, fx.makenna);
    const ka = await appt(kid.id, fx.michelle);
    const outsider = await appt((await parent("Other")).id, fx.michelle);

    const sale = await m.checkout.openSaleForAppointment(pa.id, actor);
    const ctx = await m.checkout.loadCheckoutContext(sale.id);
    expect(ctx.family.candidates.map((c) => c.appointmentId)).toEqual([ka.id]);
    await expect(ticket.addAppointmentToTicket(sale.id, outsider.id, actor)).rejects.toMatchObject({ message: expect.stringMatching(/family/) });
    await ticket.addAppointmentToTicket(sale.id, ka.id, actor);
    expect((await m.checkout.openSaleForAppointment(ka.id, actor)).id).toBe(sale.id);
    expect((await m.checkout.loadCheckoutContext(sale.id)).family.members).toEqual([expect.objectContaining({ appointmentId: ka.id, customerId: kid.id, isChild: true, staffId: fx.michelle })]);

    await m.checkout.finalizeSale({
      saleId: sale.id,
      lines: [
        { kind: "service", refId: fx.cut, qty: 1, appointmentId: pa.id },
        { kind: "service", refId: fx.cut, qty: 1, appointmentId: ka.id },
      ],
      tipCents: 1000,
      tender: cash,
      actor,
    });
    const items = await m.db.db.select().from(s().saleItems).where(eq(s().saleItems.saleId, sale.id));
    expect(items.map((i) => [i.appointmentId, i.staffId]).sort()).toEqual(
      [
        [pa.id, fx.makenna],
        [ka.id, fx.michelle],
      ].sort(),
    );
    const shares = await m.db.db.select().from(s().saleTipShares).where(eq(s().saleTipShares.saleId, sale.id));
    expect(shares.map((x) => x.staffId).sort()).toEqual([fx.makenna, fx.michelle].sort());
    const tips = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, sale.id));
    const tipOf = (id: string) => tips.filter((t) => t.staffId === id).reduce((a, t) => a + t.amountCents, 0);
    expect([tipOf(fx.makenna), tipOf(fx.michelle)]).toEqual([500, 500]);
    expect([await statusOf(pa.id), await statusOf(ka.id)]).toEqual(["completed", "completed"]);

    const earned = await ledger(sale.id);
    expect(sumFor(earned, p.id)).toBe(2 * fx.cutCents);
    expect(sumFor(earned, kid.id)).toBe(0);
    const bal = await m.loyalty.loyaltyBalance(kid.id);
    expect(bal).toMatchObject({ household: true, ownerId: p.id });
  });

  it("taking a child off the ticket returns their appointment to checked in; the payer can't change to someone outside the family", async () => {
    const p = await parent();
    const kid = await fam.addChild(p.id, { firstName: "Kit" }, actor);
    const pa = await appt(p.id, fx.makenna);
    const ka = await appt(kid.id, fx.michelle);
    const sale = await m.checkout.openSaleForAppointment(pa.id, actor);
    await ticket.addAppointmentToTicket(sale.id, ka.id, actor);
    expect(await statusOf(ka.id)).toBe("in_service");
    await ticket.removeAppointmentFromTicket(sale.id, ka.id, actor);
    expect(await statusOf(ka.id)).toBe("checked_in");
    expect((await m.db.db.select().from(s().saleItems).where(and(eq(s().saleItems.saleId, sale.id), eq(s().saleItems.appointmentId, ka.id)))).length).toBe(0);
    await m.checkout.voidSale(sale.id, "Test over", actor);
  });

  it("individual loyalty earns on each person's card; a void reverses each", async () => {
    const p = await parent();
    const kid = await fam.addChild(p.id, { firstName: "Lu" }, actor);
    await fam.saveFamilySettings({ ...DEFAULTS, loyalty: "individual" }, actor);
    try {
      const pa = await appt(p.id, fx.makenna);
      const ka = await appt(kid.id, fx.michelle);
      const sale = await m.checkout.openSaleForAppointment(pa.id, actor);
      await ticket.addAppointmentToTicket(sale.id, ka.id, actor);
      await m.checkout.finalizeSale({
        saleId: sale.id,
        lines: [
          { kind: "service", refId: fx.cut, qty: 1, appointmentId: pa.id },
          { kind: "service", refId: fx.cut, qty: 1, appointmentId: ka.id },
        ],
        tipCents: 0,
        tender: cash,
        actor,
      });
      let rows = await ledger(sale.id);
      expect([sumFor(rows, p.id), sumFor(rows, kid.id)]).toEqual([fx.cutCents, fx.cutCents]);
      expect(await m.loyalty.loyaltyBalance(kid.id)).toMatchObject({ household: false, ownerId: kid.id, lifetimeEarnedCents: fx.cutCents });

      await m.checkout.voidSale(sale.id, "Rang up the wrong family", actor);
      rows = await ledger(sale.id);
      expect([sumFor(rows, p.id), sumFor(rows, kid.id)]).toEqual([0, 0]);
      expect([await statusOf(pa.id), await statusOf(ka.id)]).toEqual(["in_service", "in_service"]);
    } finally {
      await fam.saveFamilySettings(DEFAULTS, actor);
    }
  });
});

describe("reports, search and filters", () => {
  it("counts kids' cuts separately, filters on has kids, and a child's name finds the parent", async () => {
    const scope = { shopIds: [fx.shop], from: today, to: today };
    const before = await m.reports.kpis(scope);
    const p = await parent("Quentin");
    const kid = await fam.addChild(p.id, { firstName: "Zebediah", lastName: "Quillfeather" }, actor);
    const loner = await parent("Loner");
    const ka = await appt(kid.id, fx.michelle);
    await m.db.db.update(s().appointments).set({ status: "completed", completedAt: new Date() }).where(eq(s().appointments.id, ka.id));
    const pa = await appt(p.id, fx.makenna);
    await m.db.db.update(s().appointments).set({ status: "completed", completedAt: new Date() }).where(eq(s().appointments.id, pa.id));
    const after = await m.reports.kpis(scope);
    expect(after.kidsCuts - before.kidsCuts).toBe(1);
    expect(after.kidsClients - before.kidsClients).toBe(1);

    const { SegmentSchema } = await import("@/domain/marketing");
    const { filteredClientIds } = await import("@/server/client-filters");
    const pick = async (seg: object) => {
      const where = (await filteredClientIds(SegmentSchema.parse(seg), new Date()))!;
      const rows = await m.db.db
        .select({ id: s().customers.id })
        .from(s().customers)
        .where(and(m.drizzle.inArray(s().customers.id, [p.id, kid.id, loner.id]), m.drizzle.sql`${s().customers.id} in ${where}`));
      return rows.map((r) => r.id).sort();
    };
    expect(await pick({ hasKids: "yes" })).toEqual([p.id]);
    expect(await pick({ hasKids: "no" })).toEqual([kid.id, loner.id].sort());
    expect(await pick({ isChild: "yes" })).toEqual([kid.id]);

    await signInAs(fx.frontdesk, fx.shop);
    const { searchCustomersAction } = await import("@/app/admin/calendar/actions");
    const r = await searchCustomersAction("Zebediah Quillfeather", "booking");
    if (!r.ok) throw new Error(r.error);
    const ids = r.data.map((h: { id: string }) => h.id);
    expect(ids.slice(0, 2)).toEqual([kid.id, p.id]);
  });

  it("a phone lookup lists the parent with the kids' first names under the masked phone; a child's name brings every parent along", async () => {
    const { groupFamilies } = await import("@/domain/client-search");
    const p = await parent("Philippa");
    const a = await fam.addChild(p.id, { firstName: "Wilhelmina", birthday: "2018-05-01" }, actor);
    const b = await fam.addChild(p.id, { firstName: "Barnaby" }, actor);
    await signInAs(fx.frontdesk, fx.shop);
    const { searchCustomersAction } = await import("@/app/admin/calendar/actions");
    const r = await searchCustomersAction(p.phone!.slice(2), "walk_in");
    if (!r.ok) throw new Error(r.error);
    const g = groupFamilies(r.data).find((x) => x.hit.id === p.id)!;
    expect(g.hit.phone).toMatch(new RegExp(`${p.phone!.slice(-4)}$`));
    expect(g.hit.phone).not.toContain(p.phone!.slice(2, 8));
    expect(g.kids.map((k) => [k.id, k.firstName])).toEqual([
      [a.id, "Wilhelmina"],
      [b.id, "Barnaby"],
    ]);
    expect(JSON.stringify(g.kids)).not.toMatch(/2018-05-01|Family/);

    const name = `Ozymandias${String(Date.now()).slice(-5)}`;
    const families = [];
    for (let i = 0; i < 5; i++) {
      const mom = await parent(`Guardian${i}`);
      families.push({ mom: mom.id, kid: (await fam.addChild(mom.id, { firstName: name }, actor)).id });
    }
    const r2 = await searchCustomersAction(name, "booking");
    if (!r2.ok) throw new Error(r2.error);
    const grouped = groupFamilies(r2.data);
    for (const f of families) expect(grouped.find((x) => x.hit.id === f.mom)?.kids.find((k) => k.id === f.kid)?.matched).toBe(true);
  });
});

describe("Squire families and duplicates", () => {
  it("links Squire kid rows to their parent after a clients import; a dry run only counts", async () => {
    const tag = String(Date.now()).slice(-6);
    const mk = async (firstName: string, squireId: string, phone?: string) => {
      const [c] = await m.db.db.insert(s().customers).values({ firstName, lastName: "Squire", phone: phone ?? null, homeShopId: fx.shop }).returning();
      await m.db.db.insert(s().customerSquireIds).values({ squireId, customerId: c.id, shopId: fx.shop });
      return c;
    };
    const mom = await mk("Mona", `SQ-P-${tag}`, `+1319554${tag.slice(-4)}`);
    const kid1 = await mk("Nia", `SQ-K1-${tag}`);
    const kid2 = await mk("Omar", `SQ-K2-${tag}`, "+13195540001");
    const csv = [
      "Client ID,First Name,Last Name,Parent Client ID,Parent Phone,Birthday",
      `SQ-P-${tag},Mona,Squire,,,`,
      `SQ-K1-${tag},Nia,Squire,SQ-P-${tag},,2016-04-02`,
      `SQ-K2-${tag},Omar,Squire,,${mom.phone},`,
      `SQ-K3-${tag},Pip,Squire,SQ-P-${tag},,`,
    ].join("\n");
    const { importFamilies } = await import("@/server/family-import");
    const dry = (await importFamilies(csv, { dryRun: true, actor }))!;
    expect(dry.linked).toBe(3);
    expect(await fam.childrenOf(mom.id)).toEqual([]);

    const r = (await importFamilies(csv, { dryRun: false, actor }))!;
    expect(r).toMatchObject({ linked: 2, alreadyLinked: 0 });
    expect(r.problems).toEqual([expect.objectContaining({ line: 5, message: expect.stringMatching(/isn't on file/) })]);
    const kids = await fam.childrenOf(mom.id);
    expect(kids.map((k) => k.id).sort()).toEqual([kid1.id, kid2.id].sort());
    expect(kids.find((k) => k.id === kid1.id)!.birthday).toBe("2016-04-02");
    expect(kids.find((k) => k.id === kid2.id)!.phone).toBeNull();

    const again = (await importFamilies(csv, { dryRun: false, actor }))!;
    expect(again).toMatchObject({ linked: 0, alreadyLinked: 2 });
  });

  it("attaches a duplicate as the parent's child, clears its contact and sign-in; merges refuse a parent and their child", async () => {
    const p = await parent();
    const [dup] = await m.db.db.insert(s().customers).values({ firstName: "Quin", lastName: "Family", phone: p.phone, smsOptIn: true, homeShopId: fx.shop }).returning();
    await m.auth.issueTokens(dup.id, null);
    const r = await fam.attachChild(p.id, dup.id, actor);
    expect(r).toEqual({ attached: true });
    const after = (await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, dup.id) }))!;
    expect(after).toMatchObject({ guardianId: p.id, phone: null, smsOptIn: false });
    expect(await m.db.db.select().from(s().refreshTokens).where(eq(s().refreshTokens.customerId, dup.id))).toEqual([]);
    expect(await fam.attachChild(p.id, dup.id, actor)).toEqual({ attached: false, reason: "already" });
    await expect(fam.attachChild(dup.id, p.id, actor)).rejects.toThrow();

    await expect(m.customers.mergeCustomers(p.id, dup.id, actor)).rejects.toMatchObject({ message: expect.stringMatching(/parent and their own child/) });
    const other = await parent("Otto");
    await expect(m.customers.mergeCustomers(dup.id, p.id, actor)).rejects.toMatchObject({ message: expect.stringMatching(/parent and their own child/) });
    await fam.addChild(other.id, { firstName: "Rae" }, actor);
    await expect(m.customers.mergeCustomers(dup.id, other.id, actor)).rejects.toMatchObject({ message: expect.stringMatching(/Keep the parent's record/) });
  });
});

describe("own account at 13+", () => {
  it("splits a teenager into their own account, keeping their visits; their earlier cuts still count as kids' cuts", async () => {
    const p = await parent();
    const teen = await fam.addChild(p.id, { firstName: "Sky", birthday: m.time.addDays(today, -14 * 366) }, actor);
    const young = await fam.addChild(p.id, { firstName: "Tot", age: 8 }, actor);
    const visit = await appt(teen.id, fx.makenna);
    await m.db.db.update(s().appointments).set({ status: "completed", completedAt: new Date() }).where(eq(s().appointments.id, visit.id));
    const scope = { shopIds: [fx.shop], from: today, to: today };
    const kidsBefore = (await m.reports.kpis(scope)).kidsCuts;

    await expect(fam.splitChild(young.id, { phone: "3195553131" }, actor)).rejects.toMatchObject({ message: expect.stringMatching(/from 13/) });
    await expect(fam.splitChild(teen.id, { phone: p.phone }, actor)).rejects.toMatchObject({ message: expect.stringMatching(/not the parent's/) });
    await expect(fam.splitChild(teen.id, {}, actor)).rejects.toMatchObject({ code: "bad_request" });
    const n = String(1000 + Math.floor(Math.random() * 8999));
    await fam.splitChild(teen.id, { phone: `319555${n}`, smsOptIn: true }, actor);
    const row = (await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, teen.id) }))!;
    expect(row).toMatchObject({ guardianId: null, formerGuardianId: p.id, phone: `+1319555${n}`, smsOptIn: true });
    expect(row.ownAccountAt).not.toBeNull();
    expect(await statusOf(visit.id)).toBe("completed");
    expect((await m.db.db.query.appointments.findFirst({ where: eq(s().appointments.id, visit.id) }))!.customerId).toBe(teen.id);
    expect((await m.reports.kpis(scope)).kidsCuts).toBe(kidsBefore);
    expect((await fam.familyView(p.id)).children.map((c) => c.id)).toEqual([young.id]);
  });
});

describe("badges and the parent's view", () => {
  it("the parent gets the Family badge, each child the Kid badge, visible in the family view", async () => {
    const p = await parent();
    const kid = await fam.addChild(p.id, { firstName: "Uma", notes: "Sensory: no blow dryer" }, actor);
    const { storedBadges } = await import("@/server/badges");
    const stored = await storedBadges([p.id, kid.id], new Date());
    expect(stored.get(p.id)!.map((b) => b.k)).toContain("family");
    expect(stored.get(kid.id)!.map((b) => b.k)).toContain("kid");
    expect(stored.get(kid.id)!.map((b) => b.k)).not.toContain("missing_info");
    const view = await fam.familyView(p.id);
    expect(view.settings).toEqual(DEFAULTS);
    expect(view.children).toEqual([expect.objectContaining({ id: kid.id, firstName: "Uma", notes: "Sensory: no blow dryer", visits: 0, canSplit: false, badges: expect.any(Array) })]);
  });

  it("the family endpoints: list, add, edit, remove; a child can't use them", async () => {
    const p = await parent();
    const token = (await m.auth.issueTokens(p.id, null)).accessToken;
    const api = await import("@/server/family-api");
    const call = (fn: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>, method: string, path: string, body?: object, params: Record<string, string> = {}, bearer = token) =>
      fn(
        new Request(`http://test/api/account/family${path}`, {
          method,
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        { params: Promise.resolve(params) },
      );
    const list = await call(api.getFamily as never, "GET", "");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ settings: DEFAULTS, children: [] });

    const add = await call(api.postChild as never, "POST", "/children", { firstName: "Vee", age: 6, notes: "Short on the sides" });
    expect(add.status).toBe(201);
    const child = (await add.json()) as { id: string; age: number; notes: string };
    expect(child).toMatchObject({ age: 6, notes: "Short on the sides" });

    const edit = await call(api.patchChild as never, "PATCH", `/children/${child.id}`, { notes: "Buzz cut" }, { id: child.id });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ id: child.id, notes: "Buzz cut" });

    const childToken = (await m.auth.issueTokens(child.id, null)).accessToken;
    expect((await call(api.getFamily as never, "GET", "", undefined, {}, childToken)).status).toBe(403);

    const removed = await call(api.removeChild as never, "POST", `/children/${child.id}/remove`, undefined, { id: child.id });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ children: [] });
  });
});
