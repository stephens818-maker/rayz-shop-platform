/**
 * Staff payouts against a real database, with Stripe on (a stand-in client) and no transfer path
 * registered (ST-C11 pending): owed tips go through payroll at the cutoff and are never paid twice
 * (ST-C14); the iSolved tips-paid export per period, employer and employee, final only when it adds
 * up (ST-C13); every tip tagged with its employer (ST-I14); refunds within the window reverse the
 * tip and the shop absorbs the rest and disputes (ST-C15); the seven account states from Connect
 * webhooks (ST-C12); the payout tracker (ST-I11); and the yearly tax form check (ST-I13).
 */
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TIP_DEPOSIT_CONSENT_VERSION } from "@/domain/tip-deposit-consent";
import { Mods, actor, agreeToStripeDeposits, loadModules, lockHours } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("@/server/payments/processor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/payments/processor")>();
  return { ...mod, stripe: () => (globalThis as { __fakeStripe?: unknown }).__fakeStripe ?? null };
});

const moneyCalls: string[] = [];
const fake = {
  charges: { create: async () => (moneyCalls.push("debit"), { id: "py_x" }) },
  transfers: { create: async () => (moneyCalls.push("transfer"), { id: "tr_x" }) },
  payouts: { create: async () => (moneyCalls.push("payout"), { id: "po_x" }) },
  accounts: {
    update: async (id: string) => ({ id }),
    retrieve: async () => {
      throw new Error("offline in the test");
    },
  },
};
const fakeStripe = (on: boolean) => ((globalThis as { __fakeStripe?: unknown }).__fakeStripe = on ? fake : undefined);

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let tp: typeof import("@/server/tips/payouts");
let accounts: typeof import("@/server/tips/accounts");
let tracker: typeof import("@/server/tips/tracker");
let run: typeof import("@/server/payroll/run");
let groups: typeof import("@/server/payroll/groups");
let reports: typeof import("@/server/payroll/reports");
let mm: typeof import("@/server/payments/money-movement");
let connectWebhook: typeof import("@/server/payments/connect-webhook");
let today: string;

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  accounts = await import("@/server/tips/accounts");
  tracker = await import("@/server/tips/tracker");
  run = await import("@/server/payroll/run");
  groups = await import("@/server/payroll/groups");
  reports = await import("@/server/payroll/reports");
  mm = await import("@/server/payments/money-movement");
  connectWebhook = await import("@/server/payments/connect-webhook");
  today = m.time.todayLocal();
  await m.db.db
    .update(m.schema.shops)
    .set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } })
    .where(m.drizzle.sql`${m.schema.shops.tipPayouts} = '{}'::jsonb`);
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
  // Each test picks its transfer path; the platform's is the default outside tests.
  mm.registerMoneyMovement(null);
}, 180_000);

afterEach(() => {
  fakeStripe(false);
  mm.registerMoneyMovement(null);
});

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const card = { method: "card" as const, paymentMethodId: "pm_card_visa", entryMode: "keyed" as const };
const cash = { method: "cash" as const, cashTenderedCents: null };

const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;

async function barbers(slug: string, labels: string[]) {
  const sh = await shop(slug);
  const rows = await m.db.db
    .select({ id: s().staff.id, label: s().staff.displayLabel })
    .from(s().staffShops)
    .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
    .where(and(eq(s().staffShops.shopId, sh.id), m.drizzle.inArray(s().staff.displayLabel, labels)));
  expect(rows).toHaveLength(labels.length);
  return { shop: sh, ids: labels.map((l) => rows.find((r) => r.label === l)!.id) };
}

async function tipSale(shopId: string, staffId: string, tipCents: number, tender: typeof card | typeof cash = cash) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender, actor });
  return sale;
}

async function setStaffPayouts(v: Partial<import("@/domain/staff-payouts").StaffPayoutSettings>) {
  const [b] = await m.db.db.select({ v: s().brandSettings.staffPayouts }).from(s().brandSettings);
  await m.db.db.update(s().brandSettings).set({ staffPayouts: { ...((b?.v as object) ?? {}), ...v } });
}

