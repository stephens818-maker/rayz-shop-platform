import "server-only";
import { z } from "zod";
import { db } from "@/db";
import { inArray } from "drizzle-orm";
import { assistantActions, customers } from "@/db/schema";
import {
  ASSISTANT_REPORTS,
  CONTACT_COLUMN,
  PRESET_IDS,
  type AssistantCard,
  type AssistantSettings,
} from "@/domain/assistant";
import { helpFor } from "@/domain/assistant-help";
import { encodeFilter } from "@/domain/client-filters";
import {
  NOTE_KINDS,
  NOTE_KIND_LABEL,
  type NoteKind,
  detailsLine,
  notesMode,
} from "@/domain/client-notes";
import {
  CHANNEL_LABEL,
  STOP_LINE,
  SegmentSchema,
  templatesProblem,
  type Segment,
} from "@/domain/marketing";
import { reportView, type ReportKey } from "@/domain/permissions";
import { EVENTS } from "@/domain/analytics";
import {
  CUSTOMER_FIELDS,
  EVENT_FIELDS,
  EVENT_TYPES,
  ReportDefinition,
  cellText,
  encodeDefinition,
  fieldUse,
  segmentFromReport,
  totalHeader,
  totalType,
  type FieldDef,
} from "@/domain/report-builder";
import { csvTable, type ReportTable } from "@/domain/report-views";
import { REFILL_STATUSES } from "@/domain/product-history";
import { VISIT_STATUSES } from "@/domain/visit-cadence";
import { formatCents } from "@/lib/money";
import { scrub, scrubText } from "@/lib/sensitive";
import { formatDate, todayLocal } from "@/lib/time";
import { resolveScope, selfOnly } from "@/app/admin/reports/scope";
import { can, reasonViewer, type StaffContext } from "../auth/staff";
import { barbersAt } from "../barbers";
import { panelSees, reportSees } from "../client-filters";
import { listNotes, noteViewer, reachesClient } from "../client-notes";
import { findClients } from "../client-search";
import { clientPolicy, recordClientAccess } from "../client-privacy";
import { AppError } from "../errors";
import { suggestionsFor } from "../inventory/purchasing";
import { listLocationGroups, visibleGroups } from "../locations";
import { checkSegment } from "../marketing/campaigns";
import { loadReport } from "../report-data";
import { reportContext } from "../report-access";
import { reportProblem, runReport } from "../report-builder/engine";
import type { ToolSpec } from "./providers";

/**
 * The assistant's tools. Each runs with the asking person's own context, over the same report
 * loaders, custom report engine and Campaign Center and purchasing code the pages use, so it can
 * only reach what they could open themselves. What a tool hands the model is text with client
 * contact details left out and sensitive numbers scrubbed; what the person sees is the card.
 */

export interface ToolEnv {
  ctx: StaffContext;
  settings: AssistantSettings;
  conversationId: string;
  now: Date;
}
export interface ToolResult {
  /** For the model. The first line is a one-sentence summary. */
  content: string;
  cards: AssistantCard[];
  /** Turned down (outside their access, a filter they can't use...), with the reason in `content`. */
  refused?: boolean;
}
export interface AssistantTool {
  name: string;
  spec: ToolSpec;
  args: z.ZodType<Record<string, unknown>>;
  run(env: ToolEnv, args: Record<string, unknown>): Promise<ToolResult>;
}

const ROWS_FOR_MODEL = 40;
const ROWS_ON_CARD = 10;
const MAX_GROUP_ROWS = 200;
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^ray'?z\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD");
const names = (what: string) =>
  z.array(z.string().trim().min(1).max(80)).max(20).optional().describe(what);
const spec = (
  name: string,
  description: string,
  schema: z.ZodType,
): ToolSpec => {
  const { $schema: _s, ...parameters } = z.toJSONSchema(schema, {
    io: "input",
  }) as Record<string, unknown>;
  return { name, description, parameters };
};
const fail = (message: string): ToolResult => ({
  content: `SUMMARY: ${message}`,
  cards: [],
  refused: true,
});

// ───────────────────────────── Locations and barbers by name ─────────────────────────────

/** The `shop` value for location names, matched only among the person's own locations and groups. */
async function locationParam(
  ctx: StaffContext,
  list: string[] | undefined,
): Promise<string | undefined> {
  if (!list?.length) return undefined;
  if (
    list.some((n) =>
      /^(all|every|everywhere|all locations|all shops)$/i.test(n.trim()),
    )
  )
    return "all";
  const groups = visibleGroups(await listLocationGroups(), ctx.shopIds);
  const out: string[] = [];
  for (const raw of list) {
    const n = norm(raw);
    const shop =
      ctx.shops.find((s) => norm(s.name) === n) ??
      ctx.shops.find((s) => n.length >= 3 && norm(s.name).includes(n));
    const group = shop ? null : groups.find((g) => norm(g.name) === n);
    if (shop) out.push(shop.id);
    else if (group) out.push(`group:${group.id}`);
    else
      throw new AppError("forbidden", `"${raw}" isn't one of your locations`);
  }
  return [...new Set(out)].join(",");
}

