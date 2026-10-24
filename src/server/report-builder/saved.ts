import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { roles, savedReports, staff } from "@/db/schema";
import { ReportDefinition, ReportSchedule, SavedReportInput, scheduleLabel, type Visibility } from "@/domain/report-builder";
import { audit } from "../audit";
import { loadStaffAccess } from "../auth/access";
import { can, type StaffContext } from "../auth/staff";
import { clientPolicy } from "../client-privacy";
import { AppError, forbidden, notFound } from "../errors";
import { reportProblem } from "./engine";

type Row = typeof savedReports.$inferSelect;
type Viewer = Pick<StaffContext, "staff" | "access" | "permissions" | "brandWide">;

export const usesCustomReports = (ctx: Pick<StaffContext, "permissions">) => can(ctx, "report_builder.view") || can(ctx, "report_builder.build");

/** Their main role and their role at each of their shops. */
export const roleIdsOf = (ctx: Viewer) => [...new Set([ctx.staff.roleId, ctx.access.role.id, ...Object.values(ctx.access.shopRoles)])];

/** Their own reports, the brand's templates, and reports shared with one of their roles. */
export function mayOpen(ctx: Viewer, r: Pick<Row, "ownerId" | "visibility" | "roleIds">): boolean {
  if (!usesCustomReports(ctx)) return false;
  if (r.ownerId === ctx.staff.id || r.visibility === "template") return true;
  return r.visibility === "roles" && r.roleIds.some((id) => roleIdsOf(ctx).includes(id));
}

/** The owner edits their report; brand-wide builders also look after shared reports and templates. Everyone else duplicates. */
export const mayEdit = (ctx: Viewer, r: Pick<Row, "ownerId" | "visibility">) => can(ctx, "report_builder.build") && (r.ownerId === ctx.staff.id || (r.visibility !== "private" && ctx.brandWide));

/** Exporting a customer report is exporting clients, so it also needs "Export the client list". */
export function exportDenied(ctx: Pick<StaffContext, "permissions">, source: string): string | null {
  if (!can(ctx, "report_builder.export")) return "Exporting needs \"Custom reports: export to CSV, Excel and PDF\"";
  if (source === "customers" && !can(ctx, "clients.export")) return "Exporting a customer report also needs \"Export the client list\"";
  return null;
}

export interface SavedReportItem {
  id: string;
  name: string;
  description: string | null;
  source: string;
  visibility: Visibility;
  roles: string[];
  owner: string;
  mine: boolean;
  mayEdit: boolean;
  schedule: string | null;
  morning: boolean;
  updatedAt: Date;
}

export async function listSavedReports(ctx: StaffContext): Promise<SavedReportItem[]> {
  if (!usesCustomReports(ctx)) return [];
  const mine = roleIdsOf(ctx);
  const [rows, roleRows] = await Promise.all([
    db
      .select({ r: savedReports, owner: staff.displayLabel })
      .from(savedReports)
      .innerJoin(staff, eq(staff.id, savedReports.ownerId))
      .where(
        or(
          eq(savedReports.ownerId, ctx.staff.id),
          eq(savedReports.visibility, "template"),
          and(eq(savedReports.visibility, "roles"), sql`${savedReports.roleIds} ?| array[${sql.join(
            mine.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[]`),
        ),
      )
      .orderBy(desc(savedReports.updatedAt))
      .limit(300),
    db.select({ id: roles.id, name: roles.name }).from(roles),
  ]);
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  return rows.map(({ r, owner }) => {
    const s = r.schedule ? ReportSchedule.safeParse(r.schedule) : null;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      visibility: r.visibility,
      roles: r.visibility === "roles" ? r.roleIds.map((id) => roleName.get(id) ?? "Removed role") : [],
      owner,
      mine: r.ownerId === ctx.staff.id,
      mayEdit: mayEdit(ctx, r),
      schedule: s?.success ? scheduleLabel(s.data) : null,
      morning: r.morning,
      updatedAt: r.updatedAt,
    };
  });
}

export interface OpenedReport {
  row: Row;
  definition: ReportDefinition;
  schedule: ReportSchedule | null;
  owner: string;
  mine: boolean;
  mayEdit: boolean;
}

/** A report this person may open; anyone else's private report is "not found", like a record at another shop. */
export async function openSavedReport(ctx: Viewer, id: string): Promise<OpenedReport> {
  if (!z.uuid().safeParse(id).success) throw notFound("Report");
  const [hit] = await db.select({ r: savedReports, owner: staff.displayLabel }).from(savedReports).innerJoin(staff, eq(staff.id, savedReports.ownerId)).where(eq(savedReports.id, id));
  if (!hit || !mayOpen(ctx, hit.r)) throw notFound("Report");
  const def = ReportDefinition.safeParse(hit.r.definition);
  if (!def.success) throw new AppError("conflict", "This report was saved in a form that can't be read anymore");
  const s = hit.r.schedule ? ReportSchedule.safeParse(hit.r.schedule) : null;
  return { row: hit.r, definition: def.data, schedule: s?.success ? s.data : null, owner: hit.owner, mine: hit.r.ownerId === ctx.staff.id, mayEdit: mayEdit(ctx, hit.r) };
}

