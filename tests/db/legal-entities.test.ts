/**
 * Legal entities (ST-I14) against a real database: each shop's legal entity (FEIN) is its pay
 * group's employer, kept on the shop; every punch, time entry, tip payout, cash tip declaration and
 * locked pay period carries the employer it was written under; and each entity's state
 * registrations keep only the last 4 of an account number.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let groups: typeof import("@/server/payroll/groups");
let run: typeof import("@/server/payroll/run");
let tp: typeof import("@/server/tips/payouts");
let tl: typeof import("@/server/tips/ledger");

beforeAll(async () => {
  m = await loadModules();
  groups = await import("@/server/payroll/groups");
  run = await import("@/server/payroll/run");
  tp = await import("@/server/tips/payouts");
  tl = await import("@/server/tips/ledger");
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;
const someone = async (shopId: string) => (await m.db.db.select({ id: s().staffShops.staffId }).from(s().staffShops).where(eq(s().staffShops.shopId, shopId)).limit(1))[0].id;
const at = (h: number) => new Date(Date.UTC(2026, 9, 5, h));

describe("the legal entity on every shop, time, tip, transfer and export row (ST-I14)", () => {
  it("a shop's entity follows its pay group; rows keep the employer they were written under", async () => {
    const groupsNow = await groups.ensurePayGroups();
    const ri = await shop("rock-island");
    const g = groupsNow.find((x) => x.shopId === ri.id)!;
    expect(g.employerId).not.toBeNull();
    expect((await shop("rock-island")).legalEntityId).toBe(g.employerId);

    const who = await someone(ri.id);
    const [before] = await m.db.db.insert(s().timeEntries).values({ staffId: who, shopId: ri.id, startsAt: at(14), endsAt: at(18), source: "manual" }).returning();
    expect(before.employerId).toBe(g.employerId);
    const [decl] = await m.db.db
      .insert(s().tipDeclarations)
      .values({ staffId: who, shopId: ri.id, businessDate: "2026-10-05", amountCents: 1500, source: "web", attestation: "I received these cash tips." })
      .returning();
    expect(decl.employerId).toBe(g.employerId);

    // Paid in cash: its card tips are in the shop's own account (I10), so they're never a Stripe payout.
    await m.db.db.update(s().shops).set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } }).where(eq(s().shops.id, ri.id));
    await tl.syncTipLedger();
    const b = await tp.buildBatch({ shopId: ri.id, kind: "manual", cutoff: m.time.todayLocal(), actor });
    const payouts = await m.db.db.select().from(s().tipPayouts).where(eq(s().tipPayouts.batchId, b.batchId));
    expect(payouts.length).toBeGreaterThan(0);
    expect(new Set(payouts.map((p) => p.employerId))).toEqual(new Set([g.employerId]));

    const view = await run.buildPayroll(...(await currentPeriod()));
    expect(view!.blocks.find((x) => x.shopId === ri.id)!.employer).toMatchObject({ id: g.employerId, legalName: "Ray'z Inc." });

    // Moving the shop to another entity moves the shop, not what was already written.
    expect(await run.savePayGroup(g.id, { label: g.label, legalEntity: "Ray'z Illinois LLC", exportTab: g.exportTab, calendar: g.calendar }, actor)).toBeNull();
    const moved = await shop("rock-island");
    expect(moved.legalEntityId).not.toBe(g.employerId);
    const il = (await m.db.db.query.payrollEmployers.findFirst({ where: eq(s().payrollEmployers.id, moved.legalEntityId!) }))!;
    expect(il.legalName).toBe("Ray'z Illinois LLC");
    expect((await m.db.db.query.timeEntries.findFirst({ where: eq(s().timeEntries.id, before.id) }))!.employerId).toBe(g.employerId);
    expect((await m.db.db.query.tipDeclarations.findFirst({ where: eq(s().tipDeclarations.id, decl.id) }))!.employerId).toBe(g.employerId);
    const [after] = await m.db.db.insert(s().timeEntries).values({ staffId: who, shopId: ri.id, startsAt: at(19), endsAt: at(21), source: "manual" }).returning();
    expect(after.employerId).toBe(il.id);

    // A time entry moved to another shop takes that shop's employer.
    const moline = await shop("moline");
    const [mv] = await m.db.db.update(s().timeEntries).set({ shopId: moline.id }).where(eq(s().timeEntries.id, after.id)).returning();
    expect(mv.employerId).toBe(moline.legalEntityId);

    expect(await run.savePayGroup(g.id, { label: g.label, legalEntity: "Ray'z Inc.", exportTab: g.exportTab, calendar: g.calendar }, actor)).toBeNull();
    expect((await shop("rock-island")).legalEntityId).toBe(g.employerId);
    await m.db.db.delete(s().timeEntries).where(m.drizzle.inArray(s().timeEntries.id, [before.id, after.id]));
  });

  it("rows written before a shop has a pay group are tagged when it gets one, and declarations stay append-only", async () => {
    const [sh] = await m.db.db.insert(s().shops).values({ slug: "i14-entity-test", name: "Entity Test", state: "IA", status: "archived", active: false }).returning();
    expect(sh.legalEntityId).toBeNull();
    const who = await someone((await shop("utica")).id);
    const [te] = await m.db.db.insert(s().timeEntries).values({ staffId: who, shopId: sh.id, startsAt: at(14), endsAt: at(15), source: "manual" }).returning();
    const [d] = await m.db.db
      .insert(s().tipDeclarations)
      .values({ staffId: who, shopId: sh.id, businessDate: "2026-10-05", amountCents: 500, source: "web", attestation: "I received these cash tips." })
      .returning();
    expect([te.employerId, d.employerId]).toEqual([null, null]);

    const [pg] = await m.db.db
      .insert(s().payGroups)
      .values({ shopId: sh.id, label: "Entity Test", legalEntity: "Ray'z Iowa LLC", exportTab: "Entity Test", anchorStart: "2026-10-18", anchorNumber: 23 })
      .returning();
    expect(pg.employerId).not.toBeNull();
    expect((await m.db.db.query.shops.findFirst({ where: eq(s().shops.id, sh.id) }))!.legalEntityId).toBe(pg.employerId);
    expect((await m.db.db.query.timeEntries.findFirst({ where: eq(s().timeEntries.id, te.id) }))!.employerId).toBe(pg.employerId);
    expect((await m.db.db.query.tipDeclarations.findFirst({ where: eq(s().tipDeclarations.id, d.id) }))!.employerId).toBe(pg.employerId);

    await expect(m.db.db.update(s().tipDeclarations).set({ amountCents: 1 }).where(eq(s().tipDeclarations.id, d.id))).rejects.toThrow();
    await expect(m.db.db.update(s().tipDeclarations).set({ employerId: null }).where(eq(s().tipDeclarations.id, d.id))).rejects.toThrow();

    const [locked] = await m.db.db
      .insert(s().payrollRuns)
      .values({ payGroupId: pg.id, periodStart: "2026-10-18", periodEnd: "2026-10-31", periodNumber: 23, checkDate: "2026-11-06", settings: {}, snapshot: {} })
      .returning();
    expect(locked.employerId).toBe(pg.employerId);

    await m.db.db.delete(s().payrollRuns).where(eq(s().payrollRuns.id, locked.id));
    await m.db.db.delete(s().timeEntries).where(eq(s().timeEntries.id, te.id));
  });

  it("state registrations keep only the last 4 and flag a state an entity has shops in but no registration", async () => {
    await groups.ensurePayGroups();
    const ri = await shop("rock-island");
    const employerId = ri.legalEntityId!;
    expect(await groups.saveEmployerState(employerId, { state: "il", withholdingIdLast4: "1234-5678", unemploymentIdLast4: "", registeredOn: null }, actor)).toMatch(/only the last 4/);
    expect(await groups.saveEmployerState(employerId, { state: "Illinois", withholdingIdLast4: "", unemploymentIdLast4: "", registeredOn: null }, actor)).toMatch(/two-letter/);
    expect(await groups.saveEmployerState(employerId, { state: "il", withholdingIdLast4: "5678", unemploymentIdLast4: "0042", registeredOn: "2019-03-01" }, actor)).toBeNull();
    await expect(m.db.db.insert(s().payrollEmployerStates).values({ employerId, state: "IA", withholdingIdLast4: "123456789" })).rejects.toThrow();

    const e = (await groups.payrollEmployerList()).find((x) => x.id === employerId)!;
    expect(e.workStates).toEqual(["IA", "IL"]);
    expect(e.states.map((r) => [r.state, r.withholdingIdLast4, r.unemploymentIdLast4])).toEqual([["IL", "5678", "0042"]]);
    expect(e.unregistered).toEqual(["IA"]);

    expect(await groups.saveEmployerState(employerId, { state: "IL", withholdingIdLast4: "9999", unemploymentIdLast4: "0042", registeredOn: "2019-03-01" }, actor)).toBeNull();
    expect((await groups.payrollEmployerList()).find((x) => x.id === employerId)!.states).toHaveLength(1);
    expect(await groups.removeEmployerState(employerId, "IL", actor)).toBeNull();
    expect(await groups.removeEmployerState(employerId, "IL", actor)).toMatch(/gone/);
  });
});

async function currentPeriod(): Promise<[string, string]> {
  const p = (await run.periodChoices()).find((x) => x.current)!;
  return [p.start, p.end];
}
