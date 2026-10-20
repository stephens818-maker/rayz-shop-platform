"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { requireStaff } from "@/server/auth/staff";
import { runImport, type ImportResult } from "@/server/importer";

const Input = z.object({
  kind: z.enum(["clients", "appointments", "loyalty", "gift_cards"]),
  csv: z.string().min(1, "The file is empty"),
  filename: z.string().max(200).optional(),
  dryRun: z.boolean(),
});

export async function importAction(raw: z.input<typeof Input>) {
  return safe<ImportResult>(async () => {
    const ctx = await requireStaff(["brand_admin"]);
    const p = Input.parse(raw);
    const result = await runImport(p.kind, p.csv, { dryRun: p.dryRun, actor: ctx.actor, filename: p.filename });
    if (!p.dryRun) revalidatePath("/admin/import");
    return { ...result, errors: result.errors.slice(0, 200) };
  });
}
