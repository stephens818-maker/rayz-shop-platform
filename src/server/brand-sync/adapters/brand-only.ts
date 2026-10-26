import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { brandSettings, marketingTemplates, ownerEntities, roles, shops } from "@/db/schema";
import { clip, money, onOff } from "@/domain/brand-sync";
import { CheckoutPromptSettings, CheckoutPromptSettingsSchema, PROMPT_MODE_LABEL, promptSettings } from "@/domain/checkout-prompts";
import { LOYALTY_TYPES, LoyaltyConfig, loyaltyConfig } from "@/domain/loyalty";
import { CHANNELS, CHANNEL_LABEL, type Channel, TemplatesSchema, type Templates, templatesProblem } from "@/domain/marketing";
import { MilestoneSettings, milestoneSettings } from "@/domain/milestones";
import {
  BRAND_ONLY,
  MONEY_LIMITS,
  type MoneyLimits,
  OWNER_ROLE_KEY,
  RoleDef,
  SHOP_SCOPES,
  cleanLimits,
  isPermission,
  limitLabel,
  permissionLabel,
  roleChangeDenied,
  templateFor,
  templateRow,
} from "@/domain/permissions";
import { APP_SWITCHES, APP_SWITCH_LABEL, type AppSwitches, resetAppSwitchCache } from "../../app-switches";
import { audit } from "../../audit";
import { grantor } from "../../auth/access";
import { AppError, forbidden, notFound } from "../../errors";
import { getLoyaltyConfig, saveLoyaltyConfig } from "../../loyalty";
import type { SyncAdapter } from "../types";

// ───────────────────────────── Checkout prompts ─────────────────────────────

export const checkoutPromptsAdapter: SyncAdapter<CheckoutPromptSettings, CheckoutPromptSettings> = {
  type: "checkout_prompts",
  columns: ["checkoutPrompts"],
  noun: "Checkout prompts",
  area: "checkout_prompts",
  store: "local",
  live: true,
  brandPerms: ["checkout_prompts.manage"],
  lockable: false,
  note: "On/off rules for a location, role or barber still apply on top.",
  paths: ["/admin/checkout-prompts"],
  items: async () => [{ id: "brand", label: "Rebook and product suggestions" }],
  async brand(tx, ids) {
    if (!ids.includes("brand")) return new Map();
    const [b] = await tx.select({ p: brandSettings.checkoutPrompts }).from(brandSettings).where(eq(brandSettings.id, 1));
    return new Map([["brand", promptSettings(b?.p)]]);
  },
  view: (b) => b,
  async parse(_who, raw) {
    const r = CheckoutPromptSettingsSchema.safeParse(raw);
    if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the checkout prompt settings");
    return { rebook: { ...r.data.rebook, reasons: [...new Set(r.data.rebook.reasons)] }, product: r.data.product };
  },
  async write(tx, who, _item, brand) {
    if (!brand?.to) return;
    await tx.update(brandSettings).set({ checkoutPrompts: brand.to, updatedAt: new Date() }).where(eq(brandSettings.id, 1));
    await audit(who.actor, "brand.checkout_prompts", "brand_settings", "1", { before: brand.from, after: brand.to, via: "brand_sync" }, null, tx);
  },
  describe: (v) => ({
    "Rebook prompt": v.rebook.enabled ? PROMPT_MODE_LABEL[v.rebook.mode] : "Off",
    "Times offered": String(v.rebook.options),
    "Default interval": `${v.rebook.defaultDays} days`,
    "Rebook reminders": v.rebook.reminders ? `On, ${v.rebook.reminderLeadDays} days ahead` : "Off",
    "Decline reasons": String(v.rebook.reasons.length),
    "Product suggestions": v.product.enabled ? PROMPT_MODE_LABEL[v.product.mode] : "Off",
    "Products shown": String(v.product.max),
    "Past purchases": onOff(v.product.pastPurchases),
  }),
  short: (v) => `Rebook ${v.rebook.enabled ? "on" : "off"} · Products ${v.product.enabled ? "on" : "off"}`,
};

