"use client";

import { useState } from "react";
import { useBrandSync } from "@/components/brand-sync";
import { Badge, Button, Card, CardHeader, Field, Input, Select, cx } from "@/components/ui";
import { TimeInput } from "@/components/time-input";
import { useAction } from "@/components/use-action";
import { BulkResult, PriceChange, TemplateRow, bulkSummary, describePriceChange, weeklyHours } from "@/domain/bulk-edit";
import { BOOKING_OPTION_KEYS, BOOKING_OPTION_META, BookingOptionKey, isBoolKey } from "@/domain/staff-booking";
import { WEEKDAYS, minutesToLabel } from "@/lib/time";
import {
  applyScheduleTemplateAction,
  bulkProductChangesAction,
  bulkServiceChangesAction,
  bulkShopServicesAction,
  bulkStaffAction,
  deleteScheduleTemplateAction,
  saveScheduleTemplateAction,
} from "./actions";

const $ = (c: number) => `$${(c / 100).toFixed(2)}`;

function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSel((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const setAll = (ids: string[], on: boolean) => setSel(on ? new Set(ids) : new Set());
  return { sel, toggle, setAll, ids: [...sel] };
}

function SelectAll({ ids, sel, setAll }: { ids: string[]; sel: Set<string>; setAll: (ids: string[], on: boolean) => void }) {
  const all = ids.length > 0 && ids.every((i) => sel.has(i));
  return <input type="checkbox" aria-label="Select all" checked={all} onChange={(e) => setAll(ids, e.target.checked)} />;
}

function Results({ results }: { results: BulkResult[] | null }) {
  if (!results) return null;
  const bad = results.filter((r) => !r.ok);
  return (
    <div className="space-y-1 text-xs" data-testid="bulk-results">
      <div className={bad.length ? "text-amber-700" : "text-emerald-700"}>{bulkSummary(results)}</div>
      {bad.map((r) => (
        <div key={r.id} className="text-red-600">
          {r.label}: {r.error}
        </div>
      ))}
    </div>
  );
}

/** "—" no change; a price change in dollars or percent. */
function PriceControl({ label, value, onChange, defaultRound }: { label: string; value: PriceChange | null; onChange: (v: PriceChange | null) => void; defaultRound: "cent" | "dollar" }) {
  const [mode, setMode] = useState<"" | PriceChange["mode"]>(value?.mode ?? "");
  const [amount, setAmount] = useState("");
  const [round, setRound] = useState(defaultRound);
  const emit = (m: typeof mode, a: string, r: typeof round) => {
    if (!m || a.trim() === "" || !Number.isFinite(Number(a))) return onChange(null);
    onChange({ mode: m, value: m === "pct" ? Number(a) : Math.round(Number(a) * 100), round: r });
  };
  return (
    <Field label={label}>
      <div className="flex gap-1">
        <Select
          className="w-28 py-1.5"
          value={mode}
          onChange={(e) => {
            const m = e.target.value as typeof mode;
            setMode(m);
            emit(m, amount, round);
          }}
          aria-label={`${label} change`}
        >
          <option value="">No change</option>
          <option value="set">Set to $</option>
          <option value="add">Add $</option>
          <option value="pct">Change %</option>
        </Select>
        {mode && (
          <Input
            className="w-20 py-1.5"
            inputMode="decimal"
            placeholder={mode === "pct" ? "5" : "2.00"}
            value={amount}
            aria-label={`${label} amount`}
            onChange={(e) => {
              setAmount(e.target.value);
              emit(mode, e.target.value, round);
            }}
          />
        )}
        {mode === "pct" && (
          <Select
            className="w-24 py-1.5"
            value={round}
            onChange={(e) => {
              const r = e.target.value as typeof round;
              setRound(r);
              emit(mode, amount, r);
            }}
            aria-label={`${label} rounding`}
          >
            <option value="cent">to cent</option>
            <option value="dollar">to dollar</option>
          </Select>
        )}
      </div>
    </Field>
  );
}

const triState = (v: string) => (v === "" ? undefined : v === "on");

// ───────────────────────────── Services ─────────────────────────────

export interface ServiceRow {
  id: string;
  name: string;
  kind: string;
  category: string;
  priceCents: number;
  durationMin: number;
  active: boolean;
  enabledHere: boolean | null;
  onlineHere: boolean | null;
}

export function ServicesBulk({ rows, categories, shop, canBrand, canShop }: { rows: ServiceRow[]; categories: string[]; shop: { id: string; name: string } | null; canBrand: boolean; canShop: boolean }) {
  const { sel, toggle, setAll, ids } = useSelection();
  const { pending: running, error: actionError, run } = useAction();
  const sync = useBrandSync();
  const pending = running || sync.pending;
  const error = actionError ?? sync.error;
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [category, setCategory] = useState("");
  const [active, setActive] = useState("");
  const [price, setPrice] = useState<PriceChange | null>(null);
  const [duration, setDuration] = useState("");
  const [enabled, setEnabled] = useState("");
  const [online, setOnline] = useState("");
  const brandChange = !!category || !!active || !!price || !!duration;
  return (
    <Card>
      <CardHeader title="Services" subtitle="Pick services, then one change for all of them. Brand changes apply to the catalog; shop changes to this shop's menu only." />
      <div className="grid gap-3 border-b border-zinc-100 p-4 md:grid-cols-2">
        {canBrand && (
          <div className="space-y-2 rounded-lg p-3 ring-1 ring-zinc-200">
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Brand catalog (all shops)</div>
            <div className="flex flex-wrap gap-3">
              <Field label="Category">
                <Select className="w-40 py-1.5" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
                  <option value="">No change</option>
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Active">
                <Select className="w-32 py-1.5" value={active} onChange={(e) => setActive(e.target.value)} aria-label="Active">
                  <option value="">No change</option>
                  <option value="on">Active</option>
                  <option value="off">Inactive</option>
                </Select>
              </Field>
              <PriceControl label="Default price" value={price} onChange={setPrice} defaultRound="dollar" />
              <Field label="Length (min)">
                <Input className="w-20 py-1.5" inputMode="numeric" placeholder="—" value={duration} onChange={(e) => setDuration(e.target.value.replace(/\D/g, ""))} />
              </Field>
            </div>
            <Button
              size="sm"
              disabled={pending || !ids.length || !brandChange}
              onClick={() =>
                run(
                  () =>
                    bulkServiceChangesAction({
                      ids,
                      ...(category ? { category } : {}),
                      ...(active ? { active: active === "on" } : {}),
                      ...(price ? { price } : {}),
                      ...(duration ? { durationMin: Number(duration) } : {}),
                    }),
                  (d) => {
                    if (!d.changes.length) return setResults(d.results);
                    void sync.open({ label: `Bulk edit: ${d.changes.length} service${d.changes.length === 1 ? "" : "s"}`, changes: d.changes, onDone: () => setResults(d.results) });
                  },
                )
              }
            >
              Apply to {ids.length} service{ids.length === 1 ? "" : "s"}
              {price ? ` (${describePriceChange(price)})` : ""}
            </Button>
          </div>
        )}
        {shop && canShop && (
          <div className="space-y-2 rounded-lg p-3 ring-1 ring-zinc-200">
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{shop.name} only</div>
            <div className="flex flex-wrap gap-3">
              <Field label="On the menu here">
                <Select className="w-32 py-1.5" value={enabled} onChange={(e) => setEnabled(e.target.value)} aria-label="On the menu here">
                  <option value="">No change</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              </Field>
              <Field label="Bookable online here">
                <Select className="w-32 py-1.5" value={online} onChange={(e) => setOnline(e.target.value)} aria-label="Bookable online here">
                  <option value="">No change</option>
                  <option value="on">Yes</option>
                  <option value="off">No</option>
                </Select>
              </Field>
            </div>
            <Button
              size="sm"
              disabled={pending || !ids.length || (!enabled && !online)}
              onClick={() => run(() => bulkShopServicesAction({ shopId: shop.id, ids, enabled: triState(enabled), bookableOnline: triState(online) }), setResults)}
            >
              Apply at {shop.name}
            </Button>
          </div>
        )}
        <div className="md:col-span-2">
          <Results results={results} />
          {error && <div className="text-xs text-red-600">{error}</div>}
          {sync.dialog}
        </div>
      </div>
      <BulkTable
        head={["Service", "Category", "Price", "Length", ...(shop ? [`At ${shop.name}`] : [])]}
        rows={rows.map((r) => ({
          id: r.id,
          cells: [
            <span key="n" className={cx(!r.active && "text-zinc-400")}>
              {r.kind === "addon" && <span className="text-zinc-400">+ </span>}
              {r.name}
              {!r.active && " (inactive)"}
            </span>,
            r.category,
            $(r.priceCents),
            `${r.durationMin} min`,
            ...(shop ? [r.enabledHere ? (r.onlineHere ? "On · online" : "On · in shop only") : <span className="text-zinc-400">Off</span>] : []),
          ],
        }))}
        sel={sel}
        toggle={toggle}
        setAll={setAll}
      />
    </Card>
  );
}

function BulkTable({ head, rows, sel, toggle, setAll }: { head: string[]; rows: { id: string; cells: React.ReactNode[] }[]; sel: Set<string>; toggle: (id: string) => void; setAll: (ids: string[], on: boolean) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <th className="w-8 px-3 py-2">
              <SelectAll ids={rows.map((r) => r.id)} sel={sel} setAll={setAll} />
            </th>
            {head.map((h) => (
              <th key={h} className="px-3 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={cx("border-b border-zinc-100", sel.has(r.id) && "bg-sky-50")}>
              <td className="px-3 py-1.5">
                <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label="Select" />
              </td>
              {r.cells.map((c, i) => (
                <td key={i} className="px-3 py-1.5">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────── Products ─────────────────────────────

export interface ProductRow {
  id: string;
  sku: string;
  brand: string;
  name: string;
  category: string;
  costCents: number;
  priceCents: number;
  low: number;
  par: number;
  high: number | null;
  active: boolean;
}

export function ProductsBulk({ rows, categories }: { rows: ProductRow[]; categories: string[] }) {
  const { sel, toggle, setAll, ids } = useSelection();
  const { pending: running, error: actionError, run } = useAction();
  const sync = useBrandSync();
  const pending = running || sync.pending;
  const error = actionError ?? sync.error;
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [v, setV] = useState({ category: "", brand: "", active: "", low: "", par: "", high: "", clearHigh: false });
  const [cost, setCost] = useState<PriceChange | null>(null);
  const [price, setPrice] = useState<PriceChange | null>(null);
  const any = v.category || v.brand || v.active || v.low || v.par || v.high || v.clearHigh || cost || price;
  const num = (s: string) => (s === "" ? undefined : Number(s));
  return (
    <Card>
      <CardHeader title="Products" subtitle="Brand product details for many products at once. A product whose low, par and high would end up out of order is skipped and listed." />
      <div className="space-y-3 border-b border-zinc-100 p-4">
        <div className="flex flex-wrap gap-3">
          <Field label="Category">
            <Select className="w-36 py-1.5" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} aria-label="Category">
              <option value="">No change</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Brand">
            <Input className="w-32 py-1.5" placeholder="No change" value={v.brand} onChange={(e) => setV({ ...v, brand: e.target.value })} />
          </Field>
          <Field label="Active">
            <Select className="w-28 py-1.5" value={v.active} onChange={(e) => setV({ ...v, active: e.target.value })} aria-label="Active">
              <option value="">No change</option>
              <option value="on">Active</option>
              <option value="off">Inactive</option>
            </Select>
          </Field>
          <PriceControl label="Supply price" value={cost} onChange={setCost} defaultRound="cent" />
          <PriceControl label="Retail price" value={price} onChange={setPrice} defaultRound="cent" />
          {(["low", "par", "high"] as const).map((k) => (
            <Field key={k} label={k === "low" ? "Low" : k === "par" ? "Par" : "High"}>
              <Input className="w-16 py-1.5" inputMode="numeric" placeholder="—" value={v[k]} disabled={k === "high" && v.clearHigh} onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/\D/g, "") })} />
            </Field>
          ))}
          <label className="mt-6 flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={v.clearHigh} onChange={(e) => setV({ ...v, clearHigh: e.target.checked, high: "" })} /> No high line
          </label>
        </div>
        <Button
          size="sm"
          disabled={pending || !ids.length || !any}
          onClick={() =>
            run(
              () =>
                bulkProductChangesAction({
                  ids,
                  ...(v.category ? { category: v.category } : {}),
                  ...(v.brand.trim() ? { brand: v.brand.trim() } : {}),
                  ...(v.active ? { active: v.active === "on" } : {}),
                  ...(cost ? { cost } : {}),
                  ...(price ? { price } : {}),
                  lowStockThreshold: num(v.low),
                  parLevel: num(v.par),
                  ...(v.clearHigh ? { highStockThreshold: null } : v.high ? { highStockThreshold: Number(v.high) } : {}),
                }),
              (d) => {
                if (!d.changes.length) return setResults(d.results);
                void sync.open({ label: `Bulk edit: ${d.changes.length} product${d.changes.length === 1 ? "" : "s"}`, changes: d.changes, onDone: () => setResults(d.results) });
              },
            )
          }
        >
          Apply to {ids.length} product{ids.length === 1 ? "" : "s"}
        </Button>
        <Results results={results} />
        {error && <div className="text-xs text-red-600">{error}</div>}
        {sync.dialog}
      </div>
      <BulkTable
        head={["SKU", "Product", "Category", "Supply", "Retail", "Low / par / high"]}
        rows={rows.map((r) => ({
          id: r.id,
          cells: [
            <span key="s" className="font-mono text-xs">
              {r.sku}
            </span>,
            <span key="n" className={cx(!r.active && "text-zinc-400")}>
              <span className="text-zinc-500">{r.brand}</span> {r.name}
            </span>,
            r.category,
            $(r.costCents),
            $(r.priceCents),
            `${r.low} / ${r.par} / ${r.high ?? "—"}`,
          ],
        }))}
        sel={sel}
        toggle={toggle}
        setAll={setAll}
      />
    </Card>
  );
}

// ───────────────────────────── Staff ─────────────────────────────

export interface PersonRow {
  id: string;
  label: string;
  shops: string;
  visibleHere: boolean | null;
}

export function StaffBulk({ people, shop }: { people: PersonRow[]; shop: { id: string; name: string } | null }) {
  const { sel, toggle, setAll, ids } = useSelection();
  const { pending, error, run } = useAction();
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [scope, setScope] = useState<"all" | string>(shop?.id ?? "all");
  const [visible, setVisible] = useState("");
  const [opts, setOpts] = useState<Partial<Record<BookingOptionKey, string>>>({});
  const options = Object.fromEntries(
    Object.entries(opts)
      .filter(([, x]) => x !== undefined && x !== "")
      .map(([k, x]) => [k, x === "follow" ? null : isBoolKey(k as BookingOptionKey) ? x === "on" : Number(x)]),
  );
  return (
    <Card>
      <CardHeader title="Staff" subtitle="Visible online and booking options for many barbers. Each person goes through the same checks as their own page; anyone you can't change is listed." />
      <div className="space-y-3 border-b border-zinc-100 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Where">
            <Select className="w-48 py-1.5" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Where">
              <option value="all">All shops they work at</option>
              {shop && <option value={shop.id}>{shop.name} only</option>}
            </Select>
          </Field>
          <Field label="Visible online">
            <Select className="w-32 py-1.5" value={visible} onChange={(e) => setVisible(e.target.value)} aria-label="Visible online">
              <option value="">No change</option>
              <option value="on">Visible</option>
              <option value="off">Hidden</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {BOOKING_OPTION_KEYS.map((k) => {
            const m = BOOKING_OPTION_META[k];
            const val = opts[k] ?? "";
            return (
              <Field key={k} label={m.label}>
                {isBoolKey(k) ? (
                  <Select className="py-1.5" value={val} onChange={(e) => setOpts({ ...opts, [k]: e.target.value })} aria-label={m.label}>
                    <option value="">No change</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                    <option value="follow">Follow default</option>
                  </Select>
                ) : (
                  <div className="flex gap-1">
                    <Input className="w-24 py-1.5" inputMode="numeric" placeholder={m.kind === "days" ? "days" : "minutes"} value={val === "follow" ? "" : val} onChange={(e) => setOpts({ ...opts, [k]: e.target.value.replace(/\D/g, "") })} aria-label={m.label} />
                    <Button size="sm" variant={val === "follow" ? "dark" : "ghost"} onClick={() => setOpts({ ...opts, [k]: val === "follow" ? "" : "follow" })}>
                      Follow
                    </Button>
                  </div>
                )}
              </Field>
            );
          })}
        </div>
        <Button
          size="sm"
          disabled={pending || !ids.length || (!visible && !Object.keys(options).length)}
          onClick={() => run(() => bulkStaffAction({ staffIds: ids, scope, visibleOnline: triState(visible), ...(Object.keys(options).length ? { options } : {}) }), setResults)}
        >
          Apply to {ids.length} {ids.length === 1 ? "person" : "people"} · {scope === "all" ? "all shops" : "this shop only"}
        </Button>
        <Results results={results} />
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
      <BulkTable
        head={["Name", "Shops", ...(shop ? [`Online at ${shop.name}`] : [])]}
        rows={people.map((p) => ({
          id: p.id,
          cells: [p.label, <span key="s" className="text-xs text-zinc-500">{p.shops}</span>, ...(shop ? [p.visibleHere === null ? "—" : p.visibleHere ? "Visible" : "Hidden"] : [])],
        }))}
        sel={sel}
        toggle={toggle}
        setAll={setAll}
      />
    </Card>
  );
}

// ───────────────────────────── Schedules ─────────────────────────────

export interface Template {
  id: string;
  name: string;
  rows: TemplateRow[];
}
export interface BarberWeek {
  id: string;
  label: string;
  hours: number;
  days: string;
}

const summary = (rows: TemplateRow[]) =>
  WEEKDAYS.map((d, i) => {
    const r = rows.filter((x) => x.weekday === i);
    return r.length ? `${d} ${r.map((x) => `${minutesToLabel(x.startMin)}–${minutesToLabel(x.endMin)}`).join(", ")}` : null;
  })
    .filter(Boolean)
    .join(" · ");

export function SchedulesBulk({ templates, shop, barbers, canEditTemplates }: { templates: Template[]; shop: { id: string; name: string } | null; barbers: BarberWeek[]; canEditTemplates: boolean }) {
  const [editing, setEditing] = useState<Template | null>(null);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Schedule templates"
          subtitle="A named week of shifts, shared by every shop. Apply one to many barbers below."
          action={
            <Button size="sm" variant="secondary" onClick={() => setEditing({ id: "", name: "", rows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) })}>
              New template
            </Button>
          }
        />
        <ul className="divide-y divide-zinc-100" data-testid="schedule-templates">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="w-40 font-medium">{t.name}</span>
              <span className="flex-1 text-xs text-zinc-500">{summary(t.rows) || "No shifts"}</span>
              <Badge>{weeklyHours(t.rows)} h/week</Badge>
              {canEditTemplates && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                  Edit
                </Button>
              )}
            </li>
          ))}
          {!templates.length && <li className="px-4 py-3 text-sm text-zinc-500">No templates yet.</li>}
        </ul>
        {editing && <TemplateEditor key={editing.id || "new"} t={editing} canDelete={canEditTemplates && !!editing.id} onDone={() => setEditing(null)} />}
      </Card>
      {shop ? (
        <ApplyTemplate templates={templates} shop={shop} barbers={barbers} />
      ) : (
        <Card>
          <CardHeader title="Apply a template" subtitle="Pick a shop in the switcher: a template replaces barbers' hours at one shop and leaves their hours at other shops alone." />
        </Card>
      )}
    </div>
  );
}

