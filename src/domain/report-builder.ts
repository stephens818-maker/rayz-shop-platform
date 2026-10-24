/**
 * The custom report builder. Pure: the data sources, the fields each one offers, a report's
 * definition (columns, filters, sort, grouping, totals, dates, locations and barbers), which
 * fields a person may use and how, cell formatting, email schedules, and turning a customer
 * report into a Campaign Center segment. The server builds SQL only from these whitelisted
 * fields (src/server/report-builder/engine.ts); nothing in a definition is ever run as SQL.
 */
import { z } from "zod";
import { LocalDate, addDays, formatDate, weekdayOf } from "@/lib/time";
import { filterSees, type PanelSees } from "./client-filters";
import { BUILTIN_FIELDS, type FieldKey, type Level } from "./client-privacy";
import { EMPTY_SEGMENT, SegmentSchema, filterCount, segmentProblem, type Segment } from "./marketing";
import { PRESETS, presetRange } from "./report-range";

// ───────────────────────────── Sources ─────────────────────────────

export const REPORT_SOURCES = [
  { key: "customers", label: "Customers", ready: true, hint: "One row per client: profile, contact details as you may see them, visits, spend, loyalty and marketing." },
  { key: "sales", label: "Sales", ready: false, hint: "One row per ticket or line: services, products, discounts, refunds and tenders." },
  { key: "appointments", label: "Appointments", ready: false, hint: "One row per appointment: booked and actual times, source, status and the barber." },
  { key: "staff", label: "Staff", ready: false, hint: "One row per barber: hours, sales, rebook rate and utilization." },
  { key: "inventory", label: "Inventory", ready: false, hint: "One row per product and location: stock, value, sell-through and shrink." },
  { key: "tips", label: "Tips", ready: false, hint: "One row per tip: who earned it, how it was paid and when." },
  { key: "campaigns", label: "Campaigns", ready: false, hint: "One row per Campaign Center message: sends, clicks, bookings and revenue." },
] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number]["key"];
export const SOURCE_KEYS = REPORT_SOURCES.map((s) => s.key) as [ReportSource, ...ReportSource[]];
export const sourceLabel = (s: string) => REPORT_SOURCES.find((x) => x.key === s)?.label ?? s;

// ───────────────────────────── Fields ─────────────────────────────

/** `number` is a decimal (days between visits); `stars` an average rating; `list` several names. */
export const FIELD_TYPES = ["text", "int", "number", "money", "date", "stars", "bool", "list"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const AGGS = ["none", "sum", "avg", "count", "min", "max"] as const;
export type Agg = (typeof AGGS)[number];
export const AGG_LABEL: Record<Agg, string> = { none: "No total", sum: "Sum", avg: "Average", count: "Count", min: "Lowest", max: "Highest" };

const NUMERIC = new Set<FieldType>(["int", "number", "money"]);
/** Which totals make sense for a field: sums of money and counts, averages of ratings, the earliest and latest date. Counting filled-in values works for anything. */
export function aggsFor(t: FieldType): Agg[] {
  if (NUMERIC.has(t)) return ["none", "sum", "avg", "count", "min", "max"];
  if (t === "stars") return ["none", "avg", "count", "min", "max"];
  if (t === "date") return ["none", "count", "min", "max"];
  return ["none", "count"];
}

export const FIELD_GROUPS = ["Client", "Contact", "Profile", "Family", "Visits", "Spend", "Loyalty and gift cards", "Marketing", "Custom fields"] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];

export interface FieldDef {
  key: string;
  label: string;
  group: FieldGroup;
  type: FieldType;
  hint?: string;
  /** The protected client detail it shows; its level under Client data decides who may use it. */
  reads?: FieldKey;
  /** What a masked detail still shows is the real value here (an address's town and zip, the average rating), so it can be sorted, grouped and totalled. */
  maskedShows?: boolean;
  /** Spend, tips and gift cards: only for people who see every client (as with the money filters). */
  money?: boolean;
  /** Counts what happened, so it covers the report's dates, locations and barbers. Everything else is the client as they are now. */
  activity?: boolean;
}

