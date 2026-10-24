"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { brandSettings, clientAccessAlerts, clientFieldRules, clientFields, roles, shops, staff } from "@/db/schema";
import {
  Entry,
  EntrySetting,
  FieldKey,
  Level,
  SETTINGS,
  SETTING_LABEL,
  cleanLimits,
  customFieldId,
  fieldLabel,
  fieldRuleChangeDenied,
  isBuiltinField,
  isShopLoginCap,
  resolveEntry,
  resolveLevel,
} from "@/domain/client-privacy";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, authorize } from "@/server/auth/staff";
import { rulesFor, saveShopLoginCap } from "@/server/client-privacy";
import { AppError, forbidden, notFound } from "@/server/errors";

function revalidate() {
  revalidatePath("/admin", "layout");
}

/** What the caller sees and may enter of a field at a shop (or brand-wide), for "nobody gives more than they have". */
async function callerRights(ctx: StaffContext) {
  const roleIds = [ctx.access.role.id, ...[...ctx.access.byShop.values()].map((s) => s.role.id)];
  const rules = ctx.isOwner ? [] : await rulesFor(ctx.staff.id, [...new Set(roleIds)]);
  const who = (shopId: string | null) => {
    const role = (shopId && ctx.access.byShop.get(shopId)?.role) || ctx.access.role;
    return { staffId: ctx.staff.id, roleId: role.id, roleKey: role.key };
  };
  return {
    levelAt: (shopId: string | null, field: FieldKey): Level => resolveLevel(rules, who(shopId), shopId, field),
    entryAt: (shopId: string | null, field: FieldKey, setting: EntrySetting) => resolveEntry(rules, who(shopId), shopId, field, setting),
  };
}

const FieldSchema = z.string().refine((f) => isBuiltinField(f) || /^custom:[0-9a-f-]{36}$/.test(f), "Unknown field");

const RuleSchema = z.object({
  field: FieldSchema,
  roleId: z.string().uuid().nullable(),
  staffId: z.string().uuid().nullable(),
  shopId: z.string().uuid().nullable(),
  /** "view": how visible the field is; "add" and "edit": whether it may be entered. */
  setting: z.enum(SETTINGS).default("view"),
  /** hidden, masked or full for view; allow or deny for add and edit. null removes the rule, so the next one down applies. */
  level: z.string().nullable(),
});

/** Set or clear how visible one client field is to a role or a person, or whether they may add or edit it, brand-wide or at one shop. */
export async function setFieldRuleAction(raw: z.input<typeof RuleSchema>) {
  return safe(async () => {
    const ctx = await authorize("clients.privacy", "You can't change client data protection");
    const p = RuleSchema.parse(raw);
    const field = p.field as FieldKey;
    const custom = await db.select({ id: clientFields.id, label: clientFields.label }).from(clientFields);
    if (!isBuiltinField(field) && !custom.some((c) => c.id === customFieldId(field))) throw notFound("Field");
    const role = p.roleId ? await db.query.roles.findFirst({ where: eq(roles.id, p.roleId) }) : null;
    if (p.roleId && !role) throw notFound("Role");
    const person = p.staffId ? await db.query.staff.findFirst({ where: eq(staff.id, p.staffId), columns: { id: true, displayLabel: true, roleId: true } }) : null;
    if (p.staffId && !person) throw notFound("Staff member");
    const personRole = person ? await db.query.roles.findFirst({ where: eq(roles.id, person.roleId), columns: { key: true } }) : null;
    const shop = p.shopId ? await db.query.shops.findFirst({ where: eq(shops.id, p.shopId), columns: { name: true } }) : null;
    if (p.shopId && !shop) throw notFound("Shop");
    const denied = fieldRuleChangeDenied(
      { staffId: ctx.staff.id, roleId: ctx.access.role.id, isOwner: ctx.isOwner, ...(await callerRights(ctx)) },
      { field, setting: p.setting, roleId: p.roleId, roleKey: role?.key ?? personRole?.key ?? null, staffId: p.staffId, shopId: p.shopId, level: p.level },
    );
    if (denied) throw forbidden(denied);
    const match = and(
      eq(clientFieldRules.field, field),
      eq(clientFieldRules.setting, p.setting),
      p.roleId ? eq(clientFieldRules.roleId, p.roleId) : isNull(clientFieldRules.roleId),
      p.staffId ? eq(clientFieldRules.staffId, p.staffId) : isNull(clientFieldRules.staffId),
      p.shopId ? eq(clientFieldRules.shopId, p.shopId) : isNull(clientFieldRules.shopId),
    );
    await db.transaction(async (tx) => {
      const [before] = await tx.select({ level: clientFieldRules.level }).from(clientFieldRules).where(match);
      await tx.delete(clientFieldRules).where(match);
      if (p.level)
        await tx
          .insert(clientFieldRules)
          .values({ field, setting: p.setting, roleId: p.roleId, staffId: p.staffId, shopId: p.shopId, level: p.level as Level | Entry, updatedBy: ctx.staff.id });
      await audit(
        ctx.actor,
        "client_data.rule",
        "client_field_rule",
        field,
        {
          field: fieldLabel(field, custom),
          setting: SETTING_LABEL[p.setting],
          for: role ? { role: role.name } : { person: person!.displayLabel },
          where: shop?.name ?? "brand default",
          from: before?.level ?? "inherit",
          to: p.level ?? "inherit",
        },
        p.shopId,
        tx,
      );
    });
    revalidate();
    return null;
  });
}

