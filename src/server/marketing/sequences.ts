/**
 * Lapsed sequences in the Campaign Center: several messages to a lapsed client, each at its own
 * point after their last visit with its own wording and coupon, for a set of locations and
 * optionally only some barbers' clients. "Create" writes them, "send" switches them on or off;
 * locations' people work only with their own shops, like blasts. The engine (runSequences) sends.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingCampaigns, marketingSends, marketingSteps, shops, staffShops } from "@/db/schema";
import {
  Channel,
  EMPTY_SEGMENT,
  SequenceAudience,
  SequenceAudienceSchema,
  SequenceSettings,
  SequenceSettingsSchema,
  SequenceStepSchema,
  Templates,
  pickChannel,
  stepLabel,
  stepsProblem,
  templatesProblem,
} from "@/domain/marketing";
import { audit } from "../audit";
import { StaffContext, assertCan, can } from "../auth/staff";
import { AppError, forbidden } from "../errors";
import { ChannelsSchema, assertMayEdit, blastScope, campaignById, checkSegment, parse, promoOk } from "./campaigns";
import { contactsFor } from "./consent";
import { channelsOf, sequenceTargets, stepsOf, templatesOf, unsent } from "./engine";
import { loadMarketingSettings } from "./settings";

const mayCreate = (ctx: StaffContext) => can(ctx, "campaign_center.create");
const maySend = (ctx: StaffContext) => can(ctx, "campaign_center.send");

const SequenceInput = z.object({
  id: z.uuid().nullable().default(null),
  name: z.string().trim().min(1, "Name the sequence").max(80),
  channels: ChannelsSchema,
  /** Empty: every location (brand only). */
  shopIds: z.array(z.uuid()).max(200).default([]),
  audience: SequenceAudienceSchema.default({ staffIds: [], barberMatch: "primary" }),
  settings: SequenceSettingsSchema.default({ stopAfterDays: 120 }),
  steps: z.array(SequenceStepSchema).min(1, "Add at least one step").max(6),
});
export type SequenceInput = z.input<typeof SequenceInput>;

const ordered = <T extends { afterDays: number }>(steps: T[]) => [...steps].sort((a, b) => a.afterDays - b.afterDays);
const auditShop = (shopIds: string[]) => (shopIds.length === 1 ? shopIds[0] : null);

/** The barbers must work at the sequence's locations (any location when it's every location). */
async function checkBarbers(staffIds: string[], shopIds: string[]) {
  if (!staffIds.length) return;
  const rows = await db
    .selectDistinct({ id: staffShops.staffId })
    .from(staffShops)
    .where(and(inArray(staffShops.staffId, staffIds), shopIds.length ? inArray(staffShops.shopId, shopIds) : undefined));
  if (rows.length !== new Set(staffIds).size) throw new AppError("bad_request", "Pick barbers who work at the sequence's locations");
}

async function checkAudience(ctx: StaffContext, a: SequenceAudience, shopIds: string[]) {
  await checkSegment(ctx, { ...EMPTY_SEGMENT, staffIds: a.staffIds, barberMatch: a.barberMatch });
  await checkBarbers(a.staffIds, shopIds);
}

