import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { cashDrawers, staff } from "@/db/schema";
import { Card, CardHeader, Empty, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { addDays, formatDate, formatDateTime, isValidLocalDate, todayLocal } from "@/lib/time";
import { guardPage, workingShopId } from "@/server/auth/staff";
import { drawerSummary } from "@/server/checkout";
import { CloseDrawerForm } from "./close-form";

export const metadata: Metadata = { title: "Cash drawer" };

export default async function DrawerPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/drawer");
  const shopId = workingShopId(ctx);
  if (!shopId) return <Empty title="No shop selected" />;
  const shop = ctx.shops.find((s) => s.id === shopId)!;
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : todayLocal();
  const [s, history] = await Promise.all([
    drawerSummary(shopId, date),
    db
      .select({ d: cashDrawers, by: staff.displayLabel })
      .from(cashDrawers)
      .leftJoin(staff, eq(staff.id, cashDrawers.closedBy))
      .where(and(eq(cashDrawers.shopId, shopId)))
      .orderBy(desc(cashDrawers.businessDate))
      .limit(14),
  ]);
  const closed = s.drawer?.closedAt;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="End-of-day cash drawer"
        subtitle={`${shop.name} · ${formatDate(date, "EEEE, MMM d")}`}
        actions={
          <>
            <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/drawer?date=${addDays(date, -1)}`}>
              ‹ Prev
            </Link>
            <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/drawer?date=${addDays(date, 1)}`}>
              Next ›
            </Link>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cash sales" value={formatCents(s.cashSalesCents)} hint={`${s.cashTickets} tickets · tips ${formatCents(s.cashTipsCents)}`} />
        <Stat label="Cash refunds" value={formatCents(s.cashRefundsCents)} />
        <Stat label="Expected in drawer" value={formatCents(s.expectedCents)} hint={`float ${formatCents(s.openingFloatCents)} − payouts ${formatCents(s.payoutsCents)}`} />
        <Stat label="Card (for reference)" value={formatCents(s.cardCents)} hint={`${s.cardTickets} card payments`} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader title={closed ? "Drawer closed" : "Count and close"} subtitle={closed ? `Closed ${formatDateTime(closed)}` : "Count the drawer, then close. Voids are locked once the drawer is closed."} />
          {closed ? (
            <dl className="space-y-1 p-4 text-sm tabular">
              <Row k="Opening float" v={formatCents(s.drawer!.openingFloatCents)} />
              <Row k="Payouts" v={formatCents(s.drawer!.payoutsCents)} />
              <Row k="Expected" v={formatCents(s.drawer!.expectedCents)} />
              <Row k="Counted" v={formatCents(s.drawer!.countedCents ?? 0)} />
              <Row k="Over / short" v={formatCents(s.drawer!.varianceCents ?? 0, { sign: true })} strong />
              {s.drawer!.notes && <p className="pt-2 text-zinc-600">{s.drawer!.notes}</p>}
            </dl>
          ) : (
            <CloseDrawerForm shopId={shopId} date={date} cashSalesCents={s.cashSalesCents} cashRefundsCents={s.cashRefundsCents} defaultFloatCents={s.openingFloatCents} />
          )}
        </Card>
        <Card>
          <CardHeader title="Recent closes" />
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th right>Expected</Th>
                <Th right>Counted</Th>
                <Th right>Over/short</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {history.map(({ d, by }) => (
                <tr key={d.id}>
                  <Td>
                    <Link className="hover:underline" href={`/admin/drawer?date=${d.businessDate}`}>
                      {formatDate(d.businessDate, "EEE MMM d")}
                    </Link>
                  </Td>
                  <Td right>{formatCents(d.expectedCents)}</Td>
                  <Td right>{formatCents(d.countedCents ?? 0)}</Td>
                  <Td right className={(d.varianceCents ?? 0) < 0 ? "text-red-600" : (d.varianceCents ?? 0) > 0 ? "text-amber-700" : ""}>
                    {formatCents(d.varianceCents ?? 0, { sign: true })}
                  </Td>
                  <Td>{by ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "border-t border-zinc-200 pt-2 font-semibold" : ""}`}>
      <dt className="text-zinc-600">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
