import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customers, shops, staff, waitlistEntries } from "@/db/schema";
import { Card, CardHeader, Empty, LinkButton, Notice, PageHeader, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { addDays, endOfLocalDay, formatDate, formatTime, minutesToLabel, startOfLocalDay, todayLocal } from "@/lib/time";
import { reportsFor } from "@/domain/navigation";
import { STATUS_LABEL } from "@/domain/staff-time";
import { listRequests, pendingCount, staffingFor } from "@/server/staff-time";
import { can, canAny, guardPage, reasonViewer, reportShopIds } from "@/server/auth/staff";
import { flaggedCount } from "@/server/call-ins";
import { unreadCount } from "@/server/messaging";
import { stockLevels } from "@/server/inventory/stock";
import { timesFor } from "@/server/service-times";
import { ServiceTimer } from "./calendar/service-times-panel";
import { byShop, salesSummary } from "@/server/reports";

export const metadata: Metadata = { title: "Today" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin");
  const today = todayLocal();
  const shopIds = reportShopIds(ctx);
  const ownBook = !can(ctx, "calendar.manage");
  const ownSales = !can(ctx, "sales.view");
  const salesStaffId = ownSales ? ctx.staff.id : null;
  const staffId = ownBook ? ctx.staff.id : null;
  const scope = { shopIds, from: today, to: today, staffId: salesStaffId };
  const lastWeek = { shopIds, from: addDays(today, -7), to: addDays(today, -7), staffId: salesStaffId };
  const seesWalkins = can(ctx, "walkins.manage");
  const seesStock = canAny(ctx, ["inventory.manage", "inventory.adjust", "po.create"]);
  const seesSettings = can(ctx, "settings.shop") || can(ctx, "settings.taxes");
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
        staffId: appointments.staffId,
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
    !seesWalkins
      ? Promise.resolve([{ n: 0 }])
      : db.select({ n: sql<number>`count(*)::int` }).from(waitlistEntries).where(and(inArray(waitlistEntries.shopId, shopIds), eq(waitlistEntries.status, "waiting"))),
    !seesStock
      ? Promise.resolve([])
      : stockLevels(shopIds).then((rows) =>
          rows
            .filter((r) => r.low)
            .sort((a, b) => a.available - b.available)
            .slice(0, 8),
        ),
    ctx.currentShopId === null && !ownSales ? byShop(scope) : Promise.resolve([]),
    db.select({ name: shops.name }).from(shops).where(and(inArray(shops.id, shopIds), eq(shops.taxRatesVerified, false))),
  ]);
  const seesTeam = canAny(ctx, ["calendar.manage", "timeoff.approve", "schedules.edit"]);
  const [times, staffing, waitingRequests, myDecisions, callInFlags, unreadTexts] = await Promise.all([
    timesFor(upcoming.map((a) => a.id), now),
    staffingFor(shopIds, today, today, reasonViewer(ctx), seesTeam ? null : [ctx.staff.id]),
    can(ctx, "timeoff.approve") ? pendingCount(shopIds, false) : Promise.resolve(0),
    can(ctx, "timeoff.request")
      ? listRequests({ staffId: ctx.staff.id }, { viewer: reasonViewer(ctx), statuses: ["approved", "denied"], limit: 20 }).then((rs) =>
          rs.filter((r) => r.decidedAt && new Date(r.decidedAt).getTime() > now.getTime() - 7 * 86_400_000 && r.decidedVia !== "auto"),
        )
      : Promise.resolve([]),
    can(ctx, "callins.outreach") ? flaggedCount(shopIds) : Promise.resolve(0),
    can(ctx, "inbox.view") ? unreadCount(shopIds) : Promise.resolve(0),
  ]);
  const whosIn = shopIds
    .map((id) => ({ id, name: ctx.shops.find((s) => s.id === id)?.name ?? "", rows: staffing.filter((r) => r.shopId === id) }))
    .filter((s) => s.rows.length > 0);
  const blockText = (r: (typeof staffing)[number]) =>
    r.blocks
      .filter((b) => b.category !== "time_off")
      .map((b) => `${b.label.toLowerCase()} ${minutesToLabel(b.startMin)}`)
      .join(", ");
  const offText = (r: (typeof staffing)[number]) =>
    r.blocks
      .filter((b) => b.category === "time_off")
      .map((b) => `${b.label.toLowerCase()} ${minutesToLabel(b.startMin)}–${minutesToLabel(b.endMin % (24 * 60))}`)
      .join(", ");
  const offReason = (r: (typeof staffing)[number]) => [...new Set(r.blocks.filter((b) => b.category === "time_off").map((b) => b.label.toLowerCase()))].join(", ");
  const soon = new Date(now.getTime() + 30 * 60_000);
  const runsTimer = (a: { staffId: string; status: string; startsAt: Date }) =>
    (a.staffId === ctx.staff.id || can(ctx, "calendar.manage")) && (a.status === "checked_in" || a.status === "in_service" || a.startsAt <= soon);
  const count = (s: string[]) => statusCounts.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.n, 0);
  const delta = (a: number, b: number) => (b ? `${a >= b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}% vs last ${formatDate(today, "EEEE")}` : undefined);
  const notificationsOff = (process.env.NOTIFICATIONS_SMS_PROVIDER ?? "disabled") === "disabled" && (process.env.NOTIFICATIONS_EMAIL_PROVIDER ?? "disabled") === "disabled";
  const scopeName = ctx.currentShopId === null ? (ctx.brandWide ? "All shops" : "All my shops") : ctx.shops.find((s) => s.id === ctx.currentShopId)?.name;

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
            {seesWalkins && <LinkButton href="/admin/walk-ins">+ Quick walk-in</LinkButton>}
          </>
        }
      />
      {sp.denied && <Notice tone="red">You don&apos;t have access to that page.</Notice>}
      {waitingRequests > 0 && (
        <Notice>
          {waitingRequests} time off request{waitingRequests === 1 ? " is" : "s are"} waiting for a decision.{" "}
          <Link className="underline" href="/admin/time-off">
            Review time off
          </Link>
        </Notice>
      )}
      {callInFlags > 0 && (
        <Notice tone="red">
          {callInFlags === 1 ? "One client" : `${callInFlags} clients`} from a call-in still need{callInFlags === 1 ? "s" : ""} a call from the shop: outreach couldn&apos;t reach them or got no answer.{" "}
          <Link className="underline" href="/admin/call-ins">
            Call-ins
          </Link>
        </Notice>
      )}
      {unreadTexts > 0 && (
        <Notice tone="blue">
          {unreadTexts} unread text{unreadTexts === 1 ? "" : "s"} from clients.{" "}
          <Link className="underline" href="/admin/inbox">
            Inbox
          </Link>
        </Notice>
      )}
      {myDecisions.map((r) => (
        <Notice key={r.id} tone={r.status === "approved" ? "green" : "red"}>
          Your {r.reason.label.toLowerCase()} time off for {r.range} was {r.status}
          {r.decidedBy ? ` by ${r.decidedBy}` : ""}
          {r.decisionNote ? `: “${r.decisionNote}”` : "."}{" "}
          <Link className="underline" href="/admin/my-time">
            My time
          </Link>
        </Notice>
      ))}
      {seesSettings && taxShops.length > 0 && (
        <Notice>
          Tax rates are unverified placeholders for {taxShops.map((s) => s.name).join(", ")}. Confirm them in{" "}
          <Link className="underline" href="/admin/settings">
            Shop settings
          </Link>{" "}
          before going live.
        </Notice>
      )}
      {can(ctx, "notifications.view") && notificationsOff && (
        <Notice tone="blue">
          Customer texts and emails are off (stub provider). Reminders are queued and marked &ldquo;suppressed&rdquo;; see{" "}
          <Link className="underline" href="/admin/notifications">
            Notifications
          </Link>
          .
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={ownSales ? "My services today" : "Net sales today"} value={formatCents(summary.netSalesCents)} hint={delta(summary.netSalesCents, prior.netSalesCents)} tone={summary.netSalesCents >= prior.netSalesCents ? "up" : "down"} />
        <Stat label="Tips today" value={formatCents(summary.tipsCents)} hint={`${summary.tickets} tickets`} />
        <Stat label="Appointments" value={count(["booked", "confirmed", "checked_in", "in_service", "completed"])} hint={`${count(["completed"])} done · ${count(["no_show"])} no-show`} />
        <Stat label={ownBook ? "Waiting for me" : "Waiting now"} value={count(["checked_in"]) + (waitlist[0]?.n ?? 0)} hint={!seesWalkins ? undefined : `${waitlist[0]?.n ?? 0} on waitlist`} />
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
                    <Td right className="w-36">
                      {runsTimer(a) && <ServiceTimer appointmentId={a.id} status={a.status} times={times.get(a.id) ?? null} />}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="space-y-4">
          {seesStock && (
            <Card>
              <CardHeader title="Low stock" action={<Link className="text-xs underline" href="/admin/inventory/low-stock">Reorder</Link>} />
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
                      <span className={p.available <= 0 ? "font-semibold text-red-600" : "text-amber-700"}>
                        {p.available}
                        {p.onOrder + p.inTransit > 0 && <span className="text-xs text-zinc-500"> +{p.onOrder + p.inTransit} coming</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {whosIn.length > 0 && (
            <Card>
              <CardHeader
                title={seesTeam ? "Who's in today" : "My day"}
                action={
                  <Link className="text-xs underline" href={can(ctx, "report.staffing.view") ? "/admin/reports/staffing" : "/admin/my-time"}>
                    {can(ctx, "report.staffing.view") ? "Report" : "My time"}
                  </Link>
                }
              />
              <div className="divide-y divide-zinc-100 text-sm">
                {whosIn.map((s) => (
                  <div key={s.id} className="px-4 py-2">
                    {whosIn.length > 1 && <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{s.name}</div>}
                    <ul className="space-y-1">
                      {s.rows.map((r) => (
                        <li key={r.staffId} className="flex items-baseline justify-between gap-2">
                          <span className="font-medium">{r.label}</span>
                          <span className="text-right text-xs">
                            <span className={r.status === "off" ? "font-semibold text-violet-700" : r.status === "partly_off" ? "text-violet-700" : r.status === "working" ? "text-emerald-700" : "text-zinc-500"}>
                              {STATUS_LABEL[r.status]}
                            </span>
                            {r.status === "partly_off" && <span className="text-violet-700"> · {offText(r)}</span>}
                            {r.status === "off" && offReason(r) && <span className="text-violet-700"> · {offReason(r)}</span>}
                            {r.pending && <span className="text-amber-700"> · off requested</span>}
                            {r.blockedMin > 0 && <span className="text-zinc-500"> · {blockText(r)}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
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
            {reportsFor(ctx.permissions).length > 0 && (
              <Link className="mt-3 inline-block text-xs underline" href="/admin/reports">
                Full reports
              </Link>
            )}
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
