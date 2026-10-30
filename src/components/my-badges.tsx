"use client";

import { useEffect, useState } from "react";
import { BadgeGlyph } from "@/components/badge-icons";
import type { BadgeIcon } from "@/domain/badges";
import type { CustomerBadges } from "@/domain/customer-badges";
import { api, fmtDay, getTokens } from "@/lib/api-client";

/** The signed-in customer's badges and progress meters. Nothing when signed out or there's nothing to show. */
export function MyBadges({ compact }: { compact?: boolean }) {
  const [data, setData] = useState<CustomerBadges | null>(null);
  useEffect(() => {
    if (!getTokens()) return;
    api<CustomerBadges>("/account/badges", { base: "/api" })
      .then(setData)
      .catch(() => setData(null));
  }, []);
  if (!data || (!data.badges.length && !data.progress.length)) return null;

  if (compact) {
    const badges = data.badges.filter((b) => b.id !== "miss_you");
    if (!badges.length && !data.progress.length) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-zinc-200" data-testid="my-badges-strip">
        {badges.map((b) => (
          <span key={b.id} title={b.text} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ color: b.color, backgroundColor: `${b.color}14` }}>
            <BadgeGlyph icon={b.icon as BadgeIcon} className="size-3.5" />
            {b.name}
          </span>
        ))}
        {data.progress[0] && <span className="text-xs text-zinc-500">{data.progress[0].text}</span>}
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200" data-testid="my-badges">
      <div className="text-sm font-semibold">Your badges</div>
      {!!data.badges.length && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.badges.map((b) => (
            <li key={b.id} className="flex gap-3 rounded-lg p-3" style={{ backgroundColor: `${b.color}0d`, boxShadow: `inset 0 0 0 1px ${b.color}40` }}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: b.color }}>
                <BadgeGlyph icon={b.icon as BadgeIcon} className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="font-semibold" style={{ color: b.color }}>
                  {b.name}
                </div>
                <div className="text-sm text-zinc-700">{b.text}</div>
                {b.earnedOn && <div className="mt-0.5 text-xs text-zinc-500">Since {fmtDay(b.earnedOn, { month: "short", day: "numeric", year: "numeric" })}</div>}
                {b.action && (
                  <a href={b.action.url} className="mt-2 inline-block rounded-md px-3 py-1 text-sm font-semibold text-white" style={{ backgroundColor: b.color }}>
                    {b.action.label}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.progress.map((p) => (
        <div key={p.badge} data-testid={`progress-${p.badge}`}>
          <div className="flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: p.color }}>
              <BadgeGlyph icon={p.icon as BadgeIcon} className="size-4" />
              {p.text}
            </span>
            <span className="text-xs text-zinc-500">
              {p.current} of {p.target}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-100">
            <div className="h-full rounded-full" style={{ width: `${Math.round((p.current / p.target) * 100)}%`, backgroundColor: p.color }} />
          </div>
        </div>
      ))}
    </section>
  );
}
