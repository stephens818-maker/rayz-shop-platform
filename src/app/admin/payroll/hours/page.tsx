import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { Card, CardHeader, PageHeader, cx } from "@/components/ui";
import { db } from "@/db";
import { payrollRuns, payGroups, shops, staff, timeEntries } from "@/db/schema";
import { endOfLocalDay, formatDate, formatDateTime, startOfLocalDay } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { periodChoices } from "@/server/payroll/run";
import { AddEntry, DeleteEntry, ImportCsv } from "./client";

export const metadata: Metadata = { title: "Payroll hours" };

const KIND = { worked: "Worked", training: "Training", pto: "PTO" } as const;

export default async function PayrollHoursPage({ searchParams }: { searchParams: Promise<{ period?: string; shop?: string }> }) {
  const sp = await searchParams;
  await guardPage("/admin/payroll/hours");
  const choices = await periodChoices();
  const current = choices.findIndex((c) => c.current);
  const chosen = choices.find((c) => c.key === sp.period) ?? choices[Math.max(0, current)];
  const shopList = await db.select({ id: shops.id, name: shops.name }).from(shops).where(eq(shops.active, true)).orderBy(shops.name);
  const shopId = shopList.find((s) => s.id === sp.shop)?.id ?? null;
  const people = await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(and(eq(staff.kind, "person"), eq(staff.active, true))).orderBy(staff.displayLabel);
  const rows = chosen
    ? await db
        .select({ e: timeEntries, who: staff.displayLabel, shop: shops.name })
        .from(timeEntries)
        .innerJoin(staff, eq(staff.id, timeEntries.staffId))
        .innerJoin(shops, eq(shops.id, timeEntries.shopId))
        .where(and(lt(timeEntries.startsAt, endOfLocalDay(chosen.end)), gt(timeEntries.endsAt, startOfLocalDay(chosen.start)), shopId ? eq(timeEntries.shopId, shopId) : undefined))
        .orderBy(asc(timeEntries.startsAt), asc(staff.displayLabel))
        .limit(2000)
    : [];
  const locked = chosen
    ? new Set(
        (
          await db
            .select({ shopId: payGroups.shopId })
            .from(payrollRuns)
            .innerJoin(payGroups, eq(payGroups.id, payrollRuns.payGroupId))
            .where(and(eq(payrollRuns.periodStart, chosen.start), eq(payrollRuns.periodEnd, chosen.end)))
        ).map((r) => r.shopId),
      )
    : new Set<string>();
  const total = rows.reduce((a, r) => a + (r.e.endsAt.getTime() - r.e.startsAt.getTime()) / 3600_000, 0);
  const q = (o: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ period: chosen?.key ?? null, shop: shopId, ...o })) if (v) p.set(k, v);
    return `/admin/payroll/hours?${p}`;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Payroll hours"
        subtitle="Clocked, imported and hand-entered time by shop. Payroll and cross-shop overtime are worked out from these; locked pay periods can't change."
      />
      <div className="flex flex-wrap gap-1.5">
        {choices.slice(0, 8).map((c) => (
          <Link key={c.key} href={q({ period: c.key })} className={cx("rounded-full px-3 py-1 text-sm ring-1", c.key === chosen?.key ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}>
            {formatDate(c.start, "MMM d")} – {formatDate(c.end, "MMM d")}
            {c.current && " · current"}
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 text-sm">
        <Link href={q({ shop: null })} className={cx("rounded-full px-3 py-1 ring-1", !shopId ? "bg-zinc-800 text-white ring-zinc-800" : "bg-white ring-zinc-300")}>
          All shops
        </Link>
        {shopList.map((s) => (
          <Link key={s.id} href={q({ shop: s.id })} className={cx("rounded-full px-3 py-1 ring-1", shopId === s.id ? "bg-zinc-800 text-white ring-zinc-800" : "bg-white ring-zinc-300")}>
            {s.name}
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader title="Add time" />
        <div className="px-4 py-3">
          <AddEntry staff={people} shops={shopList} defaultDate={chosen?.start ?? ""} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Import shifts (CSV)" subtitle="From Squire or a time clock." />
        <div className="px-4 py-3">
          <ImportCsv />
        </div>
      </Card>
      <Card>
        <CardHeader title={`${rows.length} entries · ${total.toFixed(2)} hours`} subtitle={chosen ? `${formatDate(chosen.start, "MMM d")} – ${formatDate(chosen.end, "MMM d, yyyy")}` : undefined} />
        <div className="max-h-[640px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-50 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">Barber</th>
                <th className="px-3 py-2">Shop</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Start</th>
                <th className="px-3 py-2">End</th>
                <th className="px-3 py-2 text-right">Hours</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Note</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ e, who, shop }) => (
                <tr key={e.id} className="border-t border-zinc-100">
                  <td className="px-3 py-1.5">{who}</td>
                  <td className="px-3 py-1.5">{shop}</td>
                  <td className="px-3 py-1.5">{KIND[e.kind]}</td>
                  <td className="px-3 py-1.5 tabular-nums">{formatDateTime(e.startsAt)}</td>
                  <td className="px-3 py-1.5 tabular-nums">{formatDateTime(e.endsAt)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{((e.endsAt.getTime() - e.startsAt.getTime()) / 3600_000).toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-xs text-zinc-500">{e.source}</td>
                  <td className="px-3 py-1.5 text-xs text-zinc-500">{e.note}</td>
                  <td className="px-3 py-1.5">{locked.has(e.shopId) ? <span className="text-xs text-zinc-400">locked</span> : <DeleteEntry id={e.id} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
