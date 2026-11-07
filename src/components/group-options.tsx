"use client";

import type { z } from "zod";
import type { GroupOptionSchema, GroupOptionsSchema } from "@/domain/booking-group";
import { cx } from "@/components/ui";
import { dollars, fmtTime } from "@/lib/api-client";

export type GroupOptions = z.infer<typeof GroupOptionsSchema>;
export type GroupOption = z.infer<typeof GroupOptionSchema>;

export const optionKey = (o: GroupOption) => `${o.plan}|${o.seats.map((s) => `${s.customerId}:${s.staffId}:${s.startsAt}`).join(",")}`;

export function windowLabel(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/** The seats an option books, in the shape the booking and reschedule endpoints take. */
export const seatsOf = (o: GroupOption) => o.seats.map((s) => ({ customerId: s.customerId, staffId: s.staffId, startsAt: s.startsAt }));

/**
 * The slot finder's plans for one day: back to back with one barber, together with several, and the
 * mix that has everyone done soonest. Each option shows the whole group's window and who sits where.
 */
export function GroupOptionsPicker({
  options,
  selected,
  onPick,
  compact,
}: {
  options: GroupOptions;
  selected: string | null;
  onPick: (o: GroupOption) => void;
  compact?: boolean;
}) {
  const any = options.plans.some((p) => p.options.length);
  return (
    <div className="space-y-4" data-testid="group-options">
      {!any && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{options.plans[0]?.reason ?? "There's no room for everyone that day"}. Try another day.</p>}
      {options.plans.map((p) => (
        <div key={p.plan}>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{p.label}</div>
          {p.options.length ? (
            <div className={cx("grid gap-2", !compact && "sm:grid-cols-2")}>
              {p.options.map((o) => {
                const k = optionKey(o);
                const on = selected === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onPick(o)}
                    aria-pressed={on}
                    className={cx("rounded-lg px-3 py-2 text-left text-sm ring-1 transition", on ? "bg-brand-50 ring-2 ring-brand-600" : "bg-white ring-zinc-200 hover:ring-zinc-400")}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold tabular">
                        {fmtTime(o.startsAt)} – {fmtTime(o.endsAt)}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {windowLabel(o.minutes)} · {o.barbers === 1 ? "1 barber" : `${o.barbers} barbers`}
                      </span>
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-zinc-600">
                      {[...o.seats]
                        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
                        .map((s) => (
                          <li key={s.customerId} className="flex justify-between gap-2">
                            <span>
                              {s.firstName ?? "Guest"} with {s.barber}
                            </span>
                            <span className="tabular">{fmtTime(s.startsAt)}</span>
                          </li>
                        ))}
                    </ul>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-zinc-400">{p.reason}</p>
          )}
        </div>
      ))}
      {options.depositCents > 0 && any && (
        <p className="text-xs text-zinc-500">A {dollars(options.depositCents)} deposit holds a family booking this size. The shop takes it before the visit and it comes off the bill.</p>
      )}
    </div>
  );
}

/** Marks an appointment booked with family members as one group. */
export function GroupLinkIcon({ title, className = "h-3.5 w-3.5" }: { title: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className={cx("shrink-0", className)}
      role="img"
      aria-label={title}
      data-testid="group-link-icon"
    >
      <title>{title}</title>
      <path
        d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"
        strokeLinecap="round"
      />
    </svg>
  );
}
