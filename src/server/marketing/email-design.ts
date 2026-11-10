/**
 * The email editor's tools: header images uploaded (and refined) for marketing emails, served
 * publicly at /mi/<id> because email clients fetch them, and the assistant's "refine text" and
 * "describe image". Only the wording being refined goes to the model, never client details.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingImages } from "@/db/schema";
import { REFINE_MAX, REFINE_STYLES, normalizeRefined, refinePrompt, stubAltText, stubRefine, type RefinePart } from "@/domain/campaign-refine";
import { MARKETING_FIELDS } from "@/domain/marketing";
import { assistantProvider, type Provider } from "../assistant/providers";
import { audit } from "../audit";
import { StaffContext, can } from "../auth/staff";
import { AppError, forbidden } from "../errors";
import { BRAND_NAME } from "./engine";

/** A 1200px JPEG at 0.85 is well under this. */
export const EMAIL_IMAGE_MAX_CHARS = 1_500_000;
const IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const UUID = /^[0-9a-f-]{36}$/;

const UploadSchema = z.object({
  dataUrl: z.string().max(EMAIL_IMAGE_MAX_CHARS, "Use an image under 1 MB").regex(IMAGE, "Use a JPEG, PNG or WebP image"),
  alt: z.string().trim().max(150).default(""),
  width: z.number().int().min(1).max(4000).nullable().default(null),
  height: z.number().int().min(1).max(4000).nullable().default(null),
  /** Refined from this image (cropped or enhanced). */
  sourceId: z.uuid().nullable().default(null),
});

export async function uploadEmailImage(ctx: StaffContext, input: unknown): Promise<{ id: string; src: string }> {
  if (!can(ctx, "campaign_center.create")) throw forbidden("Adding email images needs Campaign Center: create");
  const p = UploadSchema.safeParse(input);
  if (!p.success) throw new AppError("bad_request", p.error.issues[0]?.message ?? "Use a JPEG, PNG or WebP image under 1 MB");
  const v = p.data;
  if (v.sourceId && !(await db.select({ id: marketingImages.id }).from(marketingImages).where(eq(marketingImages.id, v.sourceId))).length) throw new AppError("bad_request", "That image is gone; upload it again");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(marketingImages)
      .values({ dataUrl: v.dataUrl, alt: v.alt || null, width: v.width, height: v.height, sourceId: v.sourceId, createdBy: ctx.staff.id })
      .returning({ id: marketingImages.id });
    await audit(ctx.actor, v.sourceId ? "campaign_center.image_refined" : "campaign_center.image_uploaded", "marketing_image", row.id, { bytes: Math.round((v.dataUrl.length * 3) / 4), width: v.width, height: v.height, sourceId: v.sourceId }, null, tx);
    return { id: row.id, src: `/mi/${row.id}` };
  });
}

/** The image's bytes for /mi/<id>, or null. */
export async function emailImage(id: string): Promise<{ type: string; bytes: Buffer } | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db.select({ d: marketingImages.dataUrl }).from(marketingImages).where(eq(marketingImages.id, id));
  const m = row && /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(row.d);
  return m ? { type: m[1], bytes: Buffer.from(m[2], "base64") } : null;
}

const PARTS = Object.keys(REFINE_MAX) as RefinePart[];
const RefineSchema = z.object({
  part: z.enum(PARTS as [RefinePart, ...RefinePart[]]),
  style: z.enum(REFINE_STYLES),
  text: z.string().max(5000),
  instruction: z.string().trim().max(200).default(""),
  extraFields: z.array(z.string().regex(/^[a-z_]{2,30}$/)).max(10).default([]),
  /** "Describe image": the email's wording the alt text is written from. */
  context: z.object({ emailSubject: z.string().max(150).default(""), emailHeadline: z.string().max(120).default(""), emailBody: z.string().max(5000).default("") }).nullable().default(null),
});

export interface RefineResult {
  text: string;
  /** "openai", "anthropic", or "keywords" without a model. */
  refiner: string;
}

export async function refineCopy(ctx: StaffContext, input: unknown, o: { provider?: Provider | null } = {}): Promise<RefineResult> {
  if (!can(ctx, "campaign_center.create")) throw forbidden("Refining wording needs Campaign Center: create");
  const p = RefineSchema.safeParse(input);
  if (!p.success) throw new AppError("bad_request", p.error.issues[0]?.message ?? "Nothing to refine");
  const v = p.data;
  const alt = v.part === "emailImageAlt";
  const source = alt ? [v.context?.emailHeadline, v.context?.emailSubject, v.context?.emailBody].filter(Boolean).join("\n\n") : v.text;
  if (!source.trim()) throw new AppError("bad_request", alt ? "Write the email first; the description comes from its wording" : "Write something first, then refine it");
  const known = [...Object.keys(MARKETING_FIELDS), ...v.extraFields];
  const provider = o.provider === undefined ? assistantProvider() : o.provider;
  let text: string;
  let refiner = "keywords";
  if (provider && provider.id !== "stub") {
    const r = await provider.complete({
      system: refinePrompt({ brand: BRAND_NAME, part: v.part, style: alt ? "custom" : v.style, instruction: alt ? "Write alt text for the email's header image from this email's wording." : v.instruction, extraFields: v.extraFields }),
      messages: [{ role: "user", content: source }],
      tools: [],
    });
    text = normalizeRefined(alt ? "" : v.text, r.text ?? "", v.part, known);
    refiner = provider.id;
  } else {
    text = alt ? stubAltText({ emailSubject: v.context?.emailSubject ?? "", emailHeadline: v.context?.emailHeadline ?? "", emailBody: v.context?.emailBody ?? "" }) : normalizeRefined(v.text, stubRefine(v.text, v.style), v.part, known);
  }
  if (!text.trim()) throw new AppError("bad_request", "The assistant didn't come back with anything; try again");
  await audit(ctx.actor, "campaign_center.ai_refined", "marketing_campaign", null, { refiner, part: v.part, style: alt ? "describe_image" : v.style, inLength: source.length, outLength: text.length }, null);
  return { text, refiner };
}
