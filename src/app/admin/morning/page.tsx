import type { Metadata } from "next";
import Link from "next/link";
import { Empty, Input, PageHeader, Select, buttonClass } from "@/components/ui";
import { morningDoc } from "@/domain/morning-render";
import { reportExport } from "@/domain/permissions";
import { addDays, formatDate, isValidLocalDate, todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { morningDashboardFor, morningShops } from "@/server/morning-dashboard";
import { MorningDocView } from "./doc-view";

export const metadata: Metadata = { title: "Morning Dashboard" };

type Params = { date?: string; shop?: string | string[] };

/** `shop` is one id, several (repeated or comma-separated), or "all"; only shops they may see it for count. */
function pickShops(eligible: string[], requested: string | string[] | undefined, current: string | null) {
  const ids = [requested ?? []].flat().flatMap((s) => s.split(",")).filter(Boolean);
  if (ids.includes("all")) return eligible;
  const picked = eligible.filter((id) => ids.includes(id));
  if (picked.length) return picked;
  return current && eligible.includes(current) ? [current] : eligible;
}

export default async function MorningPage({ searchParams }: { searchParams: Promise<Params> }) {
  const ctx = await guardPage("/admin/morning");
  const sp = await searchParams;
  const today = todayLocal();
  const date = sp.date && isValidLocalDate(sp.date) && sp.date <= today ? sp.date : today;
  const eligible = morningShops(ctx.access).filter((id) => ctx.shopIds.includes(id));
  const shopIds = pickShops(eligible, sp.shop, ctx.currentShopId);
  const d = shopIds.length ? await morningDashboardFor(ctx.access, ctx.staff.firstName, shopIds, date) : null;
  if (!d) {
    return (
      <div className="mx-auto max-w-5xl">
        <PageHeader title="Morning Dashboard" />
        <Empty title="No shops to show">You can&apos;t see the Morning Dashboard for any open shop.</Empty>
      </div>
    );
  }
  const doc = morningDoc({ ...d, baseUrl: "" });
  const all = shopIds.length === eligible.length && eligible.length > 1;
  const q = (o: { date?: string }) => {
    const p = new URLSearchParams({ date: o.date ?? date });
    if (all) p.set("shop", "all");
    else for (const id of shopIds) p.append("shop", id);
    return p.toString();
  };
  const shopValue = all ? "all" : shopIds.length === 1 ? shopIds[0] : shopIds.join(",");
  const names = new Map(ctx.access.shops.map((s) => [s.id, s.name]));
  const csv = new URLSearchParams({ type: "morning_dashboard", table: "metrics", from: addDays(date, -1), to: addDays(date, -1) });
  for (const id of shopIds) csv.append("shop", id);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title={doc.title}
        subtitle={`${doc.dateLabel} · ${doc.versionLabel}. ${doc.coverage}`}
        actions={
          can(ctx, reportExport("morning_dashboard")) ? (
            <div className="flex gap-2">
              <a className={buttonClass("secondary", "sm")} href={`/admin/morning/pdf?${q({})}`}>
                PDF
              </a>
              <a className={buttonClass("secondary", "sm")} href={`/admin/reports/export?${csv}`}>
                CSV
              </a>
            </div>
          ) : null
        }
      />
      <form className="flex flex-wrap items-end gap-3 text-sm" action="/admin/morning">
        {eligible.length > 1 && (
          <label>
            <span className="block text-xs text-zinc-500">Locations</span>
            <Select name="shop" defaultValue={shopValue} className="w-auto">
              <option value="all">All my locations</option>
              {eligible.map((id) => (
                <option key={id} value={id}>
                  {names.get(id)}
                </option>
              ))}
              {!all && shopIds.length > 1 && <option value={shopValue}>{doc.versionLabel}</option>}
            </Select>
          </label>
        )}
        <label>
          <span className="block text-xs text-zinc-500">Morning of</span>
          <Input type="date" name="date" defaultValue={date} max={today} className="w-auto" />
        </label>
        <button className={buttonClass("secondary", "md")}>Show</button>
        <span className="flex gap-3 pb-2 text-xs">
          <Link className="text-zinc-600 hover:underline" href={`/admin/morning?${q({ date: addDays(date, -1) })}`}>
            ‹ {formatDate(addDays(date, -1), "EEE MMM d")}
          </Link>
          {date < today && (
            <Link className="text-zinc-600 hover:underline" href={`/admin/morning?${q({ date: addDays(date, 1) })}`}>
              {formatDate(addDays(date, 1), "EEE MMM d")} ›
            </Link>
          )}
        </span>
      </form>
      <MorningDocView doc={doc} />
      {can(ctx, "settings.lists") && (
        <p className="text-xs text-zinc-500">
          Who gets this by email, when, and which sections:{" "}
          <Link href="/admin/digest" className="underline">
            Setup › Morning Dashboard email
          </Link>
          .
        </p>
      )}
    </div>
  );
}
