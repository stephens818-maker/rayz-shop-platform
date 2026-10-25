/**
 * "Describe what you want": the assistant's language model drafts a blast's wording, audience and
 * coupon from one sentence. The model is told the request, the brand's coupon codes and the badge
 * names, never anything about a client. The draft isn't saved: it fills in the wizard, and the
 * blast it becomes is marked as drafted so it only goes out from the review step, by a person.
 */
import "server-only";
import { shops } from "@/db/schema";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { badgeLabel } from "@/domain/badges";
import { DRAFT_TOOL, draftSystemPrompt, normalizeDraft, stubDraftRaw, type CampaignDraft, type DraftCoupon } from "@/domain/campaign-draft";
import { EMPTY_SEGMENT, segmentProblem } from "@/domain/marketing";
import { todayLocal } from "@/lib/time";
import { z } from "zod";
import { assistantProvider, type Provider } from "../assistant/providers";
import { audit } from "../audit";
import { StaffContext, can } from "../auth/staff";
import { clientPolicy } from "../client-privacy";
import { AppError, forbidden } from "../errors";
import { couponOptions, segmentSees } from "./campaigns";
import { BRAND_NAME } from "./engine";

export const DRAFT_PROMPT_MAX = 500;
const PromptSchema = z.string().trim().min(8, "Say a little more about what you want to send").max(DRAFT_PROMPT_MAX, `Keep it under ${DRAFT_PROMPT_MAX} characters`);

export interface DraftResult extends CampaignDraft {
  /** "openai", "anthropic", or "keywords" without a model. */
  drafter: string;
}

export async function draftBlast(ctx: StaffContext, prompt: unknown, o: { now?: Date; provider?: Provider | null } = {}): Promise<DraftResult> {
  if (!can(ctx, "campaign_center.create")) throw forbidden("Drafting a blast needs Campaign Center: create");
  const p = PromptSchema.safeParse(prompt);
  if (!p.success) throw new AppError("bad_request", p.error.issues[0]?.message ?? "Describe the blast");
  const now = o.now ?? new Date();
  const coupons: DraftCoupon[] = (await couponOptions(todayLocal(now))).map((c) => ({ id: c.id, code: c.code, summary: c.summary, usable: c.usable }));
  const policy = await clientPolicy(ctx);
  const badges = [...policy.badges].map((k) => ({ key: k, label: badgeLabel(k, policy.customBadges) }));
  const shopNames = ctx.brandWide
    ? (await db.select({ name: shops.name }).from(shops).where(sql`${shops.status} <> 'archived'`)).map((s) => s.name)
    : ctx.shops.filter((s) => s.status !== "archived").map((s) => s.name);
  const provider = o.provider === undefined ? assistantProvider() : o.provider;
  let raw: unknown;
  let drafter = "keywords";
  if (provider && provider.id !== "stub") {
    const r = await provider.complete({
      system: draftSystemPrompt({ brand: BRAND_NAME, shops: shopNames, coupons, badges }),
      messages: [{ role: "user", content: p.data }],
      tools: [{ name: DRAFT_TOOL.name, description: DRAFT_TOOL.description, parameters: DRAFT_TOOL.parameters as unknown as Record<string, unknown> }],
    });
    raw = r.toolCalls.find((c) => c.name === DRAFT_TOOL.name)?.args ?? null;
    drafter = provider.id;
  } else {
    raw = stubDraftRaw(p.data, coupons, badges);
  }
  const draft = normalizeDraft(raw, { coupons, badges: badges.map((b) => b.key) });
  const problem = segmentProblem(draft.segment, await segmentSees(ctx));
  if (problem) {
    draft.segment = EMPTY_SEGMENT;
    draft.notes.push(`The audience used a filter you can't use (${problem}), so it's everyone at the locations; set it in the next step.`);
  }
  await audit(ctx.actor, "campaign_center.ai_drafted", "marketing_campaign", null, { drafter, promptLength: p.data.length, campaignType: draft.campaignType, promoId: draft.promoId }, null);
  return { ...draft, drafter };
}
