"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FORMATS, type ExportFormat } from "@/domain/report-builder";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { exportRun, previewReport, type RunRequest } from "@/server/report-builder/preview";
import { deleteReport, duplicateReport, saveReport } from "@/server/report-builder/saved";

const ANY = ["report_builder.view", "report_builder.build"] as const;
const BUILD = "report_builder.build";

export async function previewReportAction(req: RunRequest) {
  return safe(async () => {
    const ctx = await authorize([...ANY], "Custom reports need \"Custom reports: open saved reports\"");
    return previewReport(ctx, req);
  });
}

export async function exportReportAction(req: RunRequest, format: string) {
  return safe(async () => {
    const ctx = await authorize("report_builder.export", "Exporting needs \"Custom reports: export to CSV, Excel and PDF\"");
    const f = FORMATS.find((x) => x === format && x !== "none") as ExportFormat | undefined;
    if (!f) throw new AppError("bad_request", "Pick CSV, Excel or PDF");
    const file = await exportRun(ctx, req, f);
    return { filename: file.filename, contentType: file.contentType, base64: Buffer.from(file.bytes).toString("base64") };
  });
}

export async function saveReportAction(input: unknown) {
  return safe(async () => {
    const ctx = await authorize(BUILD, "Saving a report needs \"Custom reports: build, save, share and schedule reports\"");
    const id = await saveReport(ctx, input);
    revalidatePath("/admin/reports/custom");
    return { id };
  });
}

export async function duplicateReportAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(BUILD, "Duplicating a report needs \"Custom reports: build, save, share and schedule reports\"");
    const copy = await duplicateReport(ctx, z.string().parse(id));
    revalidatePath("/admin/reports/custom");
    return { id: copy };
  });
}

export async function deleteReportAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(BUILD, "Deleting a report needs \"Custom reports: build, save, share and schedule reports\"");
    await deleteReport(ctx, z.string().parse(id));
    revalidatePath("/admin/reports/custom");
    return null;
  });
}