export const CUSTOMER_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", group: "Client", type: "text" },
  { key: "first_name", label: "First name", group: "Client", type: "text" },
  { key: "last_name", label: "Last name", group: "Client", type: "text" },
  { key: "nickname", label: "Nickname", group: "Client", type: "text" },
  { key: "number", label: "Client #", group: "Client", type: "int" },
  { key: "phone", label: "Phone", group: "Contact", type: "text", reads: "phone" },
  { key: "email", label: "Email", group: "Contact", type: "text", reads: "email" },
  { key: "address", label: "Address", group: "Contact", type: "text", reads: "address" },
  { key: "city", label: "City", group: "Contact", type: "text", reads: "address", maskedShows: true },
  { key: "zip", label: "Zip", group: "Contact", type: "text", reads: "address", maskedShows: true },
  { key: "birthday", label: "Birthday", group: "Contact", type: "date", reads: "birthday" },
  { key: "tags", label: "Tags", group: "Profile", type: "list" },
  { key: "badges", label: "Badges", group: "Profile", type: "list", hint: "The client's badges as of the last nightly run (or their last checkout): only the ones you see." },
  { key: "rating", label: "Staff rating", group: "Profile", type: "stars", reads: "ratings", maskedShows: true, hint: "The average of every staff rating." },
  { key: "home_location", label: "Home location", group: "Profile", type: "text" },
  { key: "primary_barber", label: "Primary barber", group: "Profile", type: "text", reads: "preferred_barber", hint: "The preferred barber on their profile, or who cut them last." },
  { key: "source", label: "Source", group: "Profile", type: "text" },
  { key: "created", label: "Client since", group: "Profile", type: "date" },
  { key: "is_child", label: "Child profile", group: "Family", type: "bool", hint: "A child on a parent's family account." },
  { key: "parent", label: "Parent", group: "Family", type: "text", hint: "The parent whose account a child is on." },
  { key: "kids", label: "Kids on account", group: "Family", type: "int", hint: "Children on this client's family account." },
  { key: "first_visit", label: "First visit", group: "Visits", type: "date", activity: true },
  { key: "last_visit", label: "Last visit", group: "Visits", type: "date", activity: true },
  { key: "visits", label: "Visits", group: "Visits", type: "int", activity: true, hint: "Completed appointments." },
  {
    key: "avg_gap_days",
    label: "Average days between visits",
    group: "Visits",
    type: "number",
    activity: true,
    hint: "The median of the last 10 gaps between visit days, so one long break doesn't skew it. Needs two visits.",
  },
  { key: "cadence_label", label: "Comes in", group: "Visits", type: "text", activity: true, hint: 'Their average time between visits in words, e.g. "Every 3.5 weeks".' },
  { key: "days_since_visit", label: "Days since last visit", group: "Visits", type: "int", activity: true },
  { key: "next_visit_due", label: "Next expected visit", group: "Visits", type: "date", activity: true, hint: "Last visit plus their average time between visits." },
  {
    key: "visit_status",
    label: "Visit status",
    group: "Visits",
    type: "text",
    activity: true,
    hint: "On track, due (from 3 days before their next expected visit) or overdue (a week, or a quarter of their gap, after it). Anyone booked is on track.",
  },
  { key: "no_shows", label: "No-shows", group: "Visits", type: "int", activity: true },
  { key: "cancellations", label: "Cancellations", group: "Visits", type: "int", activity: true },
  { key: "total_spend", label: "Total spend", group: "Spend", type: "money", money: true, activity: true, hint: "Services and products on paid tickets, less refunds." },
  { key: "avg_spend", label: "Average spend per ticket", group: "Spend", type: "money", money: true, activity: true },
  { key: "tickets", label: "Paid tickets", group: "Spend", type: "int", money: true, activity: true },
  { key: "tips", label: "Tips", group: "Spend", type: "money", money: true, activity: true, hint: "Less refunded tips." },
  { key: "services_bought", label: "Services bought", group: "Spend", type: "list", activity: true },
  { key: "products_bought", label: "Products bought", group: "Spend", type: "list", activity: true },
  { key: "loyalty_balance", label: "Loyalty rewards available", group: "Loyalty and gift cards", type: "money" },
  { key: "gift_cards", label: "Gift cards", group: "Loyalty and gift cards", type: "int", money: true, hint: "Gift cards on their profile that aren't void." },
  { key: "gift_card_balance", label: "Gift card balance", group: "Loyalty and gift cards", type: "money", money: true },
  { key: "coupons_redeemed", label: "Coupons redeemed", group: "Loyalty and gift cards", type: "int", activity: true },
  { key: "sms_opt_in", label: "Appointment texts", group: "Marketing", type: "bool", hint: "Agreed to appointment texts when booking." },
  { key: "email_opt_in", label: "Appointment emails", group: "Marketing", type: "bool" },
  { key: "sms_marketing", label: "Marketing texts", group: "Marketing", type: "bool", hint: "Agreed to marketing texts in the customer app." },
  { key: "email_marketing", label: "Marketing emails", group: "Marketing", type: "bool" },
  { key: "push_marketing", label: "Marketing push", group: "Marketing", type: "bool" },
  { key: "campaigns_received", label: "Campaign messages received", group: "Marketing", type: "int", activity: true },
  { key: "campaigns_clicked", label: "Campaign messages clicked", group: "Marketing", type: "int", activity: true },
  { key: "review_clicks", label: "Google review clicks", group: "Marketing", type: "int", activity: true },
];
const BY_KEY = new Map(CUSTOMER_FIELDS.map((f) => [f.key, f]));