export async function saveSequence(ctx: StaffContext, input: unknown): Promise<string> {
  if (!mayCreate(ctx)) throw forbidden("Writing a lapsed sequence needs Campaign Center: create");
  const v = parse(SequenceInput, input);
  const shopIds = blastScope(ctx, v.shopIds);
  await checkAudience(ctx, v.audience, shopIds);
  const steps = ordered(v.steps);
  const problem = stepsProblem(steps, v.settings.stopAfterDays);
  if (problem) throw new AppError("bad_request", problem);
  for (const [i, st] of steps.entries()) {
    const promo = await promoOk(st.promoId);
    const p = templatesProblem(st.templates, v.channels, { hasCoupon: !!promo });
    if (p) throw new AppError("bad_request", `Step ${i + 1} (${stepLabel(st.afterDays, i === steps.length - 1)}): ${p}`);
  }
  const row = { name: v.name, channels: v.channels, shopIds, segment: { ...v.audience }, settings: { ...v.settings }, updatedAt: new Date() };
  const id = await db.transaction(async (tx) => {
    let id: string;
    if (v.id) {
      const c = await campaignById(v.id);
      assertMayEdit(ctx, c, "sequence");
      if (c.status === "cancelled") throw new AppError("conflict", "This sequence was deleted");
      await tx.update(marketingCampaigns).set(row).where(eq(marketingCampaigns.id, c.id));
      id = c.id;
    } else {
      const [c] = await tx
        .insert(marketingCampaigns)
        .values({ kind: "sequence", status: "draft", enabled: false, createdBy: ctx.staff.id, ...row })
        .returning({ id: marketingCampaigns.id });
      id = c.id;
    }
    const have = await tx.select({ id: marketingSteps.id }).from(marketingSteps).where(eq(marketingSteps.campaignId, id));
    const keep = new Set(steps.flatMap((x) => (x.id && have.some((h) => h.id === x.id) ? [x.id] : [])));
    const gone = have.filter((h) => !keep.has(h.id)).map((h) => h.id);
    if (gone.length) await tx.delete(marketingSteps).where(inArray(marketingSteps.id, gone));
    // Positions are unique, so move the kept steps out of the way before renumbering.
    await tx
      .update(marketingSteps)
      .set({ position: sql`-1 - ${marketingSteps.position}` })
      .where(eq(marketingSteps.campaignId, id));
    for (const [i, st] of steps.entries()) {
      const values = { position: i, afterDays: st.afterDays, templates: { ...st.templates }, promoId: st.promoId, updatedAt: new Date() };
      if (st.id && keep.has(st.id)) await tx.update(marketingSteps).set(values).where(eq(marketingSteps.id, st.id));
      else await tx.insert(marketingSteps).values({ campaignId: id, ...values });
    }
    return id;
  });
  await audit(
    ctx.actor,
    v.id ? "campaign_center.sequence_saved" : "campaign_center.sequence_created",
    "marketing_campaign",
    id,
    { name: v.name, channels: v.channels, shopIds, staffIds: v.audience.staffIds, steps: steps.map((x) => ({ afterDays: x.afterDays, promoId: x.promoId })), stopAfterDays: v.settings.stopAfterDays },
    auditShop(shopIds),
  );
  return id;
}

/** On or off. Turning one on checks its wording again: a coupon may have been switched off since. */
export async function setSequenceEnabled(ctx: StaffContext, id: string, enabled: boolean) {
  if (!maySend(ctx)) throw forbidden("Switching a sequence on or off needs Campaign Center: send");
  const c = await campaignById(id);
  assertMayEdit(ctx, c, "sequence");
  if (c.status === "cancelled") throw new AppError("conflict", "This sequence was deleted");
  if (enabled) {
    const steps = await stepsOf(c.id);
    const problem = stepsProblem(steps, SequenceSettingsSchema.parse(c.settings ?? {}).stopAfterDays);
    if (problem) throw new AppError("bad_request", problem);
    for (const st of steps) {
      const p = templatesProblem(templatesOf(st.templates), channelsOf(c.channels), { hasCoupon: !!st.promoId });
      if (p) throw new AppError("bad_request", p);
    }
  }
  await db.update(marketingCampaigns).set({ enabled, updatedAt: new Date() }).where(eq(marketingCampaigns.id, id));
  await audit(ctx.actor, enabled ? "campaign_center.sequence_on" : "campaign_center.sequence_off", "marketing_campaign", id, { name: c.name }, auditShop(c.shopIds));
}

/** Deleting keeps its messages for the report; it just stops and leaves the list. */
export async function deleteSequence(ctx: StaffContext, id: string) {
  if (!mayCreate(ctx)) throw forbidden("Deleting a lapsed sequence needs Campaign Center: create");
  const c = await campaignById(id);
  assertMayEdit(ctx, c, "sequence");
  if (c.enabled && !maySend(ctx)) throw forbidden("Turn it off first: that needs Campaign Center: send");
  await db.update(marketingCampaigns).set({ status: "cancelled", enabled: false, updatedAt: new Date() }).where(eq(marketingCampaigns.id, id));
  await audit(ctx.actor, "campaign_center.sequence_deleted", "marketing_campaign", id, { name: c.name }, auditShop(c.shopIds));
}

export interface SequenceStepView {
  id: string;
  afterDays: number;
  label: string;
  templates: Templates;
  promoId: string | null;
  sent30: number;
}

export interface SequenceView {
  id: string;
  name: string;
  enabled: boolean;
  channels: Channel[];
  shopIds: string[];
  audience: SequenceAudience;
  settings: SequenceSettings;
  steps: SequenceStepView[];
  sent30: number;
  /** In their scope: create may edit it, send may switch it. */
  mayEdit: boolean;
}

