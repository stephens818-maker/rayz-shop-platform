import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { notificationJobs, shops, staff, staffPayoutAccounts, taxFormChecks, tipPayouts } from "@/db/schema";
import { ACCOUNT_STATES, AccountState, taxCheckDue } from "@/domain/staff-payouts";
import { LocalDate, todayLocal } from "@/lib/time";
import { appBaseUrl } from "@/lib/deployment";
import { audit, type Actor } from "@/server/audit";
import { loadStaffAccess } from "@/server/auth/access";
import { AppError } from "@/server/errors";
import { enqueueRaw } from "@/server/notifications/queue";
import { staffAccountStatus, taxFormStatus } from "./accounts";
import { staffPayoutConfig } from "./ledger";
import { onboardingRoster } from "./onboarding";
import { OWED_HOLDS } from "./payouts";

const PAYOUT_DAYS = 60;

/** Every shop that isn't archived: the chain, for "Payout tracker for every shop". */
export async function chainShopIds(): Promise<string[]> {
  return (await db.select({ id: shops.id }).from(shops).where(ne(shops.status, "archived"))).map((s) => s.id);
}

/**
 * The payout tracker (ST-I11) for some shops: each barber's Stripe account by its state, the last
 * 60 days of payouts, and what's owed (held for their setup, or until there's a transfer path).
 * Account ids and last 4 only.
 */
export async function payoutTracker(shopIds: readonly string[], now = new Date()) {
  const roster = await onboardingRoster(shopIds, now);
  const staffIds = roster.rows.map((r) => r.staffId);
  const [accounts, payouts] = await Promise.all([
    staffIds.length ? db.select().from(staffPayoutAccounts).where(inArray(staffPayoutAccounts.staffId, staffIds)) : [],
    shopIds.length
      ? db
          .select({ p: tipPayouts, name: staff.displayLabel, shop: shops.name })
          .from(tipPayouts)
          .innerJoin(staff, eq(staff.id, tipPayouts.staffId))
          .innerJoin(shops, eq(shops.id, tipPayouts.shopId))
          .where(and(inArray(tipPayouts.shopId, [...shopIds]), ne(tipPayouts.status, "cancelled"), ne(tipPayouts.method, "prior"), gte(tipPayouts.createdAt, new Date(now.getTime() - PAYOUT_DAYS * 86_400_000))))
          .orderBy(desc(tipPayouts.createdAt))
          .limit(300)
      : [],
  ]);
  const acct = new Map(accounts.map((a) => [a.staffId, a]));
  const people = roster.rows.map((r) => {
    const a = acct.get(r.staffId) ?? null;
    const state: AccountState = staffAccountStatus(a);
    return {
      staffId: r.staffId,
      name: r.name,
      shops: r.shops,
      state,
      stateChangedAt: a?.stateChangedAt ?? null,
      stripeAccountId: a?.stripeAccountId ?? null,
      simulated: !!a?.simulated,
      last4: a?.destinationLast4 ?? null,
      destinationType: a?.destinationType ?? null,
      dashboard: a?.dashboard ?? null,
      needs: r.needs,
      deadline: a?.requirementsDeadline ?? null,
      instant: !!a?.instant,
    };
  });
  const counts = Object.fromEntries(ACCOUNT_STATES.map((s) => [s, people.filter((p) => p.state === s).length])) as Record<AccountState, number>;
  const owed = payouts.filter((x) => x.p.status === "held" && !!x.p.holdKind && OWED_HOLDS.includes(x.p.holdKind));
  const sum = (xs: typeof payouts) => xs.reduce((a, x) => a + x.p.netCents, 0);
  return {
    people,
    counts,
    payouts: payouts.map((x) => ({ ...x.p, name: x.name, shop: x.shop })),
    owed: {
      cents: sum(owed),
      payouts: owed.length,
      setupCents: sum(owed.filter((x) => x.p.holdKind === "stripe_setup")),
      transfersCents: sum(owed.filter((x) => x.p.holdKind === "transfers_pending")),
    },
    inFlightCents: sum(payouts.filter((x) => x.p.status === "approved" || x.p.status === "processing")),
  };
}

// ───────────────────────────── Tax forms (ST-I13) ─────────────────────────────

