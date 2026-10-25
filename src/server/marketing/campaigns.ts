/**
 * Setting up the Campaign Center. "Create" writes wording, settings, coupons and blast drafts: with
 * access to all shops that's the brand's version of each automated campaign and blasts to every
 * location, otherwise only their own locations' wording and blasts to their shops. "Send" switches
 * campaigns on or off at their shops and sends, schedules or cancels blasts. Nobody sees a contact
 * list here: a preview is counts and a few first names.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { marketingCampaigns, marketingLocationSettings, marketingSends, marketingTemplates, promoCodes, shops, staff } from "@/db/schema";
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
import { couponSummary, couponWhenLabel, issuedExpiry, uniqueCode } from "@/domain/coupons";
import { AbSchema, AbVariantSchema, AB_METRICS, FREQS, HOLDOUT_MAX, abChanges, abOf, nextOccurrence, recurrenceOf, variantTemplates, type AbTest, type Recurrence } from "@/domain/campaign-schedule";
import { DateTime } from "luxon";
import { SHOP_TZ, addDays, formatDate } from "@/lib/time";
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

export interface CouponOption {
  id: string;
  code: string;
  summary: string;
  unique: boolean;
  /** Switched on, started, not past its end date and not used up: a campaign can carry it. */
  usable: boolean;
  active: boolean;
  expired: boolean;
  notStarted: boolean;
  maxedOut: boolean;
  endsOn: string | null;
  /** "Tue, Wed, 10 AM to 2 PM", or null for any time. */
  when: string | null;
  firstVisitOnly: boolean;
  maxPerCustomer: number | null;
  /** Redemptions that weren't reversed, and what those tickets brought in (services and products, after discounts). */
  redemptions: number;
  revenueCents: number;
  /** What {coupon_code} and {expiry} would show in a message sent today, for the wizard's preview. */
  preview: { code: string; expiry: string };
}

/** Why a coupon can't go on a campaign, or null. */
export function couponUnusable(o: Pick<CouponOption, "active" | "expired" | "notStarted" | "maxedOut" | "code" | "endsOn">): string | null {
  if (!o.active) return `${o.code} is switched off`;
  if (o.expired) return `${o.code} expired${o.endsOn ? ` on ${o.endsOn}` : ""}`;
  if (o.maxedOut) return `${o.code} is used up`;
  return null;
}

/**
 * Every coupon a campaign could carry, with its redemptions and the revenue on those tickets. By
 * default only the usable ones; `includeUnusable` lists switched-off, expired and used-up codes too,
 * so the wizard can say why they can't be picked instead of saying there are none.
 */
export async function couponOptions(today: string, o: { includeUnusable?: boolean } = {}): Promise<CouponOption[]> {
  const list = await db.select().from(promoCodes).orderBy(promoCodes.code);
  const counts = (await db.execute(sql`
    select r.promo_id, count(*)::int n, coalesce(sum(case when s.status in ('paid', 'partially_refunded') then s.service_net_cents + s.product_net_cents else 0 end), 0)::bigint cents
    from coupon_redemptions r join sales s on s.id = r.sale_id
    where r.reversed_at is null
    group by r.promo_id`)) as unknown as { promo_id: string; n: number; cents: string | number }[];
  const byId = new Map(counts.map((c) => [c.promo_id, c]));
  const out: CouponOption[] = [];
  for (const p of list) {
    const expired = !!p.endsOn && p.endsOn < today;
    const notStarted = !!p.startsOn && p.startsOn > today;
    const c = byId.get(p.id);
    const redemptions = Number(c?.n ?? 0);
    const maxedOut = p.maxRedemptions !== null && Math.max(redemptions, p.redemptions) >= p.maxRedemptions;
    // A coupon that starts later can still go on a campaign scheduled for then; the checkout checks the dates.
    const usable = p.active && !expired && !maxedOut;
    if (!usable && !o.includeUnusable) continue;
    const r = await ruleOf(p, p.code, "code");
    out.push({
      id: p.id,
      code: p.code,
      summary: couponSummary(r),
      unique: p.codeMode === "unique",
      usable,
      active: p.active,
      expired,
      notStarted,
      maxedOut,
      endsOn: p.endsOn,
      when: couponWhenLabel(p),
      firstVisitOnly: p.firstVisitOnly,
      maxPerCustomer: p.maxPerCustomer,
      redemptions,
      revenueCents: Number(c?.cents ?? 0),
      preview: {
        code: p.codeMode === "unique" ? uniqueCode(p.code, () => "7K2Q9D") : p.code,
        expiry: formatDate(issuedExpiry(today, p.validDays, p.endsOn, addDays) ?? addDays(today, 30), "MMM d"),
      },
    });
  }
  return out;
}

