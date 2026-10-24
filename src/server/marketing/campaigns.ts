/**
 * Setting up the Campaign Center. "Create" writes wording, settings, coupons and blast drafts: with
 * access to all shops that's the brand's version of each automated campaign and blasts to every
 * location, otherwise only their own locations' wording and blasts to their shops. "Send" switches
 * campaigns on or off at their shops and sends, schedules or cancels blasts. Nobody sees a contact
 * list here: a preview is counts and a few first names.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { marketingCampaigns, marketingLocationSettings, marketingSends, promoCodes, shops, staff } from "@/db/schema";
import {
  CHANNELS,
  Channel,
  Segment,
  SegmentSchema,
  TRIGGERS,
  TRIGGER_KEYS,
  Templates,
  TemplatesSchema,
  defaultTemplates,
  isTriggerKey,
  pickChannel,
  segmentProblem,
  segmentShopIds,
  templatesProblem,
  triggerSettings,
} from "@/domain/marketing";
import { couponSummary } from "@/domain/coupons";
import { z } from "zod";
import { audit } from "../audit";
import { ruleOf } from "../coupons";
import type { Permission } from "@/domain/permissions";
import { StaffContext, assertCan, assertShopAccess, can } from "../auth/staff";
import { clientPolicy } from "../client-privacy";
import type { FieldKey } from "@/domain/client-privacy";
import { AppError, forbidden, notFound } from "../errors";
import { processDueJobs } from "../notifications/queue";
import { segmentMembers } from "./audiences";
import { contactsFor } from "./consent";
import { channelsOf, runBlasts, templatesOf, testSend } from "./engine";
import { loadMarketingSettings } from "./settings";

type Campaign = typeof marketingCampaigns.$inferSelect;

const ANY: Permission[] = ["campaign_center.view", "campaign_center.create", "campaign_center.send"];
const mayCreate = (ctx: StaffContext) => can(ctx, "campaign_center.create");
const maySend = (ctx: StaffContext) => can(ctx, "campaign_center.send");
/** The brand's own versions: create, with access to every shop. */
const mayBrand = (ctx: StaffContext) => mayCreate(ctx) && ctx.brandWide;

/** One campaign row per trigger, written the first time anyone opens the Campaign Center. */
export async function ensureTriggerCampaigns(tx: DBorTx = db) {
  const have = await tx.select({ trigger: marketingCampaigns.trigger }).from(marketingCampaigns).where(eq(marketingCampaigns.kind, "trigger"));
  const missing = TRIGGER_KEYS.filter((k) => !have.some((h) => h.trigger === k));
  if (!missing.length) return;
  await tx
    .insert(marketingCampaigns)
    .values(
      missing.map((k) => ({
        kind: "trigger" as const,
        trigger: k,
        name: TRIGGERS[k].label,
        templates: { ...defaultTemplates(k, false) },
        settings: triggerSettings(k, {}),
        channels: ["sms", "email", "push"],
      })),
    )
    .onConflictDoNothing();
}

export const ChannelsSchema = z
  .array(z.enum(CHANNELS))
  .min(1, "Pick at least one channel")
  .max(3)
  .refine((a) => new Set(a).size === a.length, "Each channel once");

export async function promoOk(promoId: string | null) {
  if (!promoId) return null;
  const [p] = await db.select().from(promoCodes).where(eq(promoCodes.id, promoId));
  if (!p) throw notFound("Coupon");
  return p;
}

const AutomationInput = z.object({
  name: z.string().trim().min(1).max(80),
  channels: ChannelsSchema,
  templates: TemplatesSchema,
  settings: z.record(z.string(), z.number()).default({}),
  promoId: z.uuid().nullable().default(null),
});

const sorted = (x: unknown): unknown =>
  x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(
        Object.entries(x)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, y]) => [k, sorted(y)]),
      )
    : x;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

export const parse = <T extends z.ZodType>(s: T, input: unknown): z.infer<T> => {
  const r = s.safeParse(input);
  if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the campaign");
  return r.data;
};

export async function campaignById(id: string): Promise<Campaign> {
  const [c] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, id));
  if (!c) throw notFound("Campaign");
  return c;
}

