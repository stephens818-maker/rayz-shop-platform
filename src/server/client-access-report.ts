import "server-only";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientAccessAlerts, clientAccessLog, clientFields, customers, shops } from "@/db/schema";
import { ACCESS_KINDS, AccessKind, FieldKey, fieldLabel } from "@/domain/client-privacy";
import { accessLabel } from "./client-privacy";

export const ACCESS_PERIODS = { "1": "Last 24 hours", "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" } as const;
export type AccessPeriod = keyof typeof ACCESS_PERIODS;

export interface AccessFilters {
  days: AccessPeriod;
  staffId?: string;
  kind?: AccessKind;
  customerId?: string;
}

export function parseAccessFilters(sp: Record<string, string | undefined>): AccessFilters {
  const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
  return {
    days: (Object.keys(ACCESS_PERIODS) as AccessPeriod[]).find((d) => d === sp.days) ?? "7",
    staffId: uuid(sp.who),
    kind: (Object.keys(ACCESS_KINDS) as AccessKind[]).find((k) => k === sp.kind),
    customerId: uuid(sp.client),
  };
}

function where(f: AccessFilters) {
  return and(
    gt(clientAccessLog.at, new Date(Date.now() - Number(f.days) * 86_400_000)),
    f.staffId ? eq(clientAccessLog.staffId, f.staffId) : undefined,
    f.kind ? eq(clientAccessLog.kind, f.kind) : undefined,
    f.customerId ? eq(clientAccessLog.customerId, f.customerId) : undefined,
  );
}

/** Who looked at which client and what they saw, newest first, for the data-access report. */
export async function accessEntries(f: AccessFilters, limit: number, offset = 0) {
  const [rows, custom] = await Promise.all([
    db
      .select({ e: clientAccessLog, shop: shops.name, firstName: customers.firstName, lastName: customers.lastName })
      .from(clientAccessLog)
      .leftJoin(shops, eq(shops.id, clientAccessLog.shopId))
      .leftJoin(customers, eq(customers.id, clientAccessLog.customerId))
      .where(where(f))
      .orderBy(desc(clientAccessLog.at))
      .limit(limit)
      .offset(offset),
    db.select({ id: clientFields.id, label: clientFields.label }).from(clientFields),
  ]);
  const name = (f: string) => fieldLabel(f as FieldKey, custom);
  return rows.map(({ e, shop, firstName, lastName }) => ({
    ...e,
    shop,
    client: firstName ? `${firstName} ${lastName ?? ""}`.trim() : e.customerId ? "Removed client" : null,
    what: accessLabel(e.kind, e.field, name),
    fieldName: e.field ? name(e.field) : null,
  }));
}

/** Per person over the period: different profiles opened, reveals, exports, searches and contacts. */
export async function accessSummary(f: AccessFilters) {
  return db
    .select({
      staffId: clientAccessLog.staffId,
      who: sql<string>`max(${clientAccessLog.actorLabel})`,
      profiles: sql<number>`count(distinct ${clientAccessLog.customerId}) filter (where ${clientAccessLog.kind} = 'view')::int`,
      reveals: sql<number>`count(*) filter (where ${clientAccessLog.kind} = 'reveal')::int`,
      exports: sql<number>`count(*) filter (where ${clientAccessLog.kind} = 'export')::int`,
      searches: sql<number>`count(*) filter (where ${clientAccessLog.kind} in ('search', 'list'))::int`,
      contacts: sql<number>`count(*) filter (where ${clientAccessLog.kind} = 'contact')::int`,
      blocked: sql<number>`count(*) filter (where ${clientAccessLog.kind} = 'blocked')::int`,
      last: sql<Date>`max(${clientAccessLog.at})`,
    })
    .from(clientAccessLog)
    .where(where({ ...f, kind: undefined }))
    .groupBy(clientAccessLog.staffId)
    .orderBy(sql`count(distinct ${clientAccessLog.customerId}) filter (where ${clientAccessLog.kind} = 'view') desc`, sql`count(*) desc`)
    .limit(50);
}

export async function openAlerts() {
  return db.select().from(clientAccessAlerts).where(isNull(clientAccessAlerts.acknowledgedAt)).orderBy(desc(clientAccessAlerts.at)).limit(50);
}

export async function recentAlerts() {
  return db.select().from(clientAccessAlerts).where(isNotNull(clientAccessAlerts.acknowledgedAt)).orderBy(desc(clientAccessAlerts.at)).limit(10);
}
