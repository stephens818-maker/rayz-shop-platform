import "server-only";
import { z } from "zod";
import { db } from "@/db";
import { assistantActions } from "@/db/schema";
import { ASSISTANT_REPORTS, CONTACT_COLUMN, PRESET_IDS, type AssistantCard, type AssistantSettings } from "@/domain/assistant";
import { helpFor } from "@/domain/assistant-help";
import { encodeFilter } from "@/domain/client-filters";
import { CHANNEL_LABEL, STOP_LINE, SegmentSchema, templatesProblem, type Segment } from "@/domain/marketing";
import { reportView, type ReportKey } from "@/domain/permissions";
import { CUSTOMER_FIELDS, ReportDefinition, cellText, encodeDefinition, fieldUse, segmentFromReport, totalHeader, totalType, type FieldDef } from "@/domain/report-builder";
import { csvTable, type ReportTable } from "@/domain/report-views";
import { formatCents } from "@/lib/money";
import { scrub, scrubText } from "@/lib/sensitive";
import { formatDate, todayLocal } from "@/lib/time";
import { resolveScope, selfOnly } from "@/app/admin/reports/scope";
import { can, reasonViewer, type StaffContext } from "../auth/staff";
import { barbersAt } from "../barbers";
import { panelSees } from "../client-filters";
import { clientPolicy, recordClientAccess } from "../client-privacy";
import { AppError } from "../errors";
import { suggestionsFor } from "../inventory/purchasing";
import { listLocationGroups, visibleGroups } from "../locations";
import { checkSegment } from "../marketing/campaigns";
import { REPORT_LOADERS } from "../report-data";
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
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^ray'?z\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD");
const names = (what: string) => z.array(z.string().trim().min(1).max(80)).max(20).optional().describe(what);
const spec = (name: string, description: string, schema: z.ZodType): ToolSpec => {
  const { $schema: _s, ...parameters } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return { name, description, parameters };
};
const fail = (message: string): ToolResult => ({ content: `SUMMARY: ${message}`, cards: [], refused: true });

// ───────────────────────────── Locations and barbers by name ─────────────────────────────

/** The `shop` value for location names, matched only among the person's own locations and groups. */
async function locationParam(ctx: StaffContext, list: string[] | undefined): Promise<string | undefined> {
  if (!list?.length) return undefined;
  if (list.some((n) => /^(all|every|everywhere|all locations|all shops)$/i.test(n.trim()))) return "all";
  const groups = visibleGroups(await listLocationGroups(), ctx.shopIds);
  const out: string[] = [];
  for (const raw of list) {
    const n = norm(raw);
    const shop = ctx.shops.find((s) => norm(s.name) === n) ?? ctx.shops.find((s) => n.length >= 3 && norm(s.name).includes(n));
    const group = shop ? null : groups.find((g) => norm(g.name) === n);
    if (shop) out.push(shop.id);
    else if (group) out.push(`group:${group.id}`);
    else throw new AppError("forbidden", `"${raw}" isn't one of your locations`);
  }
  return [...new Set(out)].join(",");
}

/** The `staff` value for barber names, among barbers at the person's locations. */
async function barberParam(ctx: StaffContext, list: string[] | undefined): Promise<string | undefined> {
  if (!list?.length) return undefined;
  const visible = await barbersAt(ctx.shopIds);
  const out: string[] = [];
  for (const raw of list) {
    const n = norm(raw);
    const b = visible.find((x) => norm(x.name) === n) ?? visible.find((x) => n.length >= 2 && norm(x.name).split(" ").includes(n.split(" ")[0]));
    if (!b) throw new AppError("forbidden", `"${raw}" isn't a barber at your locations`);
    out.push(b.id);
  }
  return [...new Set(out)].join(",");
}

// ───────────────────────────── Report text ─────────────────────────────

/** A report table as the model reads it: contact columns dropped, money in dollars, long tables cut. */
export function tableText(t: ReportTable): string {
  const c = csvTable(t);
  const keep = c.headers.map((h, i) => (CONTACT_COLUMN.test(h) ? -1 : i)).filter((i) => i >= 0);
  const line = (r: (string | number | null)[]) => keep.map((i) => (r[i] === null || r[i] === undefined ? "" : String(r[i]))).join(" | ");
  const rows = c.rows.slice(0, ROWS_FOR_MODEL).map(line);
  const more = c.rows.length - rows.length;
  return [`TABLE ${t.title}${t.subtitle ? ` (${t.subtitle})` : ""}:`, keep.map((i) => c.headers[i]).join(" | "), ...rows, ...(more > 0 ? [`(${more} more rows)`] : [])].join("\n");
}