/** The brand's version of an automated campaign. */
export async function saveAutomation(ctx: StaffContext, id: string, input: unknown) {
  if (!mayBrand(ctx)) throw forbidden("Only the brand changes a campaign's wording for every location");
  const c = await campaignById(id);
  if (c.kind !== "trigger" || !isTriggerKey(c.trigger)) throw new AppError("bad_request", "That isn't an automated campaign");
  const v = parse(AutomationInput, input);
  const promo = await promoOk(v.promoId);
  const problem = templatesProblem(v.templates, v.channels, { hasCoupon: !!promo, extraFields: Object.keys(TRIGGERS[c.trigger].fields ?? {}) });
  if (problem) throw new AppError("bad_request", problem);
  const settings = triggerSettings(c.trigger, v.settings);
  await db
    .update(marketingCampaigns)
    .set({ name: v.name, channels: v.channels, templates: { ...v.templates }, settings, promoId: promo?.id ?? null, updatedAt: new Date() })
    .where(eq(marketingCampaigns.id, id));
  await audit(ctx.actor, "campaign_center.automation_saved", "marketing_campaign", id, { trigger: c.trigger, channels: v.channels, settings, promoId: promo?.id ?? null }, null);
}

const LocationInput = z.object({
  campaignId: z.uuid(),
  shopId: z.uuid(),
  enabled: z.boolean(),
  /** Null follows the brand. */
  templates: TemplatesSchema.partial().nullable().default(null),
  settings: z.record(z.string(), z.number()).nullable().default(null),
});

/** On or off at one location, with that location's own wording and settings if it has them. */
export async function setLocationAutomation(ctx: StaffContext, input: unknown) {
  if (!mayCreate(ctx) && !maySend(ctx)) throw forbidden("You can't change campaigns at this location");
  const v = parse(LocationInput, input);
  assertShopAccess(ctx, v.shopId);
  const c = await campaignById(v.campaignId);
  if (c.kind !== "trigger" || !isTriggerKey(c.trigger)) throw new AppError("bad_request", "That isn't an automated campaign");
  const templates = v.templates ? Object.fromEntries(Object.entries(v.templates).filter(([, x]) => typeof x === "string" && x.trim())) : null;
  const merged = templatesOf(c.templates, templates);
  const problem = templatesProblem(merged, channelsOf(c.channels), { hasCoupon: !!c.promoId, extraFields: Object.keys(TRIGGERS[c.trigger].fields ?? {}) });
  if (problem) throw new AppError("bad_request", problem);
  const settings = v.settings ? triggerSettings(c.trigger, v.settings) : null;
  const row = { enabled: v.enabled, templates: templates && Object.keys(templates).length ? (templates as Record<string, string>) : null, settings, updatedBy: ctx.staff.id, updatedAt: new Date() };
  const [was] = await db
    .select()
    .from(marketingLocationSettings)
    .where(and(eq(marketingLocationSettings.campaignId, c.id), eq(marketingLocationSettings.shopId, v.shopId)));
  if (!!was?.enabled !== row.enabled && !maySend(ctx)) throw forbidden("Switching a campaign on or off needs Campaign Center: send");
  if ((!sameJson(was?.templates ?? null, row.templates) || !sameJson(was?.settings ?? null, row.settings)) && !mayCreate(ctx)) {
    throw forbidden("Changing a location's wording or settings needs Campaign Center: create");
  }
  await db
    .insert(marketingLocationSettings)
    .values({ campaignId: c.id, shopId: v.shopId, ...row })
    .onConflictDoUpdate({ target: [marketingLocationSettings.campaignId, marketingLocationSettings.shopId], set: row });
  await audit(ctx.actor, v.enabled ? "campaign_center.automation_on" : "campaign_center.automation_off", "marketing_campaign", c.id, { trigger: c.trigger, ownWording: !!row.templates, settings }, v.shopId);
}

export interface AutomationView {
  id: string;
  trigger: string;
  name: string;
  when: string;
  channels: Channel[];
  templates: Templates;
  settings: Record<string, number>;
  promoId: string | null;
  locations: { shopId: string; shopName: string; enabled: boolean; templates: Partial<Templates> | null; settings: Record<string, number> | null }[];
  sent30: number;
}

