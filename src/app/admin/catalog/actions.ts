"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { authorize, can } from "@/server/auth/staff";
import { rollbackCatalogUpload, uploadCatalog } from "@/server/catalog-import";
import { AppError, forbidden } from "@/server/errors";

/**
 * Preview (dry run) or save a catalog sheet. People with catalog.manage upload items and push them
 * to shops; people with only inventory.manage can set stock and low-stock levels at their shops.
 */
export async function uploadCatalogAction(form: FormData) {
  return safe(async () => {
    const ctx = await authorize(["catalog.manage", "inventory.manage"]);
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new AppError("bad_request", "Choose a CSV or XLSX file");
    const mode = can(ctx, "catalog.manage") ? "catalog" : "stock";
    const picked = form.getAll("shops").map(String);
    let targetShopIds: string[];
    if (form.get("allShops") === "1") {
      if (mode === "catalog" && !ctx.brandWide) throw forbidden("Only people with access to all shops can push to every shop");
      targetShopIds = ctx.shopIds;
    } else {
      const outside = picked.filter((s) => !ctx.shopIds.includes(s));
      if (outside.length) throw forbidden("That shop is outside your access");
      targetShopIds = [...new Set(picked)];
    }
    if (mode === "stock" && !targetShopIds.length) throw new AppError("bad_request", "Pick the shops to update");
    const dryRun = form.get("dryRun") === "1";
    const result = await uploadCatalog({
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mode,
      targetShopIds,
      allowedShopIds: ctx.shopIds,
      dryRun,
      actor: ctx.actor,
    });
    if (!dryRun) {
      revalidatePath("/admin/catalog");
      revalidatePath("/admin/inventory");
      revalidatePath("/admin/services");
    }
    return result;
  });
}

/** Undo one saved upload: everything it changed goes back, at every shop it reached. */
export async function rollbackCatalogUploadAction(runId: string) {
  return safe(async () => {
    const ctx = await authorize(["catalog.manage", "inventory.manage"]);
    const r = await rollbackCatalogUpload({ runId: z.uuid().parse(runId), actor: ctx.actor, allowedShopIds: ctx.shopIds, mode: can(ctx, "catalog.manage") ? "catalog" : "stock" });
    revalidatePath("/admin/catalog");
    revalidatePath("/admin/inventory");
    revalidatePath("/admin/services");
    revalidatePath("/admin/sync-status");
    return r;
  });
}
