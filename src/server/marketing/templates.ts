/**
 * The brand's template library: wording for common blasts (new hours, holiday closing, a seasonal
 * promotion, refer a friend) that the brand writes and approves. Locations start a blast from an
 * approved template and change what they need; only the brand writes, approves or archives them.
 * Changing an approved template's wording sends it back to draft until it's approved again.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { marketingTemplates, staff } from "@/db/schema";
import { CHANNELS, TemplatesSchema, templatesProblem, type Channel, type Templates } from "@/domain/marketing";
import { z } from "zod";
import { audit } from "../audit";
import { StaffContext, assertCan, can } from "../auth/staff";
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
}

const mayBrand = (ctx: StaffContext) => can(ctx, "campaign_center.create") && ctx.brandWide;

/** The brand sees every template (archived with `archived`); everyone else only approved ones. */
export async function listTemplates(ctx: StaffContext, o: { archived?: boolean } = {}): Promise<TemplateView[]> {
  assertCan(ctx, ["campaign_center.view", "campaign_center.create", "campaign_center.send"]);
  const brand = mayBrand(ctx);
  const statuses: TemplateStatus[] = brand ? (o.archived ? ["draft", "approved", "archived"] : ["draft", "approved"]) : ["approved"];
  const rows = await db.select().from(marketingTemplates).where(inArray(marketingTemplates.status, statuses)).orderBy(asc(marketingTemplates.name));
  const ids = [...new Set(rows.map((r) => r.approvedBy).filter((x): x is string => !!x))];
  const names = ids.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids)) : [];
  return rows.map((r) => ({
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