export async function listAutomations(ctx: StaffContext): Promise<AutomationView[]> {
  assertCan(ctx, ANY);
  await ensureTriggerCampaigns();
  const list = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.kind, "trigger"));
  const myShops = ctx.shops.filter((s) => s.status !== "archived");
  const ids = myShops.map((s) => s.id);
  const loc = ids.length ? await db.select().from(marketingLocationSettings).where(inArray(marketingLocationSettings.shopId, ids)) : [];
  const counts = ids.length
    ? await db
        .select({ id: marketingSends.campaignId, n: sql<number>`count(*)::int` })
        .from(marketingSends)
        .where(and(eq(marketingSends.status, "queued"), inArray(marketingSends.shopId, ids), gte(marketingSends.createdAt, new Date(Date.now() - 30 * 86_400_000))))
        .groupBy(marketingSends.campaignId)
    : [];
  return TRIGGER_KEYS.flatMap((k) => {
    const c = list.find((x) => x.trigger === k);
    if (!c) return [];
    const settings = triggerSettings(k, c.settings);
    return [
      {
        id: c.id,
        trigger: k,
        name: c.name,
        when: TRIGGERS[k].when(settings),
        channels: channelsOf(c.channels),
        templates: templatesOf(c.templates),
        settings,
        promoId: c.promoId,
        locations: myShops.map((s) => {
          const l = loc.find((x) => x.campaignId === c.id && x.shopId === s.id);
          return { shopId: s.id, shopName: s.name, enabled: !!l?.enabled, templates: (l?.templates as Partial<Templates> | null) ?? null, settings: l?.settings ?? null };
        }),
        sent30: counts.find((x) => x.id === c.id)?.n ?? 0,
      },
    ];
  });
}

/** Coupons a campaign can carry: active and not past their end date. */
export async function couponOptions(today: string): Promise<{ id: string; code: string; summary: string; unique: boolean }[]> {
  const list = await db.select().from(promoCodes).where(eq(promoCodes.active, true)).orderBy(promoCodes.code);
  const out = [];
  for (const p of list.filter((x) => !x.endsOn || x.endsOn >= today)) {
    const r = await ruleOf(p, p.code, "code");
    out.push({ id: p.id, code: p.code, summary: couponSummary(r), unique: p.codeMode === "unique" });
  }
  return out;
}

/** The last 30 days at these locations, for the overview. */
export async function marketingOverview(shopIds: string[], now = new Date()) {
  if (!shopIds.length) return { sent: 0, clicked: 0, unsubscribed: 0, redeemed: 0 };
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const inList = sql`(${sql.join(
    shopIds.map((x) => sql`${x}::uuid`),
    sql`, `,
  )})`;
  const [s] = (await db.execute(sql`
    select
      (select count(*)::int from marketing_sends where status = 'queued' and shop_id in ${inList} and created_at >= ${since.toISOString()}) sent,
      (select count(*)::int from marketing_sends where status = 'queued' and clicks > 0 and shop_id in ${inList} and created_at >= ${since.toISOString()}) clicked,
      (select count(*)::int from marketing_unsubscribes u join marketing_sends s on s.id = u.send_id where s.shop_id in ${inList} and u.created_at >= ${since.toISOString()}) unsubscribed,
      (select count(*)::int from coupon_redemptions where campaign_id is not null and reversed_at is null and shop_id in ${inList} and created_at >= ${since.toISOString()}) redeemed`)) as unknown as {
    sent: number;
    clicked: number;
    unsubscribed: number;
    redeemed: number;
  }[];
  return s;
}

// ───────────────────────────── Blasts ─────────────────────────────

const BlastInput = z.object({
  id: z.uuid().nullable().default(null),
  name: z.string().trim().min(1, "Name the blast").max(80),
  channels: ChannelsSchema,
  templates: TemplatesSchema,
  segment: SegmentSchema,
  promoId: z.uuid().nullable().default(null),
  /** Empty: every location (brand only). */
  shopIds: z.array(z.uuid()).max(200).default([]),
});
export type BlastInput = z.input<typeof BlastInput>;

/** The locations a person may send to: any for the brand, only their own (and at least one) for a location. */
export function blastScope(ctx: StaffContext, shopIds: string[]): string[] {
  if (!mayCreate(ctx) && !maySend(ctx)) throw forbidden("You can't use the Campaign Center");
  if (mayBrand(ctx)) return shopIds;
  const scope = shopIds.length ? shopIds : ctx.shopIds;
  for (const s of scope) assertShopAccess(ctx, s);
  if (!scope.length) throw forbidden("Pick a location");
  return scope;
}

export function assertMayEdit(ctx: StaffContext, c: Campaign, kind: "blast" | "sequence" = "blast") {
  if (c.kind !== kind) throw new AppError("bad_request", kind === "blast" ? "That isn't a blast" : "That isn't a lapsed sequence");
  if (mayBrand(ctx)) return;
  if (!c.shopIds.length || c.shopIds.some((s) => !ctx.shopIds.includes(s))) throw forbidden(`This ${c.kind === "sequence" ? "sequence" : "blast"} goes to shops outside yours`);
}

/** Which client details the person sees, for the segment filters that would reveal them. */
export async function segmentSees(ctx: StaffContext) {
  const policy = await clientPolicy(ctx);
  return {
    birthday: policy.level("birthday") !== "hidden",
    ratings: policy.level("ratings") !== "hidden",
    preferredBarber: policy.level("preferred_barber") !== "hidden",
    level: (f: FieldKey) => policy.level(f),
    badges: [...policy.badges],
  };
}

