import { and, asc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { reportViews, staff } from "@/db/schema";
import { ReportKey, REPORTS } from "@/domain/permissions";
import { Actor, audit } from "./audit";
import { AppError, forbidden, notFound } from "./errors";

export interface SavedView {
  id: string;
  name: string;
  query: string;
  shared: boolean;
  mine: boolean;
  owner: string | null;
}

const PARAM = /^[a-z][a-z_]{0,30}$/;

/** Keeps a report's own filters (dates, shops, barbers, view, options) and drops anything else. */
export function cleanViewQuery(raw: string): string {
  const q = new URLSearchParams(raw.replace(/^\?/, ""));
  const out = new URLSearchParams();
  for (const [k, v] of q) if (PARAM.test(k) && v.length <= 300 && k !== "type" && k !== "table") out.append(k, v);
  out.sort();
  return out.toString().slice(0, 2000);
}

export const isReportKey = (k: string): k is ReportKey => REPORTS.some((r) => r.key === k);

export async function listReportViews(staffId: string, report: ReportKey): Promise<SavedView[]> {
  const rows = await db
    .select({ v: reportViews, owner: staff.displayLabel })
    .from(reportViews)
    .leftJoin(staff, eq(staff.id, reportViews.ownerId))
    .where(and(eq(reportViews.report, report), or(eq(reportViews.ownerId, staffId), eq(reportViews.shared, true))))
    .orderBy(asc(reportViews.name));
  return rows.map(({ v, owner }) => ({ id: v.id, name: v.name, query: v.query, shared: v.shared, mine: v.ownerId === staffId, owner }));
}

/** Saves (or, with the same name, replaces) one of the person's views of a report. */
export async function saveReportView(input: { report: ReportKey; name: string; query: string; shared: boolean; actor: Actor & { staffId: string } }) {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 60) throw new AppError("bad_request", "Name the view (up to 60 characters)");
  const query = cleanViewQuery(input.query);
  return db.transaction(async (tx) => {
    const same = await tx.query.reportViews.findFirst({
      where: and(eq(reportViews.ownerId, input.actor.staffId), eq(reportViews.report, input.report), sql`lower(${reportViews.name}) = lower(${name})`),
    });
    const [row] = same
      ? await tx.update(reportViews).set({ name, query, shared: input.shared }).where(eq(reportViews.id, same.id)).returning()
      : await tx.insert(reportViews).values({ ownerId: input.actor.staffId, report: input.report, name, query, shared: input.shared }).returning();
    await audit(input.actor, same ? "report_view.update" : "report_view.create", "report_view", row.id, { report: input.report, name, query, shared: input.shared }, null, tx);
    return row;
  });
}

export async function deleteReportView(id: string, actor: Actor & { staffId: string }) {
  const v = await db.query.reportViews.findFirst({ where: eq(reportViews.id, id) });
  if (!v) throw notFound("Saved view");
  if (v.ownerId !== actor.staffId) throw forbidden("Only the person who saved a view can remove it");
  await db.delete(reportViews).where(eq(reportViews.id, id));
  await audit(actor, "report_view.delete", "report_view", id, { report: v.report, name: v.name }, null);
}