async function assertCouponUsable(promoId: string | null, today: string) {
  if (!promoId) return;
  const c = (await couponOptions(today, { includeUnusable: true })).find((x) => x.id === promoId);
  if (!c) throw notFound("Coupon");
  const why = couponUnusable(c);
  if (why) throw new AppError("conflict", `${why}. Pick another coupon before sending.`);
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
  /** A quick update carries no offer; a promotion carries a coupon. Left out, it follows the coupon. */
  campaignType: z.enum(["update", "promotion"]).nullable().default(null),
  recurrence: z
    .object({
      freq: z.enum(FREQS).default("once"),
      endsOn: z.iso.date().nullable().default(null),
    })
    .default({ freq: "once", endsOn: null }),
  /** Null: no A/B test. */
  ab: z
    .object({
      testPct: AbSchema.shape.testPct,
      metric: z.enum(AB_METRICS).default("click"),
      waitHours: AbSchema.shape.waitHours,
      b: AbVariantSchema.default({}),
    })
    .nullable()
    .default(null),
  holdoutPct: z.number().int().min(0).max(HOLDOUT_MAX, `Hold back at most ${HOLDOUT_MAX}%`).default(0),
  sendTimeOpt: z.boolean().default(false),
  templateId: z.uuid().nullable().default(null),
  /** Started from the assistant's draft: it's only scheduled or sent from the review step. */
  aiDrafted: z.boolean().default(false),
});
export type BlastInput = z.input<typeof BlastInput>;

/** Blasts that can still change: not yet out, or paused. */
const EDITABLE = ["draft", "scheduled", "paused"];

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
  const campaignType = v.campaignType ?? (promo ? "promotion" : "update");
  if (campaignType === "promotion" && !promo) throw new AppError("bad_request", "A promotion needs a coupon. Pick one, or make it a quick update");
  if (campaignType === "update" && promo) throw new AppError("bad_request", "A quick update carries no coupon. Make it a promotion to add one");
  const problem = templatesProblem(v.templates, v.channels, { hasCoupon: !!promo });
  if (problem) throw new AppError("bad_request", problem);
  const recurring = v.recurrence.freq !== "once";
  if (v.ab && recurring) throw new AppError("bad_request", "A/B tests are for one-time blasts. Turn off the repeat or the test");
  if (v.ab) {
    if (!abChanges(v.templates, v.ab.b).length) throw new AppError("bad_request", "Variant B needs different wording from A");
    const bProblem = templatesProblem(variantTemplates(v.templates, v.ab.b), v.channels, { hasCoupon: !!promo });
    if (bProblem) throw new AppError("bad_request", `Variant B: ${bProblem}`);
  }
  if (v.templateId) {
    const [t] = await db.select({ status: marketingTemplates.status }).from(marketingTemplates).where(eq(marketingTemplates.id, v.templateId));
    if (!t || t.status !== "approved") throw new AppError("bad_request", "That template isn't approved");
  }
  const was = v.id ? await campaignById(v.id) : null;
  const wasRec = was ? recurrenceOf(was.recurrence) : null;
  const recurrence: Recurrence | null = recurring
    ? { freq: v.recurrence.freq as Recurrence["freq"], endsOn: v.recurrence.endsOn, anchor: wasRec?.freq === v.recurrence.freq ? wasRec.anchor : null }
    : null;
  const ab: AbTest | null = v.ab ? AbSchema.parse({ ...v.ab, b: Object.fromEntries(Object.entries(v.ab.b).filter(([, x]) => typeof x === "string" && x.trim())) }) : null;
  const row = {
    name: v.name,
    channels: v.channels,
    templates: { ...v.templates },
    segment: { ...v.segment },
    promoId: promo?.id ?? null,
    shopIds,
    campaignType,
    recurrence,
    ab,
    holdoutPct: v.holdoutPct,
    sendTimeOpt: v.sendTimeOpt,
    templateId: v.templateId,
    // Once drafted by the assistant, always: the review step is what clears it to send.
    aiDrafted: v.aiDrafted || !!was?.aiDrafted,
    updatedAt: new Date(),
  };
  const detail = { name: v.name, channels: v.channels, shopIds, campaignType, recurrence: recurrence?.freq ?? "once", ab: !!ab, holdoutPct: v.holdoutPct, sendTimeOpt: v.sendTimeOpt, aiDrafted: row.aiDrafted };
  if (was) {
    assertMayEdit(ctx, was);
    if (!EDITABLE.includes(was.status)) throw new AppError("conflict", "This blast already went out");
    await db.update(marketingCampaigns).set(row).where(eq(marketingCampaigns.id, was.id));
    await audit(ctx.actor, "campaign_center.blast_saved", "marketing_campaign", was.id, detail, shopIds.length === 1 ? shopIds[0] : null);
    return was.id;
  }
  const [c] = await db
    .insert(marketingCampaigns)
    .values({ kind: "blast", status: "draft", createdBy: ctx.staff.id, ...row })
    .returning({ id: marketingCampaigns.id });
  await audit(ctx.actor, "campaign_center.blast_created", "marketing_campaign", c.id, detail, shopIds.length === 1 ? shopIds[0] : null);
  return c.id;
}

