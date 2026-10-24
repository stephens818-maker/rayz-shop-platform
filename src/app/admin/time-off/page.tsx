import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops, staffShops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { ReasonDot, ReasonTag } from "@/components/reason-picker";
import { reasonText } from "@/domain/block-reasons";
import { LocalDate, WEEKDAYS, addDays, formatDate, minutesToLabel, todayLocal, weekdayOf } from "@/lib/time";
import { timeOffDecisionDenied } from "@/server/auth/policy";
import { approverOf, can, guardPage, reasonViewer, reportShopIds } from "@/server/auth/staff";
import { affectedByRequests, listRequests, rulesView, timeOffEntries } from "@/server/staff-time";
import { RequestCard, RulesEditor } from "./client";

export const metadata: Metadata = { title: "Time off" };

const monthOf = (s: string | undefined, today: LocalDate) => (s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : today.slice(0, 7));
const lastDay = (month: string) => addDays(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`, -1);
const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export default async function TimeOffPage({ searchParams }: { searchParams: Promise<{ month?: string; shop?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/time-off");
  const shopIds = reportShopIds(ctx, sp.shop);
  const today = todayLocal();
  const month = monthOf(sp.month, today);
  const from = `${month}-01`;
  const to = lastDay(month);
  const canApprove = can(ctx, "timeoff.approve");
  const now = new Date();
  const [requests, off, shopRows, rules] = await Promise.all([
    listRequests({ shopIds, brandWide: false }, { viewer: reasonViewer(ctx), since: new Date(now.getTime() - 14 * 86_400_000) }),
    timeOffEntries(shopIds, from, to, reasonViewer(ctx)),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, ctx.shopIds), ne(shops.status, "archived"))).orderBy(asc(shops.name)),
    can(ctx, "settings.shop") ? rulesView(ctx.shopIds) : Promise.resolve(null),
  ]);
  const open = requests.filter((r) => r.status === "pending" || (r.status === "approved" && new Date(r.endsAt) > now));
  const affected = await affectedByRequests(open.map((r) => ({ id: r.id, staffId: r.staffId, shopId: r.shopId, startsAt: new Date(r.startsAt), endsAt: new Date(r.endsAt) })));
  const links = open.length ? await db.select().from(staffShops).where(inArray(staffShops.staffId, [...new Set(open.map((r) => r.staffId))])) : [];
  const who = approverOf(ctx);
  const decideProblem = (r: (typeof open)[number]) =>
    timeOffDecisionDenied(
      who,
      r,
      links.filter((l) => l.staffId === r.staffId).map((l) => l.shopId),
    );
  const pending = open.filter((r) => r.status === "pending");
  const approved = open.filter((r) => r.status === "approved");
  const past = requests.filter((r) => !open.includes(r));
  const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
  const scopeLabel = shopIds.length === 1 ? (shopName.get(shopIds[0]) ?? "This shop") : `All ${shopIds.length} shops`;
  const href = (o: { month?: string; shop?: string }) => {
    const q = new URLSearchParams();
    q.set("month", o.month ?? month);
    const shop = o.shop ?? sp.shop;
    if (shop) q.set("shop", shop);
    return `/admin/time-off?${q}`;
  };

  // Month grid: weeks starting Sunday.
  const days: LocalDate[] = [];
  for (let d = addDays(from, -weekdayOf(from)); d <= to || weekdayOf(d) !== 0; d = addDays(d, 1)) days.push(d);
  const offOn = (d: LocalDate) =>
    off.entries.filter((e) => e.fromDate <= d && e.toDate >= d && (e.shopId === null ? (off.worksAt.get(e.staffId) ?? []).some((s) => shopIds.includes(s)) : shopIds.includes(e.shopId)));

  return (
    <div className="space-y-6">
      <PageHeader title="Time off" subtitle="Requests from barbers, who's off when, and the rules for lunch, blocks and time off." />

      {shopRows.length > 1 && (
        <div className="flex flex-wrap gap-2 text-sm" aria-label="Shop">
          <Link href={href({ shop: "all" })} className={cx("rounded-full px-3 py-1 ring-1", shopIds.length > 1 ? "bg-ink-900 text-white ring-ink-900" : "ring-zinc-300")}>
            All my shops
          </Link>
          {shopRows.map((s) => (
            <Link key={s.id} href={href({ shop: s.id })} className={cx("rounded-full px-3 py-1 ring-1", shopIds.length === 1 && shopIds[0] === s.id ? "bg-ink-900 text-white ring-ink-900" : "ring-zinc-300")}>
              {s.name}
            </Link>
          ))}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-base font-semibold">
          Waiting for a decision <Badge tone={pending.length ? "amber" : "gray"}>{pending.length}</Badge>
        </h2>
        {pending.length === 0 && <p className="text-sm text-zinc-500">No requests waiting.</p>}
        {pending.map((r) => (
          <RequestCard key={r.id} request={r} affected={affected.get(r.id) ?? []} canDecide={canApprove && !decideProblem(r)} why={canApprove ? decideProblem(r) : "You can see requests but not approve them"} />
        ))}
      </section>

      {approved.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Approved, coming up</h2>
          {approved.map((r) => (
            <RequestCard key={r.id} request={r} affected={affected.get(r.id) ?? []} canDecide={canApprove && !decideProblem(r)} why={decideProblem(r)} />
          ))}
        </section>
      )}

      <Card>
        <CardHeader
          title={`${formatDate(from, "MMMM yyyy")} · ${scopeLabel}`}
          subtitle="Approved time off in solid, requests waiting for a manager dashed, each in its reason's color."
          action={
            <div className="flex gap-2 text-sm">
              <Link className="rounded-md px-2 py-1 ring-1 ring-zinc-300" href={href({ month: shiftMonth(month, -1) })}>
                ← Prev
              </Link>
              <Link className="rounded-md px-2 py-1 ring-1 ring-zinc-300" href={href({ month: today.slice(0, 7) })}>
                This month
              </Link>
              <Link className="rounded-md px-2 py-1 ring-1 ring-zinc-300" href={href({ month: shiftMonth(month, 1) })}>
                Next →
              </Link>
            </div>
          }
        />
        <div className="grid grid-cols-7 border-t border-zinc-100 text-xs">
          {WEEKDAYS.map((w) => (
            <div key={w} className="border-b border-zinc-100 px-2 py-1 font-medium text-zinc-500">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const list = offOn(d);
            return (
              <div key={d} className={cx("min-h-20 border-b border-r border-zinc-100 p-1.5", d.slice(0, 7) !== month && "bg-zinc-50 text-zinc-400", d === today && "bg-brand-50")}>
                <div className="mb-1 font-medium">{Number(d.slice(8))}</div>
                <div className="space-y-0.5">
                  {list.slice(0, 4).map((e) => (
                    <div
                      key={e.key}
                      title={`${e.label}: ${reasonText(e.reason)}${e.partial ? ` ${minutesToLabel(e.partial.startMin)}–${minutesToLabel(e.partial.endMin % 1440)}` : ""}${e.status === "pending" ? " (waiting)" : ""}`}
                      className={cx("flex items-center gap-1 truncate rounded px-1 py-0.5 text-zinc-900", e.status === "pending" ? "shade-reason-pending" : "shade-reason")}
                      style={{ ["--reason" as string]: e.reason.color }}
                    >
                      <span className="truncate">
                        {e.label} · {e.reason.label}
                        {e.partial && " ½"}
                      </span>
                    </div>
                  ))}
                  {list.length > 4 && <div className="text-zinc-500">+{list.length - 4} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader title={`Who's off in ${formatDate(from, "MMMM")}`} />
        {off.entries.length === 0 ? (
          <div className="p-4">
            <Empty title="Nobody is off this month" />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Barber</Th>
                <Th>When</Th>
                <Th>Reason</Th>
                <Th>Where</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {off.entries.map((e) => (
                <tr key={e.key}>
                  <Td className="font-medium">{e.label}</Td>
                  <Td>
                    {e.fromDate === e.toDate ? formatDate(e.fromDate) : `${formatDate(e.fromDate)} – ${formatDate(e.toDate)}`}
                    {e.partial && `, ${minutesToLabel(e.partial.startMin)}–${minutesToLabel(e.partial.endMin % 1440)}`}
                  </Td>
                  <Td>
                    <ReasonTag reason={e.reason} />
                    {e.reason.note && <div className="mt-0.5 text-xs text-zinc-500">{e.reason.note}</div>}
                  </Td>
                  <Td>{e.shopId ? (shopName.get(e.shopId) ?? "Another shop") : "All their shops"}</Td>
                  <Td>{e.status === "pending" ? <Badge tone="amber">waiting</Badge> : <Badge tone="green">approved</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {past.length > 0 && (
        <Card>
          <CardHeader title="Recently decided" />
          <Table>
            <thead>
              <tr>
                <Th>Barber</Th>
                <Th>When</Th>
                <Th>Reason</Th>
                <Th>Decision</Th>
              </tr>
            </thead>
            <tbody>
              {past.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.staffLabel}</Td>
                  <Td>{r.range}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      <ReasonDot color={r.reason.color} /> {reasonText(r.reason)}
                    </span>
                  </Td>
                  <Td>
                    {r.status}
                    {r.decidedBy && ` by ${r.decidedBy}`}
                    {r.decidedVia === "auto" && " (automatic)"}
                    {r.decisionNote && <span className="text-zinc-500"> · {r.decisionNote}</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {rules && <RulesEditor brandWide={ctx.brandWide} rules={rules} />}
    </div>
  );
}
