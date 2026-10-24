import { BadgeGlyph } from "@/components/badge-icons";
import { cx } from "@/components/ui";
import type { BadgeTone, ShownBadge } from "@/domain/badges";

const TONE: Record<BadgeTone, string> = {
  gray: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  orange: "bg-orange-50 text-orange-800 ring-orange-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};

/** One badge: its icon and name, with why the client has it as the tooltip. */
export function ClientBadge({ badge, iconOnly, strong }: { badge: Pick<ShownBadge, "key" | "label" | "icon" | "tone" | "tip">; iconOnly?: boolean; strong?: boolean }) {
  return (
    <span
      title={`${badge.label}: ${badge.tip}`}
      aria-label={`${badge.label}: ${badge.tip}`}
      data-badge={badge.key}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-medium ring-1 ring-inset",
        iconOnly ? "p-0.5" : "px-1.5 py-px text-[11px]",
        TONE[badge.tone],
        strong && "ring-2 font-semibold",
      )}
    >
      <BadgeGlyph icon={badge.icon} className={iconOnly ? "size-3" : "size-3 shrink-0"} />
      {!iconOnly && <span className="truncate">{badge.label}</span>}
    </span>
  );
}

/**
 * A client's badges. `max` keeps a row tidy, with "+N" (its tooltip lists the rest); `only`
 * narrows to a set of keys, e.g. the ones a barber acts on today.
 */
export function ClientBadges({
  badges,
  max,
  iconOnly,
  only,
  strongActions,
  className,
}: {
  badges: readonly ShownBadge[] | undefined;
  max?: number;
  iconOnly?: boolean;
  only?: readonly string[];
  strongActions?: boolean;
  className?: string;
}) {
  const list = (badges ?? []).filter((b) => !only || only.includes(b.key));
  if (!list.length) return null;
  const shown = max ? list.slice(0, max) : list;
  const rest = list.slice(shown.length);
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)} data-testid="client-badges">
      {shown.map((b) => (
        <ClientBadge key={b.key} badge={b} iconOnly={iconOnly} strong={strongActions && b.action} />
      ))}
      {rest.length > 0 && (
        <span className="text-[11px] text-zinc-500" title={rest.map((b) => `${b.label}: ${b.tip}`).join("\n")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}
