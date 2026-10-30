"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { BULK_FEE_ACTIONS, BulkFeeAction, FEE_APPLY_TO, FEE_APPLY_TO_LABEL, SHOP_FEE_OFF_LABEL } from "@/domain/card-fee-policy";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { bulkShopFee, saveBrandFeePolicy } from "@/server/payments/card-fee";

async function brandAdmin() {
  const ctx = await authorize("settings.card_fee");
  if (!ctx.brandWide) throw new AppError("forbidden", "Which shops use the surcharge is set for the whole brand");
  return ctx;
}

const refresh = () => {
  revalidatePath("/admin/card-fee");
  revalidatePath("/admin/settings");
};

const Shops = z.object({
  appliesTo: z.enum(FEE_APPLY_TO),
  shopIds: z.array(z.uuid()).max(500),
  shopsCanEdit: z.boolean(),
});

/** Which shops use the brand's surcharge, and whether shop managers may change their own. Audited with the shops it reached. */
export async function saveFeeShopsAction(raw: z.input<typeof Shops>) {
  return safe(async () => {
    const ctx = await brandAdmin();
    const d = Shops.parse(raw);
    if (d.appliesTo === "selected" && !d.shopIds.length) throw new AppError("bad_request", `Tick at least one shop, or choose "${FEE_APPLY_TO_LABEL.none}"`);
    await saveBrandFeePolicy(ctx.actor, d);
    refresh();
    return null;
  });
}

/** Enable, disable, apply the brand rate, reset or push the brand's settings at many shops at once. */
export async function bulkShopFeeAction(action: BulkFeeAction, shopIds: string[]) {
  return safe(async () => {
    const ctx = await brandAdmin();
    const a = z.enum(BULK_FEE_ACTIONS).parse(action);
    const ids = z.array(z.uuid()).min(1, "Pick at least one shop").max(500).parse(shopIds);
    const changes = await bulkShopFee(ctx.actor, a, ids);
    refresh();
    const stillOff = a === "enable" || a === "push" ? changes.filter((c) => !c.to.on && c.to.off === "state_not_allowed").map((c) => c.name) : [];
    return { changed: changes.length, stillOff, note: stillOff.length ? `${SHOP_FEE_OFF_LABEL.state_not_allowed}: ${stillOff.join(", ")}` : null };
  });
}