export async function checkSegment(ctx: StaffContext, seg: Segment) {
  const problem = segmentProblem(seg, await segmentSees(ctx));
  if (problem) throw new AppError("bad_request", problem);
  for (const s of segmentShopIds(seg)) if (!ctx.brandWide) assertShopAccess(ctx, s);
}

export async function saveBlast(ctx: StaffContext, input: unknown): Promise<string> {
  if (!mayCreate(ctx)) throw forbidden("Writing a blast needs Campaign Center: create");
  const v = parse(BlastInput, input);
  const shopIds = blastScope(ctx, v.shopIds);
  await checkSegment(ctx, v.segment);
  const promo = await promoOk(v.promoId);
  const problem = templatesProblem(v.templates, v.channels, { hasCoupon: !!promo });
  if (problem) throw new AppError("bad_request", problem);
  const row = { name: v.name, channels: v.channels, templates: { ...v.templates }, segment: { ...v.segment }, promoId: promo?.id ?? null, shopIds, updatedAt: new Date() };
  if (v.id) {
    const c = await campaignById(v.id);
    assertMayEdit(ctx, c);
    if (c.status !== "draft" && c.status !== "scheduled") throw new AppError("conflict", "This blast already went out");
    await db.update(marketingCampaigns).set(row).where(eq(marketingCampaigns.id, c.id));
    await audit(ctx.actor, "campaign_center.blast_saved", "marketing_campaign", c.id, { name: v.name, channels: v.channels, shopIds }, shopIds.length === 1 ? shopIds[0] : null);
    return c.id;
  }
  const [c] = await db
    .insert(marketingCampaigns)
    .values({ kind: "blast", status: "draft", createdBy: ctx.staff.id, ...row })
    .returning({ id: marketingCampaigns.id });
  await audit(ctx.actor, "campaign_center.blast_created", "marketing_campaign", c.id, { name: v.name, channels: v.channels, shopIds }, shopIds.length === 1 ? shopIds[0] : null);
  return c.id;
}

/** Send it at `at`, or now. Sending now runs it straight away; the queue delivers outside quiet hours. */
export async function scheduleBlast(ctx: StaffContext, id: string, at: Date | null, now = new Date()) {
  if (!maySend(ctx)) throw forbidden("Sending a blast needs Campaign Center: send");
  const c = await campaignById(id);
  assertMayEdit(ctx, c);
  if (c.status !== "draft" && c.status !== "scheduled") throw new AppError("conflict", "This blast already went out");
  if (at && at.getTime() < now.getTime() - 60_000) throw new AppError("bad_request", "Pick a time in the future");
  const when = at ?? now;
  await db.update(marketingCampaigns).set({ status: "scheduled", scheduledAt: when, updatedAt: now }).where(eq(marketingCampaigns.id, id));
  await audit(ctx.actor, at ? "campaign_center.blast_scheduled" : "campaign_center.blast_sent", "marketing_campaign", id, { at: when.toISOString() }, c.shopIds.length === 1 ? c.shopIds[0] : null);
  if (at) return { queued: 0, skipped: 0, failed: 0 };
  const stats = await runBlasts(now, { ids: [id] });
  await processDueJobs({ now, shopIds: c.shopIds.length ? c.shopIds : undefined });
  return stats;
}

export async function cancelBlast(ctx: StaffContext, id: string) {
  const c = await campaignById(id);
  assertMayEdit(ctx, c);
  if (c.status !== "scheduled" && c.status !== "draft") throw new AppError("conflict", "This blast already went out");
  if (c.status === "scheduled" ? !maySend(ctx) : !mayCreate(ctx))
    throw forbidden(c.status === "scheduled" ? "Cancelling a scheduled blast needs Campaign Center: send" : "Discarding a draft needs Campaign Center: create");
  await db.update(marketingCampaigns).set({ status: "cancelled", updatedAt: new Date() }).where(eq(marketingCampaigns.id, id));
  await audit(ctx.actor, "campaign_center.blast_cancelled", "marketing_campaign", id, {}, c.shopIds.length === 1 ? c.shopIds[0] : null);
}

export interface BlastView {
  id: string;
  name: string;
  status: string;
  channels: Channel[];
  templates: Templates;
  segment: Segment;
  promoId: string | null;
  shopIds: string[];
  scheduledAt: Date | null;
  sentAt: Date | null;
  sent: number;
  mayEdit: boolean;
}

