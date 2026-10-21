import Link from "next/link";
import { Button, Notice, cx } from "@/components/ui";
import { REPORT_VIEWS, ReportView, viewOf } from "@/domain/report-views";
import { BarberPicker } from "./barber-picker";
import { LocationPicker } from "./location-picker";
import { PRESETS, ReportLocations, ReportViewState } from "./scope";

export interface LocationProps {
  shops: { id: string; name: string }[];
  locations: ReportLocations;
  allLabel: string;
}

export const locationProps = (ctx: { shops: { id: string; name: string }[]; brandWide: boolean }, locations: ReportLocations): LocationProps => ({
  shops: ctx.shops,
  locations,
  allLabel: ctx.brandWide ? "All shops" : "All my shops",
});

type QueryState = ReportLocations & Partial<ReportViewState>;

/** The `view` a link or form carries: what was asked for, when it isn't the report's default. */
const viewValue = (l: QueryState): string | null => {
  const v = l.viewParam ?? l.loc.view;
  return v === (l.defaultView ?? "combined") ? null : v;
};

/** URL query for a report page, keeping the locations, barbers and view. */
export function reportQuery(l: QueryState | null, extra: Record<string, string | null | undefined>) {
  const q = new URLSearchParams();
  if (l?.shopParam) q.set("shop", l.shopParam);
  const view = l && viewValue(l);
  if (view) q.set("view", view);
  if (l?.staffParam) q.set("staff", l.staffParam);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return q;
}

/** The same query with another view. */
export const withView = <T extends QueryState>(l: T, view: ReportView): T => ({ ...l, viewParam: view, loc: { ...l.loc, view: view === "shops" || view === "shops_barbers" ? "shops" : "combined" } });

/**
 * The views that apply: by location needs more than one shop, by barber more than one barber (and a
 * report with a barber on its rows).
 */
export function viewOptions(l: QueryState): ReportView[] {
  const shops = l.selection.shopIds.length > 1;
  const barbers = !!l.barbers?.pickable && l.barbers.selection.staffIds?.length !== 1;
  return (["combined", "shops", "barbers", "shops_barbers"] as const).filter((v) => (v !== "shops" && v !== "shops_barbers") || shops).filter((v) => (v !== "barbers" && v !== "shops_barbers") || barbers);
}

/** Combined total, side by side per location, per barber, or per barber at each location. */
export function ViewToggle({ l, href }: { l: QueryState; href: (v: ReportView) => string }) {
  const options = viewOptions(l);
  if (options.length < 2) return null;
  const current = viewOf(l.loc);
  return (
    <div role="group" aria-label="View" className="inline-flex flex-wrap rounded-full bg-white p-0.5 text-sm ring-1 ring-zinc-300">
      {options.map((v) => (
        <Link
          key={v}
          href={href(v)}
          aria-current={v === current ? "true" : undefined}
          className={cx("rounded-full px-3 py-0.5", v === current ? "bg-ink-900 text-white" : "text-zinc-600 hover:bg-zinc-50")}
        >
          {REPORT_VIEWS[v]}
        </Link>
      ))}
    </div>
  );
}

/** Keeps the view when a filter form is submitted. */
export function ViewInput({ l }: { l: QueryState }) {
  const v = viewValue(l);
  return v ? <input type="hidden" name="view" value={v} /> : null;
}

/** "2 shops in Quad Cities are outside your access", "Showing your own numbers" and the like. */
export function LocationNotice({ locations }: { locations: QueryState }) {
  const g = locations.selection.group;
  const b = locations.barbers;
  const bg = b?.selection.group;
  const notes = [
    g?.hidden
      ? `${g.hidden === 1 ? "1 shop" : `${g.hidden} shops`} in ${g.name} ${g.hidden === 1 ? "is" : "are"} outside your access, so this report covers the ${
          locations.selection.shopIds.length === 1 ? "shop" : `${locations.selection.shopIds.length} shops`
        } you can see.`
      : null,
    bg?.hidden
      ? `${bg.hidden === 1 ? "1 barber" : `${bg.hidden} barbers`} in ${bg.name} ${bg.hidden === 1 ? "works" : "work"} only at shops outside your access, so they're left out.`
      : null,
    b && !b.pickable && b.selection.kind === "self" ? "Showing your own numbers: your tickets, appointments, tips and ratings." : null,
  ].filter(Boolean);
  if (!notes.length) return null;
  return (
    <div className="no-print mb-4 space-y-2">
      {notes.map((n) => (
        <Notice key={n} tone="blue">
          {n}
        </Notice>
      ))}
    </div>
  );
}

export function LocationField({ p }: { p: LocationProps }) {
  const l = p.locations;
  return (
    <LocationPicker
      shops={p.shops}
      groups={l.groups.map((g) => ({ id: g.id, name: g.name, shopIds: g.shopIds }))}
      value={l.shopParam}
      selected={l.selection.shopIds}
      allLabel={p.allLabel}
    />
  );
}

/** The barber picker, for reports that break down by barber and people who may see everyone's numbers. */
export function BarberField({ l }: { l: QueryState }) {
  const b = l.barbers;
  if (!b?.pickable) return null;
  return (
    <BarberPicker
      barbers={b.visible.map((x) => ({ id: x.id, name: x.name, active: x.active !== false, here: x.shopIds.some((id) => l.selection.shopIds.includes(id)) }))}
      groups={b.groups.map((g) => ({ id: g.id, name: g.name, staffIds: g.staffIds }))}
      value={l.staffParam ?? null}
      selected={b.selection.staffIds ?? []}
    />
  );
}

export function ReportFilters({
  base,
  preset,
  from,
  to,
  scope,
  location,
}: {
  base: string;
  preset: string | null;
  from: string;
  to: string;
  scope: QueryState;
  /** Null when the viewer has one shop. */
  location: LocationProps | null;
}) {
  const qs = (extra: Record<string, string | null>) => `${base}?${reportQuery(scope, extra)}`;
  const range = preset ? { preset } : { from, to };
  return (
    <div className="no-print mb-5 space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <Link
            key={p.id}
            href={qs({ preset: p.id })}
            className={cx("rounded-full px-3 py-1 text-sm ring-1", preset === p.id ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
          >
            {p.label}
          </Link>
        ))}
      </div>
      {/* Keyed so the uncontrolled inputs reset when a preset link changes the range client-side. */}
      <form key={`${from}|${to}|${scope.shopParam}|${scope.staffParam}`} className="flex flex-wrap items-end gap-2 text-sm" action={base}>
        <label>
          <span className="block text-xs text-zinc-500">From</span>
          <input type="date" name="from" defaultValue={from} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">To</span>
          <input type="date" name="to" defaultValue={to} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300" />
        </label>
        {location && <LocationField p={location} />}
        <BarberField l={scope} />
        <ViewInput l={scope} />
        <Button type="submit" variant="dark" size="sm" className="h-9">
          Apply
        </Button>
        <div className="ml-auto self-center">
          <ViewToggle l={scope} href={(v) => `${base}?${reportQuery(withView(scope, v), range)}`} />
        </div>
      </form>
    </div>
  );
}
