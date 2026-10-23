import { execSync } from "node:child_process";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://rayz:rayz@localhost:5432/rayz_test";
process.env.DATABASE_URL = TEST_DB;
// Existing suites book online. A missing launch time means "not launched", so tests pin a past instant.
process.env.LAUNCH_AT ??= "2000-01-01T00:00:00.000Z";

export async function loadModules() {
  const env = { ...process.env, DATABASE_URL: TEST_DB, MIGRATE_DATABASE_URL: TEST_DB, SEED_HISTORY_DAYS: "3" };
  execSync("npx tsx scripts/migrate.ts && npx tsx scripts/seed.ts", { env, stdio: "pipe" });
  const db = await import("@/db");
  const { sql } = await import("drizzle-orm");
  // The per-shop gate is required. Seed leaves it null (still on Squire). Suites that book online
  // need every shop open unless a test closes one on purpose.
  await db.db.execute(sql`update shops set launch_at = '2000-01-01T00:00:00.000Z'`);
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
