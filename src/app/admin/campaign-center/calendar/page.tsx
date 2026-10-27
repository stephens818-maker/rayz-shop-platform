import type { Metadata } from "next";
import Link from "next/link";
import { DateTime } from "luxon";
import { Badge, Card, CardHeader, LinkButton, PageHeader, cx } from "@/components/ui";
import { CHANNEL_LABEL } from "@/domain/marketing";
import { formatClock } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { campaignCalendar, type CalendarEntry } from "@/server/marketing/calendar";
import { BLAST_STATUS } from "../blasts/status";

export const metadata: Metadata = { title: "Campaign calendar" };
export const dynamic = "force-dynamic";

const TONE: Record<CalendarEntry["state"], string> = {
  sent: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  scheduled: "bg-sky-50 text-sky-900 ring-sky-200",
  paused: "bg-amber-50 text-amber-900 ring-amber-200 line-through decoration-amber-400",
  testing: "bg-violet-50 text-violet-900 ring-violet-200",
};

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const ctx = await guardPage("/admin/campaign-center/calendar");
  const sp = await searchParams;
  const now = new Date();
  const month = sp.m && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.m) ? sp.m : DateTime.now().setZone("America/Chicago").toFormat("yyyy-MM");
  const cal = await campaignCalendar(ctx, month, now);
  const first = DateTime.fromISO(`${month}-01`, { zone: cal.timeZone });
  const gridStart = first.minus({ days: first.weekday % 7 });
  const weeks = Math.ceil((first.daysInMonth! + (first.weekday % 7)) / 7);
  const today = DateTime.fromJSDate(now).setZone(cal.timeZone).toISODate();
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of cal.entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const shift = (n: number) => first.plus({ months: n }).toFormat("yyyy-MM");
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Campaign calendar"
        subtitle={
          <>
            <Link href="/admin/campaign-center" className="underline">
              Campaign Center
            </Link>{" "}
            · Blasts that went out and every send still to come, repeats included. Automations run every day for the clients they fit, so they aren&apos;t on the calendar.
          </>
        }
        actions={can(ctx, "campaign_center.create") && <LinkButton href="/admin/campaign-center/blasts/new">New blast</LinkButton>}
      />
      <Card>
        <CardHeader
          title={first.toFormat("MMMM yyyy")}
          action={
            <div className="flex gap-2 text-sm">
              <Link className="rounded-md px-2 py-1 ring-1 ring-zinc-300 hover:bg-zinc-50" href={`?m=${shift(-1)}`} aria-label="Previous month">
                ←
              </Link>
              <Link className="rounded-md px-2 py-1 ring-1 ring-zinc-300 hover:bg-zinc-50" href="?">
                Today
              </Link>
              <Link className="rounded-md px-2 py-1 ring-1 ring-zinc-300 hover:bg-zinc-50" href={`?m=${shift(1)}`} aria-label="Next month">
                →
              </Link>
            </div>
          }
        />
        <div className="grid grid-cols-7 border-b border-zinc-100 text-center text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="py-2">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7" data-testid="calendar-grid">
          {Array.from({ length: weeks * 7 }, (_, i) => {
            const d = gridStart.plus({ days: i });
            const key = d.toISODate()!;
            const inMonth = d.month === first.month;
            const items = byDay.get(key) ?? [];
            return (
              <div key={key} className={cx("min-h-24 border-b border-r border-zinc-100 p-1.5", !inMonth && "bg-zinc-50/60 text-zinc-400")}>
                <div className={cx("mb-1 text-xs", key === today && "inline-grid h-5 w-5 place-items-center rounded-full bg-brand-600 font-semibold text-white")}>{d.day}</div>
                <div className="space-y-1">
                  {items.map((e) => (
                    <Link
                      key={`${e.campaignId}:${e.at.toISOString()}:${e.state}`}
                      href={`/admin/campaign-center/blasts/${e.campaignId}`}
                      title={`${e.name} · ${BLAST_STATUS[e.state]?.label ?? e.state} · ${formatClock(DateTime.fromJSDate(e.at).setZone(cal.timeZone))} · ${e.channels.map((c) => CHANNEL_LABEL[c]).join(", ")}${e.sent ? ` · ${e.sent} sent` : ""}`}
                      className={cx("block truncate rounded px-1.5 py-0.5 text-[11px] ring-1 ring-inset hover:underline", TONE[e.state])}
                    >
                      {e.recurring ? "↻ " : ""}
                      {formatClock(DateTime.fromJSDate(e.at).setZone(cal.timeZone))} {e.name}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-zinc-600">
          {(Object.keys(TONE) as CalendarEntry["state"][]).map((s) => (
            <span key={s} className={cx("rounded px-1.5 py-0.5 ring-1 ring-inset", TONE[s])}>
              {BLAST_STATUS[s]?.label}
            </span>
          ))}
          <span>↻ repeats</span>
        </div>
      </Card>
      {cal.drafts.length > 0 && (
        <Card>
          <CardHeader title="Drafts" subtitle="Not on the calendar until they're scheduled." />
          <div className="flex flex-wrap gap-2 p-4">
            {cal.drafts.map((d) => (
              <Link key={d.id} href={`/admin/campaign-center/blasts/${d.id}`}>
                <Badge>{d.name}</Badge>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
