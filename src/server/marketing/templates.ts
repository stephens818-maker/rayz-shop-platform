/**
 * The brand's template library: wording for common blasts (new hours, holiday closing, a seasonal
 * promotion, refer a friend) that the brand writes and approves. Locations start a blast from an
 * approved template and change what they need; only the brand writes, approves or archives them.
 * Changing an approved template's wording sends it back to draft until it's approved again.
 */
import { asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { marketingTemplates, staff } from "@/db/schema";
import { CHANNELS, TemplatesSchema, templatesProblem, type Channel, type Templates } from "@/domain/marketing";
import { z } from "zod";
import { audit } from "../audit";
import { StaffContext, assertCan, can } from "../auth/staff";
import { localValues } from "../brand-sync/store";
import { AppError, forbidden, notFound } from "../errors";
import { channelsOf, templatesOf } from "./engine";

export type TemplateStatus = "draft" | "approved" | "archived";

export interface TemplateView {
  id: string;
  name: string;
  campaignType: "update" | "promotion";
  description: string | null;
  channels: Channel[];
  templates: Templates;
  status: TemplateStatus;
  approvedAt: Date | null;
  approvedBy: string | null;
  updatedAt: Date;
  /** Offered from a staff milestone rather than as a general blast. */
  purpose: "milestone" | null;
}

const mayBrand = (ctx: StaffContext) => can(ctx, "campaign_center.create") && ctx.brandWide;

/** The library's starting wording, approved, as core_0065 writes it. */
export const STARTER_TEMPLATES: { name: string; campaignType: "update" | "promotion"; description: string; templates: Templates }[] = [
  {
    name: "New hours",
    campaignType: "update",
    description: "A change to a location's hours.",
    templates: {
      sms: "{shop}: Hi {first_name}, our hours are changing. See the new times and book: {book_link} Reply STOP to opt out.",
      emailSubject: "New hours at {shop}",
      emailBody: "Hi {first_name},\n\nOur hours at {shop} are changing. See the new times and grab a spot that suits you: {book_link}",
      pushTitle: "New hours at {shop}",
      pushBody: "See the new times and book.",
    },
  },
  {
    name: "Holiday closing",
    campaignType: "update",
    description: "Closed for a holiday; book before or after.",
    templates: {
      sms: "{shop}: Heads up {first_name}, we're closed for the holiday. Book before or after: {book_link} Reply STOP to opt out.",
      emailSubject: "Holiday hours at {shop}",
      emailBody: "Hi {first_name},\n\n{shop} is closed for the holiday. Book a time before or after so you're fresh for it: {book_link}",
      pushTitle: "Holiday hours",
      pushBody: "Book before or after the holiday.",
    },
  },
  {
    name: "Seasonal promotion",
    campaignType: "promotion",
    description: "A limited-time offer with a promo code.",
    templates: {
      sms: "{shop}: {first_name}, this one's for you: {coupon_code} on your next cut, till {expiry}. Book: {book_link} Reply STOP to opt out.",
      emailSubject: "A little something from {shop}",
      emailBody: "Hi {first_name},\n\nUse {coupon_code} on your next visit, good till {expiry}. Book here: {book_link}",
      pushTitle: "An offer from {shop}",
      pushBody: "Use {coupon_code} till {expiry}.",
    },
  },
  {
    name: "Refer a friend",
    campaignType: "promotion",
    description: "Thank regulars and offer a code to share.",
    templates: {
      sms: "{shop}: Thanks for being a regular, {first_name}! Bring a friend and use {coupon_code} till {expiry}: {book_link} Reply STOP to opt out.",
      emailSubject: "Bring a friend to {shop}",
      emailBody: "Hi {first_name},\n\nThanks for being a regular. Bring a friend and use {coupon_code}, good till {expiry}. Book: {book_link}",
      pushTitle: "Bring a friend",
      pushBody: "Use {coupon_code} till {expiry}.",
    },
  },
];

/** The starter templates, written the first time the library is opened with none (a database seeded after the migration). */
export async function ensureStarterTemplates() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('marketing_templates:starter'))`);
    const [any] = await tx.select({ id: marketingTemplates.id }).from(marketingTemplates).where(isNull(marketingTemplates.purpose)).limit(1);
    if (any) return;
    const now = new Date();
    await tx.insert(marketingTemplates).values(STARTER_TEMPLATES.map((t) => ({ ...t, templates: { ...t.templates }, channels: [...CHANNELS], status: "approved" as const, approvedAt: now })));
  });
}

/** The brand sees every template (archived with `archived`); everyone else only approved ones. */
export async function listTemplates(ctx: StaffContext, o: { archived?: boolean } = {}): Promise<TemplateView[]> {
  assertCan(ctx, ["campaign_center.view", "campaign_center.create", "campaign_center.send"]);
  await ensureStarterTemplates();
  const brand = mayBrand(ctx);
  const statuses: TemplateStatus[] = brand ? (o.archived ? ["draft", "approved", "archived"] : ["draft", "approved"]) : ["approved"];
  const rows = await db.select().from(marketingTemplates).where(inArray(marketingTemplates.status, statuses)).orderBy(asc(marketingTemplates.name));
  const ids = [...new Set(rows.map((r) => r.approvedBy).filter((x): x is string => !!x))];
  const names = ids.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids)) : [];
  // A location sees the version of each template the brand synced to it (Setup → Sync status).
  const shopId = brand ? null : (ctx.currentShopId ?? (ctx.shopIds.length === 1 ? ctx.shopIds[0] : null));
  const own = shopId ? await localValues<{ available: boolean; name: string; description: string | null; channels: Channel[]; templates: Templates }>("campaign_template", [shopId]) : new Map();
  const shopRows = shopId
    ? rows
        .filter((r) => own.get(`${shopId}|${r.id}`)?.available !== false)
        .map((r) => {
          const o = own.get(`${shopId}|${r.id}`);
          return o ? { ...r, name: o.name, description: o.description, channels: o.channels, templates: o.templates } : r;
        })
    : rows;
  return shopRows.map((r) => ({
    id: r.id,
    name: r.name,
    campaignType: r.campaignType,
    description: r.description,
    channels: channelsOf(r.channels),
    templates: templatesOf(r.templates),
    status: r.status,
    approvedAt: r.approvedAt,
    approvedBy: names.find((n) => n.id === r.approvedBy)?.label ?? null,
    updatedAt: r.updatedAt,
    purpose: r.purpose ?? null,
  }));
}

const TemplateInput = z.object({
  id: z.uuid().nullable().default(null),
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
export type TemplateInput = z.input<typeof TemplateInput>;

const problemOf = (t: { templates: Templates; channels: Channel[]; campaignType: "update" | "promotion" }) => templatesProblem(t.templates, t.channels, { hasCoupon: t.campaignType === "promotion" });

export async function saveTemplate(ctx: StaffContext, input: unknown): Promise<string> {
  if (!mayBrand(ctx)) throw forbidden("Only the brand writes templates");
  const r = TemplateInput.safeParse(input);
  if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the template");
  const v = r.data;
  const problem = problemOf(v);
  if (problem) throw new AppError("bad_request", problem);
  const row = { name: v.name, campaignType: v.campaignType, description: v.description || null, channels: v.channels, templates: { ...v.templates }, updatedAt: new Date() };
  if (v.id) {
    const [was] = await db.select().from(marketingTemplates).where(eq(marketingTemplates.id, v.id));
    if (!was) throw notFound("Template");
    const changed = JSON.stringify(templatesOf(was.templates)) !== JSON.stringify(templatesOf(v.templates)) || was.campaignType !== v.campaignType || JSON.stringify(was.channels) !== JSON.stringify(v.channels);
    const reapprove = changed && was.status === "approved";
    await db
      .update(marketingTemplates)
      .set({ ...row, ...(reapprove ? { status: "draft" as const, approvedAt: null, approvedBy: null } : {}) })
      .where(eq(marketingTemplates.id, v.id));
    await audit(ctx.actor, "campaign_center.template_saved", "marketing_template", v.id, { name: v.name, backToDraft: reapprove }, null);
    return v.id;
  }
  const [t] = await db
    .insert(marketingTemplates)
    .values({ ...row, status: "draft", createdBy: ctx.staff.id })
    .returning({ id: marketingTemplates.id });
  await audit(ctx.actor, "campaign_center.template_created", "marketing_template", t.id, { name: v.name }, null);
  return t.id;
}

/** Approve (locations can use it), send back to draft, or archive. */
export async function setTemplateStatus(ctx: StaffContext, id: string, status: TemplateStatus, now = new Date()) {
  if (!mayBrand(ctx)) throw forbidden("Only the brand approves templates");
  const [t] = await db.select().from(marketingTemplates).where(eq(marketingTemplates.id, id));
  if (!t) throw notFound("Template");
  if (status === "approved") {
    const problem = problemOf({ templates: templatesOf(t.templates), channels: channelsOf(t.channels), campaignType: t.campaignType });
    if (problem) throw new AppError("bad_request", problem);
  }
  await db
    .update(marketingTemplates)
    .set(status === "approved" ? { status, approvedAt: now, approvedBy: ctx.staff.id, updatedAt: now } : status === "draft" ? { status, approvedAt: null, approvedBy: null, updatedAt: now } : { status, updatedAt: now })
    .where(eq(marketingTemplates.id, id));
  await audit(ctx.actor, `campaign_center.template_${status}`, "marketing_template", id, { name: t.name }, null);
}