export async function listBlasts(ctx: StaffContext): Promise<BlastView[]> {
  assertCan(ctx, ANY);
  const rows = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.kind, "blast")).orderBy(desc(marketingCampaigns.createdAt)).limit(200);
  const visible = rows.filter((c) => ctx.brandWide || (c.shopIds.length > 0 && c.shopIds.some((s) => ctx.shopIds.includes(s))));
  const counts = visible.length
    ? await db
        .select({ id: marketingSends.campaignId, n: sql<number>`count(*)::int` })
        .from(marketingSends)
        .where(
          and(
            eq(marketingSends.status, "queued"),
            inArray(
              marketingSends.campaignId,
              visible.map((c) => c.id),
            ),
          ),
        )
        .groupBy(marketingSends.campaignId)
    : [];
  return visible.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    channels: channelsOf(c.channels),
    templates: templatesOf(c.templates),
    segment: SegmentSchema.parse(c.segment ?? {}),
    promoId: c.promoId,
    shopIds: c.shopIds,
    scheduledAt: c.scheduledAt,
    sentAt: c.sentAt,
    sent: counts.find((x) => x.id === c.id)?.n ?? 0,
    mayEdit: (c.status === "draft" || c.status === "scheduled") && (mayCreate(ctx) || maySend(ctx)) && (mayBrand(ctx) || (c.shopIds.length > 0 && c.shopIds.every((s) => ctx.shopIds.includes(s)))),
  }));
}

export interface BlastPreview {
  matched: number;
  /** Agreed to marketing on one of the channels and reachable there. */
  optedIn: number;
  /** Who would get it, by the channel they'd get it on. */
  byChannel: Record<Channel, number>;
  unreachable: number;
  /** A few first names, so the person can sanity-check the segment. */
  sample: string[];
}

/** How many clients the segment matches and how many can be reached. Counts only, never contact details. */
export async function previewBlast(ctx: StaffContext, input: unknown, now = new Date()): Promise<BlastPreview> {
  const v = parse(BlastInput.pick({ segment: true, shopIds: true, channels: true }), input);
  const shopIds = blastScope(ctx, v.shopIds);
  await checkSegment(ctx, v.segment);
  const scope = shopIds.length
    ? shopIds
    : (
        await db
          .select({ id: shops.id })
          .from(shops)
          .where(sql`${shops.status} <> 'archived'`)
      ).map((s) => s.id);
  const members = await segmentMembers(v.segment, scope, now);
  const contacts = await contactsFor(members.map((m) => m.customerId));
  const settings = await loadMarketingSettings();
  const channels = v.segment.channel === "any" ? v.channels : v.channels.filter((c) => c === v.segment.channel);
  const byChannel: Record<Channel, number> = { sms: 0, email: 0, push: 0 };
  let unreachable = 0;
  for (const m of members) {
    const r = contacts.get(m.customerId)?.reach;
    const ch = r ? pickChannel(channels, { ...r, email: r.email && !!settings.address.trim() }) : null;
    if (ch) byChannel[ch]++;
    else unreachable++;
  }
  return { matched: members.length, optedIn: members.length - unreachable, byChannel, unreachable, sample: [...new Set(members.map((m) => m.firstName))].slice(0, 5) };
}

/** A test of a campaign's wording to the person's own phone or email. */
export async function sendTest(ctx: StaffContext, o: { campaignId: string; shopId: string; channel: Channel; templates?: unknown; promoId?: string | null }) {
  if (!mayCreate(ctx) && !maySend(ctx)) throw forbidden("You can't use the Campaign Center");
  assertShopAccess(ctx, o.shopId);
  const c = await campaignById(o.campaignId);
  if (c.kind === "openings") throw new AppError("bad_request", "Test sends are for automated campaigns, blasts and sequences");
  if (c.kind !== "trigger") assertMayEdit(ctx, c, c.kind);
  const templates = o.templates ? parse(TemplatesSchema, o.templates) : templatesOf(c.templates);
  const promo = o.promoId === undefined ? undefined : await promoOk(o.promoId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, o.shopId));
  const [me] = await db.select({ id: staff.id, firstName: staff.firstName, phone: staff.phone, email: staff.email }).from(staff).where(eq(staff.id, ctx.staff.id));
  if (!shop || !me) throw notFound("Location");
  const r = await testSend({ campaign: c, shop, channel: o.channel, to: { staffId: me.id, firstName: me.firstName, phone: me.phone, email: me.email }, templates, promo });
  if (!r.ok) throw new AppError("bad_request", r.problem);
  await audit(ctx.actor, "campaign_center.test_sent", "marketing_campaign", c.id, { channel: o.channel }, o.shopId);
  return r;
}
