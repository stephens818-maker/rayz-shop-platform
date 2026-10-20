import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customers, loyaltyLedger, sales, shops, staff } from "@/db/schema";
import { Card, CardHeader, PageHeader, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/staff";
import { loyaltyBalance } from "@/server/loyalty";
import { CustomerEditor, GrantReward } from "./editor";

export const metadata: Metadata = { title: "Client" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireStaff(["brand_admin", "shop_manager"]);
  const c = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!c) notFound();
  const [visits, saleRows, loyalty, ledger, [stats]] = await Promise.all([
    db
      .select({ a: appointments, shop: shops.name, barber: staff.displayLabel, items: sql<string>`(select string_agg(name, ' + ') from appointment_items i where i.appointment_id = ${appointments.id})` })
      .from(appointments)
      .innerJoin(shops, eq(shops.id, appointments.shopId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(eq(appointments.customerId, id))
      .orderBy(desc(appointments.startsAt))
      .limit(40),
    db
      .select({ s: sales, shop: shops.name })
      .from(sales)
      .innerJoin(shops, eq(shops.id, sales.shopId))
      .where(eq(sales.customerId, id))
      .orderBy(desc(sales.createdAt))
      .limit(30),
    loyaltyBalance(id),
    db.select().from(loyaltyLedger).where(eq(loyaltyLedger.customerId, id)).orderBy(desc(loyaltyLedger.createdAt)).limit(20),
    db
      .select({
        spend: sql<number>`coalesce(sum(${sales.serviceNetCents} + ${sales.productNetCents}) filter (where ${sales.status} in ('paid','partially_refunded')), 0)::int`,
        tips: sql<number>`coalesce(sum(${sales.tipCents}) filter (where ${sales.status} in ('paid','partially_refunded')), 0)::int`,
      })
      .from(sales)
      .where(eq(sales.customerId, id)),
  ]);
  const completed = visits.filter((v) => v.a.status === "completed").length;
  const noShows = visits.filter((v) => v.a.status === "no_show").length;
  const canSeeSale = (shopId: string) => ctx.shopIds.includes(shopId);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title={`${c.firstName} ${c.lastName ?? ""}`}
        subtitle={`Client since ${formatDateTime(c.createdAt)}${c.squireId ? ` · Squire ID ${c.squireId}` : ""}`}
        actions={
          <Link className="text-sm underline" href="/admin/customers">
            All clients
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Visits" value={completed} hint={noShows ? `${noShows} no-shows` : undefined} tone={noShows ? "down" : undefined} />
        <Stat label="Lifetime spend" value={formatCents(stats.spend)} hint={`tips ${formatCents(stats.tips)}`} />
        <Stat label="Loyalty progress" value={`${formatCents(loyalty.progressCents)} / ${formatCents(loyalty.thresholdCents)}`} hint={`${formatCents(loyalty.remainingCents)} to next ${formatCents(loyalty.rewardCents)}`} />
        <Stat label="Rewards ready" value={formatCents(loyalty.availableCents)} hint={`${loyalty.rewards.length} reward${loyalty.rewards.length === 1 ? "" : "s"}`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <CustomerEditor
            id={c.id}
            initial={{ firstName: c.firstName, lastName: c.lastName ?? "", phone: c.phone ?? "", email: c.email ?? "", notes: c.notes ?? "", smsOptIn: c.smsOptIn, emailOptIn: c.emailOptIn }}
          />
          <Card>
            <CardHeader title="Loyalty" subtitle={loyalty.rules.earn} />
            <ul className="divide-y divide-zinc-100 text-sm">
              {loyalty.rewards.map((r) => (
                <li key={r.id} className="flex justify-between px-4 py-2">
                  <span>{formatCents(r.amountCents)} reward</span>
                  <span className="text-xs text-zinc-500">{r.expiresAt ? `expires ${formatDateTime(r.expiresAt)}` : "no expiry"}</span>
                </li>
              ))}
              {ledger.map((l) => (
                <li key={l.id} className="flex justify-between px-4 py-1.5 text-xs text-zinc-600">
                  <span className="capitalize">
                    {l.kind.replace("_", " ")} · {formatDateTime(l.createdAt)}
                  </span>
                  <span className="tabular">{l.progressDeltaCents ? formatCents(l.progressDeltaCents, { sign: true }) : formatCents(l.rewardCents, { sign: true })}</span>
                </li>
              ))}
            </ul>
            {ctx.isAdmin && <GrantReward customerId={c.id} />}
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Appointments" />
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Shop</Th>
                  <Th>Barber</Th>
                  <Th>Services</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => (
                  <tr key={v.a.id}>
                    <Td>{formatDateTime(v.a.startsAt)}</Td>
                    <Td>{v.shop}</Td>
                    <Td>{v.barber}</Td>
                    <Td className="max-w-xs truncate">{v.items}</Td>
                    <Td>
                      <StatusBadge status={v.a.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <CardHeader title="Purchases" />
            <Table>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Date</Th>
                  <Th>Shop</Th>
                  <Th right>Services</Th>
                  <Th right>Products</Th>
                  <Th right>Tip</Th>
                  <Th right>Total</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {saleRows.map(({ s, shop }) => (
                  <tr key={s.id}>
                    <Td>{canSeeSale(s.shopId) ? <Link className="underline" href={`/admin/sales/${s.id}`}>{s.number}</Link> : s.number}</Td>
                    <Td>{s.businessDate}</Td>
                    <Td>{shop}</Td>
                    <Td right>{formatCents(s.serviceNetCents)}</Td>
                    <Td right>{formatCents(s.productNetCents)}</Td>
                    <Td right>{formatCents(s.tipCents)}</Td>
                    <Td right>{formatCents(s.totalCents)}</Td>
                    <Td className="capitalize">{s.status.replace("_", " ")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      </div>
    </div>
  );
}