function TemplateEditor({ t, canDelete, onDone }: { t: Template; canDelete: boolean; onDone: () => void }) {
  const { pending, error, run } = useAction();
  const [name, setName] = useState(t.name);
  const [rows, setRows] = useState<TemplateRow[]>(t.rows);
  const update = (i: number, patch: Partial<TemplateRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3 border-t border-zinc-200 bg-zinc-50 p-4">
      <Field label="Template name">
        <Input className="max-w-xs py-1.5" value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekday 9 to 5" />
      </Field>
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
        {WEEKDAYS.map((d, wd) => (
          <div key={d} className="rounded-md bg-white p-2 ring-1 ring-zinc-200">
            <div className="mb-1 flex items-center justify-between text-xs font-semibold">
              {d}
              <button type="button" className="text-brand-700 hover:underline" onClick={() => setRows([...rows, { weekday: wd, startMin: 9 * 60, endMin: 17 * 60 }])}>
                + shift
              </button>
            </div>
            {rows.map((r, i) =>
              r.weekday === wd ? (
                <div key={i} className="mb-1 flex items-center gap-1">
                  <TimeInput className="w-20" aria-label={`${d} start`} value={r.startMin} onChange={(m) => update(i, { startMin: m })} />
                  <span className="text-zinc-400">–</span>
                  <TimeInput className="w-20" aria-label={`${d} end`} value={r.endMin} onChange={(m) => update(i, { endMin: m })} />
                  <button type="button" aria-label={`Remove ${d} shift`} className="px-1 text-zinc-400 hover:text-red-600" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ) : null,
            )}
            {!rows.some((r) => r.weekday === wd) && <div className="text-xs text-zinc-400">Off</div>}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => saveScheduleTemplateAction({ id: t.id || null, name, rows }), onDone)}>
          Save template
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {canDelete && (
          <Button size="sm" variant="ghost" className="ml-auto text-red-600" disabled={pending} onClick={() => run(() => deleteScheduleTemplateAction(t.id), onDone)}>
            Delete
          </Button>
        )}
        <span className="text-xs text-zinc-500">{weeklyHours(rows)} hours a week</span>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}

function ApplyTemplate({ templates, shop, barbers }: { templates: Template[]; shop: { id: string; name: string }; barbers: BarberWeek[] }) {
  const { sel, toggle, setAll, ids } = useSelection();
  const { pending, error, run } = useAction();
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const t = templates.find((x) => x.id === templateId);
  return (
    <Card>
      <CardHeader title={`Apply a template at ${shop.name}`} subtitle="Replaces the picked barbers' weekly hours at this shop. Their hours at other shops stay; anyone it would double-book is skipped and listed." />
      <div className="flex flex-wrap items-end gap-3 border-b border-zinc-100 p-4">
        <Field label="Template">
          <Select className="w-56 py-1.5" value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          size="sm"
          disabled={pending || !ids.length || !t}
          onClick={() => {
            if (window.confirm(`Replace ${ids.length} barber${ids.length === 1 ? "'s" : "s'"} hours at ${shop.name} with “${t!.name}”?`)) run(() => applyScheduleTemplateAction({ templateId, shopId: shop.id, staffIds: ids }), setResults);
          }}
        >
          Apply to {ids.length} barber{ids.length === 1 ? "" : "s"}
        </Button>
        <div className="w-full">
          {t && <div className="text-xs text-zinc-500">{summary(t.rows)}</div>}
          <Results results={results} />
          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
      </div>
      <BulkTable
        head={["Barber", `Hours at ${shop.name}`, "Week"]}
        rows={barbers.map((b) => ({ id: b.id, cells: [b.label, `${b.hours} h`, <span key="d" className="text-xs text-zinc-500">{b.days || "No hours"}</span>] }))}
        sel={sel}
        toggle={toggle}
        setAll={setAll}
      />
    </Card>
  );
}