// ───────────────────────────── Milestones ─────────────────────────────

/** What a shop shows on the day. Which milestones count, who's emailed and birthdays stay brand-wide. */
export type MilestoneValue = Pick<MilestoneSettings, "calendarBanner" | "posBanner" | "columnBadge" | "liveToast">;
export const milestoneValue = (m: MilestoneSettings): MilestoneValue => ({ calendarBanner: m.calendarBanner, posBanner: m.posBanner, columnBadge: m.columnBadge, liveToast: m.liveToast });

export const milestonesAdapter: SyncAdapter<MilestoneSettings, MilestoneValue> = {
  type: "milestones",
  columns: ["milestones"],
  noun: "Milestone celebrations",
  area: "milestones",
  store: "local",
  live: true,
  brandPerms: ["milestones.settings"],
  lockable: false,
  note: "Shops get the on-the-day banners, badges and toasts. Which milestones count, alerts and birthdays stay brand-wide.",
  paths: ["/admin/milestones", "/admin/milestones/settings"],
  items: async () => [{ id: "brand", label: "Celebrations on the day" }],
  async brand(tx, ids) {
    if (!ids.includes("brand")) return new Map();
    const [b] = await tx.select({ m: brandSettings.milestones }).from(brandSettings).limit(1);
    return new Map([["brand", milestoneSettings(b?.m)]]);
  },
  view: milestoneValue,
  async parse(_who, raw) {
    const p = MilestoneSettings.safeParse(raw);
    if (!p.success) throw new AppError("bad_request", p.error.issues[0]?.message ?? "Check the milestone settings");
    return p.data;
  },
  async write(tx, who, _item, brand) {
    if (!brand?.to) return;
    await tx.update(brandSettings).set({ milestones: brand.to, updatedAt: new Date() });
    await audit(who.actor, "settings.milestones", "brand_settings", "milestones", { ...brand.to, via: "brand_sync" }, null, tx);
  },
  describe: (v) => ({ "Calendar banner": onOff(v.calendarBanner), "POS banner": onOff(v.posBanner), "Column badge": onOff(v.columnBadge), "Live toast": onOff(v.liveToast) }),
  short: (v) => {
    const on = [v.calendarBanner && "Calendar", v.posBanner && "POS", v.columnBadge && "Badge", v.liveToast && "Toast"].filter(Boolean);
    return on.length ? on.join(" · ") : "All off";
  },
};

// ───────────────────────────── Loyalty ─────────────────────────────

export const LoyaltyInput = z.object({
  enabled: z.boolean(),
  type: z.enum(LOYALTY_TYPES),
  thresholdCents: z.number().int().min(100, "Set the goal to at least $1"),
  visitsGoal: z.number().int().min(1, "At least 1 visit").max(100, "At most 100 visits"),
  minVisitCents: z.number().int().min(0).max(100_000),
  rewardCents: z.number().int().min(100, "Make the reward at least $1"),
  includeProducts: z.boolean(),
  includeTips: z.boolean(),
  shopIds: z.array(z.uuid()).max(500).nullable(),
  rewardExpiryDays: z.number().int().min(1).nullable(),
  progressExpiryDays: z.number().int().min(1).nullable(),
  redeemableOn: z.enum(["services", "all"]),
  stackWithPromos: z.boolean(),
});

/** How a visit earns at a shop. The program itself (type, goal, reward, expiry, where it runs) is one for the brand. */
export type LoyaltyValue = Pick<LoyaltyConfig, "minVisitCents" | "includeProducts" | "includeTips">;
export const loyaltyValue = (c: LoyaltyConfig): LoyaltyValue => ({ minVisitCents: c.minVisitCents, includeProducts: c.includeProducts, includeTips: c.includeTips });

