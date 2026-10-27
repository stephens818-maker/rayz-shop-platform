/**
 * Staff payout onboarding against a real database: everyone re-registers for Stripe payouts under
 * Ray'z. The tracker's states; bulk invites by text or email with the channel fallback, the resend
 * gap and the audit; reminders on the cron (cadence, sending hours, the brand's limit, stopping once
 * done or gone); tips approved for someone not set up held for them, never paid another way, and sent
 * by themselves once they finish (simulator or account.updated); and the cutover sign-off gate.
 */
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("@/server/payments/processor", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/payments/processor")>();
  return { ...mod, stripe: () => (globalThis as { __fakeStripe?: unknown }).__fakeStripe ?? null };
});

type Call = { op: string; params: Record<string, unknown> };
const calls: Call[] = [];
let n = 0;
const record = (op: string, prefix: string) => async (params: Record<string, unknown>) => {
  calls.push({ op, params });
  return { id: `${prefix}_fake_${++n}` };
};
const fake = {
  charges: { create: record("debit", "py") },
  transfers: { create: record("transfer", "tr"), createReversal: record("reverse", "trr") },
  payouts: { create: record("payout", "po") },
  refunds: { create: record("refund", "re") },
  accounts: {
    retrieve: async () => {
      throw new Error("offline in the test");
    },
    update: async (id: string) => ({ id }),
  },
};
const fakeStripe = (on: boolean) => ((globalThis as { __fakeStripe?: unknown }).__fakeStripe = on ? fake : undefined);

let m: Mods;
let tl: typeof import("@/server/tips/ledger");
let tp: typeof import("@/server/tips/payouts");
let accounts: typeof import("@/server/tips/accounts");
let ob: typeof import("@/server/tips/onboarding");
let cut: typeof import("@/server/cutover");
let connectWebhook: typeof import("@/server/payments/connect-webhook");
let today: string;

const d = new Date();
/** Tomorrow at 10 or 11 AM in the shops' time zone. */
const t0 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 16));
const at = (days: number, hourUtc = 16) => new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate() + days, hourUtc));

beforeAll(async () => {
  m = await loadModules();
  tl = await import("@/server/tips/ledger");
  tp = await import("@/server/tips/payouts");
  accounts = await import("@/server/tips/accounts");
  ob = await import("@/server/tips/onboarding");
  cut = await import("@/server/cutover");
  connectWebhook = await import("@/server/payments/connect-webhook");
  today = m.time.todayLocal();
  // Batches by hand and cash by default here, so each test builds the batches it checks.
  await m.db.db
    .update(m.schema.shops)
    .set({ tipPayouts: { schedule: "manual", cardDelayDays: 0, defaultMethod: "cash" } })
    .where(m.drizzle.sql`${m.schema.shops.tipPayouts} = '{}'::jsonb`);
  await tl.syncTipLedger();
  await tl.recordOpeningTips(m.time.addDays(today, 1));
}, 180_000);

afterEach(() => fakeStripe(false));

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const s = () => m.schema;
const cash = { method: "cash" as const, cashTenderedCents: null };

const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(s().shops.slug, slug) }))!;
async function who(label: string) {
  const [p] = await m.db.db.select({ id: s().staff.id }).from(s().staff).where(eq(s().staff.displayLabel, label));
  return p.id;
}
const contact = (staffId: string, email: string | null, phone: string | null) => m.db.db.update(s().staff).set({ email, phone }).where(eq(s().staff.id, staffId));
const invite = async (staffId: string) => (await m.db.db.query.staffOnboardingInvites.findFirst({ where: eq(s().staffOnboardingInvites.staffId, staffId) })) ?? null;
const messages = (to: string) => m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_onboarding"), eq(s().notificationJobs.to, to)));
const audits = (action: string, entityId: string) => m.db.db.select().from(s().auditLog).where(and(eq(s().auditLog.action, action), eq(s().auditLog.entityId, entityId)));
async function setPolicy(p: Partial<import("@/domain/tips").BrandTipPolicy>) {
  const [b] = await m.db.db.select({ t: s().brandSettings.tipPayouts }).from(s().brandSettings);
  await m.db.db.update(s().brandSettings).set({ tipPayouts: { ...(b?.t as object), ...p } });
}
async function tipSale(shopId: string, staffId: string, tipCents: number) {
  const sale = await m.checkout.openBlankSale(shopId, actor, staffId);
  const svc = (await m.catalog.shopCatalog(shopId)).find((x) => x.slug === "rayz-cut-shampoo")!;
  await m.checkout.finalizeSale({ saleId: sale.id, lines: [{ kind: "service", refId: svc.id, qty: 1 }], tipCents, tender: cash, actor });
}
const payoutOf = async (batchId: string, staffId: string) => (await m.db.db.select().from(s().tipPayouts).where(and(eq(s().tipPayouts.batchId, batchId), eq(s().tipPayouts.staffId, staffId))))[0];
const payout = async (id: string) => (await m.db.db.query.tipPayouts.findFirst({ where: eq(s().tipPayouts.id, id) }))!;