/** Whether this person could open a report with this sharing, from their stored access. */
async function recipientProblem(ctx: StaffContext, staffId: string, share: { ownerId: string; visibility: Visibility; roleIds: string[] }): Promise<string | null> {
  const [person] = await db.select({ label: staff.displayLabel, email: staff.email, active: staff.active, kind: staff.kind }).from(staff).where(eq(staff.id, staffId));
  if (!person || !person.active || person.kind !== "person") return "One of the recipients isn't an active staff member";
  const access = await loadStaffAccess(staffId);
  if (!access) return "One of the recipients isn't an active staff member";
  if (!ctx.brandWide && !access.shopIds.some((s) => ctx.shopIds.includes(s))) return `${person.label} doesn't work at your shops`;
  if (!person.email) return `${person.label} has no email address on their profile`;
  const viewer = { staff: { ...ctx.staff, id: staffId, roleId: access.role.id }, access, permissions: access.permissions, brandWide: access.scope === "all" };
  if (!mayOpen(viewer, share)) return `${person.label} can't open this report: share it with their role, or make it a template`;
  return null;
}

const SaveInput = SavedReportInput.extend({ id: z.uuid().nullable().default(null) });

/**
 * Save a report. Sharing with roles needs at least one role; a brand template needs access to
 * all shops. Its columns and filters are checked against what the saver may see, and checked
 * again for whoever opens it. Scheduled recipients must be able to open it themselves.
 */
export async function saveReport(ctx: StaffContext, raw: unknown): Promise<string> {
  if (!can(ctx, "report_builder.build")) throw forbidden("Building reports needs \"Custom reports: build, save, share and schedule reports\"");
  const p = SaveInput.parse(raw);
  const cur = p.id ? (await db.select().from(savedReports).where(eq(savedReports.id, p.id)))[0] : null;
  if (p.id && (!cur || !mayOpen(ctx, cur))) throw notFound("Report");
  if (cur && !mayEdit(ctx, cur)) throw forbidden("Only its owner can change this report. Duplicate it to make your own.");
  const policy = await clientPolicy(ctx);
  const filtersChanged = !cur || JSON.stringify(ReportDefinition.safeParse(cur.definition).data?.filter ?? null) !== JSON.stringify(p.definition.filter);
  const problem = await reportProblem(ctx, policy, p.definition, { building: filtersChanged });
  if (problem) throw new AppError("bad_request", problem);
  if (p.visibility === "template" && !ctx.brandWide) throw forbidden("Brand templates are for people with access to all shops");
  const roleIds = p.visibility === "roles" ? [...new Set(p.roleIds)] : [];
  if (p.visibility === "roles") {
    if (!roleIds.length) throw new AppError("bad_request", "Pick at least one role to share with");
    const found = await db.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds));
    if (found.length !== roleIds.length) throw new AppError("bad_request", "One of those roles doesn't exist");
  }
  const ownerId = cur?.ownerId ?? ctx.staff.id;
  const schedule = p.schedule ? { ...p.schedule, recipients: p.schedule.recipients.length ? [...new Set(p.schedule.recipients)] : [ownerId] } : null;
  if (schedule)
    for (const id of schedule.recipients) {
      const why = await recipientProblem(ctx, id, { ownerId, visibility: p.visibility, roleIds });
      if (why) throw new AppError("bad_request", why);
    }
  const values = {
    name: p.name,
    description: p.description || null,
    source: p.definition.source,
    definition: p.definition as unknown as Record<string, unknown>,
    visibility: p.visibility,
    roleIds,
    schedule: schedule as unknown as Record<string, unknown> | null,
    morning: p.morning,
    updatedAt: new Date(),
  };
  let id = p.id;
  if (id) await db.update(savedReports).set(values).where(eq(savedReports.id, id));
  else id = (await db.insert(savedReports).values({ ...values, ownerId }).returning({ id: savedReports.id }))[0].id;
  await audit(
    ctx.actor,
    cur ? "report_builder.update" : "report_builder.create",
    "saved_report",
    id,
    { name: p.name, source: p.definition.source, visibility: p.visibility, roleIds, columns: p.definition.columns.map((c) => c.field), schedule: schedule ? scheduleLabel(schedule) : null, morning: p.morning },
    ctx.currentShopId,
  );
  return id!;
}

/** A private copy for the person, to change as they like. The schedule doesn't come along. */
export async function duplicateReport(ctx: StaffContext, id: string): Promise<string> {
  if (!can(ctx, "report_builder.build")) throw forbidden("Duplicating a report needs \"Custom reports: build, save, share and schedule reports\"");
  const r = await openSavedReport(ctx, id);
  const [row] = await db
    .insert(savedReports)
    .values({ name: `Copy of ${r.row.name}`.slice(0, 80), description: r.row.description, source: r.row.source, definition: r.row.definition, ownerId: ctx.staff.id, visibility: "private" })
    .returning({ id: savedReports.id });
  await audit(ctx.actor, "report_builder.duplicate", "saved_report", row.id, { from: id, name: r.row.name }, ctx.currentShopId);
  return row.id;
}

export async function deleteReport(ctx: StaffContext, id: string) {
  const r = await openSavedReport(ctx, id);
  if (!r.mayEdit) throw forbidden("Only its owner can delete this report");
  await db.delete(savedReports).where(eq(savedReports.id, id));
  await audit(ctx.actor, "report_builder.delete", "saved_report", id, { name: r.row.name }, ctx.currentShopId);
}