const CustomFieldSchema = z.object({ id: z.string().uuid().nullable(), label: z.string().trim().min(2, "Name the field").max(40), active: z.boolean() });

/** Brand-defined client fields (Instagram, allergies...). New ones start as locked down as the role defaults for custom fields. */
export async function saveCustomFieldAction(raw: z.input<typeof CustomFieldSchema>) {
  return safe(async () => {
    const ctx = await authorize("clients.privacy", "You can't change client fields");
    const p = CustomFieldSchema.parse(raw);
    const dup = await db.query.clientFields.findFirst({ where: and(sql`lower(${clientFields.label}) = lower(${p.label})`, p.id ? sql`${clientFields.id} <> ${p.id}` : undefined) });
    if (dup) throw new AppError("conflict", `There's already a field called "${dup.label}"`);
    let id = p.id;
    if (id) {
      const before = await db.query.clientFields.findFirst({ where: eq(clientFields.id, id) });
      if (!before) throw notFound("Field");
      await db.update(clientFields).set({ label: p.label, active: p.active }).where(eq(clientFields.id, id));
      await audit(
        ctx.actor,
        "client_data.field_update",
        "client_field",
        id,
        { label: before.label === p.label ? p.label : { from: before.label, to: p.label }, active: p.active },
        null,
      );
    } else {
      const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${clientFields.sortOrder}), 0)::int` }).from(clientFields);
      id = (
        await db
          .insert(clientFields)
          .values({ label: p.label, active: p.active, sortOrder: n + 10 })
          .returning({ id: clientFields.id })
      )[0].id;
      await audit(ctx.actor, "client_data.field_create", "client_field", id, { label: p.label }, null);
    }
    revalidate();
    return { id };
  });
}

const LimitsSchema = z.object({
  windowMinutes: z.number().int().min(1).max(1440),
  alertProfiles: z.number().int().min(1).max(10_000),
  blockProfiles: z.number().int().min(1).max(10_000),
  alertSearches: z.number().int().min(1).max(100_000),
  blockSearches: z.number().int().min(1).max(100_000),
});

export async function saveLookupLimitsAction(raw: z.input<typeof LimitsSchema>) {
  return safe(async () => {
    const ctx = await authorize("clients.privacy", "You can't change lookup limits");
    const p = LimitsSchema.parse(raw);
    if (p.blockProfiles < p.alertProfiles || p.blockSearches < p.alertSearches) throw new AppError("bad_request", "The pause level can't be below the alert level");
    const limits = cleanLimits(p);
    const [before] = await db.select({ l: brandSettings.clientLookupLimits }).from(brandSettings).where(eq(brandSettings.id, 1));
    await db
      .update(brandSettings)
      .set({ clientLookupLimits: { ...limits } as Record<string, number> })
      .where(eq(brandSettings.id, 1));
    await audit(ctx.actor, "client_data.limits", "brand_settings", "1", { from: cleanLimits(before?.l), to: limits }, null);
    revalidate();
    return null;
  });
}

/** How much contact detail shared shop logins see. Lifting the cap to the role's rules is the Brand Owner's call. */
export async function saveShopLoginCapAction(cap: string) {
  return safe(async () => {
    const ctx = await authorize("clients.privacy", "You can't change client data protection");
    if (!isShopLoginCap(cap)) throw new AppError("bad_request", "Pick how much shop logins see");
    if (cap === "role" && !ctx.isOwner) throw forbidden("Only the Brand Owner can let shop logins see more than masked contact details");
    await saveShopLoginCap(cap, ctx.actor);
    revalidate();
    return null;
  });
}

export async function acknowledgeAlertAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("clients.privacy");
    const [row] = await db
      .update(clientAccessAlerts)
      .set({ acknowledgedBy: ctx.staff.id, acknowledgedAt: new Date() })
      .where(and(eq(clientAccessAlerts.id, z.string().uuid().parse(id)), isNull(clientAccessAlerts.acknowledgedAt)))
      .returning({ id: clientAccessAlerts.id, who: clientAccessAlerts.actorLabel, kind: clientAccessAlerts.kind });
    if (!row) throw notFound("Alert");
    await audit(ctx.actor, "client_data.alert_ack", "client_access_alert", id, { who: row.who, kind: row.kind }, null);
    revalidatePath("/admin/client-data/access");
    return null;
  });
}
