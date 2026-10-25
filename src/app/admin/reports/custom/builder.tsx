"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { Chips, toggle } from "@/components/chips";
import { SegmentFilters } from "@/components/segment-filters";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Notice,
  Select,
  Textarea,
  buttonClass,
  cx,
} from "@/components/ui";
import { filterCount } from "@/domain/marketing";
import {
  AGG_LABEL,
  FIELD_GROUPS,
  FORMATS,
  FORMAT_LABEL,
  FREQUENCIES,
  RANGE_PRESETS,
  VISIBILITIES,
  VISIBILITY_LABEL,
  aggsFor,
  cellText,
  defaultReport,
  totalHeader,
  totalType,
  type Agg,
  type ExportFormat,
  type ReportDefinition,
  type ReportResult,
  type ReportSchedule,
  type Visibility,
} from "@/domain/report-builder";
import type { Preview } from "@/server/report-builder/preview";
import {
  deleteReportAction,
  duplicateReportAction,
  exportReportAction,
  previewReportAction,
  saveReportAction,
} from "./actions";
import type { BuilderOptions } from "./data";

export interface SavedMeta {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  roleIds: string[];
  schedule: ReportSchedule | null;
  morning: boolean;
  owner: string;
  mine: boolean;
  mayEdit: boolean;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const FREQ_LABEL = {
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
} as const;
const DEFAULT_SCHEDULE = (me: string): ReportSchedule => ({
  frequency: "weekly",
  weekday: 1,
  monthDay: 1,
  timeMin: 7 * 60,
  format: "csv",
  recipients: [me],
});
const clock = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function download(name: string, type: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Where I'm working" (null), every shop ("all"), a saved group, or picked ids: the same values as the reports' location filter. */
function ScopePicker(p: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  items: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  nullLabel: string;
  allLabel?: string;
  disabled?: boolean;
}) {
  const mode =
    p.value === null
      ? ""
      : p.value === "all" || p.value.startsWith("group:")
        ? p.value
        : "pick";
  const picked = mode === "pick" ? p.value!.split(",").filter(Boolean) : [];
  return (
    <Field label={p.label}>
      <Select
        disabled={p.disabled}
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          p.onChange(
            v === "" ? null : v === "pick" ? (p.items[0]?.id ?? null) : v,
          );
        }}
      >
        <option value="">{p.nullLabel}</option>
        {p.allLabel && <option value="all">{p.allLabel}</option>}
        {p.groups.map((g) => (
          <option key={g.id} value={`group:${g.id}`}>
            Group: {g.name}
          </option>
        ))}
        <option value="pick">Pick…</option>
      </Select>
      {mode === "pick" && (
        <div className="mt-2">
          <Chips
            disabled={p.disabled}
            options={p.items}
            selected={picked}
            onToggle={(id) => p.onChange(toggle(picked, id).join(",") || null)}
          />
        </div>
      )}
    </Field>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx("flex items-start gap-2 text-sm", disabled && "opacity-50")}
    >
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

