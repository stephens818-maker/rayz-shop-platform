import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import { type MilestoneKind, recordedTitle } from "@/domain/milestones";
import { formatDate } from "@/lib/time";

export interface Trophy {
  id: string;
  kind: MilestoneKind;
  metric: string;
  threshold: number | null;
  value: number | null;
  title: string;
  achievedOn: string;
  shop: string | null;
}

const WORD: Record<MilestoneKind, string> = { count: "Milestone", anniversary: "Anniversary", birthday: "Birthday", best: "Personal best", streak: "Streak" };

const TONE: Record<MilestoneKind, string> = {
  count: "from-amber-50 to-amber-100 text-amber-900 ring-amber-200",
  anniversary: "from-sky-50 to-sky-100 text-sky-900 ring-sky-200",
  birthday: "from-pink-50 to-pink-100 text-pink-900 ring-pink-200",
  best: "from-violet-50 to-violet-100 text-violet-900 ring-violet-200",
  streak: "from-emerald-50 to-emerald-100 text-emerald-900 ring-emerald-200",
};

const PATHS: Record<MilestoneKind, ReactNode> = {
  count: <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3" />,
  anniversary: <path d="M5 5h14v15H5zM5 9h14M9 3v4M15 3v4M9.5 14.5l1.8 1.8 3.4-3.6" />,
  birthday: <path d="M4 20h16M5 20v-7h14v7M12 13V9M12 9a1.5 1.5 0 0 1-1.5-1.5C10.5 6 12 4 12 4s1.5 2 1.5 3.5A1.5 1.5 0 0 1 12 9Z" />,
  best: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  streak: <path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 0 2 1 3 2 3 0-3-1-5.5.5-8Z" />,
};

export function MilestoneGlyph({ kind, className }: { kind: MilestoneKind; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={cx("size-5", className)} aria-hidden>
      {PATHS[kind]}
    </svg>
  );
}

/** Badges for what someone has reached. Without `money` a sales record leaves the amount out. */
export function TrophyCase({ trophies, bests, money = true, empty }: { trophies: Trophy[]; bests: Trophy[]; money?: boolean; empty?: ReactNode }) {
  if (!trophies.length && !bests.length) return <p className="px-4 py-6 text-sm text-zinc-500">{empty ?? "No milestones yet. The first one is 100 cuts."}</p>;
  return (
    <div className="space-y-4 p-4" data-testid="trophy-case">
      {trophies.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {trophies.map((t) => (
            <li key={t.id} className={cx("rounded-xl bg-gradient-to-br p-3 ring-1 ring-inset", TONE[t.kind])}>
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide opacity-80">
                <MilestoneGlyph kind={t.kind} className="size-4" />
                {WORD[t.kind]}
              </div>
              <div className="mt-1.5 text-base font-semibold leading-tight">{recordedTitle(t, { money })}</div>
              <div className="mt-1 text-xs opacity-75">
                {formatDate(t.achievedOn, "MMM d, yyyy")}
                {t.shop ? ` · ${t.shop}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
      {bests.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Personal bests</h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {bests.map((b) => (
              <li key={b.id} className="flex items-center gap-3 rounded-lg bg-violet-50/60 px-3 py-2 text-sm ring-1 ring-inset ring-violet-100">
                <MilestoneGlyph kind="best" className="size-4 text-violet-600" />
                <span className="font-medium text-zinc-900">{recordedTitle(b, { money })}</span>
                <span className="ml-auto text-xs text-zinc-500">{formatDate(b.achievedOn, "MMM d, yyyy")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
