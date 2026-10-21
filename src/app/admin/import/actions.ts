"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { IMPORT_KINDS, runImport, type ImportResult } from "@/server/importer";

const Input = z.object({
  kind: z.enum(IMPORT_KINDS as [string, ...string[]]),
  csv: z.string().min(1, "The file is empty"),
  filename: z.string().max(200).optional(),
  dryRun: z.boolean(),
});

/** The full error list (with the original rows) is kept on the run; the page shows the first 2,000. */
export async function importAction(raw: z.input<typeof Input>) {
  return safe<ImportResult & { errorsTruncated: number }>(async () => {
    const ctx = await authorize("import.run");
    const p = Input.parse(raw);
    const result = await runImport(p.kind as ImportResult["kind"], p.csv, { dryRun: p.dryRun, actor: ctx.actor, filename: p.filename });
    if (!p.dryRun) revalidatePath("/admin/import");
    return { ...result, errors: result.errors.slice(0, 2000), errorsTruncated: Math.max(0, result.errors.length - 2000) };
  });
}
