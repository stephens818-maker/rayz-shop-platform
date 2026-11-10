import Link from "next/link";
import { ChipStrip } from "@/components/chip-strip";
import { Button, Notice, cx } from "@/components/ui";
import { REPORT_VIEWS, ReportView, viewOf } from "@/domain/report-views";
import type { ReportOption } from "@/server/report-data";
import { BarberPicker } from "./barber-picker";
import { LocationPicker } from "./location-picker";
import { RANGE_TIME_ZONE_LABEL, STANDARD_PRESETS, rangeText } from "@/domain/report-range";
import type { PayPeriodPickerGroup } from "@/server/payroll/periods";
import { ReportLocations, ReportViewState } from "./scope";

export interface LocationProps {
  shops: { id: string; name: string }[];
  locations: ReportLocations;
  allLabel: string;
}

export const locationProps = (ctx: { shops: { id: string; name: string; status?: string }[]; brandWide: boolean }, locations: ReportLocations): LocationProps => ({
  shops: ctx.shops.map((s) => ({ id: s.id, name: s.status === "archived" ? `${s.name} (archived)` : s.name })),
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
    <div role="group" aria-label="View" className="inline-flex max-w-full overflow-x-auto rounded-full bg-white p-0.5 text-sm ring-1 ring-zinc-300 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 [&>*]:whitespace-nowrap">
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

/** A report's own choices (visits to qualify, filing period) as URL values; empty is the default. */
export const optionValues = (options: readonly ReportOption[] | undefined): Record<string, string | null> => Object.fromEntries((options ?? []).map((o) => [o.param, o.value || null]));

/**
 * The date chips a report shows: the standard ranges every report has, then the report's own. Pay
 * period chips are left to the pay period picker.
 */
export function presetChips(own: readonly { id: string; label: string }[] | undefined, standard = true): { id: string; label: string }[] {
  if (!standard) return [...(own ?? [])];
  const extra = (own ?? []).filter((p) => !p.id.startsWith("pp:") && !STANDARD_PRESETS.some((s) => s.id === p.id));
  return [...STANDARD_PRESETS.map((s) => own?.find((p) => p.id === s.id) ?? s), ...extra];
}

/** Hidden inputs that keep the shops, barbers, view and a report's options when another range is picked. */
function KeepInputs({ scope, opts, skip = [] }: { scope: QueryState; opts: Record<string, string | null>; skip?: string[] }) {
  return (
    <>
      {[...reportQuery(scope, opts)].filter(([k]) => !skip.includes(k)).map(([k, v]) => (
        <input key={`${k}=${v}`} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

/** A specific pay period by its iSolved number, per pay calendar (Dubuque runs on its own). */
export function PayPeriodPicker({ base, groups, preset, from, to, scope, opts }: { base: string; groups: readonly PayPeriodPickerGroup[]; preset: string | null; from: string; to: string; scope: QueryState | null; opts: Record<string, string | null> }) {
  if (!groups.some((g) => g.periods.length)) return null;
  const all = groups.flatMap((g) => g.periods);
  const value = all.find((p) => p.id === preset)?.id ?? all.find((p) => p.start === from && p.end === to)?.id ?? "";
  return (
    <form key={`${preset}|${from}|${to}`} action={base} className="flex flex-wrap items-end gap-2 text-sm" data-testid="pay-period-picker">
      <label>
        <span className="block text-xs text-zinc-500">Pay period</span>
        <select name="preset" defaultValue={value} className="h-9 max-w-72 rounded-lg bg-white px-2 ring-1 ring-zinc-300">
          <option value="" disabled>
            Pick a pay period by number
          </option>
          {groups.map((g) => (
            <optgroup key={g.payGroupId} label={groups.length > 1 ? `${g.label} pay calendar` : "Pay periods"}>
              {g.periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {`Period ${String(p.number).padStart(2, "0")} · ${rangeText(p.start, p.end)}${p.current ? " (current)" : ""}`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {scope ? <KeepInputs scope={scope} opts={opts} /> : null}
      <Button type="submit" variant="secondary" size="sm" className="h-9">
        Show
      </Button>
    </form>
  );
}

export function ReportFilters({
  base,
  preset,
  from,
  to,
  scope,
  location,
  options,
  presets,
  payPeriods = [],
  views = true,
  standard = true,
}: {
  base: string;
  preset: string | null;
  from: string;
  to: string;
  scope: QueryState;
  /** Null when the viewer has one shop. */
  location: LocationProps | null;
  options?: readonly ReportOption[];
  /** The report's own presets, shown after the standard ones. */
  presets?: readonly { id: string; label: string }[];
  /** The pay periods to pick by number, per pay calendar of the shops shown. */
  payPeriods?: readonly PayPeriodPickerGroup[];
  /** False on pages without the combined / by location / by barber views. */
  views?: boolean;
  /** False: only `presets` (the Payroll Report has its own list). */
  standard?: boolean;
}) {
  const opts = optionValues(options);
  const qs = (extra: Record<string, string | null>) => `${base}?${reportQuery(scope, { ...opts, ...extra })}`;
  const range: Record<string, string> = preset ? { preset } : { from, to };
  const chips = presetChips(presets, standard);
  return (
    <div className="no-print mb-5 space-y-3">
      <ChipStrip className="items-center gap-1.5" label="Date range">
        {chips.map((p) => (
          <Link
            key={p.id}
            href={qs({ preset: p.id })}
            aria-current={preset === p.id ? "true" : undefined}
            className={cx("rounded-full px-3 py-1 text-sm ring-1", preset === p.id ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
          >
            {p.label}
          </Link>
        ))}
        {!preset && (
          <span aria-current="true" className="rounded-full bg-ink-900 px-3 py-1 text-sm text-white ring-1 ring-ink-900">
            Custom range
          </span>
        )}
      </ChipStrip>
      {options?.filter((o) => !o.select).map((o) => (
        <div key={o.param} role="group" aria-label={o.label} className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="mr-1 text-xs text-zinc-500">{o.label}</span>
          {o.choices.map((c) => (
            <Link
              key={c.value}
              href={qs({ ...range, [o.param]: c.value || null })}
              aria-current={o.value === c.value ? "true" : undefined}
              className={cx("rounded-full px-3 py-0.5 ring-1", o.value === c.value ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
            >
              {c.label}
            </Link>
          ))}
        </div>
      ))}
      <PayPeriodPicker base={base} groups={payPeriods} preset={preset} from={from} to={to} scope={scope} opts={opts} />
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
        {options
          ?.filter((o) => o.select)
          .map((o) => (
            <label key={o.param}>
              <span className="block text-xs text-zinc-500">{o.label}</span>
              <select name={o.param} defaultValue={o.value} className="h-9 max-w-56 rounded-lg bg-white px-2 ring-1 ring-zinc-300">
                {o.choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        {views && <ViewInput l={scope} />}
        {Object.entries(opts).map(([k, v]) => (v && !options?.some((o) => o.select && o.param === k) ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <Button type="submit" variant="dark" size="sm" className="h-9">
          Apply
        </Button>
        <div className="ml-auto min-w-0 max-w-full self-center">
          {views && <ViewToggle l={scope} href={(v) => `${base}?${reportQuery(withView(scope, v), { ...opts, ...range })}`} />}
        </div>
        <p className="basis-full text-[11px] text-zinc-400">Custom dates are whole days in {RANGE_TIME_ZONE_LABEL}.</p>
      </form>
    </div>
  );
}
