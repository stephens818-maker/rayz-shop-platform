import type { ReactNode } from "react";
import { Card, cx } from "@/components/ui";
import { pctLabel, ratesOf, type Funnel, type Lift, type MetricKey } from "@/domain/campaign-metrics";
import { formatCents } from "@/lib/money";

type Definitions = Record<MetricKey, { label: string; definition: string }>;

/** A measure's name with its definition on hover and focus. */
export function MetricLabel({ k, defs, children }: { k: MetricKey; defs: Definitions; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1" title={defs[k].definition}>
      {children ?? defs[k].label}
      <span tabIndex={0} role="img" aria-label={`${defs[k].label}: ${defs[k].definition}`} className="grid h-3.5 w-3.5 cursor-help place-items-center rounded-full bg-zinc-200 text-[9px] font-bold text-zinc-600">
        i
      </span>
    </span>
  );
}

function Tile({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold text-zinc-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </Card>
  );
}

/** The four headline numbers: attributed sales, open rate, click rate and booking rate, each with its denominator. */
export function KpiTiles({ funnel: f, defs, caption }: { funnel: Funnel; defs: Definitions; caption?: string }) {
  const r = ratesOf(f);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="kpi-tiles">
      <Tile label={<MetricLabel k="attributedSales" defs={defs} />} value={formatCents(f.revenueCents)} hint={caption ?? `${f.bookings} booking${f.bookings === 1 ? "" : "s"} credited`} />
      <Tile label={<MetricLabel k="openRate" defs={defs} />} value={pctLabel(r.openRate)} hint={`${f.uniqueOpens} of ${f.emailDelivered} emails delivered`} />
      <Tile label={<MetricLabel k="clickRate" defs={defs} />} value={pctLabel(r.clickRate)} hint={`${f.uniqueClicks} of ${f.delivered} delivered`} />
      <Tile label={<MetricLabel k="bookingRate" defs={defs} />} value={pctLabel(r.bookingRate)} hint={`${f.bookers} of ${f.delivered} delivered`} />
    </div>
  );
}

export function Shimmer({ className }: { className?: string }) {
  return <span aria-hidden className={cx("block animate-pulse rounded bg-zinc-200/80", className)} />;
}

/** While the numbers load: grey bars, never a zero that changes a moment later. */
export function KpiSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy="true" aria-label="Loading results">
      {Array.from({ length: n }, (_, i) => (
        <Card key={i} className="space-y-2 p-4">
          <Shimmer className="h-3 w-24" />
          <Shimmer className="h-7 w-20" />
          <Shimmer className="h-3 w-32" />
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `2fr repeat(${cols - 1}, 1fr)` }}>
          {Array.from({ length: cols }, (_, c) => (
            <Shimmer key={c} className="h-4" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** "+4.2 points (about 12 extra bookings)" against the holdout group. */
export function liftLabel(l: Lift): string {
  if (l.points === null) return "—";
  const pts = (l.points * 100).toFixed(1);
  return `${l.points >= 0 ? "+" : ""}${pts} pts${l.incremental !== null ? ` (about ${l.incremental} ${Math.abs(l.incremental) === 1 ? "booking" : "bookings"})` : ""}`;
}
