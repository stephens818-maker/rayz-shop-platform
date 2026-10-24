import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, payments, saleReassignments, sales, shops, staff } from "@/db/schema";
import { Badge, Button, Card, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { addDays, formatDate, formatTime, isValidLocalDate, todayLocal } from "@/lib/time";
import { can, guardPage, reportShopIds } from "@/server/auth/staff";
import { newSaleAction } from "../checkout/actions";

export const metadata: Metadata = { title: "Sales" };

const TONE = { paid: "green", open: "amber", voided: "gray", refunded: "red", partially_refunded: "amber" } as const;

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/sales");
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : todayLocal();
  const shopIds = reportShopIds(ctx);
  const rows = await db
    .select({
      id: sales.id,
      number: sales.number,
      status: sales.status,
      totalCents: sales.totalCents,
      tipCents: sales.tipCents,
      cardFeeCents: sales.cardFeeCents,
      paidAt: sales.paidAt,
      createdAt: sales.createdAt,
      shop: shops.name,
      barber: staff.displayLabel,
      firstName: customers.firstName,
      lastName: customers.lastName,
      methods: sql<string>`(select string_agg(distinct ${payments.method}::text, ' + ') from ${payments} where ${payments.saleId} = ${sales.id})`,
      reassigned: sql<boolean>`exists (select 1 from ${saleReassignments} where ${saleReassignments.saleId} = ${sales.id})`,
    })
    .from(sales)
    .innerJoin(shops, eq(shops.id, sales.shopId))
    .leftJoin(staff, eq(staff.id, sales.staffId))
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(and(inArray(sales.shopId, shopIds), eq(sales.businessDate, date)))
    .orderBy(desc(sales.createdAt))
    .limit(500);
  const open = rows.filter((r) => r.status === "open");
  const closed = rows.filter((r) => r.status !== "open");
  const paidTotal = closed.filter((r) => r.status !== "voided").reduce((a, r) => a + r.totalCents, 0);
  const perBarber = [...closed.filter((r) => r.status !== "voided").reduce((m, r) => {
    const k = r.barber ?? "No barber";
    const x = m.get(k) ?? { tickets: 0, cents: 0, tips: 0 };
    m.set(k, { tickets: x.tickets + 1, cents: x.cents + r.totalCents, tips: x.tips + r.tipCents });
    return m;
  }, new Map<string, { tickets: number; cents: number; tips: number }>())].sort((a, b) => b[1].cents - a[1].cents);
  const eod = can(ctx, "report.end_of_day.view");
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sales"
        subtitle={`${formatDate(date, "EEEE, MMM d")} · ${closed.length} tickets · ${formatCents(paidTotal)} collected`}
        actions={
          <>
            <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/sales?date=${addDays(date, -1)}`}>
              ‹ Prev
            </Link>
            <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/sales?date=${addDays(date, 1)}`}>
              Next ›
            </Link>
            {eod && (
              <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/reports/end-of-day?from=${date}&to=${date}`}>
                End of day
              </Link>
            )}
            {ctx.currentShopId && can(ctx, "checkout.any") && (
              <form action={newSaleAction}>
                <Button>New sale (retail / gift card)</Button>
              </form>
            )}
          </>
        }
      />
      {open.length > 0 && (
        <Card className="mb-4">
          <div className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold">Open tickets</div>
          <div className="flex flex-wrap gap-2 p-4">
            {open.map((r) => (
              <Link key={r.id} href={`/admin/checkout/${r.id}`} className="rounded-lg bg-amber-50 px-3 py-2 text-sm ring-1 ring-amber-200 hover:bg-amber-100">
                #{r.number} · {r.firstName ?? "Walk-in"} · {r.barber ?? "No barber"}
              </Link>
            ))}
          </div>
        </Card>
      )}
      {perBarber.length > 0 && (
        <Card className="mb-4">
          <div className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold">Daily summary by barber</div>
          <div className="grid grid-cols-2 gap-px bg-zinc-100 sm:grid-cols-3 lg:grid-cols-4" data-testid="daily-summary">
            {perBarber.map(([name, x]) => (
              <div key={name} className="bg-white px-4 py-3 text-sm">
                <div className="font-medium">{name}</div>
                <div className="tabular text-zinc-600">
                  {x.tickets} ticket{x.tickets === 1 ? "" : "s"} · {formatCents(x.cents)} · tips {formatCents(x.tips)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {closed.length === 0 ? (
        <Empty title="No completed sales on this day" />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Time</Th>
                {ctx.currentShopId === null && <Th>Shop</Th>}
                <Th>Client</Th>
                <Th>Barber</Th>
                <Th>Tender</Th>
                <Th right>Tip</Th>
                <Th right>Total</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {closed.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50">
                  <Td>
                    <Link className="font-medium underline-offset-2 hover:underline" href={`/admin/sales/${r.id}`}>
                      {r.number}
                    </Link>
                  </Td>
                  <Td>{formatTime(r.paidAt ?? r.createdAt)}</Td>
                  {ctx.currentShopId === null && <Td>{r.shop}</Td>}
                  <Td>{r.firstName ? `${r.firstName} ${r.lastName ?? ""}` : <span className="text-zinc-400">Walk-in</span>}</Td>
                  <Td>
                    {r.barber ?? "—"}
                    {r.reassigned && <span className="ml-1 text-xs text-zinc-500">(reassigned)</span>}
                  </Td>
                  <Td className="capitalize">
                    {r.methods?.replace("_", " ") ?? "—"}
                    {r.cardFeeCents > 0 && <span className="ml-1 text-xs text-amber-700">+fee</span>}
                  </Td>
                  <Td right>{formatCents(r.tipCents)}</Td>
                  <Td right>{formatCents(r.totalCents)}</Td>
                  <Td>
                    <Badge tone={TONE[r.status]}>{r.status.replace("_", " ")}</Badge>
                  </Td>
                  <Td right>
                    <Link className="text-xs underline" href={`/admin/sales/${r.id}`}>
                      Receipt, refund, reassign
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