export const loyaltyAdapter: SyncAdapter<LoyaltyConfig, LoyaltyValue> = {
  type: "loyalty",
  columns: ["loyalty"],
  noun: "Loyalty earning rules",
  area: "loyalty",
  store: "local",
  live: true,
  brandPerms: ["settings.brand"],
  lockable: false,
  note: "Shops get how a visit earns. The program type, goal, reward, expiry and where it runs stay brand-wide.",
  paths: ["/admin/settings"],
  items: async () => [{ id: "brand", label: "What counts toward a reward" }],
  async brand(tx, ids) {
    return ids.includes("brand") ? new Map([["brand", await getLoyaltyConfig(tx)]]) : new Map();
  },
  view: loyaltyValue,
  async parse(_who, raw, _item, _before, tx) {
    const v = LoyaltyInput.parse(raw);
    if (v.shopIds) {
      const ids = [...new Set(v.shopIds)];
      const known = await tx.select({ id: shops.id }).from(shops).where(inArray(shops.id, ids.length ? ids : [crypto.randomUUID()]));
      if (known.length !== ids.length) throw new AppError("bad_request", "Pick locations from the list");
      v.shopIds = ids;
    }
    return loyaltyConfig(v);
  },
  async write(tx, who, _item, brand) {
    if (!brand?.to) return;
    const { converted } = await saveLoyaltyConfig(brand.to, tx);
    await audit(who.actor, "loyalty.config", "brand", "1", { before: brand.from, after: brand.to, via: "brand_sync", ...(converted ? { progressConverted: converted } : {}) }, null, tx);
  },
  describe: (v) => ({ "Minimum visit": v.minVisitCents ? money(v.minVisitCents) : "None", "Products count": onOff(v.includeProducts), "Tips count": onOff(v.includeTips) }),
  short: (v) => [v.minVisitCents ? `Min ${money(v.minVisitCents)}` : "No minimum", v.includeProducts && "products", v.includeTips && "tips"].filter(Boolean).join(" · "),
};

// ───────────────────────────── App config ─────────────────────────────

/** What a shop's clients can do in the app. Family profiles and marketing pushes are app-wide. */
export type AppValue = Pick<AppSwitches, "booking" | "payments">;
export const appAdapter: SyncAdapter<AppSwitches, AppValue> = {
  type: "app",
  columns: ["appSwitches"],
  noun: "App config",
  area: "app",
  store: "local",
  live: true,
  brandPerms: ["settings.brand"],
  lockable: false,
  note: "Booking and in-app payments can differ by shop. Family profiles and marketing pushes are app-wide. APP_KILL still turns anything off everywhere.",
  paths: ["/admin/app-switches"],
  items: async () => [{ id: "switches", label: "Booking and payments in the app" }],
  async brand(tx, ids) {
    if (!ids.includes("switches")) return new Map();
    const [b] = await tx.select({ s: brandSettings.appSwitches }).from(brandSettings).where(eq(brandSettings.id, 1));
    return new Map([["switches", Object.fromEntries(APP_SWITCHES.map((k) => [k, b?.s?.[k] !== false])) as AppSwitches]]);
  },
  view: (b) => ({ booking: b.booking, payments: b.payments }),
  async parse(_who, raw, _item, before) {
    const next = z.object(Object.fromEntries(APP_SWITCHES.map((k) => [k, z.boolean().optional()]))).parse(raw) as Partial<AppSwitches>;
    return Object.fromEntries(APP_SWITCHES.map((k) => [k, next[k] ?? before?.[k] ?? true])) as AppSwitches;
  },
  async write(tx, who, _item, brand) {
    if (!brand?.to) return;
    await tx
      .insert(brandSettings)
      .values({ id: 1, loyalty: {}, appSwitches: brand.to })
      .onConflictDoUpdate({ target: brandSettings.id, set: { appSwitches: brand.to, updatedAt: new Date() } });
    resetAppSwitchCache();
    await audit(who.actor, "app_switches.update", "brand_settings", null, { ...brand.to, via: "brand_sync" }, null, tx);
  },
  describe: (v) => ({ [APP_SWITCH_LABEL.booking]: onOff(v.booking), [APP_SWITCH_LABEL.payments]: onOff(v.payments) }),
  short: (v) => `Booking ${v.booking ? "on" : "off"} · Pay ${v.payments ? "on" : "off"}`,
};

// ───────────────────────────── Campaign Center templates ─────────────────────────────