/** The `staff` value for barber names, among barbers at the person's locations. */
async function barberParam(
  ctx: StaffContext,
  list: string[] | undefined,
): Promise<string | undefined> {
  if (!list?.length) return undefined;
  const visible = await barbersAt(ctx.shopIds);
  const out: string[] = [];
  for (const raw of list) {
    const n = norm(raw);
    const b =
      visible.find((x) => norm(x.name) === n) ??
      visible.find(
        (x) =>
          n.length >= 2 && norm(x.name).split(" ").includes(n.split(" ")[0]),
      );
    if (!b)
      throw new AppError(
        "forbidden",
        `"${raw}" isn't a barber at your locations`,
      );
    out.push(b.id);
  }
  return [...new Set(out)].join(",");
}

// ───────────────────────────── Report text ─────────────────────────────

/** A report table as the model reads it: contact columns dropped, money in dollars, long tables cut. */
export function tableText(t: ReportTable): string {
  const c = csvTable(t);
  const keep = c.headers
    .map((h, i) => (CONTACT_COLUMN.test(h) ? -1 : i))
    .filter((i) => i >= 0);
  const line = (r: (string | number | null)[]) =>
    keep
      .map((i) => (r[i] === null || r[i] === undefined ? "" : String(r[i])))
      .join(" | ");
  const rows = c.rows.slice(0, ROWS_FOR_MODEL).map(line);
  const more = c.rows.length - rows.length;
  return [
    `TABLE ${t.title}${t.subtitle ? ` (${t.subtitle})` : ""}:`,
    keep.map((i) => c.headers[i]).join(" | "),
    ...rows,
    ...(more > 0 ? [`(${more} more rows)`] : []),
  ].join("\n");
}

function cardTable(
  t: ReportTable,
): NonNullable<Extract<AssistantCard, { kind: "report" }>["table"]> {
  const c = csvTable(t);
  const keep = c.headers
    .map((h, i) => (CONTACT_COLUMN.test(h) ? -1 : i))
    .filter((i) => i >= 0);
  const transposed = !!(t.rowKinds && t.totalColumn);
  const kind = (j: number, i: number) =>
    transposed
      ? i > 0
        ? t.rowKinds![i - 1]
        : undefined
      : t.rowKinds?.[j] && i > 0
        ? t.rowKinds[j]
        : t.columns[i]?.kind;
  const show = (v: string | number | null, j: number, i: number) =>
    v === null
      ? ""
      : kind(j, i) === "money" &&
          typeof v === "string" &&
          /^-?\d+\.\d\d$/.test(v)
        ? formatCents(Math.round(Number(v) * 100))
        : String(v);
  return {
    title: t.title,
    headers: keep.map((i) => c.headers[i]),
    rows: c.rows
      .slice(0, ROWS_ON_CARD)
      .map((r, j) => keep.map((i) => show(r[i], j, i))),
    more: Math.max(0, c.rows.length - ROWS_ON_CARD),
  };
}

const rangeText = (from: string, to: string) =>
  from === to
    ? formatDate(from, "MMM d, yyyy")
    : `${formatDate(from, "MMM d")} – ${formatDate(to, "MMM d, yyyy")}`;

// ───────────────────────────── run_report ─────────────────────────────

