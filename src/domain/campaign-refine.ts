/**
 * "Refine text" in the Campaign Center editor: the assistant rewrites one part of a message
 * (shorter, friendlier, more urgent, clearer, or as the person asks) and keeps its merge fields.
 * Only that part's wording goes to the model, never anything about a client. Without a model a
 * plain rewriter does what it can (shorter and clearer), so the button always answers.
 * "Describe image" writes the email image's alt text from the email's own wording.
 */
import { MARKETING_FIELDS, TEMPLATE_PART_LABEL, type Templates } from "./marketing";

export const REFINE_STYLES = ["shorter", "friendlier", "urgent", "clearer", "custom"] as const;
export type RefineStyle = (typeof REFINE_STYLES)[number];
export const REFINE_LABEL: Record<RefineStyle, string> = {
  shorter: "Shorter",
  friendlier: "Friendlier",
  urgent: "More urgent",
  clearer: "Fix and clarify",
  custom: "Your way…",
};
const ASK: Record<Exclude<RefineStyle, "custom">, string> = {
  shorter: "Make it noticeably shorter without losing the point or the offer.",
  friendlier: "Make it warmer and more personal, like a barber who knows the client.",
  urgent: "Give it a gentle reason to act soon, without pressure, hype or ALL CAPS.",
  clearer: "Fix spelling, grammar and punctuation, and make it easy to read.",
};

export type RefinePart = Exclude<keyof Templates, "emailImage">;
/** The longest each part may be, matching TemplatesSchema. */
export const REFINE_MAX: Record<RefinePart, number> = { sms: 480, emailSubject: 150, emailHeadline: 120, emailBody: 5000, emailCta: 40, emailImageAlt: 150, pushTitle: 65, pushBody: 240 };

const FIELD = /\{([a-z_]+)(\|[^{}|]*)?\}/g;
const HAS_FIELD = /\{[a-z_]+(\|[^{}|]*)?\}/;

export function refinePrompt(o: { brand: string; part: RefinePart; style: RefineStyle; instruction?: string; extraFields?: readonly string[] }): string {
  const fields = [...Object.keys(MARKETING_FIELDS), ...(o.extraFields ?? [])].map((f) => `{${f}}`).join(", ");
  const ask = o.style === "custom" ? (o.instruction ?? "").trim() || ASK.clearer : ASK[o.style];
  return [
    `You edit marketing wording for ${o.brand}, a barbershop brand. Rewrite the ${TEMPLATE_PART_LABEL[o.part].toLowerCase()} you're given. ${ask}`,
    `Keep every merge field exactly as written (${fields}, optionally with a fallback like {first_name|there}); never invent new ones or real names.`,
    o.part === "sms" ? "It's a text: the booking link and the opt-out line are added automatically, so don't write them." : "",
    o.part === "emailImageAlt" ? "It's the image's alt text: one plain sentence describing the picture for someone who can't see it." : "",
    `No emoji, no ALL CAPS, at most ${REFINE_MAX[o.part]} characters. Answer with the rewritten wording only.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const FILLER = /\b(just|really|very|actually|simply|basically|totally|truly|so much)\s+/gi;

/** Without a language model: trims filler (shorter), tidies spacing, capitals and punctuation (clearer); other styles get the tidy-up. */
export function stubRefine(text: string, style: RefineStyle): string {
  let t = text.replace(/[ \t]+/g, " ").replace(/ +([.,!?])/g, "$1").replace(/([.,!?])(?=[A-Za-z{])/g, "$1 ");
  if (style === "shorter") {
    t = t.replace(FILLER, "").replace(/\s*\([^)]*\)/g, "");
    const lines = t.split(/\n{2,}/);
    if (lines.length > 2) t = [lines[0], ...lines.slice(1, -1).filter((l) => HAS_FIELD.test(l) || l.length < 80), lines[lines.length - 1]].join("\n\n");
  }
  t = t.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  return t.trim();
}

/**
 * The model's rewrite made safe to use: merge fields it dropped come back at the end (so
 * {coupon_code} isn't lost), fields it made up are taken out, quotes it wrapped the answer in are
 * removed, and it's cut to the part's length.
 */
export function normalizeRefined(original: string, refined: string, part: RefinePart, known: readonly string[]): string {
  let t = refined.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  t = t.replace(FIELD, (m, f: string) => (known.includes(f) ? m : ""));
  const had = [...original.matchAll(FIELD)].map((m) => m[1]);
  const kept = new Set([...t.matchAll(FIELD)].map((m) => m[1]));
  const lost = [...new Set(had)].filter((f) => !kept.has(f) && f !== "first_name" && f !== "shop");
  if (lost.length && part !== "emailImageAlt") t = `${t} ${lost.map((f) => `{${f}}`).join(" ")}`;
  t = t.replace(/[ \t]{2,}/g, " ").trim();
  return t.length > REFINE_MAX[part] ? t.slice(0, REFINE_MAX[part]).trim() : t;
}

/** Alt text from the email's wording, without a model: what the email's about. */
export function stubAltText(t: Pick<Templates, "emailSubject" | "emailHeadline" | "emailBody">): string {
  const about = (t.emailHeadline || t.emailSubject || t.emailBody.split("\n").find((l) => l.trim() && !/^hi\b/i.test(l)) || "").replace(FIELD, "").replace(/\s+/g, " ").trim();
  return (about ? `Ray'z Barber Shop: ${about}` : "Ray'z Barber Shop").slice(0, REFINE_MAX.emailImageAlt);
}