describe("the onboarding tracker", () => {
  it("shows where each active person is, and only whether there's an email or a phone, never them", async () => {
    const coralville = await shop("coralville");
    const [michelle, makenna, delaney, jessica, casey] = await Promise.all(["Michelle", "Makenna", "Delaney", "Jessica", "Casey"].map(who));
    await contact(michelle, "michelle@rayz.test", null);
    await contact(delaney, null, "+15635550101");
    await contact(jessica, null, null);
    await m.db.db.insert(s().staffPayoutAccounts).values({ staffId: michelle, stripeAccountId: "sim_acct_staff_michelle", simulated: true });
    await m.db.db.insert(s().staffPayoutAccounts).values({
      staffId: casey,
      stripeAccountId: "sim_acct_staff_casey",
      simulated: true,
      detailsSubmitted: true,
      requirementsDue: ["individual.verification.document"],
      requirementsDeadline: at(5),
    });

    const r = await ob.onboardingRoster([coralville.id], t0);
    const row = (id: string) => r.rows.find((x) => x.staffId === id)!;
    expect(row(makenna)).toMatchObject({ progress: "done", status: "ready" });
    expect(row(michelle)).toMatchObject({ progress: "started", hasEmail: true, hasPhone: false });
    expect(row(delaney)).toMatchObject({ progress: "not_invited", hasEmail: false, hasPhone: true, invite: null, nextReminderAt: null });
    expect(row(jessica)).toMatchObject({ hasEmail: false, hasPhone: false });
    expect(row(casey)).toMatchObject({ progress: "blocked", needs: [expect.stringMatching(/ID/i)] });
    expect(row(casey).shops.map((x) => x.id)).toEqual([coralville.id]);
    expect(r.rows.find((x) => x.name === "Leilah")).toBeUndefined();
    expect(r.counts.done).toBe(1);
    expect(r.counts.blocked).toBe(1);
    expect(r.total).toBe(r.rows.length);
    const json = JSON.stringify(r);
    expect(json).not.toContain("@rayz.test");
    expect(json).not.toContain("5635550101");
  });
});

describe("bulk invites", () => {
  it("go by the channel asked for or the one they have; done people, people elsewhere and people with no contact are skipped; a quick second send is skipped", async () => {
    const coralville = await shop("coralville");
    const [michelle, makenna, delaney, jessica, beth] = await Promise.all(["Michelle", "Makenna", "Delaney", "Jessica", "Beth"].map(who));
    await ob.setSquireTipsEnd(actor, coralville.id, m.time.addDays(today, 10));

    const r = await ob.sendOnboardingInvites({ actor, staffIds: [delaney, michelle, makenna, jessica, beth], choice: "sms", allowedShopIds: [coralville.id], now: t0 });
    expect(r.sent).toBe(2);
    expect(Object.fromEntries(r.skipped.map((x) => [x.staffId, x.why]))).toEqual({
      [makenna]: "Already done",
      [jessica]: "No email or mobile number on their profile",
      [beth]: "Not on the team at your locations",
    });
    const [text] = await messages("+15635550101");
    expect(text).toMatchObject({ channel: "sms" });
    expect(text.body).toMatch(/new tip payout account with Stripe.*even if you had one with Squire/);
    expect(text.body).toMatch(/when Squire stops paying tips/);
    expect(text.body).toContain("/staff-app/payouts");
    const [mail] = await messages("michelle@rayz.test");
    expect(mail).toMatchObject({ channel: "email", subject: "Reminder: finish your Ray'z tip payout setup" });
    expect(mail.body).toMatch(/You started setting up/);
    expect(await invite(delaney)).toMatchObject({ channels: ["sms"], invites: 1, reminders: 0, remindersStoppedAt: null });
    expect(await invite(michelle)).toMatchObject({ channels: ["email"], invites: 1 });

    const again = await ob.sendOnboardingInvites({ actor, staffIds: [delaney], choice: "both", allowedShopIds: [coralville.id], now: new Date(t0.getTime() + 60_000) });
    expect(again).toEqual({ sent: 0, skipped: [{ staffId: delaney, name: "Delaney", why: "Invited a few minutes ago" }] });
    expect(await messages("+15635550101")).toHaveLength(1);

    const [a] = await audits("tips.onboarding_invite", delaney);
    expect(a.details).toEqual({ channels: ["sms"], progress: "not_invited", wording: "invite" });
    expect(JSON.stringify(a.details)).not.toContain("555");
    expect((await ob.onboardingRoster([coralville.id], t0)).rows.find((x) => x.staffId === delaney)).toMatchObject({ progress: "invited", nextReminderAt: at(3) });
    await expect(ob.sendOnboardingInvites({ actor, staffIds: [], choice: "sms", allowedShopIds: [coralville.id] })).rejects.toThrow(/Pick who/);
  });
});