/** Rows of a CSV with quoted cells. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

const payoutsOf = (batchId: string) => m.db.db.select().from(s().tipPayouts).where(eq(s().tipPayouts.batchId, batchId));
const ledgerOf = (saleId: string) => m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.saleId, saleId));

async function activeOnStripe(staffId: string, acct: string) {
  const row = { method: "stripe" as const, stripeAccountId: acct, simulated: false, payoutsEnabled: true, detailsSubmitted: true, transfersCapability: "active", feesPayer: "application", destinationType: "bank_account" as const, destinationLast4: "6789", destinationName: "STRIPE TEST BANK", depositConsentVersion: TIP_DEPOSIT_CONSENT_VERSION, depositConsentAt: new Date() };
  await m.db.db.insert(s().staffPayoutAccounts).values({ staffId, ...row }).onConflictDoUpdate({ target: s().staffPayoutAccounts.staffId, set: row });
}

describe("owed tips go through payroll at the cutoff, once (ST-C14), and the tips-paid export (ST-C13, ST-I14)", () => {
  // Cash tips at a connected shop are the shop's and never a Stripe payout, so Rock Island is on the brand's account here.
  const rockIslandMode = (mode: "brand" | "connected") => m.db.db.update(s().shops).set({ paymentsMode: mode }).where(eq(s().shops.slug, "rock-island"));
  beforeAll(() => rockIslandMode("brand"));
  afterAll(() => rockIslandMode("connected"));
  it("owed Stripe tips move to payroll at lock and never again (flagged: the 8-column file can't pay them in the check); the export is a draft until locked and adds up, then final", async () => {
    const { shop: sh, ids: [g, mz] } = await barbers("rock-island", ["Garrett", "Mercedez"]);
    await groups.ensurePayGroups();
    const [pg] = await m.db.db.select().from(s().payGroups).where(eq(s().payGroups.shopId, sh.id));
    expect(pg.employerId).not.toBeNull();
    // Tips written before the shop had a pay group got its employer when the group was made.
    const untagged = await m.db.db.select().from(s().tipLedger).where(and(eq(s().tipLedger.shopId, sh.id), m.drizzle.isNull(s().tipLedger.employerId)));
    expect(untagged).toEqual([]);

    await accounts.setPayoutChoice(g, { method: "stripe", instant: false }, actor);
    await activeOnStripe(g, "acct_fake_garrett_owed");
    await accounts.setPayoutChoice(mz, { method: "stripe", instant: false }, actor);

    fakeStripe(true);
    expect(mm.directPayoutsAvailable()).toBe(false);
    const gSale = await tipSale(sh.id, g, 900);
    await tipSale(sh.id, mz, 700);
    const [gTip] = await ledgerOf(gSale.id);
    expect(gTip.employerId).toBe(pg.employerId);

    const b = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    const held = await payoutsOf(b.batchId);
    expect(held.find((p) => p.staffId === g)).toMatchObject({ status: "held", holdKind: "transfers_pending", netCents: 900 });
    expect(held.find((p) => p.staffId === mz)).toMatchObject({ status: "held", holdKind: "stripe_setup", netCents: 700 });
    await tp.approveBatch(b.batchId, actor);
    expect(moneyCalls).toEqual([]);

    const t = await tracker.payoutTracker([sh.id]);
    expect(t.people.find((p) => p.staffId === g)).toMatchObject({ state: "active", last4: "6789" });
    expect(t.people.find((p) => p.staffId === mz)!.state).toBe("not_started");
    expect(t.owed).toMatchObject({ transfersCents: 900, setupCents: 700 });
    expect(JSON.stringify(t)).not.toMatch(/routing|account_number|tax_id/);

    // Final needs the employer's iSolved company code and everyone's employee number.
    await groups.saveEmployer(pg.employerId!, { isolvedCompanyCode: "RZI01", taxIdLast4: "6789" }, actor);
    expect(await groups.saveEmployer(pg.employerId!, { isolvedCompanyCode: "RZI01", taxIdLast4: "12-3456789" }, actor)).toMatch(/only the last 4 digits/);
    expect((await m.db.db.query.payrollEmployers.findFirst({ where: eq(s().payrollEmployers.id, pg.employerId!) }))!.taxIdLast4).toBe("6789");
    const team = await m.db.db.select({ id: s().staffShops.staffId }).from(s().staffShops).where(eq(s().staffShops.shopId, sh.id));
    for (const [i, p] of team.entries())
      await m.db.db
        .insert(s().payrollProfiles)
        .values({ staffId: p.id, employeeNumber: `RI${100 + i}` })
        .onConflictDoUpdate({ target: s().payrollProfiles.staffId, set: { employeeNumber: m.drizzle.sql`coalesce(${s().payrollProfiles.employeeNumber}, ${`RI${100 + i}`})` } });

    const period = (await run.periodChoices()).find((p) => p.current)!;
    const v = (await run.buildPayroll(period.start, period.end))!;
    const block = v.blocks.find((x) => x.shopId === sh.id)!;
    expect(block.lines.find((l) => l.staffId === g)!.tipsInPayroll).toBe(9);
    expect(block.lines.find((l) => l.staffId === mz)!.tipsInPayroll).toBe(7);
    // Owed Stripe tips are told apart on the report; the file keeps them in E_Cash Tips Recd (8 columns, no separate tip codes), flagged so they're paid outside the check.
    expect(block.lines.find((l) => l.staffId === g)).toMatchObject({ tipsInPayrollOwed: 9, tipsInPayrollChosen: 0 });
    expect(block.exportHeaders).not.toContain(v.settings.owedTipsInPayrollHeader);
    const cashAt = 2;
    const gTips = block.lines.find((l) => l.staffId === g)!.tips;
    expect(block.exportRows.find((r) => r.staffId === g)!.values[cashAt]).toBe(gTips);
    expect(v.anomalies.filter((a) => a.kind === "tips_in_payroll_memo" && a.shopId === sh.id).map((a) => a.staffId).sort()).toEqual([g, mz].sort());
    expect(v.mismatches.filter((x) => x.shopId === sh.id)).toEqual([]);

    const draft = (await reports.tipsPaidFile(period.start, period.end, [sh.id]))!;
    expect(draft.status).toBe("draft");
    expect(draft.fileName).toMatch(/^DRAFT - Tips paid/);
    const [header, ...rows] = parseCsv(draft.body);
    expect(header).toEqual(["Company Code", "Employer", "EIN", "Work State", "Employee Number", "Employee", "Period Start", "Period End", "Tips Earned", "Paid via Stripe", "Paid in Cash", "Paid Through Payroll", "Owed", "Sent Not Paid", "Reversed", "Absorbed by Shop", "Status"]);
    const col = (row: string[], h: string) => row[header.indexOf(h)];
    const gNumber = (await m.db.db.query.payrollProfiles.findFirst({ where: eq(s().payrollProfiles.staffId, g) }))!.employeeNumber;
    const gRow = rows.find((r) => col(r, "Employee Number") === gNumber)!;
    expect([col(gRow, "Company Code"), col(gRow, "Employer"), col(gRow, "EIN"), col(gRow, "Work State"), col(gRow, "Owed"), col(gRow, "Status")]).toEqual(["RZI01", "Ray'z Inc.", "EIN ••6789", "IL", "9.00", "Draft"]);
    expect(draft.body).not.toMatch(/123456789/);

    await lockHours(period.start, period.end);
    expect(await run.approveAndLock(period.start, period.end, actor)).toMatchObject({ locked: expect.any(Number) });
    const after = await m.db.db.select().from(s().tipPayouts).where(m.drizzle.inArray(s().tipPayouts.id, held.map((p) => p.id)));
    expect(after.map((p) => [p.staffId, p.status])).toEqual(expect.arrayContaining([[g, "cancelled"], [mz, "cancelled"]]));
    const onPayroll = await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.shopId, sh.id), eq(s().tipPayouts.method, "payroll"), eq(s().tipPayouts.payrollPeriodStart, period.start)));
    expect(new Map(onPayroll.map((p) => [p.staffId, [p.status, p.netCents]]))).toEqual(
      new Map([
        [g, ["paid", 900]],
        [mz, ["paid", 700]],
      ]),
    );
    const moved = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.owed_to_payroll"), eq(s().auditLog.shopId, sh.id)));
    expect(moved.map((a) => (a.details as { holdKind: string }).holdKind).sort()).toEqual(["stripe_setup", "transfers_pending"]);
    const lockedBlock = (await run.buildPayroll(period.start, period.end))!.blocks.find((x) => x.shopId === sh.id)!;
    expect(lockedBlock.exportRows.find((r) => r.staffId === g)!.values[cashAt]).toBe(gTips);

    // Never twice: a later batch, a transfer path turning on and the employee finishing setup send nothing.
    mm.registerMoneyMovement({
      name: "fake",
      async send() {
        throw new Error("must not be called");
      },
      async unwind() {
        return { ok: true, errors: [] };
      },
    });
    const next = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    expect((await payoutsOf(next.batchId)).filter((p) => p.staffId === g || p.staffId === mz)).toEqual([]);
    await activeOnStripe(mz, "acct_fake_mercedez_late");
    expect(await tp.releaseSetupHolds(mz)).toEqual({ released: 0, sent: 0 });
    expect(await run.approveAndLock(period.start, period.end, actor)).toMatchObject({ error: expect.stringMatching(/already locked/) });

    const final = (await reports.tipsPaidFile(period.start, period.end, [sh.id]))!;
    expect(final.status).toBe("final");
    expect(final.fileName).toBe(`Tips paid (${period.start} to ${period.end}).csv`);
    const after2 = parseCsv(final.body).slice(1);
    expect(after2.every((r) => col(r, "Status") === "Final")).toBe(true);
    const fRow = after2.find((r) => col(r, "Employee Number") === gNumber)!;
    const n = (h: string) => Number(col(fRow, h));
    expect(n("Paid Through Payroll")).toBeGreaterThanOrEqual(9);
    expect(n("Owed")).toBe(0);
    expect(n("Tips Earned")).toBeCloseTo(n("Paid via Stripe") + n("Paid in Cash") + n("Paid Through Payroll") + n("Owed") + n("Sent Not Paid"), 6);
  });
});

describe("refunds and disputes (ST-C15)", () => {
  it("a full refund inside the window reverses the tip; after it, or a partial refund, the shop absorbs it; the brand's rule and window are settings", async () => {
    const { shop: sh, ids: [b] } = await barbers("kimberly", ["Beth"]);
    const absorbed = (saleId: string) => m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.saleId, saleId));
    // The default: the shop absorbs every refunded tip.
    const byDefault = await tipSale(sh.id, b, 300, card);
    await m.refunds.refundEverything(byDefault.id, "Default rule", false, actor);
    expect((await ledgerOf(byDefault.id)).map((e) => e.kind)).toEqual(["tip"]);
    expect(await absorbed(byDefault.id)).toEqual([expect.objectContaining({ kind: "rule", amountCents: 300 })]);

    // Today through 12 days on in one pay period, so the window decides, not the pay period (a later one is always the shop's cost).
    await run.ensurePayGroups();
    const [pg] = await m.db.db.select().from(s().payGroups).where(eq(s().payGroups.shopId, sh.id));
    await m.db.db.update(s().payGroups).set({ anchorStart: m.time.addDays(today, -1), periodDays: 14 }).where(eq(s().payGroups.id, pg.id));
    await setStaffPayouts({ reversalRule: "full_refund_in_window", reversalWindowDays: 7 });

    const late = await tipSale(sh.id, b, 600, card);
    await m.refunds.refundEverything(late.id, "Came back after a week", false, actor, new Date(Date.now() + 8 * 86_400_000));
    expect((await ledgerOf(late.id)).map((e) => e.kind)).toEqual(["tip"]);
    expect(await absorbed(late.id)).toEqual([expect.objectContaining({ kind: "outside_window", amountCents: 600, staffId: b })]);

    await setStaffPayouts({ reversalWindowDays: 10 });
    const inside = await tipSale(sh.id, b, 500, card);
    await m.refunds.refundEverything(inside.id, "Within ten days", false, actor, new Date(Date.now() + 8 * 86_400_000));
    expect((await ledgerOf(inside.id)).map((e) => [e.kind, e.amountCents]).sort()).toEqual([
      ["refund", -500],
      ["tip", 500],
    ]);
    expect(await absorbed(inside.id)).toEqual([]);

    await setStaffPayouts({ reversalRule: "any_refund" });
    const partial = await tipSale(sh.id, b, 1000, card);
    await m.checkout.refundSale({ saleId: partial.id, items: [], tipCents: 300, refundCardFee: false, reason: "Tip typo", restock: false, actor });
    expect((await ledgerOf(partial.id)).map((e) => e.amountCents).sort((x, y) => x - y)).toEqual([-300, 1000]);

    await setStaffPayouts({ reversalRule: "never" });
    const kept = await tipSale(sh.id, b, 400, card);
    await m.refunds.refundEverything(kept.id, "Never reverses", false, actor);
    expect((await ledgerOf(kept.id)).map((e) => e.kind)).toEqual(["tip"]);
    expect(await absorbed(kept.id)).toEqual([expect.objectContaining({ kind: "rule", amountCents: 400 })]);
    await setStaffPayouts({ reversalRule: "never", reversalWindowDays: 7 });
    await m.db.db.update(s().payGroups).set({ anchorStart: pg.anchorStart, periodDays: pg.periodDays }).where(eq(s().payGroups.id, pg.id));

    // Absorbed tips are never changed or removed.
    const [one] = await absorbed(kept.id);
    await expect(m.db.db.update(s().tipAbsorptions).set({ amountCents: 1 }).where(eq(s().tipAbsorptions.id, one.id))).rejects.toThrow();
    await expect(m.db.db.delete(s().tipAbsorptions).where(eq(s().tipAbsorptions.id, one.id))).rejects.toThrow();
  });

  it("a tip already in an approved payout is never taken back, whatever the rule (ST-C0b)", async () => {
    const { shop: sh, ids: [b] } = await barbers("kimberly", ["Beth"]);
    await setStaffPayouts({ reversalRule: "any_refund" });
    const sale = await tipSale(sh.id, b, 700, cash);
    const batch = await tp.buildBatch({ shopId: sh.id, kind: "manual", cutoff: today, actor });
    await tp.approveBatch(batch.batchId, actor);
    expect((await payoutsOf(batch.batchId)).find((p) => p.staffId === b)?.status).toBe("approved");
    await m.refunds.refundEverything(sale.id, "After the payout was approved", false, actor);
    expect((await ledgerOf(sale.id)).map((e) => e.kind)).toEqual(["tip"]);
    expect(await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.saleId, sale.id))).toEqual([expect.objectContaining({ kind: "after_payout", amountCents: 700 })]);
    await setStaffPayouts({ reversalRule: "never" });
  });

  it("a card dispute leaves the barber their tip: the shop absorbs it, once per dispute", async () => {
    const { shop: sh, ids: [b] } = await barbers("kimberly", ["Beth"]);
    const sale = await tipSale(sh.id, b, 800, card);
    const [pay] = await m.db.db.select().from(s().payments).where(eq(s().payments.saleId, sale.id));
    expect(await tl.recordTipDispute(pay.id, "dp_test_tip_1", today)).toBe(1);
    expect(await tl.recordTipDispute(pay.id, "dp_test_tip_1", today)).toBe(0);
    expect(await tl.recordTipDispute(pay.id, "not a dispute id", today)).toBe(0);
    expect((await ledgerOf(sale.id)).map((e) => e.kind)).toEqual(["tip"]);
    const rows = await m.db.db.select().from(s().tipAbsorptions).where(eq(s().tipAbsorptions.paymentId, pay.id));
    expect(rows).toEqual([expect.objectContaining({ kind: "dispute", amountCents: 800, stripeDisputeId: "dp_test_tip_1", staffId: b })]);
  });
});

describe("the account state machine from Connect webhooks (ST-C12)", () => {
  it("in progress, pending verification, restricted, requirements due, active, then rejected when disconnected; each move audited", async () => {
    const { ids: [k] } = await barbers("utica", ["Kate"]);
    const acct = "acct_fake_kate_states";
    await m.db.db
      .insert(s().staffPayoutAccounts)
      .values({ staffId: k, method: "stripe", stripeAccountId: acct, simulated: false })
      .onConflictDoUpdate({ target: s().staffPayoutAccounts.staffId, set: { method: "stripe", stripeAccountId: acct, simulated: false, payoutsEnabled: false, detailsSubmitted: false, transfersCapability: null, deauthorizedAt: null } });
    fakeStripe(true);
    const secret = "whsec_test_states";
    const event = (type: string, object: object) => {
      const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, account: acct, data: { object } });
      return connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
    };
    const updated = (o: { transfers: string; payouts: boolean; due?: string[]; pending?: string[] }) =>
      event("account.updated", {
        id: acct,
        object: "account",
        details_submitted: true,
        payouts_enabled: o.payouts,
        capabilities: { transfers: o.transfers },
        requirements: { currently_due: o.due ?? [], past_due: [], pending_verification: o.pending ?? [], disabled_reason: null, current_deadline: null },
        metadata: { staffId: k, ...accounts.W2_METADATA },
      });
    const state = async () => accounts.staffAccountStatus(await accounts.staffAccount(k));
    expect(await state()).toBe("in_progress");
    await updated({ transfers: "pending", payouts: false, pending: ["individual.id_number"] });
    expect(await state()).toBe("pending_verification");
    await updated({ transfers: "inactive", payouts: false, due: ["individual.verification.document"] });
    expect(await state()).toBe("restricted");
    await updated({ transfers: "active", payouts: true, due: ["individual.verification.additional_document"] });
    expect(await state()).toBe("requirements_due");
    expect(accounts.stripeReady(await accounts.staffAccount(k))).toBe(true);
    expect(accounts.canReceive(await accounts.staffAccount(k))).toBe(false);
    await agreeToStripeDeposits(k);
    expect(accounts.canReceive(await accounts.staffAccount(k))).toBe(true);
    await updated({ transfers: "active", payouts: true });
    expect(await state()).toBe("active");
    expect((await event("account.application.deauthorized", { id: "ca_fake", object: "application" })).status).toBe(200);
    expect(await state()).toBe("rejected");
    expect(accounts.stripeReady(await accounts.staffAccount(k))).toBe(false);
    expect(accounts.canReceive(await accounts.staffAccount(k))).toBe(false);

    const moves = await m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, "tips.account_state"), eq(s().auditLog.entityId, k))).orderBy(s().auditLog.at);
    expect(moves.map((a) => (a.details as { state: { to: string } }).state.to).slice(-5)).toEqual(["pending_verification", "restricted", "requirements_due", "active", "rejected"]);
  });
});

describe("the yearly tax form check (ST-I13)", () => {
  it("is due until recorded, refused while an account pays its own Stripe fees, and reminds whoever manages payouts for every shop once a week", async () => {
    const { ids: [j] } = await barbers("moline", ["Jen"]);
    await activeOnStripe(j, "acct_fake_jen_tax");
    const year = Number(today.slice(0, 4)) - 1;
    const v = await tracker.taxCheckView(`${year + 1}-02-01`);
    expect(v).toMatchObject({ setting: "will_not_file", month: 1, due: true, taxYear: year });
    expect(v.status.accounts).toBeGreaterThan(0);

    await m.db.db.update(s().staffPayoutAccounts).set({ feesPayer: "account" }).where(eq(s().staffPayoutAccounts.staffId, j));
    await expect(tracker.recordTaxFormCheck(actor, year)).rejects.toThrow(/pays its own Stripe fees/);
    await m.db.db.update(s().staffPayoutAccounts).set({ feesPayer: "application" }).where(eq(s().staffPayoutAccounts.staffId, j));

    const first = await tracker.taxCheckReminderCron();
    expect(first.due).toBe(true);
    expect(first.sent).toBeGreaterThan(0);
    expect((await tracker.taxCheckReminderCron()).sent).toBe(0);
    const [mail] = await m.db.db.select().from(s().notificationJobs).where(eq(s().notificationJobs.subject, `Check Stripe won't file ${Number(m.time.todayLocal().slice(0, 4)) - 1} 1099s for your barbers`));
    expect(mail.body).toMatch(/\/admin\/tips\/tracker/);

    await tracker.recordTaxFormCheck(actor, Number(today.slice(0, 4)) - 1);
    expect((await tracker.taxCheckView()).due).toBe(false);
    expect((await tracker.taxCheckReminderCron()).due).toBe(false);
    const [audit] = await m.db.db.select().from(s().auditLog).where(eq(s().auditLog.action, "tips.tax_form_check"));
    expect(audit.details).toMatchObject({ taxYear: Number(today.slice(0, 4)) - 1, feesOnAccount: 0 });
  });
});