export const TemplateBrandInput = z.object({
  name: z.string().trim().min(1, "Name the template").max(80),
  campaignType: z.enum(["update", "promotion"]).default("update"),
  description: z.string().trim().max(300).nullable().default(null),
  channels: z
    .array(z.enum(CHANNELS))
    .min(1, "Pick at least one channel")
    .max(3)
    .refine((a) => new Set(a).size === a.length, "Each channel once"),
  templates: TemplatesSchema,
});
export type TemplateBrand = z.output<typeof TemplateBrandInput>;
/** The wording a shop's library offers; `available` false: the shop doesn't have this template. */
export type TemplateValue = { available: boolean; name: string; description: string | null; channels: Channel[]; templates: Templates };
const templatesOf = (raw: unknown): Templates => TemplatesSchema.parse(raw ?? {});
const channelsOf = (raw: unknown): Channel[] => (Array.isArray(raw) ? raw.filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c)) : []);
const OFF: TemplateValue = { available: false, name: "", description: null, channels: [], templates: TemplatesSchema.parse({}) };

export const campaignTemplateAdapter: SyncAdapter<TemplateBrand, TemplateValue> = {
  type: "campaign_template",
  noun: "Campaign template",
  area: "campaign_templates",
  store: "local",
  live: true,
  brandPerms: ["campaign_center.create"],
  lockable: false,
  absent: OFF,
  note: "Shops it doesn't go to keep the wording they have (or don't get a new template) until it's pushed. Locations only see approved templates.",
  paths: ["/admin/campaign-center", "/admin/campaign-center/templates"],
  async items(tx) {
    const rows = await tx
      .select({ id: marketingTemplates.id, name: marketingTemplates.name, status: marketingTemplates.status })
      .from(marketingTemplates)
      .where(and(ne(marketingTemplates.status, "archived"), isNull(marketingTemplates.purpose)))
      .orderBy(asc(marketingTemplates.name));
    return rows.map((r) => ({ id: r.id, label: r.name, hint: r.status === "draft" ? "Draft" : "Approved" }));
  },
  async brand(tx, ids) {
    if (!ids.length) return new Map();
    const rows = await tx.select().from(marketingTemplates).where(inArray(marketingTemplates.id, [...ids]));
    return new Map(rows.map((r) => [r.id, { name: r.name, campaignType: r.campaignType, description: r.description, channels: channelsOf(r.channels), templates: templatesOf(r.templates) }]));
  },
  view: (b) => ({ available: true, name: b.name, description: b.description || null, channels: [...b.channels], templates: { ...b.templates } }),
  async parse(_who, raw) {
    const r = TemplateBrandInput.safeParse(raw);
    if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the template");
    const problem = templatesProblem(r.data.templates, r.data.channels, { hasCoupon: r.data.campaignType === "promotion" });
    if (problem) throw new AppError("bad_request", problem);
    return { ...r.data, description: r.data.description || null };
  },
  async write(tx, who, item, brand) {
    if (!brand) return;
    if (brand.to === null) {
      await tx.update(marketingTemplates).set({ status: "archived", updatedAt: new Date() }).where(eq(marketingTemplates.id, item));
      await audit(who.actor, "campaign_center.template_archived", "marketing_template", item, { via: "brand_sync.rollback" }, null, tx);
      return;
    }
    const row = { name: brand.to.name, campaignType: brand.to.campaignType, description: brand.to.description, channels: brand.to.channels, templates: { ...brand.to.templates }, updatedAt: new Date() };
    const [was] = await tx.select().from(marketingTemplates).where(eq(marketingTemplates.id, item));
    if (was) {
      const changed = JSON.stringify(templatesOf(was.templates)) !== JSON.stringify(row.templates) || was.campaignType !== row.campaignType || JSON.stringify(was.channels) !== JSON.stringify(row.channels);
      const reapprove = changed && was.status === "approved";
      await tx
        .update(marketingTemplates)
        .set({ ...row, ...(reapprove ? { status: "draft" as const, approvedAt: null, approvedBy: null } : {}) })
        .where(eq(marketingTemplates.id, item));
      await audit(who.actor, "campaign_center.template_saved", "marketing_template", item, { name: row.name, backToDraft: reapprove, via: "brand_sync" }, null, tx);
    } else {
      await tx.insert(marketingTemplates).values({ id: item, ...row, status: "draft", createdBy: who.actor.staffId ?? null });
      await audit(who.actor, "campaign_center.template_created", "marketing_template", item, { name: row.name, via: "brand_sync" }, null, tx);
    }
  },
  describe: (v): Record<string, string> =>
    v.available
      ? { Name: v.name, Channels: v.channels.map((c) => CHANNEL_LABEL[c]).join(", "), Text: clip(v.templates.sms, 60), "Email subject": clip(v.templates.emailSubject, 60), "Push title": clip(v.templates.pushTitle, 60) }
      : { Name: "Not available" },
  short: (v) => (v.available ? v.channels.map((c) => CHANNEL_LABEL[c]).join(" · ") : "Not available"),
};

