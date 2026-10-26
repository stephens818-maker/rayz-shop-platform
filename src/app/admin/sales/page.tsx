import type { Metadata } from "next";
import Link from "next/link";
import { CelebrationBanner } from "@/components/celebration";
import {
  Badge,
  Button,
  Card,
  Empty,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { formatCents } from "@/lib/money";
import {
  addDays,
  formatDate,
  formatTime,
  isValidLocalDate,
  todayLocal,
} from "@/lib/time";
import { can, guardPage, reportShopIds } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { openTickets } from "@/server/combined-checkout";
import {
  SALES_PAGE_SIZE,
  combinedSales,
  openSales,
  refundsAwaitingLines,
  salesDayTotals,
  salesPage,
} from "@/server/sales-list";
import { shopDay } from "@/server/milestones/day";
import { byBarber } from "@/server/reports";
import { newSaleAction } from "../checkout/actions";

export const metadata: Metadata = { title: "Sales" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TONE = {
  paid: "green",
  open: "amber",
  voided: "gray",
  refunded: "red",
  partially_refunded: "amber",
} as const;

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; before?: string }>;
}) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/sales");
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : todayLocal();
  const before = sp.before && UUID.test(sp.before) ? sp.before : null;
  const shopIds = reportShopIds(ctx);
  const policy = await clientPolicy(ctx);
  const [totals, page, open, combined, awaiting] = await Promise.all([
    salesDayTotals(shopIds, date),
    salesPage({ shopIds, date, before }),
    openSales(shopIds, date),
    combinedSales(shopIds, date),
    can(ctx, "sales.refund") ? refundsAwaitingLines(shopIds) : Promise.resolve([]),
  ]);
  const closed = page.rows;
  const isToday = date === todayLocal();
  // Each service line counts for the barber who did it, so a family ticket with two barbers shows on both.
  const [queue, barberRows, day] = await Promise.all([
    isToday ? openTickets(shopIds) : Promise.resolve(null),
    byBarber({ shopIds, from: date, to: date }),
    isToday ? shopDay(shopIds) : null,
  ]);
  const perBarber = barberRows
    .map((b) => ({
      name: b.label,
      tickets: b.tickets,
      cents: b.netServicesCents + b.netProductsCents,
      tips: b.tipsCents,
    }))
    .filter((b) => b.tickets || b.cents || b.tips)
    .sort((a, b) => b.cents - a.cents);
  const eod = can(ctx, "report.end_of_day.view");
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sales"
        subtitle={`${formatDate(date, "EEEE, MMM d")} · ${totals.tickets} ticket${totals.tickets === 1 ? "" : "s"} · ${formatCents(totals.paidCents)} collected`}
        actions={
          <>
            <Link
              className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white"
              href={`/admin/sales?date=${addDays(date, -1)}`}
            >
              ‹ Prev
            </Link>
            <Link
              className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white"
              href={`/admin/sales?date=${addDays(date, 1)}`}
            >
              Next ›
            </Link>
            {eod && (
              <Link
                className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white"
                href={`/admin/reports/end-of-day?from=${date}&to=${date}`}
              >
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
      <CelebrationBanner items={day?.pos ?? []} className="mb-4" />
      {awaiting.length > 0 && (
        <Card className="mb-4 bg-amber-50" data-testid="refunds-awaiting">
          <div className="px-4 py-3 text-sm">
            <div className="font-semibold">
              {awaiting.length === 1
                ? "A card refund made in the Stripe dashboard needs its lines"
                : `${awaiting.length} card refunds made in the Stripe dashboard need their lines`}
            </div>
            <p className="mt-0.5 text-xs text-zinc-600">
              Loyalty, gift cards and tips stay as they were until someone
              says what went back.
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {awaiting.map((a) => (
                <li key={a.id}>
                  <Link
                    className="rounded-lg bg-white px-3 py-1.5 text-xs ring-1 ring-amber-300 hover:bg-amber-100"
                    href={`/admin/sales/${a.saleId}`}
                  >
                    #{a.number} · {formatCents(a.amountCents)}
                    {ctx.currentShopId === null && ` · ${a.shop}`}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}
      {queue && queue.length > 0 ? (
        <Card className="mb-4" data-testid="checkout-queue">
          <div className="flex items-baseline justify-between border-b border-zinc-100 px-4 py-3">
            <span className="text-sm font-semibold">Checkout queue</span>
            <span className="text-xs text-zinc-500">
              Ready first. Open a ticket to combine others into it.
            </span>
          </div>
          <ul className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...queue]
              .sort(
                (a, b) =>
                  Number(b.ready > 0 && b.ready === b.total) -
                    Number(a.ready > 0 && a.ready === a.total) ||
                  b.ready - a.ready,
              )
              .map((t) => {
                const all = t.total > 0 && t.ready === t.total;
                return (
                  <li key={t.id}>
                    <Link
                      href={`/admin/checkout/${t.id}`}
                      className={`block rounded-lg px-3 py-2 text-sm ring-1 ${all ? "bg-emerald-50 ring-emerald-300 hover:bg-emerald-100" : "bg-amber-50 ring-amber-200 hover:bg-amber-100"}`}
                      data-testid="queue-ticket"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-semibold">
                          #{t.number} · {t.client ?? "Walk-in"}
                        </span>
                        <span className="tabular text-xs text-zinc-600">
                          {formatCents(t.grossCents)}
                        </span>
                      </div>
                      {t.people.length > 1 ? (
                        <ul className="mt-1 space-y-0.5 text-xs text-zinc-700">
                          {t.people.map((p) => (
                            <li
                              key={p.appointmentId}
                              className="flex items-center gap-1.5"
                            >
                              <span
                                className={`inline-block h-2 w-2 rounded-full ${p.readyAt ? "bg-emerald-500" : "bg-zinc-300"}`}
                                aria-hidden
                              />
                              {p.name}
                              {p.staffName && (
                                <span className="text-zinc-500">
                                  · {p.staffName}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-xs text-zinc-600">
                          {t.barber ?? "No barber"}
                        </div>
                      )}
                      <div className="mt-1 text-xs font-medium">
                        {t.total === 0
                          ? "Retail / gift card"
                          : all
                            ? t.total > 1
                              ? `All ${t.total} ready`
                              : "Ready"
                            : `${t.ready} of ${t.total} ready`}
                        {t.groupCode && (
                          <span className="ml-1 font-mono text-zinc-500">
                            {t.groupCode}
                          </span>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
          </ul>
        </Card>
      ) : (
        !queue &&
        open.length > 0 && (
          <Card className="mb-4">
            <div className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold">
              Open tickets
            </div>
            <div className="flex flex-wrap gap-2 p-4">
              {open.map((r) => (
                <Link
                  key={r.id}
                  href={`/admin/checkout/${r.id}`}
                  className="rounded-lg bg-amber-50 px-3 py-2 text-sm ring-1 ring-amber-200 hover:bg-amber-100"
                >
                  #{r.number} · {r.firstName ?? "Walk-in"} ·{" "}
                  {r.barber ?? "No barber"}
                </Link>
              ))}
            </div>
          </Card>
        )
      )}
      {perBarber.length > 0 && (
        <Card className="mb-4">
          <div className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold">
            Daily summary by barber
          </div>
          <div
            className="grid grid-cols-2 gap-px bg-zinc-100 sm:grid-cols-3 lg:grid-cols-4"
            data-testid="daily-summary"
          >
            {perBarber.map((x) => (
              <div key={x.name} className="bg-white px-4 py-3 text-sm">
                <div className="font-medium">{x.name}</div>
                <div className="tabular text-zinc-600">
                  {x.tickets} ticket{x.tickets === 1 ? "" : "s"} · sales{" "}
                  {formatCents(x.cents)} · tips {formatCents(x.tips)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {closed.length === 0 ? (
        <Empty
          title={
            before
              ? "No older sales on this day"
              : "No completed sales on this day"
          }
        />
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
                    <Link
                      className="font-medium underline-offset-2 hover:underline"
                      href={`/admin/sales/${r.id}`}
                    >
                      {r.number}
                    </Link>
                  </Td>
                  <Td>{formatTime(r.paidAt ?? r.createdAt)}</Td>
                  {ctx.currentShopId === null && <Td>{r.shop}</Td>}
                  <Td>
                    {r.firstName ? (
                      policy.name(r.firstName, r.lastName)
                    ) : (
                      <span className="text-zinc-400">Walk-in</span>
                    )}
                  </Td>
                  <Td>
                    {r.barber ?? "—"}
                    {r.reassigned && (
                      <span className="ml-1 text-xs text-zinc-500">
                        (reassigned)
                      </span>
                    )}
                  </Td>
                  <Td className="capitalize">
                    {r.methods?.replace("_", " ") ?? "—"}
                    {r.cardFeeCents > 0 && (
                      <span className="ml-1 text-xs text-amber-700">+fee</span>
                    )}
                  </Td>
                  <Td right>{formatCents(r.tipCents)}</Td>
                  <Td right>{formatCents(r.totalCents)}</Td>
                  <Td>
                    <Badge tone={TONE[r.status]}>
                      {r.status.replace("_", " ")}
                    </Badge>
                  </Td>
                  <Td right>
                    <Link
                      className="text-xs underline"
                      href={`/admin/sales/${r.id}`}
                    >
                      Receipt, refund, reassign
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {(before || page.next) && (
        <div
          className="mt-3 flex items-center justify-between text-sm"
          data-testid="sales-pages"
        >
          <span className="text-xs text-zinc-500">
            {SALES_PAGE_SIZE} per page, newest first
          </span>
          <span className="flex gap-2">
            {before && (
              <Link
                className="rounded-lg px-3 py-1.5 ring-1 ring-zinc-300 hover:bg-white"
                href={`/admin/sales?date=${date}`}
              >
                Newest
              </Link>
            )}
            {page.next && (
              <Link
                className="rounded-lg px-3 py-1.5 ring-1 ring-zinc-300 hover:bg-white"
                href={`/admin/sales?date=${date}&before=${page.next}`}
                data-testid="sales-older"
              >
                Older ›
              </Link>
            )}
          </span>
        </div>
      )}
      {combined.length > 0 && (
        <p
          className="mt-3 text-xs text-zinc-500"
          data-testid="combined-tickets"
        >
          Combined into other tickets:{" "}
          {combined.map((r, i) => (
            <span key={r.id}>
              {i > 0 && ", "}#{r.number} into{" "}
              <Link
                className="underline"
                href={`/admin/sales/${r.mergedIntoSaleId}`}
              >
                #{r.mergedIntoNumber}
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
