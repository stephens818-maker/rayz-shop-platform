import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customers, products, shopProducts, shops, staff, waitlistEntries } from "@/db/schema";
import { Card, CardHeader, Empty, LinkButton, Notice, PageHeader, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { addDays, endOfLocalDay, formatDate, formatTime, startOfLocalDay, todayLocal } from "@/lib/time";
import { reportShopIds, requireStaff } from "@/server/auth/staff";
import { byShop, salesSummary } from "@/server/reports";

export const metadata: Metadata = { title: "Today" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireStaff();
  const today = todayLocal();
  const shopIds = reportShopIds(ctx);
  const staffId = ctx.isBarber ? ctx.staff.id : null;
  const scope = { shopIds, from: today, to: today, staffId };
  const lastWeek = { shopIds, from: addDays(today, -7), to: addDays(today, -7), staffId };
  const now = new Date();
  const apptWhere = and(
    inArray(appointments.shopId, shopIds),
    lt(appointments.startsAt, endOfLocalDay(today)),
    gt(appointments.endsAt, startOfLocalDay(today)),
    staffId ? eq(appointments.staffId, staffId) : undefined,
  );

  const [summary, prior, statusCounts, upcoming, waitlist, lowStock, shopRows, taxShops] = await Promise.all([
    salesSummary(scope),
    salesSummary(lastWeek),
    db.select({ status: appointments.status, n: sql<number>`count(*)::int` }).from(appointments).where(apptWhere).groupBy(appointments.status),
    db
      .select({
        id: appointments.id,
        startsAt: appointments.startsAt,
        status: appointments.status,
        barber: staff.displayLabel,
        first: customers.firstName,
        last: customers.lastName,
        notes: appointments.notes,
        shop: shops.name,
        services: sql<string>`(select string_agg(${appointmentItems.name}, ' + ') from ${appointmentItems} where ${appointmentItems.appointmentId} = ${appointments.id})`,
      })
      .from(appointments)
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .innerJoin(shops, eq(shops.id, appointments.shopId))
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .where(and(apptWhere, gt(appointments.endsAt, now), inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service"])))
      .orderBy(asc(appointments.startsAt))
      .limit(10),
    ctx.isBarber
      ? Promise.resolve([{ n: 0 }])
      : db.select({ n: sql<number>`count(*)::int` }).from(waitlistEntries).where(and(inArray(waitlistEntries.shopId, shopIds), eq(waitlistEntries.status, "waiting"))),
    ctx.isBarber
      ? Promise.resolve([])
      : db
          .select({ name: products.name, brand: products.brand, stock: shopProducts.stock, shop: shops.name })
          .from(shopProducts)
          .innerJoin(products, eq(products.id, shopProducts.productId))
          .innerJoin(shops, eq(shops.id, shopProducts.shopId))
          .where(and(inArray(shopProducts.shopId, shopIds), eq(shopProducts.active, true), lte(shopProducts.stock, shopProducts.lowStockThreshold)))
          .orderBy(asc(shopProducts.stock))
          .limit(8),
    ctx.currentShopId === null ? byShop(scope) : Promise.resolve([]),
    db.select({ name: shops.name }).from(shops).where(and(inArray(shops.id, shopIds), eq(shops.taxRatesVerified, false))),
  ]);
  const count = (s: string[]) => statusCounts.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.n, 0);
  const delta = (a: number, b: number) => (b ? `${a >= b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}% vs last ${formatDate(today, "EEEE")}` : undefined);
  const notificationsOff = (process.env.NOTIFICATIONS_SMS_PROVIDER ?? "disabled") === "disabled" && (process.env.NOTIFICATIONS_EMAIL_PROVIDER ?? "disabled") === "disabled";
  const scopeName = ctx.currentShopId === null ? "All shops" : ctx.shops.find((s) => s.id === ctx.currentShopId)?.name;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title={`Hi ${ctx.staff.firstName}`}
        subtitle={`${scopeName} · ${formatDate(today, "EEEE, MMMM d")}`}
        actions={
          <>
            <LinkButton href="/admin/calendar" variant="secondary">
              Calendar
            </LinkButton>
            {!ctx.isBarber && <LinkButton href="/admin/walk-ins">+ Quick walk-in</LinkButton>}
          </>
        }
      />
      {sp.denied && <Notice tone="red">You don&apos;t have access to that page.</Notice>}
      {!ctx.isBarber && taxShops.length > 0 && (
        <Notice>
          Tax rates are unverified placeholders for {taxShops.map((s) => s.name).join(", ")}. Confirm them in{" "}
          <Link className="underline" href="/admin/settings">
            Shop settings
          </Link>{" "}
          before going live.
        </Notice>
      )}
      {!ctx.isBarber && notificationsOff && (
        <Notice tone="blue">
          Customer texts and emails are off (stub provider). Reminders are queued and marked &ldquo;suppressed&rdquo;; see{" "}
          <Link className="underline" href="/admin/notifications">
            Notifications
          </Link>
          .
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={ctx.isBarber ? "My services today" : "Net sales today"} value={formatCents(summary.netSalesCents)} hint={delta(summary.netSalesCents, prior.netSalesCents)} tone={summary.netSalesCents >= prior.netSalesCents ? "up" : "down"} />
        <Stat label="Tips today" value={formatCents(summary.tipsCents)} hint={`${summary.tickets} tickets`} />
        <Stat label="Appointments" value={count(["booked", "confirmed", "checked_in", "in_service", "completed"])} hint={`${count(["completed"])} done · ${count(["no_show"])} no-show`} />
        <Stat label={ctx.isBarber ? "Waiting for me" : "Waiting now"} value={count(["checked_in"]) + (waitlist[0]?.n ?? 0)} hint={ctx.isBarber ? undefined : `${waitlist[0]?.n ?? 0} on waitlist`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Up next" action={<Link className="text-xs underline" href="/admin/calendar">Open calendar</Link>} />
          {upcoming.length === 0 ? (
            <div className="p-4">
              <Empty title="Nothing else on the books today" />
            </div>
          ) : (
            <Table>
              <tbody>
                {upcoming.map((a) => (
                  <tr key={a.id} className="hover:bg-zinc-50">
                    <Td className="w-20 font-medium">{formatTime(a.startsAt)}</Td>
                    <Td>
                      <Link href={`/admin/calendar?appt=${a.id}`} className="font-medium hover:underline">
                        {a.first ? `${a.first} ${a.last ?? ""}` : (a.notes?.replace("Walk-in: ", "") ?? "Walk-in")}
                      </Link>
                      <div className="text-xs text-zinc-500">{a.services}</div>
                    </Td>
                    <Td>
                      {a.barber}
                      {ctx.currentShopId === null && <div className="text-xs text-zinc-500">{a.shop}</div>}
                    </Td>
                    <Td>
                      <StatusBadge status={a.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="space-y-4">
          {!ctx.isBarber && (
            <Card>
              <CardHeader title="Low stock" action={<Link className="text-xs underline" href="/admin/inventory">Inventory</Link>} />
              {lowStock.length === 0 ? (
                <div className="px-4 py-3 text-sm text-zinc-500">All products above their reorder point.</div>
              ) : (
                <ul className="divide-y divide-zinc-100 text-sm">
                  {lowStock.map((p, i) => (
                    <li key={i} className="flex justify-between px-4 py-2">
                      <span className="truncate">
                        {p.brand} {p.name}
                        {ctx.currentShopId === null && <span className="text-xs text-zinc-500"> · {p.shop}</span>}
                      </span>
                      <span className={p.stock <= 0 ? "font-semibold text-red-600" : "text-amber-700"}>{p.stock}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <Card className="p-4 text-sm">
            <div className="font-semibold">Today so far</div>
            <dl className="mt-2 space-y-1 tabular">
              <div className="flex justify-between">
                <dt className="text-zinc-500">Services</dt>
                <dd>{formatCents(summary.netServicesCents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Products</dt>
                <dd>{formatCents(summary.netProductsCents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Avg ticket</dt>
                <dd>{formatCents(summary.avgTicketCents)}</dd>
              </div>
            </dl>
            <Link className="mt-3 inline-block text-xs underline" href="/admin/reports">
              Full reports
            </Link>
          </Card>
        </div>
      </div>

      {shopRows.length > 0 && (
        <Card>
          <CardHeader title="By shop today" />
          <Table>
            <thead>
              <tr>
                <Th>Shop</Th>
                <Th right>Tickets</Th>
                <Th right>Services</Th>
                <Th right>Products</Th>
                <Th right>Tips</Th>
              </tr>
            </thead>
            <tbody>
              {shopRows.map((r) => (
                <tr key={r.shopId}>
                  <Td>{r.name}</Td>
                  <Td right>{r.tickets}</Td>
                  <Td right>{formatCents(r.netServicesCents)}</Td>
                  <Td right>{formatCents(r.netProductsCents)}</Td>
                  <Td right>{formatCents(r.tipsCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