function runReportTool(ctx: StaffContext): AssistantTool | null {
  const reports = ASSISTANT_REPORTS.filter((r) => can(ctx, reportView(r.key)));
  if (!reports.length) return null;
  const keys = reports.map((r) => r.key) as [ReportKey, ...ReportKey[]];
  const args = z.object({
    report: z.enum(keys).describe("Which report"),
    preset: z
      .enum(PRESET_IDS)
      .optional()
      .describe("A date range; the default is the last 7 days"),
    from: isoDate.optional().describe("Custom start date, with `to`"),
    to: isoDate.optional(),
    locations: names(
      'Location or location group names, or ["all"]. Leave out for where they\'re working now.',
    ),
    barbers: names(
      "Barber names to limit it to. Leave out for every barber they may see.",
    ),
    view: z
      .enum(["combined", "shops", "barbers", "shops_barbers"])
      .optional()
      .describe("combined, by location (shops), by barber, or both"),
  });
  const list = reports
    .map(
      (r) =>
        `${r.key}: ${r.label}${"hint" in r && r.hint ? ` (${r.hint})` : ""}`,
    )
    .join("; ");
  return {
    name: "run_report",
    args,
    spec: spec(
      "run_report",
      `Run one of the reports this person can open and read its numbers. Reports: ${list}.`,
      args,
    ),
    async run({ ctx }, raw) {
      const a = args.parse(raw);
      const report = reports.find((r) => r.key === a.report)!;
      const notes: string[] = [];
      let shop: string | undefined;
      let staffIds: string | undefined;
      const rctx = await reportContext(ctx, report.key);
      try {
        shop = await locationParam(rctx, a.locations);
        if (a.barbers?.length && selfOnly(ctx, a.report))
          notes.push(
            "They only see their own numbers in this report, so other barbers were left out.",
          );
        else staffIds = await barberParam(rctx, a.barbers);
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      const params = {
        preset: a.from && a.to ? undefined : a.preset,
        from: a.from,
        to: a.to,
        shop,
        staff: staffIds,
        view: a.view,
      };
      const scope = await resolveScope(rctx, params, a.report);
      const data = await loadReport(a.report, {
        scope,
        loc: scope.loc,
        viewer: rctx,
        client: await clientPolicy(ctx),
        reasons: reasonViewer(ctx),
        params: { preset: params.preset, from: a.from, to: a.to, view: a.view },
      });
      const where = [
        scope.label,
        scope.barbers && scope.barbers.label !== "All barbers"
          ? scope.barbers.label
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const dates = rangeText(scope.from, scope.to);
      const qs = new URLSearchParams();
      if (scope.preset) qs.set("preset", scope.preset);
      else {
        qs.set("from", scope.from);
        qs.set("to", scope.to);
      }
      if (scope.shopParam) qs.set("shop", scope.shopParam);
      if (scope.staffParam) qs.set("staff", scope.staffParam);
      if (a.view) qs.set("view", a.view);
      const stats = data.stats.map((s) => ({
        label: s.label,
        value: s.value,
        ...(s.hint ? { hint: s.hint } : {}),
      }));
      const tables = data.tables.slice(0, 4);
      const head = stats.length
        ? stats
            .slice(0, 4)
            .map((s) => `${s.label} ${s.value}`)
            .join(", ")
        : tables.length
          ? `${tables[0].rows.length} rows`
          : "nothing to show";
      const content = scrubText(
        [
          `SUMMARY: ${report.label}, ${dates}, ${where}: ${head}.`,
          ...notes,
          ...(data.notes ?? []),
          ...(stats.length
            ? [
                "STATS:",
                ...stats.map(
                  (s) =>
                    `- ${s.label}: ${s.value}${s.hint ? ` (${s.hint})` : ""}`,
                ),
              ]
            : []),
          ...tables.map(tableText),
        ].join("\n"),
      );
      const shown = tables.find((t) => !t.exportOnly) ?? tables[0];
      const card: AssistantCard = {
        kind: "report",
        title: report.label,
        subtitle: `${dates} · ${where}`,
        stats: stats.slice(0, 8),
        table: shown ? cardTable(shown) : null,
        links: [
          { label: `Open ${report.label}`, href: `${report.href}?${qs}` },
        ],
      };
      return { content, cards: [scrub(card)] };
    },
  };
}

// ───────────────────────────── customer_report ─────────────────────────────

/** Fields the assistant may put in a customer report: what the person sees in full, never contact details, birthdays or custom fields. */
export function assistantFields(
  sees: ReturnType<typeof panelSees>,
): FieldDef[] {
  return CUSTOMER_FIELDS.filter(
    (f) =>
      fieldUse(f, sees).use === "full" &&
      !["phone", "email", "address", "birthday"].includes(f.key),
  );
}

const aggOf = (f: FieldDef) =>
  f.key === "days_since_visit"
    ? "avg"
    : f.type === "int" || f.type === "money"
      ? "sum"
      : f.type === "number" || f.type === "stars" || f.type === "pct"
        ? "avg"
        : "none";

async function customerReportTool(
  ctx: StaffContext,
): Promise<AssistantTool | null> {
  if (!can(ctx, "report_builder.build")) return null;
  const policy = await clientPolicy(ctx);
  const fields = assistantFields(reportSees(ctx, policy));
  if (!fields.length) return null;
  const keys = fields.map((f) => f.key) as [string, ...string[]];
  const args = z.object({
    columns: z
      .array(z.enum(keys))
      .min(1)
      .max(8)
      .describe("Fields to show, e.g. name, last_visit, visits, total_spend"),
    groupBy: z
      .enum(keys)
      .optional()
      .describe("Group by one field, e.g. home_location"),
    summary: z
      .boolean()
      .optional()
      .describe("One row per group with its totals, instead of every client"),
    sort: z.enum(keys).optional(),
    descending: z.boolean().optional(),
    preset: z
      .enum(["all", ...PRESET_IDS])
      .optional()
      .describe("Dates for visits and spend; the default is all time"),
    onlyVisited: z
      .boolean()
      .optional()
      .describe("Only clients with a visit in the dates"),
    locations: names('Location or location group names, or ["all"]'),
    barbers: names("Clients of these barbers"),
    lastVisitOverDays: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Lapsed: last visit more than this many days ago"),
    lastVisitWithinDays: z.number().int().min(1).max(3650).optional(),
    minVisits: z.number().int().min(0).max(10000).optional(),
    maxVisits: z.number().int().min(0).max(10000).optional(),
    minSpendDollars: z.number().min(0).max(1_000_000).optional(),
    notBooked: z
      .boolean()
      .optional()
      .describe("Nothing booked since their last visit"),
    visitStatus: z
      .array(z.enum(VISIT_STATUSES))
      .max(3)
      .optional()
      .describe(
        "Against their usual time between visits: on_track, due (from 3 days before their next expected visit) or overdue. Booked clients are on track.",
      ),
    minDaysBetweenVisits: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Usual days between visits (median of recent gaps), at least"),
    maxDaysBetweenVisits: z.number().int().min(1).max(3650).optional(),
    refillStatus: z
      .array(z.enum(REFILL_STATUSES))
      .max(3)
      .optional()
      .describe(
        "Products they buy: running_out (from a week before what they last bought should be used up), ran_out, or stocked",
      ),
  });
  return {
    name: "customer_report",
    args,
    spec: spec(
      "customer_report",
      `List or count clients with a custom customer report, as the report builder runs it for this person. Fields: ${fields.map((f) => `${f.key} (${f.label})`).join(", ")}. Contact details aren't available here.`,
      args,
    ),
    async run({ ctx, now }, raw) {
      const a = args.parse(raw);
      let shops: string | undefined;
      let staff: string | undefined;
      try {
        shops = await locationParam(ctx, a.locations);
        staff = await barberParam(ctx, a.barbers);
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      const filter = SegmentSchema.parse({
        lastVisitOverDays: a.lastVisitOverDays ?? null,
        lastVisitWithinDays: a.lastVisitWithinDays ?? null,
        minVisits: a.minVisits ?? null,
        maxVisits: a.maxVisits ?? null,
        minSpendCents:
          a.minSpendDollars !== undefined
            ? Math.round(a.minSpendDollars * 100)
            : null,
        notBooked: a.notBooked ?? false,
        visitStatus: a.visitStatus ?? [],
        minAvgGapDays: a.minDaysBetweenVisits ?? null,
        maxAvgGapDays: a.maxDaysBetweenVisits ?? null,
        refillStatus: a.refillStatus ?? [],
      });
      const byKey = new Map(fields.map((f) => [f.key, f]));
      const def = ReportDefinition.parse({
        columns: [...new Set(a.columns)].map((k) => ({
          field: k,
          agg: aggOf(byKey.get(k)!),
        })),
        filter,
        sort: a.sort
          ? [{ field: a.sort, dir: a.descending ? "desc" : "asc" }]
          : [],
        groupBy: a.groupBy ? [a.groupBy] : [],
        summary: !!a.summary && !!a.groupBy,
        range: { preset: a.preset ?? "all" },
        rows: a.onlyVisited ? "visited" : "all",
        shops: shops ?? null,
        staff: staff ?? null,
      });
      const policy = await clientPolicy(ctx);
      const problem = await reportProblem(ctx, policy, def, { building: true });
      if (problem) return fail(problem);
      const { scope, customerIds, ...r } = await runReport(ctx, policy, def, {
        page: 1,
        pageSize: 25,
        own: true,
        now,
      });
      if (customerIds.length && r.columns.some((c) => byKey.get(c.key)?.reads))
        await recordClientAccess(ctx, {
          kind: "list",
          detail: {
            assistant: true,
            clients: customerIds.length,
            fields: r.columns.map((c) => c.key),
          },
        });
      const shownHeaders = def.summary
        ? [...r.groupBy.map((g) => g.label), ...r.columns.map(totalHeader)]
        : r.columns.map((c) => c.label);
      const rows = r.lines.flatMap((l) =>
        def.summary && l.kind === "group"
          ? [
              [
                ...l.values,
                ...r.columns.map((c, i) => cellText(totalType(c), l.cells[i])),
              ],
            ]
          : !def.summary && l.kind === "row"
            ? [r.columns.map((c, i) => cellText(c.type, l.cells[i], c.masked))]
            : [],
      );
      const totals = r.totals
        ? r.columns
            .map((c, i) =>
              c.agg === "none"
                ? null
                : `${totalHeader(c)}: ${cellText(totalType(c), r.totals!.cells[i])}`,
            )
            .filter((x): x is string => !!x)
        : [];
      const what = def.summary
        ? `${r.total} groups`
        : `${r.total} client${r.total === 1 ? "" : "s"}`;
      const content = scrubText(
        [
          `SUMMARY: ${what} match (${r.rangeLabel}, ${r.scopeLabel})${totals.length ? `; ${totals.join(", ")}` : ""}.`,
          ...scope.notes,
          shownHeaders.join(" | "),
          ...rows.map((x) => x.join(" | ")),
          ...(r.total > rows.length ? [`(${r.total - rows.length} more)`] : []),
        ].join("\n"),
      );
      const links = [
        {
          label: "Open in the report builder to save it",
          href: `/admin/reports/custom/new?d=${encodeDefinition(def)}`,
        },
      ];
      if (can(ctx, "campaign_center.create")) {
        const s = segmentFromReport(
          def,
          { shopIds: scope.shopIds, staffIds: scope.staffIds },
          todayLocal(now),
        );
        links.push({
          label: "Message these clients",
          href: `/admin/campaign-center/blasts/new?f=${encodeURIComponent(encodeFilter(s.segment))}${s.shopIds.length ? `&shops=${s.shopIds.join(",")}` : ""}`,
        });
      }
      const card: AssistantCard = {
        kind: "report",
        title: "Clients",
        subtitle: `${r.rangeLabel} · ${r.scopeLabel}`,
        stats: [
          {
            label: def.summary ? "Groups" : "Clients",
            value: r.total.toLocaleString("en-US"),
          },
          ...totals
            .slice(0, 5)
            .map((t) => ({
              label: t.split(": ")[0],
              value: t.split(": ").slice(1).join(": "),
            })),
        ],
        table: {
          title: "Clients",
          headers: shownHeaders,
          rows: rows.slice(0, ROWS_ON_CARD),
          more: Math.max(0, r.total - ROWS_ON_CARD),
        },
        links,
      };
      return { content, cards: [scrub(card)] };
    },
  };
}

// ───────────────────────────── event_report ─────────────────────────────

const EVENT_GROUPS = EVENT_FIELDS.filter(
  (f) =>
    f.type !== "money" &&
    f.type !== "number" &&
    ![
      "events",
      "occurred",
      "record_id",
      "client_number",
      "quantity",
      "reason",
    ].includes(f.key),
).map((f) => f.key);
const MEASURES = {
  amount_sum: ["amount", "sum"],
  amount_avg: ["amount", "avg"],
  minutes_avg: ["minutes", "avg"],
  minutes_sum: ["minutes", "sum"],
  minutes_max: ["minutes", "max"],
  value_avg: ["value", "avg"],
  quantity_sum: ["quantity", "sum"],
} as const;
type Measure = keyof typeof MEASURES;

/** What each measure means for these events, so the model reads "minutes" right (lead time on a cancellation, wait on a start). */
function measureDocs(types: string[]): string[] {
  const all = Object.entries(EVENTS) as [
    string,
    Record<string, string | undefined>,
  ][];
  const picked = types.length
    ? all.filter(([k]) => types.includes(k) || types.includes(k.split(".")[0]))
    : [];
  return picked.slice(0, 25).flatMap(([k, e]) => {
    const parts = (
      ["minutes", "value", "amount", "quantity", "subtype"] as const
    )
      .filter((m) => e[m])
      .map((m) => `${m} = ${e[m]}`);
    return parts.length ? [`- ${k} (${e.label}): ${parts.join("; ")}`] : [];
  });
}

function eventReportTool(
  ctx: StaffContext,
  sees: ReturnType<typeof panelSees>,
): AssistantTool | null {
  if (!can(ctx, "analytics.events") || !can(ctx, "report_builder.build"))
    return null;
  const types = EVENT_TYPES.map((t) => t.key) as [string, ...string[]];
  const groups = EVENT_GROUPS as [string, ...string[]];
  const money =
    fieldUse(
      EVENT_FIELDS.find((f) => f.key === "amount")!,
      sees,
    ).use === "full";
  const measures = (Object.keys(MEASURES) as Measure[]).filter(
    (m) => money || MEASURES[m][0] !== "amount",
  ) as [Measure, ...Measure[]];
  const args = z.object({
    eventTypes: z
      .array(z.enum(types))
      .max(20)
      .optional()
      .describe(
        "Categories (booking, funnel, appointment, ticket, payment, tip, inventory, clock, block, message, call...) or single events (booking.cancelled, appointment.started...). Leave out for every event.",
      ),
    groupBy: z
      .array(z.enum(groups))
      .max(2)
      .optional()
      .describe(
        "Up to two fields, e.g. event, subtype, location, barber, channel, booking_source, business_date, month, hour, weekday",
      ),
    measures: z
      .array(z.enum(measures))
      .max(4)
      .optional()
      .describe(
        "Totals besides the event count: minutes_avg (e.g. average wait or lead time), amount_sum, value_avg...",
      ),
    preset: z
      .enum(["all", ...PRESET_IDS])
      .optional()
      .describe("Dates; the default is the last 30 days"),
    from: isoDate.optional().describe("Custom start date, with `to`"),
    to: isoDate.optional(),
    locations: names('Location or location group names, or ["all"]'),
    barbers: names("Only events about these barbers"),
  });
  return {
    name: "event_report",
    args,
    spec: spec(
      "event_report",
      "Count and total logged actions from the event log, as the report builder runs it for this person: bookings, cancellations and their lead time, the online booking funnel, check-in and service times, no-shows, tickets, voids, refunds, tips, stock, clock punches, block-outs, messages, campaigns, calls and more. Ids and numbers only, never contact details.",
      args,
    ),
    async run({ ctx, now }, raw) {
      const a = args.parse(raw);
      let shops: string | undefined;
      let staff: string | undefined;
      try {
        shops = await locationParam(ctx, a.locations);
        staff = await barberParam(ctx, a.barbers);
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      const picked = [...new Set(a.measures ?? [])];
      const groupBy = [...new Set(a.groupBy ?? [])];
      const def = ReportDefinition.parse({
        source: "events",
        columns: [
          { field: "events", agg: "sum" },
          ...picked.map((m) => ({
            field: MEASURES[m][0],
            agg: MEASURES[m][1],
          })),
        ],
        groupBy,
        summary: groupBy.length > 0,
        range:
          a.from && a.to
            ? { preset: "custom", from: a.from, to: a.to }
            : { preset: a.preset ?? "30d" },
        eventTypes: a.eventTypes ?? [],
        shops: shops ?? null,
        staff: staff ?? null,
      });
      const policy = await clientPolicy(ctx);
      const problem = await reportProblem(ctx, policy, def, { building: true });
      if (problem) return fail(problem);
      const {
        scope,
        customerIds: _c,
        ...r
      } = await runReport(ctx, policy, def, {
        page: 1,
        pageSize: groupBy.length ? MAX_GROUP_ROWS : 1,
        own: true,
        now,
      });
      const headers = [
        ...r.groupBy.map((g) => g.label),
        ...r.columns.map(totalHeader),
      ];
      const rows = r.lines
        .filter(
          (l): l is Extract<typeof l, { kind: "group" }> => l.kind === "group",
        )
        .sort((x, y) => Number(y.cells[0] ?? 0) - Number(x.cells[0] ?? 0))
        .map((l) => [
          ...l.values,
          ...r.columns.map((c, i) => cellText(totalType(c), l.cells[i])),
        ]);
      const totals = r.totals
        ? r.columns.map((c, i) => ({
            label: totalHeader(c),
            value: cellText(totalType(c), r.totals!.cells[i]) || "0",
          }))
        : [];
      const events = r.totals ? Number(r.totals.count) : r.total;
      const what =
        (a.eventTypes ?? [])
          .map((t) => EVENT_TYPES.find((x) => x.key === t)?.label ?? t)
          .join(", ") || "All events";
      const content = scrubText(
        [
          `SUMMARY: ${what}: ${events.toLocaleString("en-US")} event${events === 1 ? "" : "s"} (${r.rangeLabel}, ${r.scopeLabel})${
            totals.length > 1
              ? `; ${totals
                  .slice(1)
                  .map((t) => `${t.label}: ${t.value}`)
                  .join(", ")}`
              : ""
          }.`,
          ...scope.notes,
          ...(measureDocs(a.eventTypes ?? []).length
            ? ["MEASURES:", ...measureDocs(a.eventTypes ?? [])]
            : []),
          ...(rows.length
            ? [
                headers.join(" | "),
                ...rows.slice(0, ROWS_FOR_MODEL).map((x) => x.join(" | ")),
                ...(rows.length > ROWS_FOR_MODEL
                  ? [`(${rows.length - ROWS_FOR_MODEL} more groups)`]
                  : []),
              ]
            : []),
        ].join("\n"),
      );
      const card: AssistantCard = {
        kind: "report",
        title: "Event log",
        subtitle: `${what} · ${r.rangeLabel} · ${r.scopeLabel}`,
        stats: [
          { label: "Events", value: events.toLocaleString("en-US") },
          ...totals.slice(1, 5),
        ],
        table: rows.length
          ? {
              title: "Event log",
              headers,
              rows: rows.slice(0, ROWS_ON_CARD),
              more: Math.max(0, rows.length - ROWS_ON_CARD),
            }
          : null,
        links: [
          {
            label: "Open in the report builder to save it",
            href: `/admin/reports/custom/new?d=${encodeDefinition(def)}`,
          },
        ],
      };
      return { content, cards: [scrub(card)] };
    },
  };
}

// ───────────────────────────── help ─────────────────────────────

function helpTool(): AssistantTool {
  const args = z.object({ question: z.string().trim().min(1).max(500) });
  return {
    name: "help",
    args,
    spec: spec(
      "help",
      "How to do something in the software: the steps and the page, for pages this person can open.",
      args,
    ),
    async run({ ctx }, raw) {
      const a = args.parse(raw);
      const topics = helpFor(a.question, ctx.permissions);
      if (!topics.length)
        return fail(
          "I don't have a guide for that. The sidebar lists every page they can open.",
        );
      return {
        content: [
          `SUMMARY: ${topics[0].title}: ${topics[0].steps.join(" ")}`,
          ...topics
            .slice(1)
            .map((t) => `ALSO ${t.title}: ${t.steps.join(" ")}`),
        ].join("\n"),
        cards: topics
          .slice(0, 2)
          .map((t) => ({
            kind: "help",
            title: t.title,
            steps: t.steps,
            links: [{ label: "Go there", href: t.page }],
          })),
      };
    },
  };
}

// ───────────────────────────── Client notes ─────────────────────────────

/** A client's notes, found by name or client number, as the person could read them on the profile. */
function clientNotesTool(): AssistantTool {
  const args = z.object({
    client: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .describe("The client's name or client number"),
    kind: z
      .enum(["any", ...NOTE_KINDS])
      .optional()
      .describe(
        "profile, visit (cut and formula notes) or private; any by default",
      ),
  });
  return {
    name: "client_notes",
    args,
    spec: spec(
      "client_notes",
      "A client's notes from every location: pinned profile notes, cut and formula notes (guard numbers, style, products) and, for managers, private notes. Never contact details.",
      args,
    ),
    async run({ ctx }, raw) {
      const a = args.parse(raw);
      const policy = await clientPolicy(ctx);
      if (!notesMode(noteViewer(ctx, policy)))
        return fail("Client notes aren't shown to them.");
      const { ranked } = await findClients(ctx, policy, a.client, {
        via: "assistant",
        limit: 5,
        ownClientsOf: can(ctx, "clients.view_all") ? undefined : ctx.staff.id,
      });
      const reached = [];
      for (const r of ranked)
        if (await reachesClient(ctx, r.id)) reached.push(r.id);
      if (!reached.length)
        return fail(`No client they can see matches "${a.client}".`);
      const named = await db
        .select({
          id: customers.id,
          firstName: customers.firstName,
          lastName: customers.lastName,
          number: customers.number,
        })
        .from(customers)
        .where(inArray(customers.id, reached));
      const nameOf = (id: string) => {
        const c = named.find((x) => x.id === id)!;
        return {
          label: `${c.firstName} ${c.lastName ?? ""}`.trim(),
          number: c.number,
        };
      };
      const id = reached[0];
      const who = nameOf(id);
      try {
        await recordClientAccess(ctx, {
          kind: "view",
          customerId: id,
          detail: { assistant: true, notes: true },
        });
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      const list = await listNotes(ctx, id);
      const others = reached
        .slice(1)
        .map((x) => `${nameOf(x).label} (#${nameOf(x).number})`);
      const also = others.length ? `\nOTHER MATCHES: ${others.join(", ")}` : "";
      const links = [
        { label: `${who.label}'s profile`, href: `/admin/customers/${id}` },
      ];
      if (list.mode === "count") {
        return {
          content: `SUMMARY: ${who.label} (#${who.number}) has ${list.count} note${list.count === 1 ? "" : "s"} on file; client notes are masked for them, so only the count shows.${also}`,
          cards: [
            {
              kind: "report",
              title: `Notes: ${who.label}`,
              subtitle: "Client notes are masked for you",
              stats: [{ label: "Notes on file", value: String(list.count) }],
              table: null,
              links,
            },
          ],
        };
      }
      const notes = list.notes.filter(
        (n) => !a.kind || a.kind === "any" || n.kind === a.kind,
      );
      const line = (n: (typeof notes)[number]) =>
        scrubText([detailsLine(n.details), n.body].filter(Boolean).join(" · "));
      const count = (k: NoteKind) =>
        list.notes.filter((n) => n.kind === k).length;
      return {
        content:
          [
            `SUMMARY: ${who.label} (#${who.number}) has ${notes.length} ${a.kind && a.kind !== "any" ? NOTE_KIND_LABEL[a.kind].toLowerCase() : "note"}${notes.length === 1 ? "" : "s"}${notes.some((n) => n.pinned) ? ", pinned first" : ""}.`,
            ...notes
              .slice(0, ROWS_FOR_MODEL)
              .map(
                (n) =>
                  `${n.pinned ? "PINNED " : ""}${NOTE_KIND_LABEL[n.kind]} (${n.credit}): ${line(n)}`,
              ),
          ].join("\n") + also,
        cards: [
          {
            kind: "report",
            title: `Notes: ${who.label}`,
            subtitle: "From every location, pinned first",
            stats: [
              { label: "Profile", value: String(count("profile")) },
              { label: "Cut notes", value: String(count("visit")) },
              ...(list.notes.some((n) => n.kind === "private")
                ? [{ label: "Private", value: String(count("private")) }]
                : []),
            ],
            table: notes.length
              ? {
                  title: "Notes",
                  headers: ["", "Kind", "Note", "By"],
                  rows: notes
                    .slice(0, ROWS_ON_CARD)
                    .map((n) => [
                      n.pinned ? "Pinned" : "",
                      NOTE_KIND_LABEL[n.kind],
                      line(n),
                      n.credit,
                    ]),
                  more: Math.max(0, notes.length - ROWS_ON_CARD),
                }
              : null,
            links,
          },
        ],
      };
    },
  };
}

// ───────────────────────────── Drafts ─────────────────────────────

async function pendingAction(
  env: ToolEnv,
  kind: "draft_blast" | "draft_po",
  params: Record<string, unknown>,
  title: string,
  lines: string[],
): Promise<ToolResult> {
  const summary = scrubText([title, ...lines].join("\n"));
  const [row] = await db
    .insert(assistantActions)
    .values({
      conversationId: env.conversationId,
      staffId: env.ctx.staff.id,
      kind,
      params: scrub(params),
      summary,
    })
    .returning({ id: assistantActions.id });
  return {
    content: `SUMMARY: ${title}. It's a draft: nothing is created until they press Confirm under this answer.\n${lines.join("\n")}`,
    cards: [
      {
        kind: "action",
        actionId: row.id,
        title,
        lines,
        status: "pending",
        links: [],
      },
    ],
  };
}

function draftPoTool(): AssistantTool {
  const args = z.object({
    location: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe("The location; leave out for where they're working now"),
    vendor: z.string().trim().max(80).optional().describe("Only this vendor"),
  });
  return {
    name: "draft_po",
    args,
    spec: spec(
      "draft_po",
      "Draft purchase orders for what's at or below its reorder point at one location, one per vendor, filled up to par. The person confirms before anything is created.",
      args,
    ),
    async run(env, raw) {
      const { ctx } = env;
      const a = args.parse(raw);
      let shopId: string | null;
      try {
        shopId = a.location
          ? ((await locationParam(ctx, [a.location]))?.split(",")[0] ?? null)
          : (ctx.currentShopId ??
            (ctx.shopIds.length === 1 ? ctx.shopIds[0] : null));
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      if (!shopId || shopId === "all" || shopId.startsWith("group:"))
        return fail(
          "Which location? Purchase orders are drafted for one location at a time.",
        );
      const [s] = await suggestionsFor([shopId]);
      const orders = (s?.orders ?? []).filter(
        (o) => !a.vendor || norm(o.vendorName).includes(norm(a.vendor)),
      );
      if (!orders.length)
        return fail(
          `Nothing at ${s?.shop ?? "that location"} is at or below its reorder point${a.vendor ? ` from ${a.vendor}` : " with a vendor"}, so there's nothing to order.`,
        );
      const lines = orders.map(
        (o) =>
          `${o.vendorName}: ${o.lines.length} item${o.lines.length === 1 ? "" : "s"}, ${formatCents(o.totalCents)}${o.belowMinimum ? ` (under the ${formatCents(o.minimumOrderCents)} minimum)` : ""}`,
      );
      return pendingAction(
        env,
        "draft_po",
        { picks: orders.map((o) => ({ shopId, vendorId: o.vendorId })) },
        `Draft ${orders.length} purchase order${orders.length === 1 ? "" : "s"} for ${s.shop}`,
        lines,
      );
    },
  };
}

/** A blast's locations: empty is every location, which only the brand may pick. */
async function blastShops(
  ctx: StaffContext,
  loc: string | undefined,
): Promise<string[]> {
  if (!loc)
    return ctx.currentShopId
      ? [ctx.currentShopId]
      : ctx.brandWide
        ? []
        : [...ctx.shopIds];
  if (loc === "all") return ctx.brandWide ? [] : [...ctx.shopIds];
  const groups = await listLocationGroups();
  const ids = loc
    .split(",")
    .flatMap((t) =>
      t.startsWith("group:")
        ? (groups.find((g) => g.id === t.slice(6))?.shopIds ?? [])
        : [t],
    );
  return [...new Set(ids.filter((id) => ctx.shopIds.includes(id)))];
}

function draftBlastTool(): AssistantTool {
  const args = z.object({
    name: z.string().trim().min(1).max(80),
    channel: z.enum(["sms", "email"]),
    message: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        "The wording. Merge fields: {first_name}, {shop}, {barber}, {book_link}. Texts must end with Reply STOP to opt out.",
      ),
    subject: z.string().trim().max(150).optional().describe("Email subject"),
    locations: names('Location names, or ["all"]'),
    barbers: names("Clients of these barbers"),
    lastVisitOverDays: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Lapsed: last visit more than this many days ago"),
    lastVisitWithinDays: z.number().int().min(1).max(3650).optional(),
    minVisits: z.number().int().min(0).max(10000).optional(),
  });
  return {
    name: "draft_blast",
    args,
    spec: spec(
      "draft_blast",
      "Draft a Campaign Center blast to a segment of clients. Confirming saves it as a draft blast to review and send from Blasts; it never sends.",
      args,
    ),
    async run(env, raw) {
      const { ctx } = env;
      const a = args.parse(raw);
      let shopIds: string[];
      let staffIds: string[];
      try {
        shopIds = await blastShops(ctx, await locationParam(ctx, a.locations));
        staffIds = (await barberParam(ctx, a.barbers))?.split(",") ?? [];
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      const segment: Segment = SegmentSchema.parse({
        staffIds,
        lastVisitOverDays: a.lastVisitOverDays ?? null,
        lastVisitWithinDays: a.lastVisitWithinDays ?? null,
        minVisits: a.minVisits ?? null,
        channel: a.channel,
      });
      const sms =
        a.channel === "sms"
          ? /\bSTOP\b/.test(a.message)
            ? a.message
            : `${a.message} ${STOP_LINE}`
          : "";
      const templates = {
        sms,
        emailSubject: a.channel === "email" ? a.subject || a.name : "",
        emailBody: a.channel === "email" ? a.message : "",
        pushTitle: "",
        pushBody: "",
      };
      const problem = templatesProblem(templates, [a.channel], {
        hasCoupon: false,
      });
      if (problem) return fail(problem);
      try {
        await checkSegment(ctx, segment);
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      const shopName = new Map(ctx.shops.map((s) => [s.id, s.name]));
      const who = [
        a.lastVisitOverDays
          ? `last visit more than ${a.lastVisitOverDays} days ago`
          : null,
        a.lastVisitWithinDays
          ? `last visit in the last ${a.lastVisitWithinDays} days`
          : null,
        a.minVisits ? `at least ${a.minVisits} visits` : null,
        staffIds.length ? `clients of ${a.barbers!.join(", ")}` : null,
      ].filter(Boolean);
      const lines = [
        `${CHANNEL_LABEL[a.channel]}: ${a.channel === "sms" ? sms : `${templates.emailSubject} — ${a.message}`}`,
        `To: clients who agreed to marketing ${a.channel === "sms" ? "texts" : "emails"}${who.length ? `, ${who.join(", ")}` : ""}`,
        `Locations: ${shopIds.length ? shopIds.map((id) => shopName.get(id) ?? "").join(", ") : "every location"}`,
        "Confirm saves it as a draft blast. Review the audience and send it from Blasts.",
      ];
      return pendingAction(
        env,
        "draft_blast",
        { name: a.name, channels: [a.channel], templates, segment, shopIds },
        `Draft blast "${a.name}"`,
        lines,
      );
    },
  };
}

// ───────────────────────────── The set ─────────────────────────────

/** The tools this person may use: a report only if they may view it, drafts only with the permission to make them. */
export async function toolsFor(
  ctx: StaffContext,
  settings: AssistantSettings,
): Promise<AssistantTool[]> {
  const out: (AssistantTool | null)[] = [
    runReportTool(ctx),
    await customerReportTool(ctx),
    can(ctx, "analytics.events")
      ? eventReportTool(ctx, reportSees(ctx, await clientPolicy(ctx)))
      : null,
    helpTool(),
    can(ctx, "notes.view") ? clientNotesTool() : null,
  ];
  if (settings.actions && can(ctx, "po.create")) out.push(draftPoTool());
  if (settings.actions && can(ctx, "campaign_center.create"))
    out.push(draftBlastTool());
  return out.filter((t): t is AssistantTool => !!t);
}
