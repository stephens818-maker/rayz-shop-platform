import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, shops } from "@/db/schema";
import { Card, Empty, Input, PageHeader, Select, Table, Td, Th, buttonClass } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/staff";

export const metadata: Metadata = { title: "Audit log" };

const PAGE = 100;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; entity?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff(["brand_admin", "shop_manager"]);
  const page = Math.max(0, Number(sp.page) || 0);
  const q = sp.q?.trim();

  // Brand admins in brand view see everything, including brand-level entries with no shop.
  const scope: SQL | undefined =
    ctx.isAdmin && !ctx.currentShopId ? undefined : ctx.isAdmin ? or(eq(auditLog.shopId, ctx.currentShopId!), isNull(auditLog.shopId)) : inArray(auditLog.shopId, ctx.shopIds);
  const where = and(
    scope,
    sp.entity ? eq(auditLog.entity, sp.entity) : undefined,
    q ? or(ilike(auditLog.action, `%${q}%`), ilike(auditLog.actorLabel, `%${q}%`), ilike(auditLog.entityId, `%${q}%`), sql`${auditLog.details}::text ilike ${`%${q}%`}`) : undefined,
  );
  const [rows, areas] = await Promise.all([
    db
      .select({ a: auditLog, shop: shops.name })
      .from(auditLog)
      .leftJoin(shops, eq(shops.id, auditLog.shopId))
      .where(where)
      .orderBy(desc(auditLog.at))
      .limit(PAGE + 1)
      .offset(page * PAGE),
    db.selectDistinct({ entity: auditLog.entity }).from(auditLog).where(scope).orderBy(auditLog.entity),
  ]);
  const more = rows.length > PAGE;
  const qs = (p: number) => `/admin/audit?${new URLSearchParams({ ...(q ? { q } : {}), ...(sp.entity ? { entity: sp.entity } : {}), page: String(p) })}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Audit log" subtitle="Every sale, void, refund, price, tax, schedule, and settings change, with who did it. Entries can't be edited or deleted." />
      <form className="mb-3 flex flex-wrap gap-2" method="get">
        <Input name="q" defaultValue={q} placeholder="Search action, person, ID, details…" className="max-w-xs" />
        <Select name="entity" defaultValue={sp.entity ?? ""} className="max-w-48">
          <option value="">All areas</option>
          {areas.map(({ entity }) => (
            <option key={entity} value={entity}>
              {entity.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <button className={buttonClass("secondary")}>Filter</button>
      </form>
      <Card>
        {rows.length === 0 ? (
          <Empty title="Nothing logged yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th>Shop</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, PAGE).map(({ a, shop }) => (
                <tr key={a.id} className="align-top">
                  <Td className="whitespace-nowrap">{formatDateTime(a.at)}</Td>
                  <Td className="whitespace-nowrap">{a.actorLabel ?? "—"}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="font-mono text-xs">{a.action}</span>
                    {a.entityId && <div className="max-w-40 truncate font-mono text-[11px] text-zinc-400">{a.entityId}</div>}
                  </Td>
                  <Td className="whitespace-nowrap">{shop ?? "Brand"}</Td>
                  <Td>
                    <Details value={a.details} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <div className="mt-3 flex justify-between text-sm">
        {page > 0 ? <Link href={qs(page - 1)}>‹ Newer</Link> : <span />}
        {more && <Link href={qs(page + 1)}>Older ›</Link>}
      </div>
    </div>
  );
}

function Details({ value }: { value: unknown }) {
  if (!value || (typeof value === "object" && Object.keys(value).length === 0)) return <span className="text-zinc-400">—</span>;
  const text = JSON.stringify(value);
  if (text.length <= 140) return <code className="break-all text-xs text-zinc-600">{text}</code>;
  return (
    <details>
      <summary className="cursor-pointer text-xs text-zinc-600">{text.slice(0, 120)}…</summary>
      <pre className="mt-1 max-w-xl overflow-x-auto rounded bg-zinc-50 p-2 text-[11px]">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