export const isCustomField = (key: string) => /^custom:[0-9a-f-]{36}$/.test(key);
export const customDef = (c: { id: string; label: string }): FieldDef => ({ key: `custom:${c.id}`, label: c.label, group: "Custom fields", type: "text", reads: `custom:${c.id}` });

/** The field, or null when it isn't one the source offers (or a custom field that's gone). */
export function fieldDef(key: string, custom: readonly { id: string; label: string }[]): FieldDef | null {
  if (isCustomField(key)) {
    const c = custom.find((x) => `custom:${x.id}` === key);
    return c ? customDef(c) : null;
  }
  return BY_KEY.get(key) ?? null;
}

export const allFields = (custom: readonly { id: string; label: string }[]) => [...CUSTOMER_FIELDS, ...custom.map(customDef)];

/** How one person may use a field: in full, masked (shown as Client data masks it), or not at all and why. */
export type FieldUse = { use: "full" } | { use: "masked" } | { use: "none"; why: string };

export function fieldUse(f: FieldDef, sees: PanelSees): FieldUse {
  if (f.money && !sees.money) return { use: "none", why: "Spend, tips and gift cards need access to every client" };
  if (f.key === "badges" && !sees.badges?.length) return { use: "none", why: "No client badges are shown to you" };
  if (!f.reads) return { use: "full" };
  const level: Level = sees.levels[f.reads] ?? "hidden";
  const name = f.reads.startsWith("custom:") ? f.label : (BUILTIN_FIELDS.find((b) => b.key === f.reads)?.label ?? f.label);
  if (level === "hidden") return { use: "none", why: `${name} is hidden from you under Client data` };
  if (level === "masked") return f.maskedShows ? { use: "full" } : { use: "masked" };
  return { use: "full" };
}

// ───────────────────────────── Definition ─────────────────────────────

export const RANGE_PRESETS: { id: string; label: string }[] = [{ id: "all", label: "All time" }, ...PRESETS, { id: "custom", label: "Custom dates" }];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .default(null);
const fieldKey = z.string().trim().min(1).max(80);

export const ReportColumn = z.object({
  field: fieldKey,
  /** The header; empty uses the field's name. */
  label: z.string().trim().max(60, "Keep column names under 60 characters").default(""),
  agg: z.enum(AGGS).default("none"),
});
export type ReportColumn = z.output<typeof ReportColumn>;

