import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff, timePunches } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { FLAG_LABEL, METHOD_LABEL, PUNCH_LABEL, wallStamp, type PunchFlag, type PunchType } from "@/domain/time-clock";
import { formatDate, formatDateTime, formatTime, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { can, canAny, guardPage } from "@/server/auth/staff";
import { inTenant } from "@/server/tenant";
import { chosenPeriod, recentPeriods, timesheetView } from "@/server/time-clock";
import { declarationRules, myDeclarations } from "@/server/tips/declarations";
import { DeclarationList, DeclareCashTips } from "../../my-tips/declare";
import { AddPunch, ApproveOwn, ClearPin, EditPunch, ManagerApprove } from "../timesheets";
import { formatPayHours } from "@/lib/hours";

export const metadata: Metadata = { title: "Timesheet" };

const hours = (centi: number) => formatPayHours(centi / 100);
const fromMin = (min: number) => formatPayHours(min / 60);
const hoursH = (centi: number) => formatPayHours(centi / 100, { unit: true });
const fromMinH = (min: number) => formatPayHours(min / 60, { unit: true });
const DAY_MS = 86_400_000;

type Snap = { type: PunchType; at: string; shopId: string; voided: boolean } | null;

export default async function TimesheetPage({ params, searchParams }: { params: Promise<{ staffId: string }>; searchParams: Promise<{ period?: string }> }) {
  const ctx = await guardPage("/admin/timesheets/[staffId]");
  const { staffId } = await params;
  const sp = await searchParams;
  const own = staffId === ctx.staff.id;
  const manage = canAny(ctx, ["timesheet.edit", "timesheet.approve", "payroll.export"]);
  if (own ? !can(ctx, "timesheet.own") && !manage : !manage || !(await inTenant(ctx, "staff", staffId))) notFound();
  const today = todayLocal();
  const [periods, period] = await Promise.all([recentPeriods(today), chosenPeriod(sp.period, today)]);
  const view = await timesheetView(staffId, period.start, own ? null : ctx.shopIds);
  const canEdit = can(ctx, "timesheet.edit") && (!own || ctx.isOwner);
  const canApprove = can(ctx, "timesheet.approve") && !own;
  const canPhoto = canAny(ctx, ["timesheet.edit", "timesheet.approve"]);
  const editShopIds = canEdit ? ctx.shopIds : [];
  const [punches, shopRows, team, [who]] = await Promise.all([
    db
      .select()
      .from(timePunches)
      .where(and(eq(timePunches.staffId, staffId), gte(timePunches.at, new Date(period.startsAt.getTime() - DAY_MS)), lt(timePunches.at, new Date(period.endsAt.getTime() + DAY_MS)), own ? undefined : inArray(timePunches.shopId, [...ctx.shopIds])))
      .orderBy(asc(timePunches.at)),
    db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(asc(shops.name)),
    workShopIds(staffId),
    db.select({ pin: staff.clockPinHash }).from(staff).where(eq(staff.id, staffId)),
  ]);
  const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
  const [tipRules, mine] = await Promise.all([declarationRules(), myDeclarations(staffId, period.start, today)]);
  const decls = mine.declarations.filter((d) => d.businessDate <= period.end && (own || ctx.shopIds.includes(d.shopId)));
  const inSheet = new Set(view.punchIds);
  const pickShops = shopRows.filter((s) => editShopIds.includes(s.id) && (team.includes(s.id) || view.shops.some((v) => v.shopId === s.id)));
  const snap = (s: Snap) => (s ? `${PUNCH_LABEL[s.type]} ${formatDateTime(s.at)} at ${shopName.get(s.shopId) ?? "another shop"}${s.voided ? " (void)" : ""}` : "nothing");
  const q = (start: string) => `/admin/timesheets/${staffId}?period=${start}`;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title={own ? "My timesheet" : `${view.label}'s timesheet`}
        subtitle={`${formatDate(period.start, "MMM d")} – ${formatDate(period.end, "MMM d, yyyy")}. Scheduled against actual hours, breaks and overtime, per shop.`}
        actions={
          manage ? (
            <Link href={`/admin/timesheets?period=${period.start}`} className="text-sm underline">
              All timesheets
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-1.5">
        {periods.map((p) => (
          <Link key={p.start} href={q(p.start)} className={cx("rounded-full px-3 py-1 text-sm ring-1", p.start === period.start ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}>
            {formatDate(p.start, "MMM d")} – {formatDate(p.end, "MMM d")}
          </Link>
        ))}
      </div>
      {!view.shops.length && <Empty title="No time or schedule in this period" />}
      {view.shops.map((s) => {
        const locked = !!s.locked || s.payrollLocked;
        const mine = punches.filter((p) => p.shopId === s.shopId && inSheet.has(p.id));
        const running = today >= period.start && today <= period.end;
        const dueMin = running ? s.days.filter((d) => d.date <= today).reduce((a, d) => a + d.scheduledMin, 0) : s.totals.scheduledMin;
        const diff = s.totals.workedCenti - Math.round((dueMin * 100) / 60);
        return (
          <Card key={s.shopId}>
            <CardHeader
              title={s.shop}
              subtitle={
                <>
                  {hoursH(s.totals.workedCenti)} worked ({hours(s.totals.regularCenti)} regular, {hours(s.totals.otCenti)} overtime) against {fromMinH(s.totals.scheduledMin)} scheduled{running ? `, ${fromMinH(dueMin)} of it through today` : ""} ({diff >= 0 ? "+" : ""}
                  {hours(diff)}). Breaks {fromMinH(s.totals.breakMin)}, {fromMinH(s.totals.unpaidBreakMin)} unpaid.
                  {s.totals.ptoCenti > 0 && ` PTO ${hoursH(s.totals.ptoCenti)}.`}
                  {s.totals.trainingCenti > 0 && ` Training ${hoursH(s.totals.trainingCenti)}.`}
                </>
              }
              action={locked ? <Badge tone="gray">{s.payrollLocked ? "Payroll locked" : "Locked"}</Badge> : undefined}
            />
            <div className="space-y-2 px-4 py-3 text-sm">
              {s.problems.map((p) => (
                <Notice key={p.punchId + p.kind} tone="red">
                  {p.label}: {formatDateTime(p.at)}. {own ? "Ask a manager to add the missing punch." : canEdit ? "Add or fix the punch below." : ""}
                </Notice>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  Employee:{" "}
                  {s.approval.employeeAt ? <Badge tone="green">Signed off {formatDateTime(s.approval.employeeAt)}</Badge> : <span className="text-zinc-500">not signed off</span>}
                </span>
                <span>
                  Manager:{" "}
                  {s.approval.managerAt ? (
                    <Badge tone="green">
                      Approved by {s.approval.managerBy ?? "a manager"} {formatDateTime(s.approval.managerAt)}
                    </Badge>
                  ) : (
                    <span className="text-zinc-500">not approved</span>
                  )}
                </span>
                {s.approval.note && <span className="text-xs text-zinc-500">Note: {s.approval.note}</span>}
              </div>
              {!locked && (
                <div className="flex flex-wrap gap-3">
                  {own && can(ctx, "timesheet.own") && !s.approval.employeeAt && today >= period.start && <ApproveOwn shopId={s.shopId} periodStart={period.start} />}
                  {canApprove && !s.approval.managerAt && ctx.shopIds.includes(s.shopId) && (
                    <ManagerApprove staffId={staffId} shopId={s.shopId} periodStart={period.start} employeeApproved={!!s.approval.employeeAt} />
                  )}
                </div>
              )}
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th className="text-right">Scheduled</Th>
                  <Th className="text-right">Actual</Th>
                  <Th>Shifts</Th>
                </tr>
              </thead>
              <tbody>
                {s.days
                  .filter((d) => d.scheduledMin || d.workedMin || d.otherMin || d.shifts.length)
                  .map((d) => (
                    <tr key={d.date}>
                      <Td>{formatDate(d.date)}</Td>
                      <Td className="text-right tabular-nums">{d.scheduledMin ? fromMin(d.scheduledMin) : "–"}</Td>
                      <Td className="text-right tabular-nums">
                        {fromMin(d.workedMin)}
                        {d.otherMin > 0 && <span className="block text-xs text-zinc-500">+{fromMin(d.otherMin)} PTO/training</span>}
                      </Td>
                      <Td>
                        {d.shifts.map((sh) => (
                          <div key={sh.inId} className="flex flex-wrap items-center gap-1">
                            <span className="tabular-nums">
                              {formatTime(sh.start)} – {sh.end ? formatTime(sh.end) : "still open"}
                            </span>
                            {sh.breaks.map((b) => (
                              <span key={b.startId} className="text-xs text-zinc-500">
                                break {formatTime(b.start)}–{b.end ? `${formatTime(b.end)} ${b.paid ? "(paid)" : "(unpaid)"}` : "?"}
                              </span>
                            ))}
                            {sh.flags.map((f) => (
                              <Badge key={f} tone="amber">
                                {FLAG_LABEL[f]}
                              </Badge>
                            ))}
                            {sh.edited && <Badge tone="gray">Edited</Badge>}
                            {canPhoto &&
                              sh.photos.map((id) => (
                              <a key={id} href={`/admin/timesheets/photo?id=${id}`} target="_blank" rel="noreferrer" className="text-xs underline">
                                photo
                              </a>
                            ))}
                          </div>
                        ))}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
            {s.weeks.length > 0 && (
              <div className="flex flex-wrap gap-4 border-t border-zinc-100 px-4 py-2 text-xs text-zinc-600">
                {s.weeks.map((w) => (
                  <span key={w.weekStart}>
                    Week of {formatDate(w.weekStart, "MMM d")}: {hoursH(w.workedCenti)} worked here, {hoursH(w.otCenti)} OT, {fromMinH(w.scheduledMin)} scheduled
                  </span>
                ))}
              </div>
            )}
            <details className="border-t border-zinc-100" open={canEdit && s.problems.length > 0}>
              <summary className="cursor-pointer px-4 py-2 text-sm font-medium">Punches ({mine.length})</summary>
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Punch</Th>
                    <Th>How</Th>
                    <Th>Where</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {mine.map((p) => (
                    <tr key={p.id} className={p.voidedAt ? "text-zinc-400 line-through" : undefined}>
                      <Td className="tabular-nums">{formatDateTime(p.at)}</Td>
                      <Td>
                        {PUNCH_LABEL[p.type]}
                        {(p.flags as PunchFlag[])
                          .filter((f) => f in FLAG_LABEL)
                          .map((f) => (
                            <Badge key={f} tone="amber" className="ml-1">
                              {FLAG_LABEL[f]}
                            </Badge>
                          ))}
                      </Td>
                      <Td className="text-xs">
                        {METHOD_LABEL[p.method]}
                        {p.source === "kiosk" && " (front desk)"}
                      </Td>
                      <Td className="text-xs text-zinc-500">
                        {p.distanceM !== null && `${p.distanceM} m from the shop`}
                        {p.hasPhoto && canPhoto && (
                          <a href={`/admin/timesheets/photo?id=${p.id}`} target="_blank" rel="noreferrer" className="ml-1 underline">
                            photo
                          </a>
                        )}
                      </Td>
                      <Td>{canEdit && !locked && !p.voidedAt && <EditPunch punch={{ id: p.id, type: p.type, shopId: p.shopId, when: wallStamp(p.at) }} shops={pickShops} />}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {canEdit && !locked && <AddPunch staffId={staffId} shops={pickShops.filter((x) => x.id === s.shopId)} defaultLocal={`${period.start}T09:00`} />}
            </details>
          </Card>
        );
      })}
      {canEdit && !own && pickShops.length > 0 && view.shops.length === 0 && (
        <Card>
          <CardHeader title="Add a punch" />
          <AddPunch staffId={staffId} shops={pickShops} defaultLocal={`${period.start}T09:00`} />
        </Card>
      )}
      {view.edits.length > 0 && (
        <Card>
          <CardHeader title="Edit history" subtitle="Every change to a punch, with who made it and why. This log can't be changed." />
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>By</Th>
                <Th>Change</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {view.edits.map((e, i) => (
                <tr key={i}>
                  <Td className="tabular-nums">{formatDateTime(e.at)}</Td>
                  <Td>{e.by ?? "Someone"}</Td>
                  <Td className="text-xs">
                    {e.action === "add" ? "Added " : e.action === "void" ? "Voided " : "Changed "}
                    {e.action === "add" ? snap(e.after as Snap) : `${snap(e.before as Snap)}${e.action === "edit" ? ` to ${snap(e.after as Snap)}` : ""}`}
                  </Td>
                  <Td className="text-xs">{e.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {tipRules.enabled && (decls.length > 0 || (canEdit && !own && pickShops.length > 0)) && (
        <Card>
          <CardHeader
            title="Cash tips declared"
            subtitle={own ? "Declare or correct them on My tips." : "Each declaration and correction is kept. A manager's entry needs a reason; none can go into a locked pay period."}
          />
          {canEdit && !own && pickShops.length > 0 && (
            <div className="px-4 py-3">
              <DeclareCashTips shops={pickShops} today={today < period.end ? today : period.end} attestation={tipRules.attestation} staffId={staffId} />
            </div>
          )}
          {decls.length > 0 && <DeclarationList rows={decls} shops={pickShops} today={today} attestation={tipRules.attestation} staffId={canEdit && !own ? staffId : undefined} />}
        </Card>
      )}
      {canEdit && !own && who?.pin && pickShops[0] && (
        <div className="text-right">
          <ClearPin staffId={staffId} shopId={pickShops[0].id} />
        </div>
      )}
    </div>
  );
}
