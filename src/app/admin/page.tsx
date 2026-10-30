import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appointmentItems,
  appointments,
  customers,
  shops,
  staff,
  waitlistEntries,
} from "@/db/schema";
import {
  Card,
  CardHeader,
  Empty,
  LinkButton,
  Notice,
  PageHeader,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { formatCents } from "@/lib/money";
import {
  addDays,
  endOfLocalDay,
  formatDate,
  formatTime,
  minutesToLabel,
  startOfLocalDay,
  todayLocal,
} from "@/lib/time";
import { ACTION_BADGES, todayLine } from "@/domain/badges";
import { reportsFor } from "@/domain/navigation";
import { STATUS_LABEL } from "@/domain/staff-time";
import { listRequests, staffingFor } from "@/server/staff-time";
import {
  can,
  canAny,
  guardPage,
  reasonViewer,
} from "@/server/auth/staff";
import { todayAlerts, viewerOf } from "@/server/today";
import { badgeCounts, shownBadges } from "@/server/badges";
import { noteBriefs, noteViewer } from "@/server/client-notes";
import { clientPolicy } from "@/server/client-privacy";
import { ClientNotesBrief } from "@/components/client-notes-brief";
import { ClientBadges } from "@/components/client-badges";
import { liveClock } from "@/server/clock-live";
import { PortalWelcome } from "@/components/celebration";
import { LiveRefresh } from "@/components/live-refresh";
import { timesFor } from "@/server/service-times";
import { ServiceTimer } from "./calendar/service-times-panel";
import { SendToCheckoutButton } from "./checkout/send-to-checkout";
import { TodayAlerts } from "./today/alerts";
import { FrontDeskHome } from "./front-desk";
import { byShop, salesSummary } from "@/server/reports";
import { todayMilestones } from "@/server/milestones/views";
import { congratsLine } from "@/domain/milestones";
import { DismissCongrats } from "./milestones/client";
import { myRebook } from "@/server/rebook-report";
import { pctText, ptsLabel } from "@/domain/rebook";
import { parseCardPeriod } from "@/domain/pph-card";
import { priorPeriod, rangeHeading, rangeText } from "@/domain/report-range";
import { payPeriodPicker } from "@/server/payroll/periods";
import { DashboardPph, PphCardSkeleton } from "./pph-card";
import { ReportFilters, locationProps, reportQuery } from "./reports/filters";
import { resolveLocations, resolveRange } from "./reports/scope";

export const metadata: Metadata = { title: "Today" };

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{
    denied?: string;
    pph?: string;
    ppc?: string;
    preset?: string;
    from?: string;
    to?: string;
    shop?: string | string[];
  }>;
}) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin");
  if (ctx.staff.kind === "shop")
    return (
      <FrontDeskHome
        ctx={ctx}
        denied={!!sp.denied}
        pphBy={parseCardPeriod(sp.pph)}
        ppcBy={parseCardPeriod(sp.ppc)}
      />
    );
  const today = todayLocal();
  const locs = await resolveLocations(ctx, { shop: sp.shop }).catch(() =>
    resolveLocations(ctx, {}),
  );
  const shopIds = locs.selection.shopIds;
  const range = await resolveRange(sp, {
    shopIds,
    defaultPreset: "today",
    memory: { staffId: ctx.staff.id, key: "dashboard" },
  });
  const isToday = range.from === today && range.to === today;
  const heading = rangeHeading({
    from: range.from,
    to: range.to,
    label: range.rangeLabel,
  });
  const cardRange = isToday
    ? null
    : { from: range.from, to: range.to, label: range.rangeLabel ?? "Custom range" };
  const pphBy = parseCardPeriod(sp.pph, !!cardRange);
  const ppcBy = parseCardPeriod(sp.ppc, !!cardRange);
  const rangeQuery = reportQuery(
    locs,
    range.preset ? { preset: range.preset } : { from: range.from, to: range.to },
  ).toString();
  const ownBook = !can(ctx, "calendar.manage");
  const ownSales = !can(ctx, "sales.view");
  const salesStaffId = ownSales ? ctx.staff.id : null;
  const staffId = ownBook ? ctx.staff.id : null;
  const scope = { shopIds, from: range.from, to: range.to, staffId: salesStaffId };
  const priorDates = isToday
    ? { from: addDays(today, -7), to: addDays(today, -7) }
    : priorPeriod(range.from, range.to, range.preset);
  const lastWeek = { shopIds, ...priorDates, staffId: salesStaffId };
  const seesWalkins = can(ctx, "walkins.manage");
  const now = new Date();
  const apptWhere = and(
    inArray(appointments.shopId, shopIds),
    lt(appointments.startsAt, endOfLocalDay(today)),
    gt(appointments.endsAt, startOfLocalDay(today)),
    staffId ? eq(appointments.staffId, staffId) : undefined,
  );
  const countsWhere = (where: ReturnType<typeof and>) =>
    db
      .select({ status: appointments.status, n: sql<number>`count(*)::int` })
      .from(appointments)
      .where(where)
      .groupBy(appointments.status);

  const [
    summary,
    prior,
    statusCounts,
    upcoming,
    waitlist,
    shopRows,
    alerts,
    rangeCounts,
    payPeriods,
  ] =
    await Promise.all([
      salesSummary(scope),
      salesSummary(lastWeek),
      countsWhere(apptWhere),
      db
        .select({
          id: appointments.id,
          startsAt: appointments.startsAt,
          status: appointments.status,
          staffId: appointments.staffId,
          customerId: appointments.customerId,
          barber: staff.displayLabel,
          first: customers.firstName,
          last: customers.lastName,
          notes: appointments.notes,
          readyAt: appointments.checkoutReadyAt,
          shop: shops.name,
          services: sql<string>`(select string_agg(${appointmentItems.name}, ' + ') from ${appointmentItems} where ${appointmentItems.appointmentId} = ${appointments.id})`,
        })
        .from(appointments)
        .innerJoin(staff, eq(staff.id, appointments.staffId))
        .innerJoin(shops, eq(shops.id, appointments.shopId))
        .leftJoin(customers, eq(customers.id, appointments.customerId))
        .where(
          and(
            apptWhere,
            gt(appointments.endsAt, now),
            inArray(appointments.status, [
              "booked",
              "confirmed",
              "checked_in",
              "in_service",
            ]),
          ),
        )
        .orderBy(asc(appointments.startsAt))
        .limit(10),
      !seesWalkins
        ? Promise.resolve([{ n: 0 }])
        : db
            .select({ n: sql<number>`count(*)::int` })
            .from(waitlistEntries)
            .where(
              and(
                inArray(waitlistEntries.shopId, shopIds),
                eq(waitlistEntries.status, "waiting"),
              ),
            ),
      shopIds.length > 1 && !ownSales
        ? byShop(scope)
        : Promise.resolve([]),
      todayAlerts(viewerOf(ctx), now),
      isToday
        ? Promise.resolve(null)
        : countsWhere(
            and(
              inArray(appointments.shopId, shopIds),
              lt(appointments.startsAt, endOfLocalDay(range.to)),
              gt(appointments.endsAt, startOfLocalDay(range.from)),
              staffId ? eq(appointments.staffId, staffId) : undefined,
            ),
          ),
      payPeriodPicker(shopIds, today),
    ]);
  const seesTeam = canAny(ctx, [
    "calendar.manage",
    "timeoff.approve",
    "schedules.edit",
  ]);
  const policy = await clientPolicy(ctx);
  const [
    times,
    staffing,
    myDecisions,
    badges,
    badgeTally,
    noteBriefsFor,
    milestones,
    myRebookRate,
  ] = await Promise.all([
    timesFor(
      upcoming.map((a) => a.id),
      now,
    ),
    staffingFor(
      shopIds,
      today,
      today,
      reasonViewer(ctx),
      seesTeam ? null : [ctx.staff.id],
    ),
    can(ctx, "timeoff.request")
      ? listRequests(
          { staffId: ctx.staff.id },
          {
            viewer: reasonViewer(ctx),
            statuses: ["approved", "denied"],
            limit: 20,
          },
        ).then((rs) =>
          rs.filter(
            (r) =>
              r.decidedAt &&
              new Date(r.decidedAt).getTime() >
                now.getTime() - 7 * 86_400_000 &&
              r.decidedVia !== "auto",
          ),
        )
      : Promise.resolve([]),
    shownBadges(
      policy,
      upcoming.map((a) => a.customerId),
      now,
    ),
    badgeCounts(shopIds, today, [...policy.badges], { now, staffId }),
    noteBriefs(
      noteViewer(ctx, policy),
      upcoming.map((a) => a.customerId),
    ),
    todayMilestones(ctx, shopIds, now),
    can(ctx, "report.rebook_rate.view") && ctx.staff.kind === "person"
      ? myRebook(ctx.staff.id, ctx.shopIds, today, now)
      : Promise.resolve(null),
  ]);
  const whosIn = shopIds
    .map((id) => ({
      id,
      name: ctx.shops.find((s) => s.id === id)?.name ?? "",
      rows: staffing.filter((r) => r.shopId === id),
    }))
    .filter((s) => s.rows.length > 0);
  const clockShops = whosIn.length
    ? await db
        .select({ id: shops.id, timeClock: shops.timeClock })
        .from(shops)
        .where(
          inArray(
            shops.id,
            whosIn.map((s) => s.id),
          ),
        )
    : [];
  const clocks = new Map(
    await Promise.all(
      clockShops.map(
        async (s) =>
          [
            s.id,
            (
              await liveClock(
                s,
                today,
                staffing.filter((r) => r.shopId === s.id).map((r) => r.staffId),
                now,
              )
            ).days,
          ] as const,
      ),
    ),
  );
  const clockOf = (r: (typeof staffing)[number]) => {
    const d = clocks.get(r.shopId)?.get(r.staffId);
    if (!d?.status || r.status === "off") return null;
    if (d.status === "not_in" && r.status === "not_scheduled") return null;
    const at = d.since ? formatTime(d.since) : "";
    const text = d.elsewhereShopId
      ? "Clocked in at another shop"
      : d.status === "in"
        ? `Clocked in ${at}`
        : d.status === "break"
          ? `On break since ${at}`
          : d.status === "out"
            ? `Clocked out ${at}`
            : "Not in yet";
    const flag =
      d.overdueMin !== null
        ? `${d.overdueMin}m past start`
        : d.lateMin !== null
          ? `late ${d.lateMin}m`
          : d.earlyOutMin !== null
            ? `left ${d.earlyOutMin}m early`
            : d.missed.length
              ? "missed punch"
              : null;
    const tone =
      d.status === "in"
        ? "text-emerald-700"
        : d.status === "break"
          ? "text-amber-700"
          : d.overdueMin !== null
            ? "font-semibold text-red-700"
            : "text-zinc-500";
    return { text, flag, tone };
  };
  const blockText = (r: (typeof staffing)[number]) =>
    r.blocks
      .filter((b) => b.category !== "time_off")
      .map((b) => `${b.label.toLowerCase()} ${minutesToLabel(b.startMin)}`)
      .join(", ");
  const offText = (r: (typeof staffing)[number]) =>
    r.blocks
      .filter((b) => b.category === "time_off")
      .map(
        (b) =>
          `${b.label.toLowerCase()} ${minutesToLabel(b.startMin)}–${minutesToLabel(b.endMin % (24 * 60))}`,
      )
      .join(", ");
  const offReason = (r: (typeof staffing)[number]) =>
    [
      ...new Set(
        r.blocks
          .filter((b) => b.category === "time_off")
          .map((b) => b.label.toLowerCase()),
      ),
    ].join(", ");
  const soon = new Date(now.getTime() + 30 * 60_000);
  const runsTimer = (a: { staffId: string; status: string; startsAt: Date }) =>
    (a.staffId === ctx.staff.id || can(ctx, "calendar.manage")) &&
    (a.status === "checked_in" ||
      a.status === "in_service" ||
      a.startsAt <= soon);
  const sends = (a: { staffId: string; status: string }) =>
    (a.staffId === ctx.staff.id || can(ctx, "checkout.any")) &&
    (a.status === "checked_in" || a.status === "in_service");
  const countIn = (rows: typeof statusCounts, s: string[]) =>
    rows.filter((c) => s.includes(c.status)).reduce((a, c) => a + c.n, 0);
  const count = (s: string[]) => countIn(statusCounts, s);
  const booked = (s: string[]) => countIn(rangeCounts ?? statusCounts, s);
  const delta = (a: number, b: number) =>
    b
      ? `${a >= b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}% vs ${
          isToday
            ? `last ${formatDate(today, "EEEE")}`
            : rangeText(priorDates.from, priorDates.to)
        }`
      : undefined;
  const when = isToday ? "today" : "in range";
  const notificationsOff =
    (process.env.NOTIFICATIONS_SMS_PROVIDER ?? "disabled") === "disabled" &&
    (process.env.NOTIFICATIONS_EMAIL_PROVIDER ?? "disabled") === "disabled";
  const scopeName = locs.shopParam
    ? locs.label
    : ctx.currentShopId === null
      ? ctx.brandWide
        ? "All shops"
        : "All my shops"
      : ctx.shops.find((s) => s.id === ctx.currentShopId)?.name;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title={`Hi ${ctx.staff.firstName}`}
        subtitle={
          <>
            {scopeName} · {formatDate(today, "EEEE, MMMM d")}
            {!isToday && (
              <>
                {" "}
                · Metrics:{" "}
                <span data-testid="dashboard-range">{heading}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <LinkButton href="/admin/calendar" variant="secondary">
              Calendar
            </LinkButton>
            {seesWalkins && (
              <LinkButton href="/admin/walk-ins">+ Quick walk-in</LinkButton>
            )}
          </>
        }
      />
      <LiveRefresh everyMs={30_000} />
      {milestones.welcome.length > 0 && (
        <PortalWelcome
          firstName={ctx.staff.firstName}
          items={milestones.welcome}
        />
      )}
      {sp.denied && (
        <Notice tone="red">You don&apos;t have access to that page.</Notice>
      )}
      <TodayAlerts alerts={alerts} multiShop={shopIds.length > 1} />
      {myDecisions.map((r) => (
        <Notice key={r.id} tone={r.status === "approved" ? "green" : "red"}>
          Your {r.reason.label.toLowerCase()} time off for {r.range} was{" "}
          {r.status}
          {r.decidedBy ? ` by ${r.decidedBy}` : ""}
          {r.decisionNote ? `: “${r.decisionNote}”` : "."}{" "}
          <Link className="underline" href="/admin/my-time">
            My time
          </Link>
        </Notice>
      ))}
      {milestones.congrats.length > 0 && (
        <Notice tone="green">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Congratulations!{" "}
              {milestones.congrats.map(congratsLine).join(" · ")}.{" "}
              <Link className="underline" href="/admin/milestones">
                Trophy case
              </Link>
            </span>
            <DismissCongrats ids={milestones.congrats.map((m) => m.id)} />
          </span>
        </Notice>
      )}
      {milestones.team.length > 0 && (
        <Notice tone="blue">
          {milestones.team.map((l) => l.text).join("; ")}.{" "}
          <Link className="underline" href="/admin/milestones">
            Milestones
          </Link>
        </Notice>
      )}
      {can(ctx, "notifications.view") && notificationsOff && (
        <Notice tone="blue">
          Customer texts and emails are off (stub provider). Reminders are
          queued and marked &ldquo;suppressed&rdquo;; see{" "}
          <Link className="underline" href="/admin/notifications">
            Notifications
          </Link>
          .
        </Notice>
      )}

      <ReportFilters
        base="/admin"
        preset={range.preset}
        from={range.from}
        to={range.to}
        scope={locs}
        location={ctx.shops.length > 1 ? locationProps(ctx, locs) : null}
        payPeriods={payPeriods}
        views={false}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="dashboard-stats">
        <Stat
          label={ownSales ? `My services ${when}` : `Net sales ${when}`}
          value={formatCents(summary.netSalesCents)}
          hint={delta(summary.netSalesCents, prior.netSalesCents)}
          tone={summary.netSalesCents >= prior.netSalesCents ? "up" : "down"}
        />
        <Stat
          label={`Tips ${when}`}
          value={formatCents(summary.tipsCents)}
          hint={`${summary.tickets} tickets`}
        />
        <Stat
          label="Appointments"
          value={booked([
            "booked",
            "confirmed",
            "checked_in",
            "in_service",
            "completed",
          ])}
          hint={`${booked(["completed"])} done · ${booked(["no_show"])} no-show`}
        />
        <Stat
          label={ownBook ? "Waiting for me" : "Waiting now"}
          value={count(["checked_in"]) + (waitlist[0]?.n ?? 0)}
          hint={!seesWalkins ? undefined : `${waitlist[0]?.n ?? 0} on waitlist`}
        />
      </div>

      <Suspense fallback={<PphCardSkeleton />}>
        <DashboardPph
          ctx={ctx}
          rankBy={pphBy}
          perClientBy={ppcBy}
          today={today}
          now={now}
          shopIds={shopIds}
          range={cardRange}
          query={rangeQuery}
        />
      </Suspense>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader
            title="Up next"
            action={
              <Link className="text-xs underline" href="/admin/calendar">
                Open calendar
              </Link>
            }
          />
          {upcoming.length === 0 ? (
            <div className="p-4">
              <Empty title="Nothing else on the books today" />
            </div>
          ) : (
            <Table>
              <tbody>
                {upcoming.map((a) => (
                  <tr key={a.id} className="hover:bg-zinc-50">
                    <Td className="w-20 font-medium">
                      {formatTime(a.startsAt)}
                    </Td>
                    <Td>
                      <Link
                        href={`/admin/calendar?appt=${a.id}`}
                        className="font-medium hover:underline"
                      >
                        {a.first
                          ? policy.name(a.first, a.last)
                          : (a.notes?.replace("Walk-in: ", "") ?? "Walk-in")}
                      </Link>
                      <div className="text-xs text-zinc-500">{a.services}</div>
                      <ClientBadges
                        badges={
                          a.customerId ? badges.get(a.customerId) : undefined
                        }
                        only={ACTION_BADGES}
                        strongActions
                        className="mt-0.5 flex"
                      />
                      <ClientNotesBrief
                        brief={
                          a.customerId ? noteBriefsFor.get(a.customerId) : null
                        }
                        compact
                        className="mt-1 max-w-md"
                      />
                    </Td>
                    <Td>
                      {a.barber}
                      {ctx.currentShopId === null && (
                        <div className="text-xs text-zinc-500">{a.shop}</div>
                      )}
                    </Td>
                    <Td>
                      <StatusBadge status={a.status} />
                    </Td>
                    <Td right className="w-36">
                      {runsTimer(a) && (
                        <ServiceTimer
                          appointmentId={a.id}
                          status={a.status}
                          times={times.get(a.id) ?? null}
                        />
                      )}
                      {sends(a) && (
                        <div className="mt-1">
                          <SendToCheckoutButton
                            appointmentId={a.id}
                            readyAt={a.readyAt?.toISOString() ?? null}
                          />
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="space-y-4">
          {badgeTally.length > 0 && (
            <Card data-testid="today-badges">
              <CardHeader
                title={ownBook ? "Your clients today" : "Today's clients"}
                subtitle="Booked today, by badge."
              />
              <ul className="space-y-1 px-4 py-3 text-sm">
                {badgeTally.map((b) => (
                  <li key={b.key} className="flex items-center gap-2">
                    <span className="w-6 text-right font-semibold tabular">
                      {b.count}
                    </span>
                    <span className="text-zinc-700">
                      {todayLine(b.key, b.count).replace(/^\d+ /, "")}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {whosIn.length > 0 && (
            <Card>
              <CardHeader
                title={seesTeam ? "Who's in today" : "My day"}
                action={
                  <Link
                    className="text-xs underline"
                    href={
                      can(ctx, "report.staffing.view")
                        ? "/admin/reports/staffing"
                        : "/admin/my-time"
                    }
                  >
                    {can(ctx, "report.staffing.view") ? "Report" : "My time"}
                  </Link>
                }
              />
              <div className="divide-y divide-zinc-100 text-sm">
                {whosIn.map((s) => (
                  <div key={s.id} className="px-4 py-2">
                    {whosIn.length > 1 && (
                      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        {s.name}
                      </div>
                    )}
                    <ul className="space-y-1">
                      {s.rows.map((r) => {
                        const clock = clockOf(r);
                        return (
                          <li
                            key={r.staffId}
                            className="flex items-baseline justify-between gap-2"
                          >
                            <span className="font-medium">{r.label}</span>
                            <span className="text-right text-xs">
                              {clock ? (
                                <span className={clock.tone}>
                                  {clock.text}
                                  {clock.flag && (
                                    <span className="text-red-700">
                                      {" "}
                                      · {clock.flag}
                                    </span>
                                  )}
                                </span>
                              ) : (
                                <span
                                  className={
                                    r.status === "off"
                                      ? "font-semibold text-violet-700"
                                      : r.status === "partly_off"
                                        ? "text-violet-700"
                                        : r.status === "working"
                                          ? "text-emerald-700"
                                          : "text-zinc-500"
                                  }
                                >
                                  {STATUS_LABEL[r.status]}
                                </span>
                              )}
                              {r.status === "partly_off" && (
                                <span className="text-violet-700">
                                  {" "}
                                  · {offText(r)}
                                </span>
                              )}
                              {r.status === "off" && offReason(r) && (
                                <span className="text-violet-700">
                                  {" "}
                                  · {offReason(r)}
                                </span>
                              )}
                              {r.pending && (
                                <span className="text-amber-700">
                                  {" "}
                                  · off requested
                                </span>
                              )}
                              {r.blockedMin > 0 && (
                                <span className="text-zinc-500">
                                  {" "}
                                  · {blockText(r)}
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {myRebookRate && myRebookRate.counts.known > 0 && (
            <MyRebookCard r={myRebookRate} />
          )}
          <Card className="p-4 text-sm">
            <div className="font-semibold">
              {isToday ? "Today so far" : heading}
            </div>
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
              <Link
                className="mt-3 inline-block text-xs underline"
                href="/admin/reports"
              >
                Full reports
              </Link>
            )}
          </Card>
        </div>
      </div>

      {shopRows.length > 0 && (
        <Card>
          <CardHeader
            title={isToday ? "By shop today" : "By shop"}
            subtitle={isToday ? undefined : heading}
          />
          <Table label={isToday ? "By shop today" : "By shop"}>
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

/** The signed-in barber's own rebook numbers over the last 30 days, against the brand average. */
function MyRebookCard({ r }: { r: Awaited<ReturnType<typeof myRebook>> }) {
  const vs = ptsLabel(r.rates.rebook, r.brand.rebook);
  const ahead = r.rates.rebook !== null && r.brand.rebook !== null && r.rates.rebook > r.brand.rebook;
  const line = (label: string, x: number | null, brand: number | null) => (
    <div className="flex justify-between">
      <dt className="text-zinc-500">{label}</dt>
      <dd>
        {pctText(x)}
        <span className="ml-1 text-xs text-zinc-400">brand {pctText(brand)}</span>
      </dd>
    </div>
  );
  return (
    <Card className="p-4 text-sm" data-testid="my-rebook">
      <div className="flex items-baseline justify-between">
        <div className="font-semibold">My rebook rate</div>
        <span className="text-xs text-zinc-500">Last 30 days</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular">{pctText(r.rates.rebook)}</span>
        {vs && (
          <span className={ahead ? "text-sm text-emerald-700" : vs === "even" ? "text-sm text-zinc-500" : "text-sm text-red-700"}>
            {vs === "even" ? "same as the brand" : `${vs} vs brand ${pctText(r.brand.rebook)}`}
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        {r.counts.rebooked} of {r.counts.known} visits ended with the client&apos;s next visit booked.
      </p>
      <dl className="mt-2 space-y-1 tabular">
        {line("New clients rebooked", r.rates.newRebook, r.brand.newRebook)}
        {r.newJudged > 0 && line("2nd-visit retention", r.second, r.brandSecond)}
        <div className="flex justify-between">
          <dt className="text-zinc-500">Booked ahead</dt>
          <dd>{r.counts.future.toLocaleString("en-US")}</dd>
        </div>
      </dl>
      <Link className="mt-3 inline-block text-xs underline" href="/admin/reports/rebook?preset=30d">
        Rebook report
      </Link>
    </Card>
  );
}
