import type { Metadata } from "next";
import Link from "next/link";
import { Card, Empty, PageHeader, cx } from "@/components/ui";
import { formatTimeOfDay } from "@/lib/time-parse";
import { addDays, formatDate, isValidLocalDate, localMinutesOf, todayLocal } from "@/lib/time";
import { guardPage, reasonViewer } from "@/server/auth/staff";
import { BoardAppt, loadBrandBoard } from "@/server/brand-board";
import { LiveRefresh } from "./refresh";

export const metadata: Metadata = { title: "All-shops day board" };

const STATUS: Record<string, { label: string; cls: string }> = {
  booked: { label: "Booked", cls: "bg-sky-100 text-sky-900 ring-sky-300" },
  confirmed: { label: "Confirmed", cls: "bg-sky-100 text-sky-900 ring-sky-300" },
  checked_in: { label: "Here", cls: "bg-amber-100 text-amber-900 ring-amber-400" },
  in_service: { label: "In the chair", cls: "bg-violet-100 text-violet-900 ring-violet-400" },
  completed: { label: "Done", cls: "bg-emerald-100 text-emerald-900 ring-emerald-300" },
  no_show: { label: "No-show", cls: "bg-red-50 text-red-700 ring-red-300 line-through" },
};

const hourLabel = (m: number) => formatTimeOfDay(m).replace(":00", "").replace(" AM", "a").replace(" PM", "p");