export const ReportDefinition = z.object({
  source: z.enum(SOURCE_KEYS).default("customers"),
  columns: z.array(ReportColumn).min(1, "Add at least one column").max(40, "Up to 40 columns"),
  /** The segment builder's filters, over the client's whole history. */
  filter: SegmentSchema.default(EMPTY_SEGMENT),
  sort: z
    .array(z.object({ field: fieldKey, dir: z.enum(["asc", "desc"]).default("asc") }))
    .max(3, "Sort by up to three fields")
    .default([]),
  groupBy: z.array(fieldKey).max(2, "Group by up to two fields").default([]),
  /** One row per group with its totals, instead of every client under each group. */
  summary: z.boolean().default(false),
  totals: z.boolean().default(true),
  range: z
    .object({ preset: z.string().max(20).default("all"), from: isoDate, to: isoDate })
    .default({ preset: "all", from: null, to: null }),
  /** "visited": only clients with a completed visit in the dates, at the locations, with the barbers. "all": every client they reach there. */
  rows: z.enum(["all", "visited"]).default("all"),
  /** The report's `shop` value: "all", "group:<id>", shop ids; null for the location the viewer is working in. */
  shops: z.string().max(4000).nullable().default(null),
  /** The report's `staff` value: "group:<id>" or staff ids; null for every barber. */
  staff: z.string().max(4000).nullable().default(null),
});
export type ReportDefinition = z.output<typeof ReportDefinition>;

export const DEFAULT_CUSTOMER_REPORT: ReportDefinition = ReportDefinition.parse({
  columns: [{ field: "name" }, { field: "home_location" }, { field: "last_visit" }, { field: "visits", agg: "sum" }],
  sort: [{ field: "last_visit", dir: "desc" }],
});

export const columnLabel = (c: ReportColumn, f: FieldDef | null) => c.label || f?.label || "Removed field";

/** The date range a report covers on a given day, or null for all time. */
export function reportRange(r: ReportDefinition["range"], today: LocalDate): { from: LocalDate; to: LocalDate } | null {
  if (r.preset === "all") return null;
  if (r.preset === "custom") {
    if (!r.from || !r.to) return null;
    return r.from <= r.to ? { from: r.from, to: r.to } : { from: r.to, to: r.from };
  }
  return presetRange(r.preset, today);
}

export function rangeLabel(r: ReportDefinition["range"], today: LocalDate): string {
  const d = reportRange(r, today);
  if (!d) return "All time";
  const preset = PRESETS.find((p) => p.id === r.preset)?.label;
  const dates = d.from === d.to ? formatDate(d.from, "MMM d, yyyy") : `${formatDate(d.from, "MMM d")} – ${formatDate(d.to, "MMM d, yyyy")}`;
  return preset ? `${preset} (${dates})` : dates;
}

/** Whether a field can order or group rows for this person: only values they see as they really are. */
const ordersBy = (f: FieldDef, sees: PanelSees) => fieldUse(f, sees).use === "full" && f.type !== "list";

/**
 * Why a report can't run for this person, or null. A column on a hidden detail, money without
 * every client, or sorting, grouping or totalling a masked value (which would give away what the
 * mask hides) is refused, and so is any filter the segment builder would refuse them.
 */
export function definitionProblem(def: ReportDefinition, sees: PanelSees, custom: readonly { id: string; label: string }[], o: { filters: boolean } = { filters: true }): string | null {
  const src = REPORT_SOURCES.find((s) => s.key === def.source);
  if (!src?.ready) return `${sourceLabel(def.source)} reports are coming next. Customer reports are ready now.`;
  const known = (key: string) => fieldDef(key, custom);
  for (const c of def.columns) {
    const f = known(c.field);
    if (!f) return `"${c.label || c.field}" isn't a field this report can show anymore. Remove the column.`;
    const u = fieldUse(f, sees);
    if (u.use === "none") return `You can't add "${f.label}": ${u.why.charAt(0).toLowerCase()}${u.why.slice(1)}`;
    if (!aggsFor(f.type).includes(c.agg)) return `"${columnLabel(c, f)}" can't be totalled as ${AGG_LABEL[c.agg].toLowerCase()}`;
    if (u.use === "masked" && c.agg !== "none" && c.agg !== "count") return `"${columnLabel(c, f)}" is masked for you, so it can only be counted`;
  }
  for (const s of def.sort) {
    const f = known(s.field);
    if (!f) return "One of the sort fields isn't available anymore";
    if (!ordersBy(f, sees)) return f.type === "list" ? `Lists like "${f.label}" can't be sorted` : `You can't sort by "${f.label}" because you don't see it in full`;
  }
  for (const g of def.groupBy) {
    const f = known(g);
    if (!f) return "One of the grouping fields isn't available anymore";
    if (!ordersBy(f, sees)) return f.type === "list" ? `Lists like "${f.label}" can't be grouped` : `You can't group by "${f.label}" because you don't see it in full`;
  }
  if (new Set(def.groupBy).size < def.groupBy.length) return "Group by two different fields";
  if (def.summary && !def.groupBy.length) return "Pick a field to group by for a summary";
  if (def.range.preset === "custom" && (!def.range.from || !def.range.to)) return "Pick both dates for a custom range";
  if (def.range.preset !== "all" && def.range.preset !== "custom" && !PRESETS.some((p) => p.id === def.range.preset)) return "Pick a date range";
  if (!o.filters && filterCount(def.filter) > 0) return "Filters need \"Use advanced client filters\"";
  return segmentProblem(def.filter, filterSees(sees));
}

