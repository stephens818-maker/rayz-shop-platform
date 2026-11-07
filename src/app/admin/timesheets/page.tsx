import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { ftStatusChanges, staff, staffShops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { FT_LABEL } from "@/domain/time-clock";
import { addDays, formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { can, canAny, guardPage } from "@/server/auth/staff";
import { narrowShops } from "@/server/tenant";
import { chosenPeriod, ftOverview, recentPeriods, timesheetList } from "@/server/time-clock";
import { LockPeriod } from "./timesheets";
import { formatPayHours } from "@/lib/hours";

export const metadata: Metadata = { title: "Timesheets" };

const WINDOWS = [4, 8, 12, 13] as const;
const hours = (centi: number) => formatPayHours(centi / 100);
const fromMin = (min: number) => formatPayHours(min / 60);
const hoursH = (centi: number) => formatPayHours(centi / 100, { unit: true });
const fromMinH = (min: number) => formatPayHours(min / 60, { unit: true });

export default async function TimesheetsPage({ searchParams }: { searchParams: Promise<{ period?: string; shop?: string; window?: string }> }) {
  const ctx = await guardPage("/admin/timesheets");
  if (!canAny(ctx, ["timesheet.edit", "timesheet.approve", "payroll.export"])) redirect(`/admin/timesheets/${ctx.staff.id}`);
  const sp = await searchParams;
  const today = todayLocal();
  const [periods, period] = await Promise.all([recentPeriods(today), chosenPeriod(sp.period, today)]);
  const shopId = ctx.shops.find((s) => s.id === sp.shop)?.id ?? null;
  const shopIds = narrowShops(ctx, shopId ? [shopId] : null);
  const window = WINDOWS.find((w) => String(w) === sp.window) ?? 8;
  const canApprove = can(ctx, "timesheet.approve");
  const canUnlock = ctx.isOwner || can(ctx, "payroll.run");
  const canFt = canAny(ctx, ["timesheet.edit", "timesheet.approve", "payroll.run"]);

  const people = shopIds.length
    ? await db
        .selectDistinct({ id: staff.id, label: staff.displayLabel })
        .from(staffShops)
        .innerJoin(staff, eq(staff.id, staffShops.staffId))
        .where(and(inArray(staffShops.shopId, shopIds), eq(staff.active, true), eq(staff.kind, "person")))
    : [];
  const [{ rows, locks }, ft, changes] = await Promise.all([
    timesheetList(period.start, shopIds),
    canFt && people.length ? ftOverview(people.map((p) => p.id), today, window) : Promise.resolve(null),
    canFt && people.length
      ? db
          .select()
          .from(ftStatusChanges)
          .where(and(inArray(ftStatusChanges.staffId, people.map((p) => p.id)), gte(ftStatusChanges.weekStart, addDays(today, -91))))
          .orderBy(desc(ftStatusChanges.weekStart))
      : Promise.resolve([]),
  ]);
  const label = new Map(people.map((p) => [p.id, p.label]));
  const shopsShown = ctx.shops.filter((s) => shopIds.includes(s.id));
  const ended = today > period.end;
  const q = (o: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ period: period.start, shop: shopId, window: String(window), ...o })) if (v) p.set(k, v);
    return `/admin/timesheets?${p}`;
  };
  const exportHref = (format: string) => `/admin/timesheets/export?${new URLSearchParams({ period: period.start, format, ...(shopId ? { shop: shopId } : {}) })}`;
  const total = rows.reduce((a, r) => ({ worked: a.worked + r.workedCenti, ot: a.ot + r.otCenti, sched: a.sched + r.scheduledMin }), { worked: 0, ot: 0, sched: 0 });

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Timesheets"
        subtitle="Punched hours per person and shop for each bi-weekly pay period (Sunday to Saturday). Each person signs off, then a manager approves, then the period locks."
        actions={
          <Link href={`/admin/timesheets/${ctx.staff.id}?period=${period.start}`} className="text-sm underline">
            My timesheet
          </Link>
        }
      />
      <div className="flex flex-wrap gap-1.5">
        {periods.map((p) => (
          <Link key={p.start} href={q({ period: p.start })} className={cx("rounded-full px-3 py-1 text-sm ring-1", p.start === period.start ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}>
            {formatDate(p.start, "MMM d")} – {formatDate(p.end, "MMM d")}
            {p.start <= today && today <= p.end && " · current"}
          </Link>
        ))}
      </div>
      {ctx.shops.length > 1 && (
        <div className="flex flex-wrap gap-1.5 text-sm">
          <Link href={q({ shop: null })} className={cx("rounded-full px-3 py-1 ring-1", !shopId ? "bg-zinc-800 text-white ring-zinc-800" : "bg-white ring-zinc-300")}>
            All my shops
          </Link>
          {ctx.shops.map((s) => (
            <Link key={s.id} href={q({ shop: s.id })} className={cx("rounded-full px-3 py-1 ring-1", shopId === s.id ? "bg-zinc-800 text-white ring-zinc-800" : "bg-white ring-zinc-300")}>
              {s.name}
            </Link>
          ))}
        </div>
      )}

      <Card>
        <CardHeader
          title={`${rows.length} timesheet${rows.length === 1 ? "" : "s"} · ${hoursH(total.worked)} worked · ${hoursH(total.ot)} overtime · ${fromMinH(total.sched)} scheduled`}
          subtitle={`${formatDate(period.start, "MMM d")} – ${formatDate(period.end, "MMM d, yyyy")}${ended ? "" : ". Still running: lock it after it ends."}`}
        />
        {rows.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Shop</Th>
                <Th className="text-right">Scheduled</Th>
                <Th className="text-right">Worked</Th>
                <Th className="text-right">Overtime</Th>
                <Th className="text-right">Breaks</Th>
                <Th>Needs attention</Th>
                <Th>Signed off</Th>
                <Th>Manager</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.staffId}|${r.shopId}`}>
                  <Td>
                    <Link href={`/admin/timesheets/${r.staffId}?period=${period.start}`} className="underline">
                      {r.label}
                    </Link>
                  </Td>
                  <Td>{r.shop}</Td>
                  <Td className="text-right tabular-nums">{fromMin(r.scheduledMin)}</Td>
                  <Td className="text-right tabular-nums">{hours(r.workedCenti)}</Td>
                  <Td className="text-right tabular-nums">{r.otCenti ? hours(r.otCenti) : "–"}</Td>
                  <Td className="text-right tabular-nums">{fromMin(r.breakMin)}</Td>
                  <Td>
                    {r.problems > 0 && <Badge tone="red">{r.problems} missed punch{r.problems === 1 ? "" : "es"}</Badge>} {r.flags > 0 && <Badge tone="amber">{r.flags} flag{r.flags === 1 ? "" : "s"}</Badge>}
                  </Td>
                  <Td>{r.employeeApprovedAt ? <Badge tone="green">Yes</Badge> : <span className="text-xs text-zinc-400">Not yet</span>}</Td>
                  <Td>{r.managerApprovedAt ? <Badge tone="green">Approved</Badge> : <span className="text-xs text-zinc-400">Waiting</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="px-4 py-6">
            <Empty title="No time or schedules in this period" />
          </div>
        )}
      </Card>

      {canApprove && (
        <Card>
          <CardHeader title="Lock the period" subtitle="Once every timesheet with hours is approved by a manager. A locked period takes no punches or edits; payroll locks it for good." />
          <div className="divide-y divide-zinc-100">
            {shopsShown.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
                <span>
                  {s.name}
                  {locks[s.id] && <span className="ml-2 text-xs text-zinc-500">Locked {formatDateTime(locks[s.id])}</span>}
                </span>
                {(ended || locks[s.id]) && <LockPeriod shopId={s.id} periodStart={period.start} locked={!!locks[s.id]} canUnlock={canUnlock} />}
              </div>
            ))}
          </div>
        </Card>
      )}

      {can(ctx, "payroll.export") && (
        <Card>
          <CardHeader
            title="Payroll export"
            subtitle={`Per person and shop: regular and overtime hours, break time, card and cash tips, service and product sales. ${Object.keys(locks).length === shopsShown.length && shopsShown.length ? "" : "Some shops aren't locked yet, so the file is marked DRAFT. "}Every download is logged. Nothing is sent to iSolved; you upload the file yourself.`}
          />
          <div className="flex flex-wrap gap-3 px-4 py-3 text-sm">
            <a href={exportHref("isolved")} className="rounded-md bg-ink-900 px-3 py-1.5 text-white">
              iSolved import (CSV)
            </a>
            <a href={exportHref("generic")} className="rounded-md px-3 py-1.5 ring-1 ring-zinc-300">
              All fields (CSV)
            </a>
            {can(ctx, "payroll.run") && (
              <Link href="/admin/time-clock#export" className="self-center text-xs underline">
                Change the iSolved columns
              </Link>
            )}
          </div>
        </Card>
      )}

      {ft && (
        <Card>
          <CardHeader
            title="Full time and part time"
            subtitle={`Average weekly hours over the last ${ft.window} full weeks (through ${formatDate(addDays(ft.lastWeek, 6), "MMM d")}). Over ${ft.threshold} h a week is full time; at or under is part time.`}
            action={
              <span className="flex gap-1 text-xs">
                {WINDOWS.map((w) => (
                  <Link key={w} href={q({ window: String(w) })} className={cx("rounded-full px-2 py-0.5 ring-1", w === window ? "bg-zinc-800 text-white ring-zinc-800" : "ring-zinc-300")}>
                    {w} wk
                  </Link>
                ))}
              </span>
            }
          />
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th className="text-right">Average h/week</Th>
                <Th>Status</Th>
                <Th className="text-right">Last week</Th>
              </tr>
            </thead>
            <tbody>
              {[...ft.rows]
                .sort((a, b) => b.average - a.average)
                .map((r) => (
                  <tr key={r.staffId}>
                    <Td>{label.get(r.staffId)}</Td>
                    <Td className="text-right tabular-nums">{formatPayHours(r.average)}</Td>
                    <Td>
                      <Badge tone={r.status === "full_time" ? "blue" : "gray"}>{FT_LABEL[r.status]}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">{r.weeks.length ? formatPayHours(r.weeks[r.weeks.length - 1].hours) : ""}</Td>
                  </tr>
                ))}
            </tbody>
          </Table>
          {changes.length > 0 && (
            <div className="border-t border-zinc-100 px-4 py-3 text-sm">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Recent changes</div>
              {changes.map((c) => (
                <div key={c.id}>
                  {label.get(c.staffId)}: {FT_LABEL[c.fromStatus]} to {FT_LABEL[c.toStatus]} for the week of {formatDate(c.weekStart, "MMM d")} ({formatPayHours(Number(c.averageHours), { unit: true })} over {c.windowWeeks} weeks)
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