// ───────────────────────────── Roles ─────────────────────────────

/** A role's stored limits: only the ones that are set, in cents. */
export const roleLimits = (raw: unknown): Partial<MoneyLimits> => Object.fromEntries(Object.entries(cleanLimits(raw)).filter(([, v]) => v !== null));
export const RoleBrandInput = z.object({
  name: z.string().trim().min(2, "Give the role a name").max(40),
  description: z.string().trim().max(300).optional().default(""),
  permissions: z.array(z.string()).transform((xs) => [...new Set(xs.filter(isPermission))].sort()),
  maxDiscountPct: z.number().int().min(0).max(100),
  defaultScope: z.enum(SHOP_SCOPES),
  /** Cents; a missing or null one is no limit. */
  moneyLimits: z
    .object(Object.fromEntries(MONEY_LIMITS.map((l) => [l.key, z.number().int().min(0, "Limits can't be negative").max(10_000_000).nullable().optional()])))
    .optional()
    .transform((v) => roleLimits(v)),
  /** Custom roles only: the owner entity the role belongs to; left as it is when not sent. */
  ownerEntityId: z.uuid().nullable().optional(),
  /** Custom roles only; left as it is when not sent. */
  brandLevel: z.boolean().optional(),
});
export type RoleBrand = Omit<z.output<typeof RoleBrandInput>, "brandLevel" | "ownerEntityId"> & { key: string | null; brandLevel: boolean; ownerEntityId: string | null };
/** What the role lets someone do at a shop. Brand-only permissions work on what every shop shares, so they're always the brand's. */
export type RoleValue = { permissions: string[]; maxDiscountPct: number; moneyLimits?: Partial<MoneyLimits> };
const asDef = (r: RoleBrand): RoleDef => ({ key: r.key, name: r.name, permissions: r.permissions, maxDiscountPct: r.maxDiscountPct, brandLevel: r.brandLevel, moneyLimits: r.moneyLimits, ownerEntityId: r.ownerEntityId });
const roleValue = (r: { permissions: readonly string[]; maxDiscountPct: number; moneyLimits?: unknown }): RoleValue => {
  const limits = roleLimits(r.moneyLimits);
  return {
    permissions: [...new Set(r.permissions.filter((p) => isPermission(p) && !BRAND_ONLY.has(p)))].sort(),
    maxDiscountPct: r.maxDiscountPct,
    ...(Object.keys(limits).length ? { moneyLimits: limits } : {}),
  };
};
const limitsText = (l: Partial<MoneyLimits> | undefined) =>
  MONEY_LIMITS.filter((m) => typeof l?.[m.key] === "number")
    .map((m) => `${m.label} ${limitLabel(l![m.key]!)}`)
    .join(", ") || "None";
