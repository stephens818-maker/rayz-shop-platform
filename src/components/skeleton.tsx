import { cx } from "./ui";

/** A grey placeholder shaped like what's loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("skeleton", className ?? "h-4 w-full")} />;
}

/** Wraps a loading placeholder so screen readers hear one "Loading" instead of empty boxes. */
export function LoadingRegion({ label = "Loading", children, className }: { label?: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className} data-testid="page-loading">
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  );
}

export function PageHeaderSkeleton({ actions = 1 }: { actions?: number }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-[70vw]" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: actions }, (_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function StatsSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-7 w-24" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 8, cols = 5, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={cx("overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200", className)}>
      <div className="border-b border-zinc-100 px-4 py-3">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="divide-y divide-zinc-100">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="grid gap-4 px-4 py-3" style={{ gridTemplateColumns: `2fr repeat(${cols - 1}, 1fr)` }}>
            {Array.from({ length: cols }, (_, c) => (
              <Skeleton key={c} className={cx("h-4", c === 0 ? "w-3/4" : "ml-auto w-1/2")} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div className="mt-4 rounded-xl bg-white p-4 ring-1 ring-zinc-200">
      <Skeleton className="h-4 w-48" />
      <div className="mt-4 flex h-40 items-end gap-2">
        {[40, 65, 50, 80, 55, 90, 70, 45, 60, 75, 50, 85].map((h, i) => (
          <div key={i} aria-hidden className="skeleton flex-1 rounded-b-none" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}
