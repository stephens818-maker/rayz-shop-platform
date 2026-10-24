import { sql } from "drizzle-orm";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eventContextJson } from "./event-context";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type DBorTx = DB | Tx;

const globalForDb = globalThis as unknown as { __rayzSql?: postgres.Sql; __rayzDb?: DB };

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  return url;
}

function create(): DB {
  const client = postgres(databaseUrl(), {
    max: process.env.VERCEL ? 1 : 10,
    prepare: !/pooler|pgbouncer/.test(databaseUrl()),
    onnotice: () => {},
  });
  globalForDb.__rayzSql = client;
  return drizzle(client, { schema });
}

/** A transaction started inside an event context tells the event triggers who is acting (see ./event-context). */
const transaction: DB["transaction"] = (fn, config) =>
  globalForDb.__rayzDb!.transaction(async (tx) => {
    const ctx = eventContextJson();
    if (ctx) await tx.execute(sql`select set_config('rayz.event_ctx', ${ctx}, true)`);
    return fn(tx);
  }, config);

export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    if (!globalForDb.__rayzDb) globalForDb.__rayzDb = create();
    const real = globalForDb.__rayzDb;
    if (prop === "transaction") return transaction;
    const value = Reflect.get(real, prop);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export async function closeDb() {
  await globalForDb.__rayzSql?.end({ timeout: 5 });
  globalForDb.__rayzSql = undefined;
  globalForDb.__rayzDb = undefined;
}

export { schema };