describe("reminders", () => {
  it("every 3 days in sending hours, up to the brand's limit; stop once done or gone", async () => {
    const [michelle, delaney] = await Promise.all(["Michelle", "Delaney"].map(who));
    expect(await ob.onboardingReminderCron(at(2))).toMatchObject({ sent: 0 });
    expect(await ob.onboardingReminderCron(at(3, 3))).toEqual({ sent: 0, stopped: 0, waiting: 0 });
    expect(await ob.onboardingReminderCron(at(3))).toMatchObject({ sent: 2 });
    expect(await ob.onboardingReminderCron(at(3))).toMatchObject({ sent: 0 });
    expect(await invite(delaney)).toMatchObject({ reminders: 1, lastSentAt: at(3) });
    const texts = await messages("+15635550101");
    expect(texts).toHaveLength(2);
    expect(texts.at(-1)!.body).toMatch(/^Ray'z reminder: finish your tip payout setup/);
    const [r] = await audits("tips.onboarding_reminder", delaney);
    expect(r).toMatchObject({ actorLabel: "system" });
    expect(r.details).toMatchObject({ reminder: 1, of: 4, channels: ["sms"], progress: "invited" });

    // Michelle finishes: her reminders stop at once.
    await accounts.simulateStaffOnboarding(michelle, actor);
    expect((await invite(michelle))!.remindersStoppedAt).not.toBeNull();
    await setPolicy({ reminderMax: 2 });
    expect(await ob.onboardingReminderCron(at(6))).toMatchObject({ sent: 1 });
    expect(await messages("michelle@rayz.test")).toHaveLength(2);
    expect(await ob.onboardingReminderCron(at(9))).toMatchObject({ sent: 0 });
    expect(await invite(delaney)).toMatchObject({ reminders: 2 });

    await setPolicy({ reminderMax: 4 });
    await m.db.db.update(s().staff).set({ active: false }).where(eq(s().staff.id, delaney));
    expect(await ob.onboardingReminderCron(at(12))).toMatchObject({ sent: 0, stopped: 1 });
    expect((await invite(delaney))!.remindersStoppedAt).not.toBeNull();
    await m.db.db.update(s().staff).set({ active: true }).where(eq(s().staff.id, delaney));
  });

  it("a manager can stop someone's reminders; the next invite starts them again", async () => {
    const coralville = await shop("coralville");
    const casey = await who("Casey");
    await contact(casey, "casey.tips@rayz.test", null);
    await ob.sendOnboardingInvites({ actor, staffIds: [casey], choice: "email", allowedShopIds: [coralville.id], now: t0 });
    await ob.stopOnboardingReminders(actor, casey, [coralville.id], t0);
    await expect(ob.stopOnboardingReminders(actor, casey, [coralville.id], t0)).rejects.toThrow(/already off/);
    expect(await ob.onboardingReminderCron(at(20))).toMatchObject({ sent: 0 });
    await ob.sendOnboardingInvites({ actor, staffIds: [casey], choice: "email", allowedShopIds: [coralville.id], now: at(21) });
    expect(await invite(casey)).toMatchObject({ invites: 2, reminders: 0, remindersStoppedAt: null });
    const [mail] = await messages("casey.tips@rayz.test");
    expect(mail.subject).toBe("Stripe needs more to pay your tips");
  });
});

describe("tips wait, never lost, until onboarding is done", () => {
  it("a Stripe payout for someone not set up is held for them, not paid another way; it goes out by itself once they finish", async () => {
    const coralville = await shop("coralville");
    const jessica = await who("Jessica");
    await contact(jessica, "jessica.tips@rayz.test", null);
    await accounts.setPayoutChoice(jessica, { method: "stripe", instant: false }, actor);
    await tipSale(coralville.id, jessica, 1500);
    const one = await tp.buildBatch({ shopId: coralville.id, kind: "manual", cutoff: today, actor });
    const p1 = await payoutOf(one.batchId, jessica);
    expect(p1).toMatchObject({ method: "stripe", status: "held", holdKind: "stripe_setup", netCents: 1500, holdReason: expect.stringMatching(/Stripe payout setup/) });
    await expect(tp.releasePayout(p1.id, actor)).rejects.toThrow(/waits for them to finish Stripe payout setup/);

    expect(await tp.approveBatch(one.batchId, actor)).toMatchObject({ waitingForSetup: 1 });
    expect(await payout(p1.id)).toMatchObject({ status: "held", holdKind: "stripe_setup" });
    expect((await m.db.db.query.tipPayoutBatches.findFirst({ where: eq(s().tipPayoutBatches.id, one.batchId) }))!.status).toBe("approved");
    const claimed = await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, p1.id));
    expect(claimed.reduce((a, e) => a + e.amountCents, 0)).toBe(1500);
    const [note] = await m.db.db.select().from(s().notificationJobs).where(and(eq(s().notificationJobs.kind, "tip_payout"), eq(s().notificationJobs.to, "jessica.tips@rayz.test")));
    expect(note.subject).toBe("$15.00 in tips is waiting for your Stripe setup");
    expect(note.body).toMatch(/nothing is lost/);

    await tipSale(coralville.id, jessica, 700);
    const two = await tp.buildBatch({ shopId: coralville.id, kind: "manual", cutoff: today, actor });
    const p2 = await payoutOf(two.batchId, jessica);
    expect(p2).toMatchObject({ status: "held", holdKind: "stripe_setup", netCents: 700 });
    expect((await tp.waitingForSetup([jessica])).get(jessica)).toEqual({ cents: 2200, payouts: 2 });
    expect((await tl.myTips(jessica, [coralville.id])).waitingForSetup).toEqual({ cents: 2200, payouts: 2 });

    await accounts.simulateStaffOnboarding(jessica, actor);
    expect(await payout(p1.id)).toMatchObject({ status: "paid", holdKind: null, holdReason: null });
    expect((await m.db.db.query.tipPayoutBatches.findFirst({ where: eq(s().tipPayoutBatches.id, one.batchId) }))!.status).toBe("completed");
    expect(await payout(p2.id)).toMatchObject({ status: "pending", holdKind: null });
    expect((await audits("tips.release", p1.id))[0].details).toMatchObject({ why: "stripe_setup_done", to: "approved" });
    expect((await tp.waitingForSetup([jessica])).get(jessica)).toBeUndefined();
    await tp.approveBatch(two.batchId, actor);
    expect(await payout(p2.id)).toMatchObject({ status: "paid" });
  });

  it("an approved payout whose account stops being payable before it's sent waits instead of failing", async () => {
    const coralville = await shop("coralville");
    const makenna = await who("Makenna");
    await accounts.setPayoutChoice(makenna, { method: "stripe", instant: false }, actor);
    await tipSale(coralville.id, makenna, 900);
    const b = await tp.buildBatch({ shopId: coralville.id, kind: "manual", cutoff: today, actor });
    const p = await payoutOf(b.batchId, makenna);
    expect(p).toMatchObject({ status: "pending", method: "stripe" });
    await m.db.db.update(s().staffPayoutAccounts).set({ payoutsEnabled: false, requirementsDue: ["external_account"] }).where(eq(s().staffPayoutAccounts.staffId, makenna));
    await tp.approveBatch(b.batchId, actor);
    expect(await payout(p.id)).toMatchObject({ status: "held", holdKind: "stripe_setup", failureMessage: null, stripeTransferId: null });
    expect((await m.db.db.select().from(s().tipLedger).where(eq(s().tipLedger.payoutId, p.id))).length).toBeGreaterThan(0);
    await accounts.simulateStaffOnboarding(makenna, actor);
    expect(await payout(p.id)).toMatchObject({ status: "paid" });
  });

  it("account.updated that finishes onboarding sends what was waiting through Stripe", async () => {
    const utica = await shop("utica");
    await m.db.db.update(s().shops).set({ paymentsMode: "brand" }).where(eq(s().shops.id, utica.id));
    const [kate] = await m.db.db
      .select({ id: s().staff.id })
      .from(s().staffShops)
      .innerJoin(s().staff, eq(s().staff.id, s().staffShops.staffId))
      .where(and(eq(s().staffShops.shopId, utica.id), eq(s().staff.displayLabel, "Kate")));
    const acct = "acct_fake_kate_onboarding";
    await m.db.db.insert(s().staffPayoutAccounts).values({ staffId: kate.id, method: "stripe", stripeAccountId: acct, simulated: false }).onConflictDoUpdate({
      target: s().staffPayoutAccounts.staffId,
      set: { method: "stripe", stripeAccountId: acct, simulated: false, payoutsEnabled: false, detailsSubmitted: false },
    });
    await tipSale(utica.id, kate.id, 1100);
    const b = await tp.buildBatch({ shopId: utica.id, kind: "manual", cutoff: today, actor });
    const p = await payoutOf(b.batchId, kate.id);
    expect(p).toMatchObject({ status: "held", holdKind: "stripe_setup" });
    await tp.approveBatch(b.batchId, actor);

    fakeStripe(true);
    calls.length = 0;
    const secret = "whsec_test_onboarding";
    const payload = JSON.stringify({
      id: "evt_onboarding_done",
      object: "event",
      type: "account.updated",
      account: acct,
      data: {
        object: {
          id: acct,
          object: "account",
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null, current_deadline: null },
          external_accounts: { object: "list", data: [{ id: "ba_fake_kate_ob", object: "bank_account", bank_name: "STRIPE TEST BANK", last4: "6789", default_for_currency: true, available_payout_methods: ["standard"] }] },
        },
      },
    });
    expect((await connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret)).status).toBe(200);
    const sent = await payout(p.id);
    expect(sent).toMatchObject({ status: "processing", holdKind: null, destinationLast4: "6789" });
    const mine = calls.filter((c) => (c.params.metadata as { tipPayoutId?: string } | undefined)?.tipPayoutId === p.id);
    expect(mine.map((c) => [c.op, c.params.amount])).toEqual([
      ["transfer", 1100],
      ["payout", 1100],
    ]);
  });
});