/** The yearly check that Stripe won't file 1099s for the barbers' accounts: what's due, what each year found. */
export async function taxCheckView(today: LocalDate = todayLocal()) {
  const [cfg, status, checks] = await Promise.all([
    staffPayoutConfig(),
    taxFormStatus(),
    db.select({ c: taxFormChecks, by: staff.displayLabel }).from(taxFormChecks).leftJoin(staff, eq(staff.id, taxFormChecks.checkedBy)).orderBy(desc(taxFormChecks.taxYear)).limit(10),
  ]);
  const due = taxCheckDue(
    today,
    cfg.taxCheckMonth,
    checks.map((x) => x.c.taxYear),
  );
  return { setting: cfg.taxForms, month: cfg.taxCheckMonth, ...due, status, checks: checks.map((x) => ({ ...x.c, by: x.by })) };
}

/**
 * Records this year's check: every employee account set not to file, Ray'z paying their Stripe
 * fees (no 1099-K). Refused while an account pays its own fees, since Stripe would file for it.
 * Again for the same year updates it.
 */
export async function recordTaxFormCheck(actor: Actor, taxYear: number) {
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) throw new AppError("bad_request", "Pick a tax year");
  const s = await taxFormStatus();
  if (s.feesOnAccount)
    throw new AppError("conflict", `${s.feesOnAccount} account${s.feesOnAccount === 1 ? " pays" : "s pay"} its own Stripe fees, so Stripe would file a 1099-K. Ask Stripe to move the fees to Ray'z first.`);
  const now = new Date();
  await db
    .insert(taxFormChecks)
    .values({ taxYear, accounts: s.accounts, untagged: s.untagged, feesOnAccount: s.feesOnAccount, checkedBy: actor.staffId ?? null, checkedAt: now })
    .onConflictDoUpdate({ target: taxFormChecks.taxYear, set: { accounts: s.accounts, untagged: s.untagged, feesOnAccount: s.feesOnAccount, checkedBy: actor.staffId ?? null, checkedAt: now } });
  await audit(actor, "tips.tax_form_check", "brand", null, { taxYear, ...s });
  return s;
}

const TAX_SUBJECT = (year: number) => `Check Stripe won't file ${year} 1099s for your barbers`;

/**
 * From the brand's check month until it's recorded, a weekly email to whoever runs the payout
 * tracker for every shop (Manage, every shop): import the 1099 exclusions in Stripe and record the
 * check. Nothing while no barber has a Stripe account.
 */
export async function taxCheckReminderCron(now = new Date()) {
  const today = todayLocal(now);
  const v = await taxCheckView(today);
  if (!v.due || v.setting !== "will_not_file" || !v.status.accounts) return { due: v.due, sent: 0 };
  const subject = TAX_SUBJECT(v.taxYear);
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationJobs)
    .where(and(eq(notificationJobs.subject, subject), gte(notificationJobs.createdAt, new Date(now.getTime() - 7 * 86_400_000))));
  if (recent.n) return { due: true, sent: 0 };
  const brand = await db
    .select({ id: staff.id, email: staff.email })
    .from(staff)
    .where(and(eq(staff.active, true), eq(staff.kind, "person"), eq(staff.shopScope, "all"), isNotNull(staff.email)));
  const [anyShop] = await db.select({ id: shops.id }).from(shops).where(ne(shops.status, "archived")).orderBy(shops.name).limit(1);
  if (!anyShop) return { due: true, sent: 0 };
  const link = `${appBaseUrl()}/admin/tips/tracker`;
  let sent = 0;
  for (const p of brand) {
    const access = await loadStaffAccess(p.id);
    if (!access?.permissions.has("payouts.manage") || !access.permissions.has("payouts.chain")) continue;
    await enqueueRaw({
      kind: "tip_banking",
      channel: "email",
      to: p.email!,
      subject,
      body: `Stripe files ${v.taxYear} 1099s in January. Tips are W-2 wages through payroll, so the ${v.status.accounts} barber Stripe account${v.status.accounts === 1 ? "" : "s"} must be set not to file. Download the 1099 exclusions, import them in the Stripe Dashboard (Tax reporting → Import → Update), then record the check on the payout tracker: ${link}`,
      shopId: anyShop.id,
    });
    sent++;
  }
  return { due: true, sent };
}