export async function listSequences(ctx: StaffContext, now = new Date()): Promise<SequenceView[]> {
  assertCan(ctx, ["campaign_center.view", "campaign_center.create", "campaign_center.send"]);
  const rows = await db
    .select()
    .from(marketingCampaigns)
    .where(and(eq(marketingCampaigns.kind, "sequence"), sql`${marketingCampaigns.status} <> 'cancelled'`))
    .orderBy(desc(marketingCampaigns.createdAt));
  const visible = rows.filter((c) => ctx.brandWide || (c.shopIds.length > 0 && c.shopIds.some((s) => ctx.shopIds.includes(s))));
  if (!visible.length) return [];
  const ids = visible.map((c) => c.id);
  const [steps, counts] = await Promise.all([
    db.select().from(marketingSteps).where(inArray(marketingSteps.campaignId, ids)).orderBy(marketingSteps.afterDays),
    db
      .select({ step: marketingSends.stepId, n: sql<number>`count(*)::int` })
      .from(marketingSends)
      .where(and(inArray(marketingSends.campaignId, ids), eq(marketingSends.status, "queued"), gte(marketingSends.createdAt, new Date(now.getTime() - 30 * 86_400_000))))
      .groupBy(marketingSends.stepId),
  ]);
  const n = new Map(counts.map((x) => [x.step, x.n]));
  return visible.map((c) => {
    const mine = steps.filter((x) => x.campaignId === c.id);
    const list = mine.map((x, i) => ({ id: x.id, afterDays: x.afterDays, label: stepLabel(x.afterDays, i === mine.length - 1), templates: templatesOf(x.templates), promoId: x.promoId, sent30: n.get(x.id) ?? 0 }));
    return {
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      channels: channelsOf(c.channels),
      shopIds: c.shopIds,
      audience: SequenceAudienceSchema.parse(c.segment ?? {}),
      settings: SequenceSettingsSchema.parse(c.settings ?? {}),
      steps: list,
      sent30: list.reduce((a, x) => a + x.sent30, 0),
      mayEdit: ctx.brandWide || (c.shopIds.length > 0 && c.shopIds.every((s) => ctx.shopIds.includes(s))),
    };
  });
}

export interface SequencePreview {
  /** Lapsed clients in the sequence's window right now, by the step they're at. */
  steps: { afterDays: number; label: string; matched: number; optedIn: number; due: number }[];
  matched: number;
  optedIn: number;
  /** Would get a message on the next run: opted in and not sent that step for this lapse yet. */
  due: number;
  sample: string[];
}

/** How many lapsed clients are at each step now and how many can be reached. Counts and first names only. */
export async function previewSequence(ctx: StaffContext, input: unknown, now = new Date()): Promise<SequencePreview> {
  if (!mayCreate(ctx) && !maySend(ctx)) throw forbidden("You can't use the Campaign Center");
  const v = parse(SequenceInput.pick({ id: true, shopIds: true, channels: true, audience: true, settings: true }).extend({ steps: z.array(z.object({ id: z.uuid().nullable().default(null), afterDays: z.number().int().min(7).max(365) })).min(1).max(6) }), input);
  const shopIds = blastScope(ctx, v.shopIds);
  await checkAudience(ctx, v.audience, shopIds);
  const steps = ordered(v.steps).map((x, i) => ({ ...x, id: x.id ?? `new-${i}` }));
  const scope = shopIds.length ? shopIds : (await db.select({ id: shops.id }).from(shops).where(eq(shops.status, "live"))).map((s) => s.id);
  const targets = await sequenceTargets({ segment: v.audience, settings: v.settings, shopIds }, steps, scope, now);
  const fresh = new Set((v.id ? await unsent(v.id, targets) : targets).map((t) => `${t.customerId}:${t.stepId}`));
  const contacts = await contactsFor(targets.map((t) => t.customerId));
  const settings = await loadMarketingSettings();
  const reach = (id: string) => {
    const r = contacts.get(id)?.reach;
    return !!r && !!pickChannel(v.channels, { ...r, email: r.email && !!settings.address.trim() });
  };
  const byStep = steps.map((st, i) => {
    const at = targets.filter((t) => t.stepId === st.id);
    const ok = at.filter((t) => reach(t.customerId));
    return { afterDays: st.afterDays, label: stepLabel(st.afterDays, i === steps.length - 1), matched: at.length, optedIn: ok.length, due: ok.filter((t) => fresh.has(`${t.customerId}:${t.stepId}`)).length };
  });
  return {
    steps: byStep,
    matched: targets.length,
    optedIn: byStep.reduce((a, x) => a + x.optedIn, 0),
    due: byStep.reduce((a, x) => a + x.due, 0),
    sample: [...new Set(targets.slice(0, 50).flatMap((t) => contacts.get(t.customerId)?.firstName ?? []))].slice(0, 5),
  };
}