const scopeShop = (c: Campaign) => (c.shopIds.length === 1 ? c.shopIds[0] : null);
const tzOf = async (c: Campaign) => {
  if (!c.shopIds.length) return SHOP_TZ;
  const [s] = await db.select({ tz: shops.timezone }).from(shops).where(eq(shops.id, c.shopIds[0]));
  return s?.tz || SHOP_TZ;
};

/**
 * Send it at `at`, or now. Sending now runs it straight away; the queue delivers outside quiet hours.
 * A repeating blast's first send sets its weekday (or day of the month) and time. A blast the
 * assistant drafted goes only with `reviewed`: the person confirmed the review step.
 */
export async function scheduleBlast(ctx: StaffContext, id: string, at: Date | null, now = new Date(), o: { reviewed?: boolean } = {}) {
  if (!maySend(ctx)) throw forbidden("Sending a blast needs Campaign Center: send");
  const c = await campaignById(id);
  assertMayEdit(ctx, c);
  if (!EDITABLE.includes(c.status)) throw new AppError("conflict", c.status === "testing" ? "The A/B test is running; the winner goes out when it ends" : "This blast already went out");
  if (at && at.getTime() < now.getTime() - 60_000) throw new AppError("bad_request", "Pick a time in the future");
  if (c.aiDrafted && !o.reviewed) throw new AppError("bad_request", "The assistant drafted this blast. Review it and confirm before it's sent");
  if (c.campaignType === "promotion" && !c.promoId) throw new AppError("bad_request", "This promotion's coupon was removed. Pick another, or make it a quick update");
  const tz = await tzOf(c);
  await assertCouponUsable(c.promoId, DateTime.fromJSDate(now).setZone(tz).toISODate()!);
  const when = at ?? now;
  const rec = recurrenceOf(c.recurrence);
  if (rec?.endsOn && DateTime.fromJSDate(when).setZone(tz).toISODate()! > rec.endsOn) throw new AppError("bad_request", "The first send is after the repeat's end date");
  const ab = rec ? null : abOf(c.ab);
  await db
    .update(marketingCampaigns)
    .set({
      status: "scheduled",
      scheduledAt: when,
      recurrence: rec ? { ...rec, anchor: when.toISOString() } : null,
      ab: ab ? { ...ab, winner: null, testEndsAt: null, decidedAt: null, result: null } : null,
      ...(o.reviewed ? { reviewedBy: ctx.staff.id, reviewedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(marketingCampaigns.id, id));
  await audit(ctx.actor, at ? "campaign_center.blast_scheduled" : "campaign_center.blast_sent", "marketing_campaign", id, { at: when.toISOString(), reviewed: !!o.reviewed, aiDrafted: c.aiDrafted, recurrence: rec?.freq ?? "once" }, scopeShop(c));
  if (at) return { queued: 0, skipped: 0, failed: 0 };
  const stats = await runBlasts(now, { ids: [id] });
  await processDueJobs({ now, shopIds: c.shopIds.length ? c.shopIds : undefined });
  return stats;
}

/** Holds a scheduled blast (one time or repeating) until someone resumes it. */
export async function pauseBlast(ctx: StaffContext, id: string, now = new Date()) {
  if (!maySend(ctx)) throw forbidden("Pausing a blast needs Campaign Center: send");
  const c = await campaignById(id);
  assertMayEdit(ctx, c);
  if (c.status === "testing") throw new AppError("conflict", "The A/B test is running; the winner goes out when it ends");
  if (c.status !== "scheduled") throw new AppError("conflict", "Only a scheduled blast can be paused");
  await db.update(marketingCampaigns).set({ status: "paused", updatedAt: now }).where(and(eq(marketingCampaigns.id, id), eq(marketingCampaigns.status, "scheduled")));
  await audit(ctx.actor, "campaign_center.blast_paused", "marketing_campaign", id, {}, scopeShop(c));
}

/** Back on the schedule. A repeating blast picks up at its next send from now; a one-time blast whose time passed goes out on the next run. */
export async function resumeBlast(ctx: StaffContext, id: string, now = new Date()) {
  if (!maySend(ctx)) throw forbidden("Resuming a blast needs Campaign Center: send");
  const c = await campaignById(id);
  assertMayEdit(ctx, c);
  if (c.status !== "paused") throw new AppError("conflict", "This blast isn't paused");
  const tz = await tzOf(c);
  await assertCouponUsable(c.promoId, DateTime.fromJSDate(now).setZone(tz).toISODate()!);
  const rec = recurrenceOf(c.recurrence);
  let at = c.scheduledAt && c.scheduledAt > now ? c.scheduledAt : now;
  if (rec && c.scheduledAt && c.scheduledAt <= now) {
    const anchor = rec.anchor ? new Date(rec.anchor) : c.scheduledAt;
    const next = nextOccurrence(rec, anchor, now, tz);
    if (!next) throw new AppError("conflict", "This blast's end date has passed");
    at = next;
  }
  await db.update(marketingCampaigns).set({ status: "scheduled", scheduledAt: at, updatedAt: now }).where(eq(marketingCampaigns.id, id));
  await audit(ctx.actor, "campaign_center.blast_resumed", "marketing_campaign", id, { at: at.toISOString() }, scopeShop(c));
  return at;
}

/** A new draft with the same wording, audience and options, to send again or change. */
export async function duplicateBlast(ctx: StaffContext, id: string): Promise<string> {
  if (!mayCreate(ctx)) throw forbidden("Copying a blast needs Campaign Center: create");
  const c = await campaignById(id);
  assertMayEdit(ctx, c);
  const rec = recurrenceOf(c.recurrence);
  const ab = abOf(c.ab);
  const [copy] = await db
    .insert(marketingCampaigns)
    .values({
      kind: "blast",
      status: "draft",
      name: `Copy of ${c.name}`.slice(0, 80),
      channels: c.channels,
      templates: c.templates,
      segment: c.segment,
      promoId: c.promoId,
      shopIds: c.shopIds,
      campaignType: c.campaignType,
      recurrence: rec ? { ...rec, anchor: null } : null,
      ab: ab ? { ...ab, winner: null, testEndsAt: null, decidedAt: null, result: null } : null,
      holdoutPct: c.holdoutPct,
      sendTimeOpt: c.sendTimeOpt,
      templateId: c.templateId,
      // A reviewed and sent draft's wording was checked by a person; an unreviewed one still needs it.
      aiDrafted: c.aiDrafted && !c.reviewedAt,
      createdBy: ctx.staff.id,
    })
    .returning({ id: marketingCampaigns.id });
  await audit(ctx.actor, "campaign_center.blast_duplicated", "marketing_campaign", copy.id, { from: c.id }, scopeShop(c));
  return copy.id;
}

/** A new name for a blast or lapsed sequence, whatever its status. Names are internal; clients never see them. */
export async function renameCampaign(ctx: StaffContext, id: string, name: unknown) {
  if (!mayCreate(ctx)) throw forbidden("Renaming needs Campaign Center: create");
  const v = parse(z.string().trim().min(1, "Give it a name").max(80), name);
  const c = await campaignById(id);
  if (c.kind !== "blast" && c.kind !== "sequence") throw new AppError("bad_request", "Only blasts and sequences can be renamed here");
  assertMayEdit(ctx, c, c.kind);
  await db.update(marketingCampaigns).set({ name: v, updatedAt: new Date() }).where(eq(marketingCampaigns.id, id));
  await audit(ctx.actor, "campaign_center.renamed", "marketing_campaign", id, { from: c.name, to: v }, scopeShop(c));
}

export async function cancelBlast(ctx: StaffContext, id: string) {
  const c = await campaignById(id);
  assertMayEdit(ctx, c);
  if (c.status === "paused") {
    if (!maySend(ctx)) throw forbidden("Cancelling a paused blast needs Campaign Center: send");
    await db.update(marketingCampaigns).set({ status: "cancelled", updatedAt: new Date() }).where(eq(marketingCampaigns.id, id));
    await audit(ctx.actor, "campaign_center.blast_cancelled", "marketing_campaign", id, {}, scopeShop(c));
    return;
  }
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
  campaignType: "update" | "promotion";
  recurrence: Recurrence | null;
  ab: AbTest | null;
  holdoutPct: number;
  sendTimeOpt: boolean;
  templateId: string | null;
  aiDrafted: boolean;
  reviewedAt: Date | null;
  createdAt: Date;
  /** Goes only to the person's locations (or they're the brand): they can rename, copy, pause or resume it. */
  inScope: boolean;
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
  const inScope = (c: Campaign) => mayBrand(ctx) || (c.shopIds.length > 0 && c.shopIds.every((s) => ctx.shopIds.includes(s)));
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
    mayEdit: EDITABLE.includes(c.status) && (mayCreate(ctx) || maySend(ctx)) && inScope(c),
    inScope: inScope(c),
    campaignType: c.campaignType ?? (c.promoId ? "promotion" : "update"),
    recurrence: recurrenceOf(c.recurrence),
    ab: abOf(c.ab),
    holdoutPct: c.holdoutPct,
    sendTimeOpt: c.sendTimeOpt,
    templateId: c.templateId,
    aiDrafted: c.aiDrafted,
    reviewedAt: c.reviewedAt,
    createdAt: c.createdAt,
  }));
}

export interface BlastPreview {
  matched: number;
  /** Agreed to marketing on one of the channels and reachable there. */
  optedIn: number;
  /** Who would get it, by the channel they'd get it on. */
  byChannel: Record<Channel, number>;
  /** Opted in and reachable on each channel on its own, whichever the blast uses: a client can count on several. */
  optedInBy: Record<Channel, number>;
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
  const optedInBy: Record<Channel, number> = { sms: 0, email: 0, push: 0 };
  let unreachable = 0;
  for (const m of members) {
    const raw = contacts.get(m.customerId)?.reach;
    const r = raw ? { ...raw, email: raw.email && !!settings.address.trim() } : null;
    if (r) for (const k of CHANNELS) if (r[k]) optedInBy[k]++;
    const ch = r ? pickChannel(channels, r) : null;
    if (ch) byChannel[ch]++;
    else unreachable++;
  }
  return { matched: members.length, optedIn: members.length - unreachable, byChannel, optedInBy, unreachable, sample: [...new Set(members.map((m) => m.firstName))].slice(0, 5) };
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
