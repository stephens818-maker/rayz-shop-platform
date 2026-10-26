"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { clientPolicy, redactImportErrors } from "@/server/client-privacy";
import { importFamilies, type FamilyImportResult } from "@/server/family-import";
import { clientMatchReport, type ShopMatchLine } from "@/server/import-match-report";
import { IMPORT_KINDS, runImport, type ImportResult } from "@/server/importer";
import { reconcileSquireClients, type SquireReconcileResult } from "@/server/squire-reconcile";

const Input = z.object({
  kind: z.enum(IMPORT_KINDS as [string, ...string[]]),
  csv: z.string().min(1, "The file is empty"),
  filename: z.string().max(200).optional(),
  dryRun: z.boolean(),
  /** A cutover delta import: bookings and tickets of other shops are left alone. */
  shopId: z.string().uuid().optional(),
});

/** The full error list (with the original rows) is kept on the run; the page shows the first 2,000, with client details as the importer may see them. */
export async function importAction(raw: z.input<typeof Input>) {
  return safe<ImportResult & { errorsTruncated: number; family: FamilyImportResult | null; reconcile: SquireReconcileResult | null; matchReport: ShopMatchLine[] | null }>(async () => {
    const ctx = await authorize("import.run");
    const p = Input.parse(raw);
    const result = await runImport(p.kind as ImportResult["kind"], p.csv, { dryRun: p.dryRun, actor: ctx.actor, filename: p.filename, shopId: p.shopId });
    const matchReport = p.kind === "clients" && p.dryRun ? await clientMatchReport(p.csv) : null;
    // Squire kid records go on their parent's account once both are on file.
    const family = p.kind === "clients" ? await importFamilies(p.csv, { dryRun: p.dryRun, actor: ctx.actor }) : null;
    // One profile per client: the same person at several Squire shops, matched by name and birthday.
    const reconcile = p.kind === "clients" ? await reconcileSquireClients(p.csv, { dryRun: p.dryRun, actor: ctx.actor }) : null;
    if (!p.dryRun) {
      revalidatePath("/admin/import");
      revalidatePath("/admin/cutover");
    }
    const errors = redactImportErrors(await clientPolicy(ctx), result.headerMap, result.errors.slice(0, 2000));
    return { ...result, errors, errorsTruncated: Math.max(0, result.errors.length - 2000), family, reconcile, matchReport };
  });
}