function cardTable(t: ReportTable): NonNullable<Extract<AssistantCard, { kind: "report" }>["table"]> {
  const c = csvTable(t);
  const keep = c.headers.map((h, i) => (CONTACT_COLUMN.test(h) ? -1 : i)).filter((i) => i >= 0);
  const kinds = t.rowKinds && t.totalColumn ? null : t.columns.map((x) => x.kind);
  const show = (v: string | number | null, i: number) => (v === null ? "" : kinds?.[i] === "money" && typeof v === "string" && /^-?\d+\.\d\d$/.test(v) ? formatCents(Math.round(Number(v) * 100)) : String(v));
  return { title: t.title, headers: keep.map((i) => c.headers[i]), rows: c.rows.slice(0, ROWS_ON_CARD).map((r) => keep.map((i) => show(r[i], i))), more: Math.max(0, c.rows.length - ROWS_ON_CARD) };
}

const rangeText = (from: string, to: string) => (from === to ? formatDate(from, "MMM d, yyyy") : `${formatDate(from, "MMM d")} – ${formatDate(to, "MMM d, yyyy")}`);

// ───────────────────────────── run_report ─────────────────────────────

function runReportTool(ctx: StaffContext): AssistantTool | null {
  const reports = ASSISTANT_REPORTS.filter((r) => can(ctx, reportView(r.key)));
  if (!reports.length) return null;
  const keys = reports.map((r) => r.key) as [ReportKey, ...ReportKey[]];
  const args = z.object({
    report: z.enum(keys).describe("Which report"),
    preset: z.enum(PRESET_IDS).optional().describe("A date range; the default is the last 7 days"),
    from: isoDate.optional().describe("Custom start date, with `to`"),
    to: isoDate.optional(),
    locations: names('Location or location group names, or ["all"]. Leave out for where they\'re working now.'),
    barbers: names("Barber names to limit it to. Leave out for every barber they may see."),
    view: z.enum(["combined", "shops", "barbers", "shops_barbers"]).optional().describe("combined, by location (shops), by barber, or both"),
  });
  const list = reports.map((r) => `${r.key}: ${r.label}${"hint" in r && r.hint ? ` (${r.hint})` : ""}`).join("; ");
  return {
    name: "run_report",
    args,
    spec: spec("run_report", `Run one of the reports this person can open and read its numbers. Reports: ${list}.`, args),
    async run({ ctx }, raw) {
      const a = args.parse(raw);
      const report = reports.find((r) => r.key === a.report)!;
      const notes: string[] = [];
      let shop: string | undefined;
      let staffIds: string | undefined;
      try {
        shop = await locationParam(ctx, a.locations);
        if (a.barbers?.length && selfOnly(ctx, a.report)) notes.push("They only see their own numbers in this report, so other barbers were left out.");
        else staffIds = await barberParam(ctx, a.barbers);
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      const params = { preset: a.from && a.to ? undefined : a.preset, from: a.from, to: a.to, shop, staff: staffIds, view: a.view };
      const scope = await resolveScope(ctx, params, a.report);
      const data = await REPORT_LOADERS[a.report]({ scope, loc: scope.loc, viewer: ctx, client: await clientPolicy(ctx), reasons: reasonViewer(ctx), params: { preset: params.preset, from: a.from, to: a.to, view: a.view } });
      const where = [scope.label, scope.barbers && scope.barbers.label !== "All barbers" ? scope.barbers.label : null].filter(Boolean).join(" · ");
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
      const stats = data.stats.map((s) => ({ label: s.label, value: s.value, ...(s.hint ? { hint: s.hint } : {}) }));
      const tables = data.tables.slice(0, 4);
      const head = stats.length ? stats.slice(0, 4).map((s) => `${s.label} ${s.value}`).join(", ") : tables.length ? `${tables[0].rows.length} rows` : "nothing to show";
      const content = scrubText(
        [
          `SUMMARY: ${report.label}, ${dates}, ${where}: ${head}.`,
          ...notes,
          ...(data.notes ?? []),
          ...(stats.length ? ["STATS:", ...stats.map((s) => `- ${s.label}: ${s.value}${s.hint ? ` (${s.hint})` : ""}`)] : []),
          ...tables.map(tableText),
        ].join("\n"),
      );
      const shown = tables.find((t) => !t.exportOnly) ?? tables[0];
      const card: AssistantCard = { kind: "report", title: report.label, subtitle: `${dates} · ${where}`, stats: stats.slice(0, 8), table: shown ? cardTable(shown) : null, links: [{ label: `Open ${report.label}`, href: `${report.href}?${qs}` }] };
      return { content, cards: [scrub(card)] };
    },
  };
}

// ───────────────────────────── customer_report ─────────────────────────────

/** Fields the assistant may put in a customer report: what the person sees in full, never contact details, birthdays or custom fields. */
export function assistantFields(sees: ReturnType<typeof panelSees>): FieldDef[] {
  return CUSTOMER_FIELDS.filter((f) => fieldUse(f, sees).use === "full" && !["phone", "email", "address", "birthday"].includes(f.key));
}

const aggOf = (f: FieldDef) => (f.type === "int" || f.type === "money" ? "sum" : f.type === "number" || f.type === "stars" ? "avg" : "none");

async function customerReportTool(ctx: StaffContext): Promise<AssistantTool | null> {
  if (!can(ctx, "report_builder.build")) return null;
  const policy = await clientPolicy(ctx);
  const fields = assistantFields(panelSees(ctx, policy));
  if (!fields.length) return null;
  const keys = fields.map((f) => f.key) as [string, ...string[]];
  const args = z.object({
    columns: z.array(z.enum(keys)).min(1).max(8).describe("Fields to show, e.g. name, last_visit, visits, total_spend"),
    groupBy: z.enum(keys).optional().describe("Group by one field, e.g. home_location"),
    summary: z.boolean().optional().describe("One row per group with its totals, instead of every client"),
    sort: z.enum(keys).optional(),
    descending: z.boolean().optional(),
    preset: z.enum(["all", ...PRESET_IDS]).optional().describe("Dates for visits and spend; the default is all time"),
    onlyVisited: z.boolean().optional().describe("Only clients with a visit in the dates"),
    locations: names('Location or location group names, or ["all"]'),
    barbers: names("Clients of these barbers"),
    lastVisitOverDays: z.number().int().min(1).max(3650).optional().describe("Lapsed: last visit more than this many days ago"),
    lastVisitWithinDays: z.number().int().min(1).max(3650).optional(),
    minVisits: z.number().int().min(0).max(10000).optional(),
    maxVisits: z.number().int().min(0).max(10000).optional(),
    minSpendDollars: z.number().min(0).max(1_000_000).optional(),
    notBooked: z.boolean().optional().describe("Nothing booked since their last visit"),
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
        minSpendCents: a.minSpendDollars !== undefined ? Math.round(a.minSpendDollars * 100) : null,
        notBooked: a.notBooked ?? false,
      });
      const byKey = new Map(fields.map((f) => [f.key, f]));
      const def = ReportDefinition.parse({
        columns: [...new Set(a.columns)].map((k) => ({ field: k, agg: aggOf(byKey.get(k)!) })),
        filter,
        sort: a.sort ? [{ field: a.sort, dir: a.descending ? "desc" : "asc" }] : [],
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
      const { scope, customerIds, ...r } = await runReport(ctx, policy, def, { page: 1, pageSize: 25, own: true, now });
      if (customerIds.length && r.columns.some((c) => byKey.get(c.key)?.reads))
        await recordClientAccess(ctx, { kind: "list", detail: { assistant: true, clients: customerIds.length, fields: r.columns.map((c) => c.key) } });
      const shownHeaders = def.summary ? [...r.groupBy.map((g) => g.label), ...r.columns.map(totalHeader)] : r.columns.map((c) => c.label);
      const rows = r.lines.flatMap((l) =>
        def.summary && l.kind === "group"
          ? [[...l.values, ...r.columns.map((c, i) => cellText(totalType(c), l.cells[i]))]]
          : !def.summary && l.kind === "row"
            ? [r.columns.map((c, i) => cellText(c.type, l.cells[i], c.masked))]
            : [],
      );
      const totals = r.totals ? r.columns.map((c, i) => (c.agg === "none" ? null : `${totalHeader(c)}: ${cellText(totalType(c), r.totals!.cells[i])}`)).filter((x): x is string => !!x) : [];
      const what = def.summary ? `${r.total} groups` : `${r.total} client${r.total === 1 ? "" : "s"}`;
      const content = scrubText(
        [
          `SUMMARY: ${what} match (${r.rangeLabel}, ${r.scopeLabel})${totals.length ? `; ${totals.join(", ")}` : ""}.`,
          ...scope.notes,
          shownHeaders.join(" | "),
          ...rows.map((x) => x.join(" | ")),
          ...(r.total > rows.length ? [`(${r.total - rows.length} more)`] : []),
        ].join("\n"),
      );
      const links = [{ label: "Open in the report builder to save it", href: `/admin/reports/custom/new?d=${encodeDefinition(def)}` }];
      if (can(ctx, "campaign_center.create")) {
        const s = segmentFromReport(def, { shopIds: scope.shopIds, staffIds: scope.staffIds }, todayLocal(now));
        links.push({ label: "Message these clients", href: `/admin/campaign-center/blasts/new?f=${encodeURIComponent(encodeFilter(s.segment))}${s.shopIds.length ? `&shops=${s.shopIds.join(",")}` : ""}` });
      }
      const card: AssistantCard = {
        kind: "report",
        title: "Clients",
        subtitle: `${r.rangeLabel} · ${r.scopeLabel}`,
        stats: [{ label: def.summary ? "Groups" : "Clients", value: r.total.toLocaleString("en-US") }, ...totals.slice(0, 5).map((t) => ({ label: t.split(": ")[0], value: t.split(": ").slice(1).join(": ") }))],
        table: { title: "Clients", headers: shownHeaders, rows: rows.slice(0, ROWS_ON_CARD), more: Math.max(0, r.total - ROWS_ON_CARD) },
        links,
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
    spec: spec("help", "How to do something in the software: the steps and the page, for pages this person can open.", args),
    async run({ ctx }, raw) {
      const a = args.parse(raw);
      const topics = helpFor(a.question, ctx.permissions);
      if (!topics.length) return fail("I don't have a guide for that. The sidebar lists every page they can open.");
      return {
        content: [`SUMMARY: ${topics[0].title}: ${topics[0].steps.join(" ")}`, ...topics.slice(1).map((t) => `ALSO ${t.title}: ${t.steps.join(" ")}`)].join("\n"),
        cards: topics.slice(0, 2).map((t) => ({ kind: "help", title: t.title, steps: t.steps, links: [{ label: "Go there", href: t.page }] })),
      };
    },
  };
}

// ───────────────────────────── Drafts ─────────────────────────────

async function pendingAction(env: ToolEnv, kind: "draft_blast" | "draft_po", params: Record<string, unknown>, title: string, lines: string[]): Promise<ToolResult> {
  const summary = scrubText([title, ...lines].join("\n"));
  const [row] = await db.insert(assistantActions).values({ conversationId: env.conversationId, staffId: env.ctx.staff.id, kind, params: scrub(params), summary }).returning({ id: assistantActions.id });
  return {
    content: `SUMMARY: ${title}. It's a draft: nothing is created until they press Confirm under this answer.\n${lines.join("\n")}`,
    cards: [{ kind: "action", actionId: row.id, title, lines, status: "pending", links: [] }],
  };
}

function draftPoTool(): AssistantTool {
  const args = z.object({
    location: z.string().trim().max(80).optional().describe("The location; leave out for where they're working now"),
    vendor: z.string().trim().max(80).optional().describe("Only this vendor"),
  });
  return {
    name: "draft_po",
    args,
    spec: spec("draft_po", "Draft purchase orders for what's at or below its reorder point at one location, one per vendor, filled up to par. The person confirms before anything is created.", args),
    async run(env, raw) {
      const { ctx } = env;
      const a = args.parse(raw);
      let shopId: string | null;
      try {
        shopId = a.location ? ((await locationParam(ctx, [a.location]))?.split(",")[0] ?? null) : (ctx.currentShopId ?? (ctx.shopIds.length === 1 ? ctx.shopIds[0] : null));
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      if (!shopId || shopId === "all" || shopId.startsWith("group:")) return fail("Which location? Purchase orders are drafted for one location at a time.");
      const [s] = await suggestionsFor([shopId]);
      const orders = (s?.orders ?? []).filter((o) => !a.vendor || norm(o.vendorName).includes(norm(a.vendor)));
      if (!orders.length) return fail(`Nothing at ${s?.shop ?? "that location"} is at or below its reorder point${a.vendor ? ` from ${a.vendor}` : " with a vendor"}, so there's nothing to order.`);
      const lines = orders.map((o) => `${o.vendorName}: ${o.lines.length} item${o.lines.length === 1 ? "" : "s"}, ${formatCents(o.totalCents)}${o.belowMinimum ? ` (under the ${formatCents(o.minimumOrderCents)} minimum)` : ""}`);
      return pendingAction(env, "draft_po", { picks: orders.map((o) => ({ shopId, vendorId: o.vendorId })) }, `Draft ${orders.length} purchase order${orders.length === 1 ? "" : "s"} for ${s.shop}`, lines);
    },
  };
}

/** A blast's locations: empty is every location, which only the brand may pick. */
async function blastShops(ctx: StaffContext, loc: string | undefined): Promise<string[]> {
  if (!loc) return ctx.currentShopId ? [ctx.currentShopId] : ctx.brandWide ? [] : [...ctx.shopIds];
  if (loc === "all") return ctx.brandWide ? [] : [...ctx.shopIds];
  const groups = await listLocationGroups();
  const ids = loc.split(",").flatMap((t) => (t.startsWith("group:") ? (groups.find((g) => g.id === t.slice(6))?.shopIds ?? []) : [t]));
  return [...new Set(ids.filter((id) => ctx.shopIds.includes(id)))];
}

function draftBlastTool(): AssistantTool {
  const args = z.object({
    name: z.string().trim().min(1).max(80),
    channel: z.enum(["sms", "email"]),
    message: z.string().trim().min(1).max(1000).describe("The wording. Merge fields: {first_name}, {shop}, {barber}, {book_link}. Texts must end with Reply STOP to opt out."),
    subject: z.string().trim().max(150).optional().describe("Email subject"),
    locations: names('Location names, or ["all"]'),
    barbers: names("Clients of these barbers"),
    lastVisitOverDays: z.number().int().min(1).max(3650).optional().describe("Lapsed: last visit more than this many days ago"),
    lastVisitWithinDays: z.number().int().min(1).max(3650).optional(),
    minVisits: z.number().int().min(0).max(10000).optional(),
  });
  return {
    name: "draft_blast",
    args,
    spec: spec("draft_blast", "Draft a Campaign Center blast to a segment of clients. Confirming saves it as a draft blast to review and send from Blasts; it never sends.", args),
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
      const sms = a.channel === "sms" ? (/\bSTOP\b/.test(a.message) ? a.message : `${a.message} ${STOP_LINE}`) : "";
      const templates = { sms, emailSubject: a.channel === "email" ? a.subject || a.name : "", emailBody: a.channel === "email" ? a.message : "", pushTitle: "", pushBody: "" };
      const problem = templatesProblem(templates, [a.channel], { hasCoupon: false });
      if (problem) return fail(problem);
      try {
        await checkSegment(ctx, segment);
      } catch (e) {
        if (e instanceof AppError) return fail(e.message);
        throw e;
      }
      const shopName = new Map(ctx.shops.map((s) => [s.id, s.name]));
      const who = [
        a.lastVisitOverDays ? `last visit more than ${a.lastVisitOverDays} days ago` : null,
        a.lastVisitWithinDays ? `last visit in the last ${a.lastVisitWithinDays} days` : null,
        a.minVisits ? `at least ${a.minVisits} visits` : null,
        staffIds.length ? `clients of ${a.barbers!.join(", ")}` : null,
      ].filter(Boolean);
      const lines = [
        `${CHANNEL_LABEL[a.channel]}: ${a.channel === "sms" ? sms : `${templates.emailSubject} — ${a.message}`}`,
        `To: clients who agreed to marketing ${a.channel === "sms" ? "texts" : "emails"}${who.length ? `, ${who.join(", ")}` : ""}`,
        `Locations: ${shopIds.length ? shopIds.map((id) => shopName.get(id) ?? "").join(", ") : "every location"}`,
        "Confirm saves it as a draft blast. Review the audience and send it from Blasts.",
      ];
      return pendingAction(env, "draft_blast", { name: a.name, channels: [a.channel], templates, segment, shopIds }, `Draft blast "${a.name}"`, lines);
    },
  };
}

// ───────────────────────────── The set ─────────────────────────────

/** The tools this person may use: a report only if they may view it, drafts only with the permission to make them. */
export async function toolsFor(ctx: StaffContext, settings: AssistantSettings): Promise<AssistantTool[]> {
  const out: (AssistantTool | null)[] = [runReportTool(ctx), await customerReportTool(ctx), helpTool()];
  if (settings.actions && can(ctx, "po.create")) out.push(draftPoTool());
  if (settings.actions && can(ctx, "campaign_center.create")) out.push(draftBlastTool());
  return out.filter((t): t is AssistantTool => !!t);
}
