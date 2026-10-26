"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { assertShopMayEdit, noteShopEdit } from "@/server/brand-sync/engine";
import { forbidden } from "@/server/errors";
import {
  ApplyTemplateInput,
  BulkProductsInput,
  BulkServicesInput,
  BulkShopServicesInput,
  BulkStaffInput,
  applyScheduleTemplate,
  bulkProductChanges,
  bulkServiceChanges,
  bulkShopServices,
  bulkStaff,
  bulkUpdateProducts,
  bulkUpdateServices,
  deleteScheduleTemplate,
  saveScheduleTemplate,
} from "@/server/bulk-edit";
import { ScheduleTemplateInput } from "@/domain/bulk-edit";
import { assertCanSchedule } from "@/server/staff-guards";

const refresh = (...paths: string[]) => {
  revalidatePath("/admin/bulk-edit");
  for (const p of paths) revalidatePath(p);
};

export async function bulkServicesAction(raw: z.input<typeof BulkServicesInput>) {
  return safe(async () => {
    const ctx = await authorize("catalog.manage");
    const r = await bulkUpdateServices(ctx.actor, raw);
    refresh("/admin/services");
    return r;
  });
}

/** The brand changes a services bulk edit makes, for the sync dialog to preview and send to the shops picked. */
export async function bulkServiceChangesAction(raw: z.input<typeof BulkServicesInput>) {
  return safe(async () => {
    await authorize("catalog.manage");
    return bulkServiceChanges(raw);
  });
}

export async function bulkProductChangesAction(raw: z.input<typeof BulkProductsInput>) {
  return safe(async () => {
    await authorize("catalog.manage");
    return bulkProductChanges(raw);
  });
}

export async function bulkShopServicesAction(raw: z.input<typeof BulkShopServicesInput>) {
  return safe(async () => {
    const ctx = await authorize(["catalog.prices", "catalog.manage"]);
    assertShopAccess(ctx, raw.shopId);
    if (raw.enabled !== undefined) await assertShopMayEdit(ctx, "service");
    const r = await bulkShopServices(ctx.actor, raw);
    await noteShopEdit("service", raw.ids, raw.shopId);
    refresh("/admin/services");
    return r;
  });
}

export async function bulkProductsAction(raw: z.input<typeof BulkProductsInput>) {
  return safe(async () => {
    const ctx = await authorize("catalog.manage");
    const r = await bulkUpdateProducts(ctx.actor, raw);
    refresh("/admin/products", "/admin/inventory");
    return r;
  });
}

export async function bulkStaffAction(raw: z.input<typeof BulkStaffInput>) {
  return safe(async () => {
    const ctx = await authorize("staff.manage");
    const r = await bulkStaff({ actor: ctx.actor, staffId: ctx.staff.id, shopIds: ctx.shopIds, brandWide: ctx.brandWide }, raw);
    refresh("/admin/staff");
    return r;
  });
}

/** Templates are shared by every shop's managers, so editing one needs access to all shops. */
export async function saveScheduleTemplateAction(raw: z.input<typeof ScheduleTemplateInput>) {
  return safe(async () => {
    const ctx = await authorize("schedules.edit");
    if (!ctx.brandWide && raw.id) throw forbidden("Templates are shared by every shop; changing one needs access to all shops");
    const r = await saveScheduleTemplate(ctx.actor, raw);
    refresh();
    return r;
  });
}

export async function deleteScheduleTemplateAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("schedules.edit");
    if (!ctx.brandWide) throw forbidden("Templates are shared by every shop; deleting one needs access to all shops");
    await deleteScheduleTemplate(ctx.actor, z.uuid().parse(id));
    refresh();
    return null;
  });
}

export async function applyScheduleTemplateAction(raw: z.input<typeof ApplyTemplateInput>) {
  return safe(async () => {
    const ctx = await authorize("schedules.edit");
    assertShopAccess(ctx, raw.shopId);
    const r = await applyScheduleTemplate(ctx.actor, raw, (id) => assertCanSchedule(ctx, id));
    refresh("/admin/staff", "/admin/calendar");
    return r;
  });
}
