import { execSync } from "node:child_process";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://rayz:rayz@localhost:5432/rayz_test";
process.env.DATABASE_URL = TEST_DB;

export async function loadModules() {
  const env = { ...process.env, DATABASE_URL: TEST_DB, MIGRATE_DATABASE_URL: TEST_DB, SEED_HISTORY_DAYS: "3" };
  execSync("npx tsx scripts/migrate.ts && npx tsx scripts/seed.ts", { env, stdio: "pipe" });
  return {
    db: await import("@/db"),
    schema: await import("@/db/schema"),
    booking: await import("@/server/booking"),
    checkout: await import("@/server/checkout"),
    refunds: await import("@/server/refunds"),
    reports: await import("@/server/reports"),
    loyalty: await import("@/server/loyalty"),
    importer: await import("@/server/importer"),
    customers: await import("@/server/customers"),
    auth: await import("@/server/auth/customer"),
    rateLimit: await import("@/server/rate-limit"),
    importErrors: await import("@/lib/import-errors"),
    queue: await import("@/server/notifications/queue"),
    public: await import("@/server/public"),
    catalog: await import("@/server/catalog"),
    processor: await import("@/server/payments/processor"),
    webhook: await import("@/server/payments/webhook"),
    drizzle: await import("drizzle-orm"),
    time: await import("@/lib/time"),
    ledger: await import("@/server/inventory/ledger"),
    stock: await import("@/server/inventory/stock"),
    purchasing: await import("@/server/inventory/purchasing"),
    transfers: await import("@/server/inventory/transfers"),
    counts: await import("@/server/inventory/counts"),
    adjust: await import("@/server/inventory/adjust"),
    invReports: await import("@/server/inventory/reports"),
  };
}

export type Mods = Awaited<ReturnType<typeof loadModules>>;
export const actor = { staffId: null, label: "test" };

/**
 * The time clock's hours locked for the timesheet periods covering a pay period, as managers do once
 * each timesheet is approved; payroll's approve and lock waits for it. Default: every shop whose pay
 * group has that pay period.
 */
export async function lockHours(start: string, end: string, shopIds?: string[]) {
  const { db } = await import("@/db");
  const { timesheetLocks } = await import("@/db/schema");
  const { periodFor } = await import("@/server/time-clock");
  const { ensurePayGroups } = await import("@/server/payroll/groups");
  const { periodStarting } = await import("@/domain/payroll/calendar");
  const { addDays } = await import("@/lib/time");
  const ids = shopIds ?? (await ensurePayGroups()).filter((g) => periodStarting(g.calendar, start)?.end === end).map((g) => g.shopId);
  if (!ids.length) return;
  for (let d = start; d <= end; ) {
    const p = await periodFor(d);
    await db
      .insert(timesheetLocks)
      .values(ids.map((shopId) => ({ shopId, periodStart: p.start, periodEnd: p.end })))
      .onConflictDoNothing();
    d = addDays(p.end, 1);
  }
}

/** The employee agrees to today's Stripe tip deposit wording, as they would on My banking (ST-C17). */
export async function agreeToStripeDeposits(staffId: string) {
  const { setDepositConsent } = await import("@/server/tips/accounts");
  const { TIP_DEPOSIT_CONSENT_VERSION } = await import("@/domain/tip-deposit-consent");
  return setDepositConsent(staffId, { agree: true, version: TIP_DEPOSIT_CONSENT_VERSION, source: "web" }, { staffId, label: "employee" });
}
