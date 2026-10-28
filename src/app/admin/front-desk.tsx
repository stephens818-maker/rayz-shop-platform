import Link from "next/link";
import { Suspense } from "react";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, appointments, customers, staff, waitlistEntries } from "@/db/schema";
import { Notice } from "@/components/ui";
import { LiveRefresh } from "@/components/live-refresh";
import { deskStep } from "@/domain/front-desk";
import { formatCents } from "@/lib/money";
import { endOfLocalDay, formatDate, formatTime, startOfLocalDay, todayLocal } from "@/lib/time";
import { StaffContext, can, reportShopIds } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { openTickets } from "@/server/combined-checkout";
import { newSaleAction } from "./checkout/actions";
import { DeskClientRow } from "./front-desk-row";
import type { CardPeriod } from "@/domain/pph-card";
import { DashboardPph } from "./pph-card";

const STATUS: Record<string, string> = { booked: "Booked", confirmed: "Confirmed", checked_in: "Waiting", in_service: "In the chair" };

/**
 * A shop login's home: big buttons for the front desk, today's clients to check in and out, and the
 * checkout queue, then the shop's PPH and product sales per client cards when the login's role has the
 * PPH report (it doesn't by default).
 */
export async function FrontDeskHome({ ctx, denied, pphBy, ppcBy }: { ctx: StaffContext; denied: boolean; pphBy: CardPeriod; ppcBy: CardPeriod }) {
  const today = todayLocal();
  const shopIds = reportShopIds(ctx);
  const now = new Date();
  const checkout = can(ctx, "checkout.any");
  const [policy, rows, queue, waiting] = await Promise.all([
    clientPolicy(ctx),
    db
      .select({
        id: appointments.id,
        startsAt: appointments.startsAt,
        status: appointments.status,
        barber: staff.displayLabel,
        first: customers.firstName,
        last: customers.lastName,
        services: sql<string | null>`(select string_agg(${appointmentItems.name}, ' + ') from ${appointmentItems} where ${appointmentItems.appointmentId} = ${appointments.id})`,
      })
      .from(appointments)
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .where(
        and(
          inArray(appointments.shopId, shopIds),
          lt(appointments.startsAt, endOfLocalDay(today)),
          gt(appointments.endsAt, startOfLocalDay(today)),
          inArray(appointments.status, ["booked", "confirmed", "checked_in", "in_service"]),
        ),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(60),
    checkout ? openTickets(shopIds, { limit: 12 }) : Promise.resolve([]),
    can(ctx, "walkins.manage")
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(waitlistEntries)
          .where(and(inArray(waitlistEntries.shopId, shopIds), eq(waitlistEntries.status, "waiting")))
          .then((r) => r[0]?.n ?? 0)
      : Promise.resolve(0),
  ]);
  const inChair = rows.filter((r) => r.status === "in_service").length;
  const waitingIn = rows.filter((r) => r.status === "checked_in").length;
  const ready = [...queue].sort((a, b) => Number(b.total > 0 && b.ready === b.total) - Number(a.total > 0 && a.ready === a.total) || b.ready - a.ready);
  return (
    <div className="mx-auto max-w-6xl space-y-5" data-testid="front-desk">
      <LiveRefresh everyMs={30_000} />
      {denied && <Notice tone="red">You don&apos;t have access to that page.</Notice>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{formatDate(today, "EEEE, MMM d")}</h1>
          <p className="text-base text-zinc-600" data-testid="front-desk-counts">
            {rows.length} to come or in the shop · {waitingIn} waiting · {inChair} in the chair{waiting ? ` · ${waiting} on the waitlist` : ""}
          </p>
        </div>
        {checkout && (
          <form action={newSaleAction}>
            <button className="h-14 rounded-2xl bg-brand-600 px-6 text-lg font-semibold text-white shadow-sm hover:bg-brand-700" data-testid="front-desk-new-sale">
              New sale
            </button>
          </form>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <section className="rounded-2xl bg-white shadow-xs ring-1 ring-zinc-200" aria-labelledby="desk-today">
          <h2 id="desk-today" className="border-b border-zinc-100 px-4 py-3 text-lg font-semibold">
            Today&apos;s clients
          </h2>
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-base text-zinc-600">Nobody else is booked today.</p>
          ) : (
            <ul className="divide-y divide-zinc-100" data-testid="front-desk-clients">
              {rows.map((r) => (
                <DeskClientRow
                  key={r.id}
                  id={r.id}
                  time={formatTime(r.startsAt)}
                  late={deskStep(r.status) === "check_in" && r.startsAt < now}
                  client={r.first ? policy.name(r.first, r.last) : "Walk-in"}
                  barber={r.barber}
                  services={r.services}
                  status={STATUS[r.status] ?? r.status}
                  step={checkout || deskStep(r.status) === "check_in" ? deskStep(r.status) : null}
                />
              ))}
            </ul>
          )}
        </section>

        {checkout && (
          <section className="order-first self-start rounded-2xl bg-white shadow-xs ring-1 ring-zinc-200 lg:order-none" aria-labelledby="desk-queue">
            <h2 id="desk-queue" className="border-b border-zinc-100 px-4 py-3 text-lg font-semibold">
              Ready to check out
            </h2>
            {ready.length === 0 ? (
              <p className="px-4 py-6 text-base text-zinc-600">No open tickets.</p>
            ) : (
              <ul className="space-y-2 p-3" data-testid="front-desk-queue">
                {ready.map((t) => {
                  const all = t.total > 0 && t.ready === t.total;
                  return (
                    <li key={t.id}>
                      <Link
                        href={`/admin/checkout/${t.id}`}
                        className={`flex min-h-16 items-center justify-between gap-3 rounded-xl px-4 py-2 ring-1 ${all ? "bg-emerald-50 ring-emerald-300 hover:bg-emerald-100" : "bg-amber-50 ring-amber-200 hover:bg-amber-100"}`}
                      >
                        <span>
                          <span className="block text-base font-semibold">{t.client ?? "Walk-in"}</span>
                          <span className="block text-sm text-zinc-600">
                            #{t.number}
                            {t.barber ? ` · ${t.barber}` : ""}
                            {t.total > 1 ? ` · ${t.ready} of ${t.total} ready` : ""}
                          </span>
                        </span>
                        <span className="tabular text-lg font-semibold">{formatCents(t.grossCents)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
      <Suspense fallback={null}>
        <DashboardPph ctx={ctx} rankBy={pphBy} perClientBy={ppcBy} today={today} now={now} />
      </Suspense>
    </div>
  );
}