/** Every role but the Brand Owner, who always has every permission. */
const syncedRole = sql`${roles.key} is distinct from ${OWNER_ROLE_KEY}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const roleAdapter: SyncAdapter<RoleBrand, RoleValue> = {
  type: "role",
  noun: "Role",
  area: "roles",
  store: "local",
  live: true,
  brandPerms: ["permissions.manage"],
  lockable: false,
  note: "Applies to anyone working at that shop under the role, brand-level and all-shops people included. Permissions that work on what every shop shares (brand-only) are the brand's at every shop.",
  paths: ["/admin/permissions"],
  async items(tx) {
    const rows = await tx.select({ id: roles.id, name: roles.name, brandLevel: roles.brandLevel, scope: roles.defaultScope }).from(roles).where(syncedRole).orderBy(asc(roles.sortOrder), asc(roles.name));
    return rows.map((r) => ({ id: r.id, label: r.name, hint: r.brandLevel ? "Brand-level" : r.scope === "all" ? "All shops" : undefined }));
  },
  async brand(tx, ids) {
    if (!ids.length) return new Map();
    const rows = await tx
      .select()
      .from(roles)
      .where(and(inArray(roles.id, [...ids]), syncedRole));
    return new Map(
      rows.map((r) => [
        r.id,
        {
          key: r.key,
          brandLevel: r.brandLevel,
          name: r.name,
          description: r.description ?? "",
          permissions: [...r.permissions].sort(),
          maxDiscountPct: r.maxDiscountPct,
          defaultScope: r.defaultScope,
          moneyLimits: roleLimits(r.moneyLimits),
          ownerEntityId: r.ownerEntityId,
        },
      ]),
    );
  },
  view: roleValue,
  async parse(who, raw, item, before, tx) {
    if (!before) {
      const [owner] = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.id, UUID.test(item) ? item : crypto.randomUUID()), eq(roles.key, OWNER_ROLE_KEY)));
      if (owner) throw forbidden("The Brand Owner role always has every permission and can't be changed");
      if (!UUID.test(item)) throw notFound("Role");
    }
    const reset = !!raw && typeof raw === "object" && (raw as { reset?: unknown }).reset === true;
    const t = reset ? templateFor(before?.key) : null;
    if (reset && (!before || !t)) throw new AppError("bad_request", "Only built-in roles have a template to reset to");
    const row = t ? templateRow(t) : null;
    const p =
      row && t
        ? { name: t.name, description: row.description ?? "", permissions: [...row.permissions].filter(isPermission).sort(), maxDiscountPct: row.maxDiscountPct, defaultScope: row.defaultScope, moneyLimits: roleLimits(t.moneyLimits), brandLevel: undefined, ownerEntityId: undefined }
        : RoleBrandInput.parse(raw);
    const [dup] = await tx.select({ name: roles.name }).from(roles).where(and(sql`lower(${roles.name}) = lower(${p.name})`, ne(roles.id, item)));
    if (dup) throw new AppError("conflict", `There's already a role called "${dup.name}"`);
    const { brandLevel, ownerEntityId, ...rest } = p;
    if (before?.key && brandLevel !== undefined && brandLevel !== before.brandLevel) throw new AppError("bad_request", "Built-in roles can't be made brand-level");
    const owner = ownerEntityId === undefined ? (before?.ownerEntityId ?? null) : ownerEntityId;
    const after: RoleBrand = { ...rest, key: before?.key ?? null, brandLevel: before?.key ? before.brandLevel : (brandLevel ?? before?.brandLevel ?? false), ownerEntityId: owner };
    if (who.ctx) {
      const denied = roleChangeDenied(grantor(who.ctx.access), before ? asDef(before) : null, asDef(after));
      if (denied) throw forbidden(denied);
    }
    if (owner && owner !== (before?.ownerEntityId ?? null)) {
      const [entity] = await tx.select({ id: ownerEntities.id }).from(ownerEntities).where(eq(ownerEntities.id, owner));
      if (!entity) throw new AppError("bad_request", "Pick an owner from the list");
      if (before) {
        // People who hold the role at shops that owner doesn't run would lose everything there.
        const [{ n }] = await tx.select({ n: sql<number>`count(distinct s.id)::int` }).from(sql`staff s`).where(sql`s.removed_at is null and (
          (s.role_id = ${item} and (s.shop_scope = 'all' or exists (select 1 from staff_access_shops a join shops sh on sh.id = a.shop_id where a.staff_id = s.id and a.role_id is null and sh.owner_entity_id is distinct from ${owner})))
          or exists (select 1 from staff_access_shops a join shops sh on sh.id = a.shop_id where a.staff_id = s.id and a.role_id = ${item} and sh.owner_entity_id is distinct from ${owner}))`);
        if (n) throw new AppError("conflict", `${n} ${n === 1 ? "person holds" : "people hold"} this role at shops that owner doesn't run. Give them another role there first.`);
      }
    }
    return after;
  },
  async write(tx, who, item, brand) {
    if (!brand) return;
    if (brand.to === null) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(sql`staff s`).where(sql`s.role_id = ${item} or exists (select 1 from staff_access_shops a where a.staff_id = s.id and a.role_id = ${item})`);
      if (n) throw new AppError("conflict", `${n} ${n === 1 ? "person has" : "people have"} this role now, so it can't be undone. Give them another role first.`);
      await tx.delete(roles).where(eq(roles.id, item));
      await audit(who.actor, "permissions.role_delete", "role", item, { name: brand.from?.name, via: "brand_sync.rollback" }, null, tx);
      return;
    }
    const all: string[] = brand.to.permissions;
    const permissions = all.filter((x) => !/^report\..+\.export$/.test(x) || all.includes(x.replace(/\.export$/, ".view")));
    const values = {
      name: brand.to.name,
      description: brand.to.description,
      permissions,
      maxDiscountPct: brand.to.maxDiscountPct,
      moneyLimits: roleLimits(brand.to.moneyLimits),
      defaultScope: brand.to.defaultScope,
      brandLevel: brand.to.brandLevel,
      ownerEntityId: brand.to.ownerEntityId ?? null,
      updatedAt: new Date(),
    };
    if (brand.from) await tx.update(roles).set(values).where(eq(roles.id, item));
    else {
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${roles.sortOrder}), 0)::int` }).from(roles);
      await tx.insert(roles).values({ id: item, ...values, key: null, sortOrder: n + 10 });
    }
    const was = new Set<string>(brand.from?.permissions ?? []);
    const from = brand.from;
    const change = <T>(a: T | undefined, b: T) => (from && JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? undefined : { from: from ? (a ?? null) : null, to: b ?? null });
    await audit(
      who.actor,
      brand.from ? "permissions.role_update" : "permissions.role_create",
      "role",
      item,
      {
        name: brand.to.name,
        added: permissions.filter((x) => !was.has(x)),
        removed: [...was].filter((x) => !permissions.includes(x)),
        maxDiscountPct: change(from?.maxDiscountPct, brand.to.maxDiscountPct),
        renamed: change(from?.name, brand.to.name),
        description: change(from?.description, brand.to.description),
        defaultScope: change(from?.defaultScope, brand.to.defaultScope),
        moneyLimits: change(from?.moneyLimits && limitsText(from.moneyLimits), limitsText(values.moneyLimits)),
        ownerEntityId: change(from?.ownerEntityId, values.ownerEntityId),
        brandLevel: change(from?.brandLevel, brand.to.brandLevel),
        via: "brand_sync",
      },
      null,
      tx,
    );
  },
  describe: (v) => ({ Permissions: `${v.permissions.length}`, "Max discount": `${v.maxDiscountPct}%`, "Dollar limits": limitsText(v.moneyLimits) }),
  short: (v) => `${v.permissions.length} permissions · ${v.maxDiscountPct}%${v.moneyLimits ? " · limits" : ""}`,
};

/** For the history: which permissions a role change adds or removes at a shop. */
export function rolePermissionDiff(from: RoleValue | null, to: RoleValue | null): { added: string[]; removed: string[] } {
  const a = new Set(from?.permissions ?? []);
  const b = new Set(to?.permissions ?? []);
  const label = (p: string) => (isPermission(p) ? permissionLabel(p) : p);
  return { added: [...b].filter((p) => !a.has(p)).map(label), removed: [...a].filter((p) => !b.has(p)).map(label) };
}