describe("the cutover checklist", () => {
  it("sign-off waits for everyone at the shop to finish payout setup, then switches without a waiver", async () => {
    const silvis = await shop("silvis");
    const frozen = new Date(Date.now() - 3600_000);
    const reconciled = new Date();
    await m.db.db.update(s().shops).set({ bookingMode: "external", externalBookingUrl: "https://getsquire.com/booking/rayz-silvis" }).where(eq(s().shops.id, silvis.id));
    await m.db.db
      .insert(s().shopCutovers)
      .values({ shopId: silvis.id, squireFrozenAt: frozen, matched: true, reconciledAt: reconciled })
      .onConflictDoUpdate({ target: s().shopCutovers.shopId, set: { squireFrozenAt: frozen, matched: true, reconciledAt: reconciled } });
    const before = (await ob.shopOnboardingCounts([silvis.id])).get(silvis.id)!;
    expect(before.notDone.length).toBeGreaterThan(0);
    await expect(cut.signOffAndSwitch(actor, silvis.id)).rejects.toThrow(new RegExp(`${before.notDone.length} of ${before.total} at Silvis haven't finished Stripe payout setup`));

    for (const p of before.notDone) await accounts.simulateStaffOnboarding(p.staffId, actor);
    expect((await ob.shopOnboardingCounts([silvis.id])).get(silvis.id)).toMatchObject({ done: before.total, notDone: [] });
    await cut.signOffAndSwitch(actor, silvis.id, new Date(), { staffWaiver: "not needed" });
    const [sw] = await audits("cutover.switch", silvis.id);
    expect((sw.details as { staffPayouts: unknown }).staffPayouts).toEqual({ model: "stripe", onboarded: before.total, total: before.total, notOnboarded: [], waiver: null });
  });
});
