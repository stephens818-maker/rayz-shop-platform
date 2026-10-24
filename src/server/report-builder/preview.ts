import { encodeFilter } from "@/domain/client-filters";
import { ReportDefinition, segmentFromReport, type ExportFormat, type ReportResult } from "@/domain/report-builder";
import { todayLocal } from "@/lib/time";
import { can, type StaffContext } from "../auth/staff";
import { clientPolicy, recordClientAccess } from "../client-privacy";
import { AppError, forbidden } from "../errors";
import { exportReport } from "./deliver";
import { reportProblem, runReport } from "./engine";
import { openSavedReport, usesCustomReports } from "./saved";

/** What the builder asks to run: a saved report as saved (optionally over other dates), or a definition being built. */
export interface RunRequest {
  id?: string | null;
  definition?: unknown;
  /** Someone viewing a report they can't change may still look at other dates. */
  range?: unknown;
  page?: number;
}

export interface ResolvedRun {
  id: string | null;
  name: string;
  definition: ReportDefinition;
  /** Their own definition: its locations must be inside their access, not cut down to it. */
  own: boolean;
}

/**
 * The definition to run for this person. A changed definition needs "build", and new filters need
 * the advanced client filters; anyone else only runs a saved report they may open, as it was saved.
 */
export async function resolveRun(ctx: StaffContext, req: RunRequest): Promise<ResolvedRun> {
  if (!usesCustomReports(ctx)) throw forbidden("Custom reports need \"Custom reports: open saved reports\"");
  const saved = req.id ? await openSavedReport(ctx, req.id) : null;
  if (req.definition !== undefined && req.definition !== null) {
    if (!can(ctx, "report_builder.build")) throw forbidden("Changing a report needs \"Custom reports: build, save, share and schedule reports\"");
    const def = ReportDefinition.parse(req.definition);
    const newFilters = !saved || JSON.stringify(saved.definition.filter) !== JSON.stringify(def.filter);
    const problem = await reportProblem(ctx, await clientPolicy(ctx), def, { building: newFilters });
    if (problem) throw new AppError("bad_request", problem);
    return { id: saved?.row.id ?? null, name: saved?.row.name ?? "Custom report", definition: def, own: true };
  }
  if (!saved) throw new AppError("bad_request", "Pick a report to run");
  const range = req.range ? ReportDefinition.shape.range.parse(req.range) : null;
  return { id: saved.row.id, name: saved.row.name, definition: range ? { ...saved.definition, range } : saved.definition, own: saved.mine };
}

export interface Preview {
  result: ReportResult;
  /** How the report was cut down for this person. */
  notes: string[];
  /** "Message these clients": the blast's filter and locations, for people who write blasts. */
  blast: { f: string; shops: string; notes: string[] } | null;
}

/** One page of the report, logged in the client data access log like browsing the client list. */
export async function previewReport(ctx: StaffContext, req: RunRequest, now: Date = new Date()): Promise<Preview> {
  const r = await resolveRun(ctx, req);
  const policy = await clientPolicy(ctx);
  const { scope, customerIds, ...result } = await runReport(ctx, policy, r.definition, { page: req.page, own: r.own, now });
  if (customerIds.length)
    await recordClientAccess(ctx, { kind: "list", detail: { report: r.id, name: r.name, page: result.page, clients: customerIds.length, fields: result.columns.map((c) => `${c.key}${c.masked ? ":masked" : ""}`) } });
  let blast: Preview["blast"] = null;
  if (r.definition.source === "customers" && can(ctx, "campaign_center.create")) {
    const s = segmentFromReport(r.definition, { shopIds: scope.shopIds, staffIds: scope.staffIds }, todayLocal(now));
    blast = { f: encodeFilter(s.segment), shops: s.shopIds.join(","), notes: s.notes };
  }
  return { result, notes: scope.notes, blast };
}

/** The whole report as a file; see exportReport for the permissions and the logging. */
export async function exportRun(ctx: StaffContext, req: RunRequest, format: ExportFormat, now: Date = new Date()) {
  const r = await resolveRun(ctx, req);
  const { file } = await exportReport(ctx, r, format, { now });
  return file;
}