/** The report as the page shows it: group headers with their subtotals, clients' rows, and the grand total. */
export function ResultTable({
  r,
  summary,
}: {
  r: ReportResult;
  summary: boolean;
}) {
  const grouped = r.groupBy.length > 0;
  const noun = r.noun ?? "client";
  const sumCols = r.columns
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.agg !== "none");
  if (summary && grouped)
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="report-table">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500">
              {r.groupBy.map((g) => (
                <th key={g.key} className="px-3 py-2 font-medium">
                  {g.label}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">
                {noun === "event" ? "Events" : "Clients"}
              </th>
              {sumCols.map((x) => (
                <th key={x.i} className="px-3 py-2 text-right font-medium">
                  {totalHeader(x.c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l, k) =>
              l.kind === "group" ? (
                <tr key={k} className="border-b border-zinc-100">
                  {l.values.map((v, i) => (
                    <td key={i} className="px-3 py-1.5">
                      {v}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {l.count.toLocaleString("en-US")}
                  </td>
                  {sumCols.map((x) => (
                    <td
                      key={x.i}
                      className="px-3 py-1.5 text-right tabular-nums"
                    >
                      {cellText(totalType(x.c), l.cells[x.i])}
                    </td>
                  ))}
                </tr>
              ) : null,
            )}
          </tbody>
          {r.totals && (
            <tfoot>
              <tr className="border-t-2 border-zinc-300 font-semibold">
                <td className="px-3 py-2" colSpan={r.groupBy.length}>
                  Total
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.totals.count.toLocaleString("en-US")}
                </td>
                {sumCols.map((x) => (
                  <td key={x.i} className="px-3 py-2 text-right tabular-nums">
                    {cellText(totalType(x.c), r.totals!.cells[x.i])}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    );
  const numeric = (t: string) =>
    t === "int" || t === "number" || t === "money" || t === "stars" || t === "pct";
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm" data-testid="report-table">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500">
            {r.columns.map((c, i) => (
              <th
                key={i}
                className={cx(
                  "whitespace-nowrap px-3 py-2 font-medium",
                  numeric(c.type) && "text-right",
                )}
              >
                {c.label}
                {c.masked && (
                  <Badge tone="amber" className="ml-1">
                    masked
                  </Badge>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l, k) =>
            l.kind === "group" ? (
              <tr
                key={k}
                className={cx(
                  "border-b border-zinc-200",
                  l.level === 0 ? "bg-zinc-100" : "bg-zinc-50",
                )}
              >
                {r.columns.map((c, i) => (
                  <td
                    key={i}
                    className={cx(
                      "px-3 py-1.5 font-semibold",
                      numeric(totalType(c)) && "text-right tabular-nums",
                    )}
                    style={
                      i === 0
                        ? { paddingLeft: `${0.75 + l.level * 1.25}rem` }
                        : undefined
                    }
                  >
                    {i === 0 ? (
                      <>
                        {r.groupBy[l.level]?.label}: {l.values[l.level]}{" "}
                        <span className="font-normal text-zinc-500">
                          ({l.count.toLocaleString("en-US")} {noun}
                          {l.count === 1 ? "" : "s"}
                          {l.continued ? ", continued" : ""})
                        </span>
                        {c.agg !== "none" && (
                          <div className="text-xs font-normal text-zinc-600">{`${AGG_LABEL[c.agg]}: ${cellText(totalType(c), l.cells[i])}`}</div>
                        )}
                      </>
                    ) : c.agg !== "none" ? (
                      cellText(totalType(c), l.cells[i])
                    ) : null}
                  </td>
                ))}
              </tr>
            ) : (
              <tr key={k} className="border-b border-zinc-100 hover:bg-zinc-50">
                {r.columns.map((c, i) => (
                  <td
                    key={i}
                    className={cx(
                      "px-3 py-1.5",
                      numeric(c.type) && !c.masked && "text-right tabular-nums",
                    )}
                    style={
                      i === 0 && grouped
                        ? {
                            paddingLeft: `${0.75 + r.groupBy.length * 1.25}rem`,
                          }
                        : undefined
                    }
                  >
                    {i === 0 && noun === "client" ? (
                      <Link
                        className="hover:underline"
                        href={`/admin/customers/${l.id}`}
                      >
                        {cellText(c.type, l.cells[i], c.masked) || "—"}
                      </Link>
                    ) : (
                      cellText(c.type, l.cells[i], c.masked)
                    )}
                  </td>
                ))}
              </tr>
            ),
          )}
        </tbody>
        {r.totals && (
          <tfoot>
            <tr className="border-t-2 border-zinc-300 font-semibold">
              {r.columns.map((c, i) => (
                <td
                  key={i}
                  className={cx(
                    "px-3 py-2",
                    numeric(totalType(c)) && "text-right tabular-nums",
                  )}
                >
                  {i === 0 && c.agg === "none"
                    ? `Total (${r.totals!.count.toLocaleString("en-US")} ${noun}s)`
                    : c.agg !== "none"
                      ? `${i === 0 ? "Total: " : ""}${cellText(totalType(c), r.totals!.cells[i])}`
                      : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} action={action} />
      <div className="space-y-3 p-4">{children}</div>
    </Card>
  );
}

/**
 * The custom report builder: a field picker, columns to drag into order, rename and total, the
 * segment builder's filters, sorting, grouping, dates and scope, a live preview, saving, sharing,
 * schedules and exports. Read-only for someone viewing a report they can't change: they may still
 * look at other dates, export it if allowed, or duplicate it to make their own.
 */
export function ReportBuilder({
  o,
  saved,
  initial,
}: {
  o: BuilderOptions;
  saved: SavedMeta | null;
  initial: ReportDefinition;
}) {
  const router = useRouter();
  const editable = o.may.build && (!saved || saved.mayEdit);
  const [def, setDef] = useState<ReportDefinition>(initial);
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  const [name, setName] = useState(saved?.name ?? "");
  const [description, setDescription] = useState(saved?.description ?? "");
  const [visibility, setVisibility] = useState<Visibility>(
    saved?.visibility ?? "private",
  );
  const [roleIds, setRoleIds] = useState<string[]>(saved?.roleIds ?? []);
  const [schedule, setSchedule] = useState<ReportSchedule | null>(
    saved?.schedule ?? null,
  );
  const [morning, setMorning] = useState(saved?.morning ?? false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const asked = useRef(0);

  const events = def.source === "events";
  const fields = events ? o.eventFields : o.fields;
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const update = (x: Partial<ReportDefinition>) => {
    setDef((d) => ({ ...d, ...x }));
    setPage(1);
  };
  const orderable = fields.filter(
    (f) => f.use.use === "full" && f.type !== "list",
  );
  const inColumns = new Set(def.columns.map((c) => c.field));
  const shown = fields.filter(
    (f) =>
      !q.trim() ||
      f.label.toLowerCase().includes(q.trim().toLowerCase()) ||
      f.group.toLowerCase().includes(q.trim().toLowerCase()),
  );

  const defKey = JSON.stringify(def);
  useEffect(() => {
    const n = ++asked.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await previewReportAction({
        id: saved?.id ?? null,
        ...(editable
          ? { definition: JSON.parse(defKey) }
          : { range: JSON.parse(defKey).range }),
        page,
      });
      if (n !== asked.current) return;
      setLoading(false);
      if (r.ok) {
        setPreview(r.data);
        setRunError(null);
      } else setRunError(r.error);
    }, 450);
    return () => clearTimeout(t);
  }, [defKey, page, editable, saved?.id]);

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= def.columns.length) return;
    const cols = [...def.columns];
    const [c] = cols.splice(from, 1);
    cols.splice(to, 0, c);
    update({ columns: cols });
  };
  const setColumn = (
    i: number,
    x: Partial<ReportDefinition["columns"][number]>,
  ) =>
    update({
      columns: def.columns.map((c, j) => (j === i ? { ...c, ...x } : c)),
    });
  const addField = (key: string) =>
    inColumns.has(key)
      ? update({ columns: def.columns.filter((c) => c.field !== key) })
      : update({
          columns: [...def.columns, { field: key, label: "", agg: "none" }],
        });

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      setDone(null);
      await fn();
    });
  const doExport = (format: ExportFormat) =>
    run(async () => {
      const r = await exportReportAction(
        {
          id: saved?.id ?? null,
          ...(editable ? { definition: def } : { range: def.range }),
        },
        format,
      );
      if (!r.ok) return setError(r.error);
      download(r.data.filename, r.data.contentType, r.data.base64);
    });
  const save = () =>
    run(async () => {
      const r = await saveReportAction({
        id: saved?.id ?? null,
        name,
        description,
        visibility,
        roleIds,
        schedule,
        morning,
        definition: def,
      });
      if (!r.ok) return setError(r.error);
      if (!saved) router.push(`/admin/reports/custom/${r.data.id}`);
      else {
        setDone("Saved");
        router.refresh();
      }
    });
  const duplicate = () =>
    run(async () => {
      const r = await duplicateReportAction(saved!.id);
      if (!r.ok) return setError(r.error);
      router.push(`/admin/reports/custom/${r.data.id}`);
    });
  const remove = () =>
    run(async () => {
      if (
        !confirm(
          `Delete "${saved!.name}"? Anyone it's shared with or emailed to loses it too.`,
        )
      )
        return;
      const r = await deleteReportAction(saved!.id);
      if (!r.ok) return setError(r.error);
      router.push("/admin/reports/custom");
    });

  const result = preview?.result ?? null;
  const pages = result
    ? Math.max(1, Math.ceil(result.total / result.pageSize))
    : 1;
  const filters = filterCount(def.filter);
  const exportNote = events ? o.may.exportEvents : o.may.export;
  const noun = events ? "event" : "client";
  const pickedCats = def.eventTypes.filter((t) => !t.includes("."));
  const pickedEvents = def.eventTypes.filter((t) => t.includes("."));
  const typeLabel = new Map(o.eventTypes.map((t) => [t.key, t.label]));

  const columnsCard = (
    <Section
      title="Columns"
      subtitle={
        editable
          ? "Drag to reorder. Rename a header, or total a column for each group and the whole report."
          : undefined
      }
    >
      <ol className="space-y-1.5" data-testid="report-columns">
        {def.columns.map((c, i) => {
          const f = byKey.get(c.field);
          const masked = f?.use.use === "masked";
          const aggs = (f ? aggsFor(f.type) : (["none"] as Agg[])).filter(
            (a) => !masked || a === "none" || a === "count",
          );
          return (
            <li
              key={`${c.field}-${i}`}
              draggable={editable}
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => editable && e.preventDefault()}
              onDrop={() => {
                if (drag !== null) move(drag, i);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
              className={cx(
                "flex flex-wrap items-center gap-2 rounded-lg bg-white px-2 py-1.5 ring-1 ring-zinc-200",
                drag === i && "opacity-50",
              )}
            >
              {editable && (
                <span
                  aria-hidden
                  className="cursor-grab select-none px-1 text-zinc-400"
                  title="Drag to reorder"
                >
                  ⋮⋮
                </span>
              )}
              <span
                className="w-40 truncate text-xs text-zinc-500"
                title={f?.hint}
              >
                {f?.label ?? "Removed field"}
                {masked && (
                  <Badge tone="amber" className="ml-1">
                    masked
                  </Badge>
                )}
              </span>
              <Input
                aria-label={`Header for ${f?.label ?? c.field}`}
                className="h-8 w-48 flex-1"
                placeholder={f?.label}
                disabled={!editable}
                value={c.label}
                maxLength={60}
                onChange={(e) => setColumn(i, { label: e.target.value })}
              />
              <Select
                aria-label={`Total for ${f?.label ?? c.field}`}
                className="h-8 w-36"
                disabled={!editable}
                value={c.agg}
                onChange={(e) => setColumn(i, { agg: e.target.value as Agg })}
              >
                {aggs.map((a) => (
                  <option key={a} value={a}>
                    {AGG_LABEL[a]}
                  </option>
                ))}
              </Select>
              {editable && (
                <span className="flex gap-0.5">
                  <button
                    type="button"
                    className="rounded px-1.5 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"
                    aria-label="Move left"
                    disabled={i === 0}
                    onClick={() => move(i, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="rounded px-1.5 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"
                    aria-label="Move right"
                    disabled={i === def.columns.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="rounded px-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-30"
                    aria-label={`Remove ${f?.label ?? c.field}`}
                    disabled={def.columns.length === 1}
                    onClick={() =>
                      update({ columns: def.columns.filter((_, j) => j !== i) })
                    }
                  >
                    ×
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </Section>
  );

  const rowsCard = (
    <Section
      title="Rows"
      subtitle={
        events
          ? "Which events, over which business days, at which locations and about which barbers."
          : "Which clients, over which dates, where and with whom. Visits, spend and campaign columns count only what happened in these dates, at these locations, with these barbers."
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Dates">
          <Select
            value={def.range.preset}
            onChange={(e) =>
              update({ range: { ...def.range, preset: e.target.value } })
            }
          >
            {RANGE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
          {def.range.preset === "custom" && (
            <div className="mt-2 flex items-center gap-1.5">
              <Input
                type="date"
                aria-label="From"
                value={def.range.from ?? ""}
                onChange={(e) =>
                  update({
                    range: { ...def.range, from: e.target.value || null },
                  })
                }
              />
              <span className="text-xs text-zinc-400">to</span>
              <Input
                type="date"
                aria-label="To"
                value={def.range.to ?? ""}
                onChange={(e) =>
                  update({
                    range: { ...def.range, to: e.target.value || null },
                  })
                }
              />
            </div>
          )}
        </Field>
        {o.shops.length > 1 ? (
          <ScopePicker
            label="Locations"
            disabled={!editable}
            value={def.shops}
            onChange={(shops) => update({ shops })}
            items={o.shops}
            groups={o.shopGroups}
            nullLabel="The location I'm working in"
            allLabel="All my locations"
          />
        ) : (
          <Field label="Locations">
            <p className="pt-2 text-sm text-zinc-600">
              {o.shops[0]?.name ?? "Your location"}
            </p>
          </Field>
        )}
        {o.barbers ? (
          <ScopePicker
            label="Barbers"
            disabled={!editable}
            value={def.staff}
            onChange={(staff) => update({ staff })}
            items={o.barbers}
            groups={o.barberGroups}
            nullLabel="Every barber"
          />
        ) : (
          <Field label="Barbers">
            <p className="pt-2 text-xs text-zinc-500">
              Only your own visits: seeing other barbers&apos; numbers needs
              &quot;See every barber&apos;s numbers&quot;.
            </p>
          </Field>
        )}
        {!events && (
          <Field label="Clients" className="sm:col-span-2 lg:col-span-3">
            <Select
              disabled={!editable}
              value={def.rows}
              onChange={(e) =>
                update({ rows: e.target.value as ReportDefinition["rows"] })
              }
            >
              <option value="all">
                Every client of these locations (home location or any visit)
              </option>
              <option value="visited">
                Only clients with a completed visit in these dates, here, with
                these barbers
              </option>
            </Select>
          </Field>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Group by"
          hint="Up to two levels, each with its subtotals."
        >
          <div className="flex gap-2">
            {[0, 1].map((lvl) =>
              lvl === 0 || def.groupBy[0] ? (
                <Select
                  key={lvl}
                  aria-label={`Group by, level ${lvl + 1}`}
                  disabled={!editable}
                  value={def.groupBy[lvl] ?? ""}
                  onChange={(e) => {
                    const g = [...def.groupBy];
                    if (e.target.value) g[lvl] = e.target.value;
                    else g.splice(lvl);
                    update({
                      groupBy: g.filter(Boolean),
                      summary: g.filter(Boolean).length ? def.summary : false,
                    });
                  }}
                >
                  <option value="">
                    {lvl === 0 ? "No grouping" : "Then by…"}
                  </option>
                  {orderable
                    .filter((f) => f.type !== "money" && f.type !== "number")
                    .map((f) => (
                      <option
                        key={f.key}
                        value={f.key}
                        disabled={
                          def.groupBy.includes(f.key) &&
                          def.groupBy[lvl] !== f.key
                        }
                      >
                        {f.label}
                      </option>
                    ))}
                </Select>
              ) : null,
            )}
          </div>
        </Field>
        <Field
          label="Sort by"
          hint="Up to three; groups sort the same way when they're also sorted."
        >
          <div className="space-y-1.5">
            {def.sort.map((s, i) => (
              <div key={i} className="flex gap-1.5">
                <Select
                  aria-label={`Sort ${i + 1}`}
                  disabled={!editable}
                  value={s.field}
                  onChange={(e) =>
                    update({
                      sort: def.sort.map((x, j) =>
                        j === i ? { ...x, field: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {orderable.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={`Sort ${i + 1} direction`}
                  className="w-36"
                  disabled={!editable}
                  value={s.dir}
                  onChange={(e) =>
                    update({
                      sort: def.sort.map((x, j) =>
                        j === i
                          ? { ...x, dir: e.target.value as "asc" | "desc" }
                          : x,
                      ),
                    })
                  }
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </Select>
                {editable && (
                  <button
                    type="button"
                    aria-label="Remove sort"
                    className="px-1.5 text-zinc-500 hover:text-red-700"
                    onClick={() =>
                      update({ sort: def.sort.filter((_, j) => j !== i) })
                    }
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {editable && def.sort.length < 3 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  update({
                    sort: [
                      ...def.sort,
                      { field: orderable[0]?.key ?? "name", dir: "asc" },
                    ],
                  })
                }
              >
                + Add a sort
              </Button>
            )}
          </div>
        </Field>
      </div>
      <div className="flex flex-wrap gap-6">
        <Toggle
          label="Summary only"
          hint={`One line per group with its ${noun} count and totals.`}
          disabled={!editable || !def.groupBy.length}
          checked={def.summary}
          onChange={(summary) => update({ summary })}
        />
        <Toggle
          label="Grand total"
          hint="A total line for the columns that have a total."
          disabled={!editable}
          checked={def.totals}
          onChange={(totals) => update({ totals })}
        />
      </div>
    </Section>
  );

  const eventTypesCard = (
    <Section
      title="Event types"
      subtitle="Leave empty for every logged event, or pick whole categories and single events."
      action={
        def.eventTypes.length > 0 ? (
          <Badge tone="blue">{def.eventTypes.length} picked</Badge>
        ) : undefined
      }
    >
      <Chips
        disabled={!editable}
        options={o.eventTypes
          .filter((t) => !t.key.includes("."))
          .map((t) => ({ id: t.key, name: t.label }))}
        selected={pickedCats}
        onToggle={(id) => update({ eventTypes: toggle(def.eventTypes, id) })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Add an event"
          className="w-72"
          disabled={!editable}
          value=""
          onChange={(e) =>
            e.target.value &&
            update({ eventTypes: [...def.eventTypes, e.target.value] })
          }
        >
          <option value="">Add one event…</option>
          {o.eventTypes
            .filter(
              (t) =>
                t.key.includes(".") &&
                !def.eventTypes.includes(t.key) &&
                !pickedCats.includes(t.category),
            )
            .map((t) => (
              <option key={t.key} value={t.key}>
                {typeLabel.get(t.category) ?? t.category} · {t.label}
              </option>
            ))}
        </Select>
        {pickedEvents.map((k) => (
          <Badge key={k} tone="blue">
            {typeLabel.get(k) ?? k}
            {editable && (
              <button
                type="button"
                className="ml-1"
                aria-label={`Remove ${typeLabel.get(k) ?? k}`}
                onClick={() =>
                  update({ eventTypes: def.eventTypes.filter((t) => t !== k) })
                }
              >
                ×
              </button>
            )}
          </Badge>
        ))}
      </div>
    </Section>
  );

  const filtersCard = (
    <Section
      title="Filters"
      subtitle="The client list's and Campaign Center's filters. They look at each client's whole history, whatever the report's dates."
      action={filters > 0 ? <Badge tone="blue">{filters} on</Badge> : undefined}
    >
      {o.filters ? (
        <SegmentFilters
          seg={def.filter}
          onChange={(x) => update({ filter: { ...def.filter, ...x } })}
          options={o.filters}
          sees={o.sees}
          disabled={!editable}
        />
      ) : filters > 0 ? (
        <p className="text-sm text-zinc-600">
          This report has {filters} filter{filters === 1 ? "" : "s"}. Changing
          them needs &quot;Use advanced client filters&quot;.
        </p>
      ) : (
        <p className="text-sm text-zinc-500">
          Filtering needs &quot;Use advanced client filters&quot;.
        </p>
      )}
    </Section>
  );

  const resultCard = (
    <Card>
      <CardHeader
        title={
          result
            ? `${result.total.toLocaleString("en-US")} ${def.summary && def.groupBy.length ? "group" : noun}${result.total === 1 ? "" : "s"}`
            : "Preview"
        }
        subtitle={
          result ? `${result.rangeLabel} · ${result.scopeLabel}` : "Running…"
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {loading && (
              <span className="text-xs text-zinc-400">Updating…</span>
            )}
            {preview?.blast && (
              <Link
                className={buttonClass("secondary", "sm")}
                href={`/admin/campaign-center/blasts/new?f=${encodeURIComponent(preview.blast.f)}${preview.blast.shops ? `&shops=${preview.blast.shops}` : ""}`}
                title={preview.blast.notes.join(" ")}
              >
                Message these clients
              </Link>
            )}
            {FORMATS.filter((f): f is ExportFormat => f !== "none").map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant="secondary"
                disabled={pending || !!exportNote}
                title={
                  exportNote ??
                  `Download the whole report as ${FORMAT_LABEL[f]}`
                }
                onClick={() => doExport(f)}
              >
                {FORMAT_LABEL[f]}
              </Button>
            ))}
          </div>
        }
      />
      {runError && (
        <div className="p-4">
          <Notice tone="red">{runError}</Notice>
        </div>
      )}
      {preview && preview.notes.length > 0 && (
        <div className="px-4 pt-3">
          <Notice tone="blue">{preview.notes.join(" ")}</Notice>
        </div>
      )}
      {result &&
        !runError &&
        (result.lines.length ? (
          <ResultTable r={result} summary={def.summary} />
        ) : (
          <p className="p-6 text-center text-sm text-zinc-500">
            No {noun}s match.
          </p>
        ))}
      {result && pages > 1 && (
        <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-2 text-sm">
          <span className="text-zinc-500">
            Page {result.page} of {pages.toLocaleString("en-US")}
          </span>
          <span className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </span>
        </div>
      )}
      {exportNote && (
        <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
          {exportNote}.
        </p>
      )}
    </Card>
  );

  const saveCard = editable && (
    <Section
      title={saved ? "Save changes" : "Save this report"}
      subtitle="Saved reports keep their columns, filters, grouping, dates and scope. Whoever opens one sees it through their own access."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={name}
            maxLength={80}
            placeholder="Lapsed regulars at Kimberly"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Description">
          <Textarea
            rows={1}
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Who can open it">
        <div className="flex flex-wrap gap-4 text-sm">
          {VISIBILITIES.map((v) => (
            <label
              key={v}
              className={cx(
                "flex items-center gap-1.5",
                v === "template" && !o.may.template && "opacity-50",
              )}
              title={
                v === "template" && !o.may.template
                  ? "Brand templates are for people with access to all shops"
                  : undefined
              }
            >
              <input
                type="radio"
                name="visibility"
                checked={visibility === v}
                disabled={v === "template" && !o.may.template}
                onChange={() => setVisibility(v)}
              />
              {VISIBILITY_LABEL[v]}
            </label>
          ))}
        </div>
        {visibility === "roles" && (
          <div className="mt-2">
            <Chips
              options={o.roles}
              selected={roleIds}
              onToggle={(id) => setRoleIds(toggle(roleIds, id))}
            />
          </div>
        )}
      </Field>
      <Field
        label="Email it"
        hint="Each recipient gets it as they may see it; the file is attached only for people who may export it, and a customer report also needs “Export the client list”."
      >
        <Select
          value={schedule?.frequency ?? ""}
          onChange={(e) =>
            setSchedule(
              e.target.value
                ? {
                    ...(schedule ?? DEFAULT_SCHEDULE(o.me)),
                    frequency: e.target.value as ReportSchedule["frequency"],
                  }
                : null,
            )
          }
        >
          <option value="">Don&apos;t email it</option>
          {FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {FREQ_LABEL[f]}
            </option>
          ))}
        </Select>
        {schedule && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {schedule.frequency === "weekly" && (
                <Select
                  aria-label="Day of the week"
                  className="w-40"
                  value={schedule.weekday}
                  onChange={(e) =>
                    setSchedule({
                      ...schedule,
                      weekday: Number(e.target.value),
                    })
                  }
                >
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </Select>
              )}
              {schedule.frequency === "monthly" && (
                <Select
                  aria-label="Day of the month"
                  className="w-28"
                  value={schedule.monthDay}
                  onChange={(e) =>
                    setSchedule({
                      ...schedule,
                      monthDay: Number(e.target.value),
                    })
                  }
                >
                  {Array.from({ length: 28 }, (_, i) => (
                    <option key={i} value={i + 1}>
                      Day {i + 1}
                    </option>
                  ))}
                </Select>
              )}
              <span className="text-zinc-500">at</span>
              <Input
                type="time"
                aria-label="Time"
                className="w-32"
                value={clock(schedule.timeMin)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map(Number);
                  if (Number.isFinite(h) && Number.isFinite(m))
                    setSchedule({ ...schedule, timeMin: h * 60 + m });
                }}
              />
              <span className="text-zinc-500">with</span>
              <Select
                aria-label="Attachment"
                className="w-40"
                value={schedule.format}
                onChange={(e) =>
                  setSchedule({
                    ...schedule,
                    format: e.target.value as ReportSchedule["format"],
                  })
                }
              >
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABEL[f]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <span className="block text-xs text-zinc-500">To</span>
              <Chips
                options={o.recipients}
                selected={schedule.recipients}
                onToggle={(id) =>
                  setSchedule({
                    ...schedule,
                    recipients: toggle(schedule.recipients, id),
                  })
                }
              />
            </div>
          </div>
        )}
      </Field>
      <Toggle
        label="Show its totals in the Morning Dashboard"
        hint="For you and anyone it's emailed to who gets the Morning Dashboard. Totals only, never a client's row."
        checked={morning}
        onChange={setMorning}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={pending} onClick={save}>
          {saved ? "Save changes" : "Save report"}
        </Button>
        {saved && (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={duplicate}
            >
              Duplicate
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={remove}
            >
              Delete
            </Button>
          </>
        )}
        {done && <span className="text-sm text-emerald-700">{done}</span>}
      </div>
    </Section>
  );

  return (
    <div className="space-y-4">
      {error && <Notice tone="red">{error}</Notice>}
      {saved && !editable && (
        <Notice tone="blue">
          {saved.owner}&apos;s report
          {saved.visibility === "template" ? ", a brand template" : ""}. You see
          it through your own access; you can look at other dates
          {o.may.build ? ", or duplicate it to change it" : ""}.
          {o.may.build && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="ml-3"
              disabled={pending}
              onClick={duplicate}
            >
              Duplicate to change it
            </Button>
          )}
        </Notice>
      )}
      <div
        className={cx(
          "grid gap-4",
          editable && "lg:grid-cols-[17rem_minmax(0,1fr)]",
        )}
      >
        {editable && (
          <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
            <Card className="p-3">
              <Field label="Data source">
                <Select
                  value={def.source}
                  onChange={(e) =>
                    update({
                      ...defaultReport(e.target.value),
                      range: def.range,
                      shops: def.shops,
                      staff: def.staff,
                    })
                  }
                >
                  {o.sources.map((s) => (
                    <option key={s.key} value={s.key} disabled={!s.ready}>
                      {s.label}
                      {s.ready
                        ? ""
                        : s.key === "events"
                          ? " (needs event log access)"
                          : " (coming next)"}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="mt-1 text-xs text-zinc-500">
                {o.sources.find((s) => s.key === def.source)?.hint}
              </p>
            </Card>
            <Card className="p-3" data-testid="field-picker">
              <Input
                aria-label="Search fields"
                placeholder="Search fields"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <div className="mt-2 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
                {FIELD_GROUPS.map((g) => {
                  const fs = shown.filter((f) => f.group === g);
                  if (!fs.length) return null;
                  return (
                    <div key={g}>
                      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                        {g}
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {fs.map((f) => {
                          const off = f.use.use === "none";
                          return (
                            <li key={f.key}>
                              <label
                                className={cx(
                                  "flex items-center gap-2 rounded px-1.5 py-1 text-sm",
                                  off
                                    ? "cursor-not-allowed text-zinc-400"
                                    : "hover:bg-zinc-50",
                                )}
                                title={
                                  f.use.use === "none" ? f.use.why : f.hint
                                }
                              >
                                <input
                                  type="checkbox"
                                  disabled={
                                    off ||
                                    (inColumns.has(f.key) &&
                                      def.columns.length === 1)
                                  }
                                  checked={inColumns.has(f.key)}
                                  onChange={() => addField(f.key)}
                                />
                                <span className="flex-1">{f.label}</span>
                                {f.use.use === "masked" && (
                                  <Badge tone="amber">masked</Badge>
                                )}
                                {off && <Badge>hidden</Badge>}
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </Card>
          </aside>
        )}
        <div className="min-w-0 space-y-4">
          {columnsCard}
          {rowsCard}
          {events ? eventTypesCard : filtersCard}
          {resultCard}
          {saveCard}
        </div>
      </div>
    </div>
  );
}
