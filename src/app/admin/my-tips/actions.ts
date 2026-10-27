"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { forbidden } from "@/server/errors";
import { inTenant } from "@/server/tenant";
import { declareCashTips } from "@/server/tips/declarations";

const Declare = z.object({
  shopId: z.uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.number().int().min(0).max(1_000_000),
  attest: z.boolean(),
  replacesId: z.uuid().nullish(),
  reason: z.string().trim().max(300).nullish(),
});

function refresh() {
  revalidatePath("/admin/my-tips");
  revalidatePath("/admin/timesheets", "layout");
  revalidatePath("/admin/payroll", "layout");
}

/** Their own cash tips for a day, or a correction of one of their declarations (SB-C3). */
export async function declareCashTipsAction(input: z.input<typeof Declare>) {
  return safe(async () => {
    const ctx = await authorize("tips.own");
    const v = Declare.parse(input);
    assertShopAccess(ctx, v.shopId);
    const d = await declareCashTips({ staffId: ctx.staff.id, ...v, attested: v.attest, source: "web", actor: ctx.actor });
    refresh();
    return { id: d.id };
  });
}

/** A manager enters or corrects someone's declaration, with a reason; allowed after the month closes, never in a locked pay period. */
export async function managerDeclareAction(input: z.input<typeof Declare> & { staffId: string }) {
  return safe(async () => {
    const ctx = await authorize("timesheet.edit");
    const v = Declare.extend({ staffId: z.uuid() }).parse(input);
    assertShopAccess(ctx, v.shopId);
    if (v.staffId === ctx.staff.id && !ctx.isOwner) throw forbidden("Ask another manager to enter your own cash tips.");
    if (!(await inTenant(ctx, "staff", v.staffId))) throw forbidden("Not someone at your shops");
    const d = await declareCashTips({ ...v, attested: true, source: "manager", actor: ctx.actor });
    refresh();
    return { id: d.id };
  });
}