export const parseDefinition = (raw: unknown) => ReportDefinition.safeParse(raw);

/** A definition in a link (base64url JSON), for "Open in the report builder". */
export const encodeDefinition = (def: ReportDefinition) => Buffer.from(JSON.stringify(def), "utf8").toString("base64url");
export function decodeDefinition(s: string): ReportDefinition | null {
  try {
    const r = ReportDefinition.safeParse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── Results ─────────────────────────────

export type Cell = string | number | boolean | string[] | null;

export interface ResultColumn {
  key: string;
  label: string;
  type: FieldType;
  agg: Agg;
  /** Shown as Client data masks it: the cells are already the masked text. */
  masked: boolean;
}

/** A client's row, or a group's header with its client count and totals (in the columns that have one). */
export type ResultLine = { kind: "row"; id: string; cells: Cell[] } | { kind: "group"; level: number; values: string[]; count: number; cells: Cell[]; continued?: boolean };

export interface ReportResult {
  columns: ResultColumn[];
  groupBy: { key: string; label: string; type: FieldType }[];
  lines: ResultLine[];
  /** Clients, or groups in a summary. */
  total: number;
  page: number;
  pageSize: number;
  /** The whole report's totals, when any column has one. */
  totals: { count: number; cells: Cell[] } | null;
  rangeLabel: string;
  scopeLabel: string;
  /** More rows than an export takes. */
  truncated: boolean;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** A cell as it reads on the page, in an email and in a PDF. */
export function cellText(type: FieldType, v: Cell, masked = false): string {
  if (v === null || v === undefined || v === "") return "";
  if (masked) return String(v);
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  switch (type) {
    case "money":
      return usd.format(Number(v) / 100);
    case "int":
      return Math.round(Number(v)).toLocaleString("en-US");
    case "number":
      return (Math.round(Number(v) * 10) / 10).toLocaleString("en-US");
    case "stars":
      return Number(v).toFixed(1);
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v, "MMM d, yyyy") : String(v);
    default:
      return String(v);
  }
}

/** A cell for CSV and Excel: plain numbers (dollars with cents), ISO dates, lists separated by semicolons. */
export function cellValue(type: FieldType, v: Cell, masked = false): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (masked) return String(v);
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (type === "money") return Math.round(Number(v)) / 100;
  if (type === "number" || type === "stars") return Math.round(Number(v) * 100) / 100;
  if (type === "int") return Number(v);
  return String(v);
}

/** The header of a total: "Sum of Total spend". */
export const totalHeader = (c: ResultColumn) => (c.agg === "none" ? c.label : `${AGG_LABEL[c.agg]} of ${c.label}`);

/** The type a column's total is in: a count is a whole number, the rest keep the column's type. */
export const totalType = (c: ResultColumn): FieldType => (c.agg === "count" ? "int" : c.type === "int" && c.agg === "avg" ? "number" : c.type);

export interface FlatTable {
  headers: string[];
  /** Each column's type on a client's row, and on a subtotal or total line (a count is a whole number). */
  types: FieldType[];
  totalTypes: FieldType[];
  /** Masked on a client's row: the cell is already the masked text. */
  masked: boolean[];
  rows: { kind: "row" | "group" | "total"; level: number; cells: Cell[] }[];
}

const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

/**
 * The report as one flat table for CSV, Excel and PDF. Grouped, each row carries its group values
 * and each group gets a subtotal line before its clients; a summary is one line per group with
 * its client count and the totalled columns. The grand total comes last.
 */
export function flatTable(r: Pick<ReportResult, "columns" | "groupBy" | "lines" | "totals">, summary: boolean): FlatTable {
  const g = r.groupBy;
  if (summary && g.length) {
    const cols = r.columns.map((c, i) => ({ c, i })).filter((x) => x.c.agg !== "none");
    const rows: FlatTable["rows"] = r.lines.flatMap((l) => (l.kind === "group" ? [{ kind: "row" as const, level: 0, cells: [...l.values, l.count, ...cols.map((x) => l.cells[x.i])] }] : []));
    if (r.totals) rows.push({ kind: "total", level: 0, cells: [`Total (${plural(r.totals.count, "client")})`, ...g.slice(1).map(() => null), r.totals.count, ...cols.map((x) => r.totals!.cells[x.i])] });
    return {
      headers: [...g.map((x) => x.label), "Clients", ...cols.map((x) => totalHeader(x.c))],
      types: [...g.map(() => "text" as FieldType), "int", ...cols.map((x) => totalType(x.c))],
      totalTypes: [...g.map(() => "text" as FieldType), "int", ...cols.map((x) => totalType(x.c))],
      masked: [...g.map(() => false), false, ...cols.map(() => false)],
      rows,
    };
  }
  const lead = !g.length && !!r.totals;
  const headers = [...(lead ? [""] : []), ...g.map((x) => x.label), ...r.columns.map((c) => c.label)];
  const types: FieldType[] = [...(lead ? ["text" as FieldType] : []), ...g.map(() => "text" as FieldType), ...r.columns.map((c) => c.type)];
  const masked = [...(lead ? [false] : []), ...g.map(() => false), ...r.columns.map((c) => c.masked)];
  const rows: FlatTable["rows"] = [];
  let current: string[] = [];
  for (const l of r.lines) {
    if (l.kind === "group") {
      current = [...current.slice(0, l.level), l.values[l.level]];
      const vals = g.map((_, i) => (i < l.level ? l.values[i] : i === l.level ? `${l.values[i]} (subtotal, ${plural(l.count, "client")})` : null));
      rows.push({ kind: "group", level: l.level, cells: [...vals, ...l.cells.map((c, i) => (r.columns[i].agg === "none" ? null : c))] });
    } else rows.push({ kind: "row", level: 0, cells: [...(lead ? [null] : []), ...g.map((_, i) => current[i] ?? null), ...l.cells] });
  }
  if (r.totals) {
    const label = `Total (${plural(r.totals.count, "client")})`;
    rows.push({ kind: "total", level: 0, cells: [...(lead ? [label] : g.map((_, i) => (i === 0 ? label : null))), ...r.totals.cells] });
  }
  const totalTypes: FieldType[] = [...(lead ? ["text" as FieldType] : []), ...g.map(() => "text" as FieldType), ...r.columns.map(totalType)];
  return { headers, types, totalTypes, masked, rows };
}

// ───────────────────────────── Saving and sharing ─────────────────────────────

export const VISIBILITIES = ["private", "roles", "template"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABEL: Record<Visibility, string> = { private: "Only me", roles: "Shared with roles", template: "Brand template (everyone with custom reports)" };

export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const FORMATS = ["none", "csv", "xlsx", "pdf"] as const;
export type ExportFormat = Exclude<(typeof FORMATS)[number], "none">;
export const FORMAT_LABEL: Record<(typeof FORMATS)[number], string> = { none: "No attachment", csv: "CSV", xlsx: "Excel", pdf: "PDF" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const ReportSchedule = z.object({
  frequency: z.enum(FREQUENCIES),
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  weekday: z.number().int().min(0).max(6).default(1),
  /** Monthly: the day of the month, up to the 28th so every month has it. */
  monthDay: z.number().int().min(1).max(28).default(1),
  /** Local minutes after midnight. */
  timeMin: z.number().int().min(0).max(1439).default(7 * 60),
  /** The file attached for recipients who may export it. */
  format: z.enum(FORMATS).default("csv"),
  /** Staff who get it; each must be able to open the report. */
  recipients: z.array(z.uuid()).max(50, "Up to 50 recipients").default([]),
});
export type ReportSchedule = z.output<typeof ReportSchedule>;

export const SavedReportInput = z.object({
  name: z.string().trim().min(1, "Name the report").max(80, "Keep the name under 80 characters"),
  description: z.string().trim().max(300, "Keep the description under 300 characters").default(""),
  visibility: z.enum(VISIBILITIES).default("private"),
  roleIds: z.array(z.uuid()).max(30).default([]),
  schedule: ReportSchedule.nullable().default(null),
  morning: z.boolean().default(false),
  definition: ReportDefinition,
});
export type SavedReportInput = z.output<typeof SavedReportInput>;

/** Whether a schedule sends on this day. */
export function sendsOn(s: ReportSchedule, day: LocalDate): boolean {
  if (s.frequency === "daily") return true;
  if (s.frequency === "weekly") return weekdayOf(day) === s.weekday;
  return Number(day.slice(8, 10)) === s.monthDay;
}

/** The day this run sends for, or null: it's a sending day and past the time. A late run still sends that day; the next day is a new period. */
export const duePeriod = (s: ReportSchedule, today: LocalDate, nowMin: number): LocalDate | null => (sendsOn(s, today) && nowMin >= s.timeMin ? today : null);

/** The next day it sends, from today on. */
export function nextSend(s: ReportSchedule, today: LocalDate, nowMin: number): LocalDate {
  for (let i = 0; i < 62; i++) {
    const d = addDays(today, i);
    if (sendsOn(s, d) && (i > 0 || nowMin < s.timeMin)) return d;
  }
  return today;
}

const clock = (min: number) => {
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h >= 12 ? "PM" : "AM"}`;
};
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export function scheduleLabel(s: ReportSchedule): string {
  const when = s.frequency === "daily" ? "Every day" : s.frequency === "weekly" ? `Every ${WEEKDAYS[s.weekday]}` : `The ${ordinal(s.monthDay)} of every month`;
  return `${when} at ${clock(s.timeMin)}${s.format === "none" ? "" : `, with ${FORMAT_LABEL[s.format]}`}`;
}

// ───────────────────────────── Campaign Center ─────────────────────────────

/**
 * A customer report's clients as a Campaign Center blast: its filters, its barbers (any visit with
 * them) and, for clients with a visit in a range that runs to today, a last visit since its start.
 * Its locations become the blast's locations, which go by a client's last visit or home location.
 * A range that ended before today can't be written as a segment, so it's left out and the notes say so.
 */
export function segmentFromReport(def: ReportDefinition, scope: { shopIds: string[] | null; staffIds: string[] | null }, today: LocalDate): { segment: Segment; shopIds: string[]; notes: string[] } {
  const seg: Segment = { ...def.filter };
  const notes: string[] = [];
  if (scope.staffIds?.length) {
    seg.staffIds = [...scope.staffIds];
    seg.barberMatch = "any";
  }
  const range = reportRange(def.range, today);
  const visited = def.rows === "visited" || !!scope.staffIds?.length;
  if (visited && range) {
    if (range.to >= today) {
      if (!seg.lastVisitFrom || seg.lastVisitFrom < range.from) seg.lastVisitFrom = range.from;
    } else notes.push("The report's dates end before today, so the blast isn't limited to them. Add a last-visit filter in the blast if you need one.");
  }
  if (scope.shopIds) notes.push("The blast goes to the report's locations, by each client's last visit (or home location when they haven't visited).");
  if (scope.staffIds?.length) notes.push("Barbers become \"any visit with\" those barbers.");
  notes.push("Only clients who agreed to marketing on the blast's channel get it.");
  return { segment: seg, shopIds: scope.shopIds ? [...scope.shopIds] : [], notes };
}