export default async function BoardPage({ searchParams }: { searchParams: Promise<{ date?: string; shops?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/calendar/board");
  const today = todayLocal();
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : today;
  const mine = ctx.shops.filter((s) => s.status !== "archived");
  const picked = sp.shops ? sp.shops.split(",").filter((id) => mine.some((s) => s.id === id)) : [];
  const shopIds = picked.length ? picked : mine.map((s) => s.id);
  const board = await loadBrandBoard(shopIds, date, reasonViewer(ctx));
  const span = board.rangeEnd - board.rangeStart;
  const pos = (m: number) => `${((Math.max(board.rangeStart, Math.min(board.rangeEnd, m)) - board.rangeStart) / span) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, Math.min(board.rangeEnd, b) - Math.max(board.rangeStart, a)) / span) * 100}%`;
  const hours = Array.from({ length: span / 60 + 1 }, (_, i) => board.rangeStart + i * 60);
  const nowMin = date === today ? localMinutesOf(new Date()) : null;
  const q = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const v = { date: date === today ? null : date, shops: picked.length ? picked.join(",") : null, ...extra };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    const s = p.toString();
    return `/admin/calendar/board${s ? `?${s}` : ""}`;
  };
  const toggle = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    return q({ shops: next.length && next.length < mine.length ? next.join(",") : null });
  };
  const totals = board.shops.reduce((a, s) => ({ booked: a.booked + s.counts.booked, here: a.here + s.counts.checkedIn, done: a.done + s.counts.done, working: a.working + s.counts.working }), { booked: 0, here: 0, done: 0, working: 0 });
  const chip = (on: boolean) => cx("rounded-full px-3 py-1 text-sm ring-1", on ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50");
  const apptHref = (shopId: string, a: BoardAppt) => `/admin/calendar?shop=${shopId}&date=${date}&appt=${a.id}`;

  return (
    <div className="space-y-4">
      {nowMin !== null && <LiveRefresh />}
      <PageHeader
        title="All-shops day board"
        subtitle={`${formatDate(date, "EEEE, MMMM d")} · ${totals.booked} booked · ${totals.here} here now · ${totals.done} done · ${totals.working} barbers working${nowMin !== null ? " · updates every minute" : ""}`}
        actions={
          <div className="flex gap-1.5">
            <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={q({ date: addDays(date, -1) })}>
              ‹ Prev
            </Link>
            {date !== today && (
              <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={q({ date: null })}>
                Today
              </Link>
            )}
            <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={q({ date: addDays(date, 1) })}>
              Next ›
            </Link>
          </div>
        }
      />
      {mine.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Shops">
          <Link href={q({ shops: null })} className={chip(!picked.length)}>
            Shop (all)
          </Link>
          {mine.map((s) => (
            <Link key={s.id} href={toggle(s.id)} className={chip(picked.includes(s.id))}>
              {s.name}
            </Link>
          ))}
        </div>
      )}
      {!board.shops.length && <Empty title="No shops to show" />}
      {board.shops.map((shop) => (
        <Card key={shop.id} data-testid="board-shop">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-100 px-4 py-2.5">
            <div>
              <Link href={`/admin/calendar?shop=${shop.id}&date=${date}`} className="font-semibold hover:underline">
                {shop.name}
              </Link>
              <span className="ml-2 text-xs text-zinc-500">{shop.closed ?? (shop.openMin !== null ? `${formatTimeOfDay(shop.openMin)} – ${formatTimeOfDay(shop.closeMin!)}` : "")}</span>
            </div>
            <div className="flex gap-3 text-xs text-zinc-600">
              <span>{shop.counts.booked} booked</span>
              <span>{shop.counts.checkedIn} here</span>
              <span>{shop.counts.done} done</span>
              {shop.counts.noShow > 0 && <span className="text-red-600">{shop.counts.noShow} no-show</span>}
              <span>{shop.counts.working} working</span>
            </div>
          </div>
          {shop.lanes.length === 0 ? (
            <p className="px-4 py-4 text-sm text-zinc-500">{shop.closed ? "Closed today." : "Nobody scheduled."}</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[760px] px-4 pb-3 pt-1">
                <div className="relative ml-36 h-5 text-[10px] text-zinc-400">
                  {hours.map((h) => (
                    <span key={h} className="absolute -translate-x-1/2" style={{ left: pos(h) }}>
                      {hourLabel(h)}
                    </span>
                  ))}
                </div>
                {shop.lanes.map((l) => (
                  <div key={l.staffId} className="flex items-stretch border-t border-zinc-100">
                    <div className="w-36 shrink-0 py-1.5 pr-2 text-sm">
                      <div className="flex items-center gap-1.5 truncate font-medium">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: l.color ?? "#a1a1aa" }} />
                        {l.label}
                      </div>
                      {l.spans.some((s) => s.dayOn) && <div className="text-[11px] text-emerald-700">Day on</div>}
                      {l.elsewhere.length > 0 && <div className="truncate text-[11px] text-zinc-400">Also {l.elsewhere.join(", ")}</div>}
                    </div>
                    <div className="relative h-11 flex-1 bg-zinc-50/60">
                      {hours.map((h) => (
                        <div key={h} className="absolute inset-y-0 border-l border-zinc-200/70" style={{ left: pos(h) }} />
                      ))}
                      {l.spans.map((s, i) => (
                        <div key={i} className={cx("absolute inset-y-0", s.dayOn ? "bg-emerald-100/70" : "bg-white")} style={{ left: pos(s.startMin), width: width(s.startMin, s.endMin) }} title={s.dayOn ? "Day on" : "Working"} />
                      ))}
                      {l.blocks.map((b, i) => (
                        <div
                          key={i}
                          className="absolute inset-y-1 overflow-hidden rounded bg-zinc-200 px-1 text-[10px] leading-9 text-zinc-600 [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,.5)_4px,rgba(255,255,255,.5)_8px)]"
                          style={{ left: pos(b.startMin), width: width(b.startMin, b.endMin) }}
                          title={`${b.label} ${formatTimeOfDay(b.startMin)} – ${formatTimeOfDay(b.endMin)}`}
                        >
                          {b.label}
                        </div>
                      ))}
                      {l.appts.map((a) => {
                        const st = STATUS[a.status] ?? STATUS.booked;
                        return (
                          <Link
                            key={a.id}
                            href={apptHref(shop.id, a)}
                            className={cx("absolute inset-y-1 overflow-hidden rounded px-1.5 py-0.5 text-[11px] leading-tight ring-1 hover:z-10 hover:shadow", st.cls)}
                            style={{ left: pos(a.startMin), width: width(a.startMin, a.endMin) }}
                            title={`${a.client} · ${formatTimeOfDay(a.startMin)} – ${formatTimeOfDay(a.endMin)} · ${st.label}`}
                          >
                            <div className="truncate font-medium">{a.client}</div>
                            <div className="truncate opacity-75">
                              {formatTimeOfDay(a.startMin)} · {st.label}
                            </div>
                          </Link>
                        );
                      })}
                      {nowMin !== null && nowMin >= board.rangeStart && nowMin <= board.rangeEnd && <div className="absolute inset-y-0 z-20 w-px bg-red-500" style={{ left: pos(nowMin) }} />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      ))}
      <p className="text-xs text-zinc-500">Read-only. Click an appointment or a shop to open its calendar, where appointments are booked and moved.</p>
    </div>
  );
}
