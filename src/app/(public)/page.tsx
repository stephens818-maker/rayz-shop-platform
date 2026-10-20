import Link from "next/link";
import { WEEKDAYS, hhmmToMinutes, minutesToLabel, todayLocal, weekdayOf } from "@/lib/time";
import { formatPhone } from "@/lib/phone";
import { publicShops } from "@/server/public";

export const dynamic = "force-dynamic";

export default async function Home() {
  const shops = await publicShops();
  const wd = weekdayOf(todayLocal());
  return (
    <div>
      <section className="mb-6 rounded-2xl bg-ink-900 px-6 py-8 text-white sm:px-10 sm:py-12">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-500">Iowa · Illinois</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Old-school shop. Modern cuts.</h1>
        <p className="mt-3 max-w-xl text-zinc-300">Pick a shop to see open times. No payment needed to book, and you can cancel or reschedule up to 30 minutes before.</p>
      </section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">Choose a shop</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shops.map((s) => {
          const today = s.hours.find((h) => h.weekday === wd);
          const noStaff = s.barberCount === 0;
          return (
            <Link
              key={s.id}
              href={`/book/${s.slug}`}
              className="group rounded-xl bg-white p-4 ring-1 ring-zinc-200 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-zinc-300"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-zinc-900">{s.name}</div>
                  <div className="text-sm text-zinc-500">
                    {s.address}, {s.city}, {s.state}
                  </div>
                </div>
                <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">{s.state}</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className={today ? "text-emerald-700" : "text-zinc-400"}>
                  {today ? `Today ${minutesToLabel(hhmmToMinutes(today.open))} – ${minutesToLabel(hhmmToMinutes(today.close))}` : `Closed ${WEEKDAYS[wd]}`}
                </span>
                <span className="text-zinc-500">{noStaff ? "Opening soon" : `${s.barberCount} barbers`}</span>
              </div>
              {s.phone && <div className="mt-1 text-xs text-zinc-400">{formatPhone(s.phone)}</div>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
