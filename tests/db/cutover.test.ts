/**
 * Moving one shop off Squire (C22, C11 both ways, the C21 match report): the switch needs a recorded
 * freeze, a delta import that leaves other shops alone, and Squire's final exports reconciled to the cent;
 * an import after the reconciliation means reconciling again; handing back lists what Squire needs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));

let m: Mods;
let cut: typeof import("@/server/cutover");
let report: typeof import("@/server/import-match-report");
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const actor = { staffId: null, label: "test" };
let kimberly: { id: string };
let coralville: { id: string };

const CLIENTS = `Client ID,First Name,Last Name,Phone,Location
CUT-1,Dana,Cutover,(563) 555-8101,Kimberly
CUT-2,Eli,Cutover,(563) 555-8102,Kimberly`;
const BOOKINGS_BEFORE = `Appointment ID,Date,Time,Location,Barber,Client ID,Client Name,Phone,Service,Price,Duration,Status
CUT-A1,3/10/2027,7:15 AM,Kimberly,Beth,CUT-1,Dana Cutover,(563) 555-8101,Buzz Cut,24.00,15,Booked
CUT-A2,3/10/2027,7:15 AM,Coralville,Michelle,CUT-2,Eli Cutover,(563) 555-8102,Buzz Cut,24.00,15,Booked`;
const BOOKINGS_FINAL = `Appointment ID,Date,Time,Location,Barber,Client ID,Client Name,Phone,Service,Price,Duration,Status
CUT-A1,3/10/2027,7:15 AM,Kimberly,Beth,CUT-1,Dana Cutover,(563) 555-8101,Buzz Cut,24.00,15,Cancelled
CUT-A2,3/11/2027,7:15 AM,Coralville,Michelle,CUT-2,Eli Cutover,(563) 555-8102,Buzz Cut,24.00,15,Booked
CUT-A3,3/12/2027,7:45 AM,Kimberly,Beth,CUT-2,Eli Cutover,(563) 555-8102,Buzz Cut,30.00,15,Booked`;
const LOYALTY = `Client ID,First Name,Phone,Progress,Rewards Available
CUT-1,Dana,(563) 555-8101,$12.00,1`;
const CARDS = (one: string) => `Code,Original Amount,Remaining Balance,Client ID
CUTGC-1,$50.00,${one},CUT-1
CUTGC-2,$40.00,$40.00,`;

const shopRow = (id: string) => m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.id, id) });
const appt = (squireId: string) => m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.squireId, squireId) });
const files = (o: Partial<Record<"bookings" | "loyalty" | "gift_cards" | "tickets", string>>) => Object.fromEntries(Object.entries(o).map(([k, csv]) => [k, { name: `${k}.csv`, csv }]));

beforeAll(async () => {
  m = await loadModules();
  cut = await import("@/server/cutover");
  report = await import("@/server/import-match-report");
  const all = await m.db.db.select().from(m.schema.shops);
  kimberly = all.find((s) => s.name === "Kimberly")!;
  coralville = all.find((s) => s.name === "Coralville")!;
  await m.db.db.update(m.schema.shops).set({ bookingMode: "external", externalBookingUrl: "https://getsquire.com/booking/rayz-kimberly" }).where(eq(m.schema.shops.id, kimberly.id));
});

afterAll(async () => {
  await m?.db.closeDb();
});

describe("per-shop Squire cutover (C22)", () => {
  it("a clients dry run reports, per shop, how clients match and where a number is shared (C21)", async () => {
    const lines = await report.clientMatchReport(`${CLIENTS}\nCUT-3,Fay,Cutover,(563) 555-8102,Kimberly\n,Walk-In,,,Kimberly`);
    expect(lines.find((l) => l.shop === "Kimberly")).toMatchObject({ rows: 4, skipped: 1, newProfiles: 3, sharedPhone: 2, noContact: 0 });
  });

  it("imports, then won't reconcile or switch until the freeze is recorded, and the settings switch is refused", async () => {
    for (const [kind, csv] of [
      ["clients", CLIENTS],
      ["appointments", BOOKINGS_BEFORE],
      ["loyalty", LOYALTY],
      ["gift_cards", CARDS("$30.00")],
    ] as const) {
      const r = await m.importer.runImport(kind, csv, { dryRun: false, actor });
      expect(r.errors).toEqual([]);
    }
    expect(await cut.squireHistory(kimberly.id)).toBe(true);
    await expect(cut.reconcileShop(actor, kimberly.id, files({ bookings: BOOKINGS_FINAL }))).rejects.toThrow(/turned off/);
    await expect(cut.signOffAndSwitch(actor, kimberly.id)).rejects.toThrow(/turned off/);
    await expect(cut.recordFreeze(actor, kimberly.id, new Date(Date.now() + 3600_000))).rejects.toThrow(/ahead of time/);
  });

  it("a delta import for the shop takes only its bookings; reconciling shows each difference in cents", async () => {
    await cut.recordFreeze(actor, kimberly.id, new Date(Date.now() - 3600_000));
    const coralBefore = await appt("CUT-A2");
    const delta = await m.importer.runImport("appointments", BOOKINGS_FINAL, { dryRun: false, actor, shopId: kimberly.id });
    expect(delta.skippedByReason).toEqual({ "Other shop": 1 });
    expect(delta.errors[0].message).toMatch(/Coralville isn't the shop being moved/);
    expect((await appt("CUT-A2"))!.startsAt).toEqual(coralBefore!.startsAt);
    expect(await appt("CUT-A1")).toMatchObject({ status: "cancelled" });
    expect(await appt("CUT-A3")).toMatchObject({ status: "booked", estimateCents: 3000 });
    const [run] = await m.db.db.select().from(m.schema.importRuns).where(eq(m.schema.importRuns.id, delta.runId!));
    expect(run.shopId).toBe(kimberly.id);

    // CUTGC-2 was used here after the import: Squire can't know, so it's explained, not a blocker.
    const card2 = await m.db.db.query.giftCards.findFirst({ where: eq(m.schema.giftCards.code, "CUTGC-2") });
    await m.db.db.update(m.schema.giftCards).set({ balanceCents: 3000 }).where(eq(m.schema.giftCards.id, card2!.id));
    await m.db.db.insert(m.schema.giftCardLedger).values({ giftCardId: card2!.id, deltaCents: -1000, kind: "redeem" });

    const r = await cut.reconcileShop(actor, kimberly.id, files({ bookings: BOOKINGS_FINAL, loyalty: LOYALTY, gift_cards: CARDS("$25.00") }));
    expect(r.matched).toBe(false);
    const s = r.reconciliation.sections;
    expect(s.bookings).toMatchObject({ expected: { count: 1, cents: 3000 }, actual: { count: 1, cents: 3000 }, differences: [] });
    expect(s.loyalty!.differences).toEqual([]);
    expect(s.gift_cards!.expected).toEqual({ count: 2, cents: 6500 });
    expect(s.gift_cards!.actual).toEqual({ count: 2, cents: 6000 });
    expect(s.gift_cards!.differences).toEqual([expect.objectContaining({ ref: "GC-1", squireCents: 2500, hereCents: 3000 })]);
    expect(s.gift_cards!.explained).toEqual([expect.objectContaining({ squireCents: 4000, hereCents: 3000, label: expect.stringMatching(/used here since the import/) })]);
    expect(cut.cutoverStage((await shopRow(kimberly.id))!, (await m.db.db.query.shopCutovers.findFirst({ where: eq(m.schema.shopCutovers.shopId, kimberly.id) }))!)).toBe("frozen");
    await expect(cut.signOffAndSwitch(actor, kimberly.id)).rejects.toThrow(/didn't match to the cent/);
  });

  it("matches once the final balances are imported; an import after that needs another reconciliation; then an owner switches it", async () => {
    await m.importer.runImport("gift_cards", CARDS("$25.00").split("\n").slice(0, 2).join("\n"), { dryRun: false, actor, shopId: kimberly.id });
    const missing = await cut.reconcileShop(actor, kimberly.id, files({ bookings: BOOKINGS_FINAL, gift_cards: CARDS("$25.00") }));
    expect(missing).toMatchObject({ matched: false, missing: ["loyalty"] });
    const ok = await cut.reconcileShop(actor, kimberly.id, files({ bookings: BOOKINGS_FINAL, loyalty: LOYALTY, gift_cards: CARDS("$25.00") }));
    expect(ok.matched).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    await m.importer.runImport("loyalty", LOYALTY, { dryRun: false, actor });
    await expect(cut.signOffAndSwitch(actor, kimberly.id)).rejects.toThrow(/Reconcile again/);
    expect((await cut.listCutovers()).find((x) => x.shop.id === kimberly.id)).toMatchObject({ stage: "frozen" });

    await cut.reconcileShop(actor, kimberly.id, files({ bookings: BOOKINGS_FINAL, loyalty: LOYALTY, gift_cards: CARDS("$25.00") }));
    // Nobody at the shop has set up Ray'z Stripe payouts yet: only an owner's reason lets it switch.
    await expect(cut.signOffAndSwitch(actor, kimberly.id)).rejects.toThrow(/haven't finished Stripe payout setup/);
    await expect(cut.signOffAndSwitch(actor, kimberly.id, new Date(), { staffWaiver: "   " })).rejects.toThrow(/haven't finished Stripe payout setup/);
    await cut.signOffAndSwitch(actor, kimberly.id, new Date(), { staffWaiver: "Two barbers are on leave; their tips wait for them" });
    expect(await shopRow(kimberly.id)).toMatchObject({ bookingMode: "platform" });
    const [sw] = await m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.entityId, kimberly.id), eq(m.schema.auditLog.action, "cutover.switch")));
    const staffPayouts = (sw.details as { staffPayouts: { onboarded: number; total: number; notOnboarded: unknown[]; waiver: string } }).staffPayouts;
    expect(staffPayouts).toMatchObject({ onboarded: 0, waiver: "Two barbers are on leave; their tips wait for them" });
    expect(staffPayouts.total).toBeGreaterThan(0);
    expect(staffPayouts.notOnboarded).toHaveLength(staffPayouts.total);
    const c = await m.db.db.query.shopCutovers.findFirst({ where: eq(m.schema.shopCutovers.shopId, kimberly.id) });
    expect(c).toMatchObject({ matched: true });
    expect(c!.signedOffAt).not.toBeNull();
    const audits = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, kimberly.id));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["cutover.freeze", "cutover.reconcile", "cutover.switch"]));
  });

  it("hands a shop back to Squire with the bookings made here, and a later move starts over", async () => {
    const [beth] = await m.db.db.select({ id: m.schema.staff.id }).from(m.schema.staff).where(eq(m.schema.staff.firstName, "Beth"));
    const dana = await m.customers.customerBySquireId(m.db.db, "CUT-1");
    await m.db.db.insert(m.schema.appointments).values({
      code: `CUTHB${Date.now() % 100000}`,
      shopId: kimberly.id,
      staffId: beth.id,
      customerId: dana!.id,
      startsAt: new Date("2027-03-15T13:15:00Z"),
      endsAt: new Date("2027-03-15T13:30:00Z"),
      status: "booked",
      source: "staff",
      estimateCents: 2400,
    });
    const before = await cut.handBackReport(kimberly.id);
    const mine = before.bookings.filter((b) => b.code.startsWith("CUTHB"));
    expect(mine.map((b) => b.firstName)).toEqual(["Dana"]);
    const imported = (await appt("CUT-A3"))!.code;
    expect(before.bookings.some((b) => b.code === imported)).toBe(false);
    expect(cut.handBackCsv(mine).split("\n")[1]).toMatch(/^CUTHB\d+,.*,Dana,Cutover,\(563\) 555-8101,,,24\.00$/);

    await expect(cut.handBack(actor, kimberly.id, "http://insecure.example")).rejects.toThrow(/https/);
    await cut.handBack(actor, kimberly.id, "https://getsquire.com/booking/rayz-kimberly");
    expect(await shopRow(kimberly.id)).toMatchObject({ bookingMode: "external", externalBookingUrl: "https://getsquire.com/booking/rayz-kimberly" });
    const c = await m.db.db.query.shopCutovers.findFirst({ where: eq(m.schema.shopCutovers.shopId, kimberly.id) });
    expect(c).toMatchObject({ squireFrozenAt: null, matched: false, signedOffAt: null });
    expect(cut.cutoverStage((await shopRow(kimberly.id))!, c!)).toBe("handed_back");
    await expect(cut.signOffAndSwitch(actor, kimberly.id)).rejects.toThrow(/turned off/);
    expect(await cut.squireHistory(coralville.id)).toBe(true);
  });
});
