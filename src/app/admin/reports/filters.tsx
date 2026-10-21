import Link from "next/link";
import { Button, Notice, cx } from "@/components/ui";
import { LOCATION_VIEWS, LocationView } from "@/domain/report-views";
import { LocationPicker } from "./location-picker";
import { PRESETS, ReportLocations } from "./scope";

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

/** URL query for a report page, keeping the location and view. */
export function reportQuery(l: ReportLocations | null, extra: Record<string, string | null | undefined>) {
  const q = new URLSearchParams();
  if (l?.shopParam) q.set("shop", l.shopParam);
  if (l && l.loc.view !== "combined") q.set("view", l.loc.view);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return q;
}

/** Combined total, or side by side per location. Only offered when more than one shop is selected. */
export function ViewToggle({ view, href }: { view: LocationView; href: (v: LocationView) => string }) {
  return (
    <div role="group" aria-label="Location view" className="inline-flex rounded-full bg-white p-0.5 text-sm ring-1 ring-zinc-300">
      {(Object.keys(LOCATION_VIEWS) as LocationView[]).map((v) => (
        <Link
          key={v}
          href={href(v)}
          aria-current={v === view ? "true" : undefined}
          className={cx("rounded-full px-3 py-0.5", v === view ? "bg-ink-900 text-white" : "text-zinc-600 hover:bg-zinc-50")}
        >
          {LOCATION_VIEWS[v]}
        </Link>
      ))}
    </div>
  );
}

/** "2 shops in Quad Cities are outside your access" and the like. */
export function LocationNotice({ locations }: { locations: ReportLocations }) {
  const g = locations.selection.group;
  if (!g?.hidden) return null;
  return (
    <div className="no-print mb-4">
      <Notice tone="blue">
        {g.hidden === 1 ? "1 shop" : `${g.hidden} shops`} in {g.name} {g.hidden === 1 ? "is" : "are"} outside your access, so this report covers the{" "}
        {locations.selection.shopIds.length === 1 ? "shop" : `${locations.selection.shopIds.length} shops`} you can see.
      </Notice>
    </div>
  );
}

export function LocationField({ p }: { p: LocationProps }) {
  const l = p.locations;
  return (
    <>
      <LocationPicker
        shops={p.shops}
        groups={l.groups.map((g) => ({ id: g.id, name: g.name, shopIds: g.shopIds }))}
        value={l.shopParam}
        selected={l.selection.shopIds}
        allLabel={p.allLabel}
      />
      {l.loc.view !== "combined" && <input type="hidden" name="view" value={l.loc.view} />}
    </>
  );
}

export function ReportFilters({
  base,
  preset,
  from,
  to,
  staff,
  barbers,
  location,
}: {
  base: string;
  preset: string | null;
  from: string;
  to: string;
  staff: string | null;
  barbers: { id: string; label: string }[] | null;
  /** Null when the viewer has one shop. */
  location: LocationProps | null;
}) {
  const l = location?.locations ?? null;
  const qs = (extra: Record<string, string | null>) => `${base}?${reportQuery(l, { staff, ...extra })}`;
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
      <form key={`${from}|${to}|${l?.shopParam}|${staff}`} className="flex flex-wrap items-end gap-2 text-sm" action={base}>
        <label>
          <span className="block text-xs text-zinc-500">From</span>
          <input type="date" name="from" defaultValue={from} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">To</span>
          <input type="date" name="to" defaultValue={to} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300" />
        </label>
        {location && <LocationField p={location} />}
        {barbers && (
          <label>
            <span className="block text-xs text-zinc-500">Barber</span>
            <select name="staff" defaultValue={staff ?? ""} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300">
              <option value="">All barbers</option>
              {barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="dark" size="sm" className="h-9">
          Apply
        </Button>
        {l && l.selection.shopIds.length > 1 && (
          <div className="ml-auto self-center">
            <ViewToggle view={l.loc.view} href={(v) => `${base}?${reportQuery({ ...l, loc: { ...l.loc, view: v } }, { staff, ...range })}`} />
          </div>
        )}
      </form>
    </div>
  );
}
