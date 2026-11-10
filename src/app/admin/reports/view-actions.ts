"use server";

import { revalidatePath } from "next/cache";
import { reportFor } from "@/domain/navigation";
import { reportView } from "@/domain/permissions";
import { safe } from "@/server/action";
import { can, requireStaff } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import { deleteReportView, isReportKey, saveReportView } from "@/server/report-views-saved";

export async function saveReportViewAction(input: { report: string; name: string; query: string; shared: boolean }) {
  return safe(async () => {
    const ctx = await requireStaff();
    if (!isReportKey(input.report) || !can(ctx, reportView(input.report))) throw forbidden();
    if (input.shared && !can(ctx, "report_builder.build")) throw forbidden("Sharing views needs Custom reports: build, save, share");
    const v = await saveReportView({ report: input.report, name: input.name, query: input.query, shared: input.shared, actor: { ...ctx.actor, staffId: ctx.staff.id } });
    revalidatePath(reportFor(input.report).href);
    return { id: v.id };
  });
}

export async function deleteReportViewAction(input: { id: string; report: string }) {
  return safe(async () => {
    const ctx = await requireStaff();
    await deleteReportView(input.id, { ...ctx.actor, staffId: ctx.staff.id });
    if (isReportKey(input.report)) revalidatePath(reportFor(input.report).href);
    return null;
  });
}
