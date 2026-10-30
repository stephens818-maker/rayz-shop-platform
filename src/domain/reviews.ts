/**
 * Google reviews: each location's review link, when it's shown (from the client's Nth visit, and not
 * again for a while after a tap), the optional follow-up after a visit, and its wording. Everyone who
 * qualifies gets the same link the same way. Nothing here (or in the server code that uses it) looks
 * at ratings, tips, refunds or complaints: asking only happy clients ("review gating") is against
 * Google's review policy.
 */
import { z } from "zod";

/** Google Place IDs: letters, digits, `_` and `-` (e.g. ChIJN1t_tDeuEmsRUsoyG83frY4). */
const PLACE_ID = /^[A-Za-z0-9_-]{16,512}$/;
/** The code in a g.page/r/… share link. */
const SHARE_CODE = /^[A-Za-z0-9_-]{4,128}$/;

export const writeReviewUrl = (placeId: string) => `https://search.google.com/local/writereview?placeid=${placeId}`;

export const GOOGLE_REVIEW_HELP = "Paste the link from Google Business Profile (g.page/r/… or search.google.com/local/writereview?placeid=…), or the Place ID";

export type GoogleReviewLink = { ok: true; url: string | null } | { ok: false; message: string };

/**
 * A location's Google review link, from what someone pasted: a g.page/r/… share link, a
 * search.google.com/local/writereview?placeid=… link, or a bare Place ID. Always saved as https,
 * rebuilt from the parts we accept (no extra query or tracking parameters). Blank is no link.
 */
export function googleReviewLink(raw: unknown): GoogleReviewLink {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: true, url: null };
  const bad = { ok: false as const, message: `That isn't a Google review link. ${GOOGLE_REVIEW_HELP}.` };
  if (PLACE_ID.test(s)) return { ok: true, url: writeReviewUrl(s) };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return bad;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return bad;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "g.page") {
    const m = u.pathname.match(/^\/r\/([^/]+)(?:\/review)?\/?$/);
    if (m && SHARE_CODE.test(m[1])) return { ok: true, url: `https://g.page/r/${m[1]}/review` };
  }
  if (host === "search.google.com" && u.pathname.replace(/\/+$/, "") === "/local/writereview") {
    const id = u.searchParams.get("placeid");
    if (id && PLACE_ID.test(id)) return { ok: true, url: writeReviewUrl(id) };
  }
  return bad;
}

/** Stored settings read defensively: anything that isn't a Google review link is no link (no button). */
export const storedReviewLink = (raw: unknown): string | null => {
  const r = googleReviewLink(raw);
  return r.ok ? r.url : null;
};

// ───────────────────────────── The follow-up after a visit ─────────────────────────────

export const REVIEW_FOLLOW_UP_DEFAULT = { enabled: false, delayHours: 3, repeatDays: 90 };

/**
 * Per location. The same request, a set time after the ticket is paid, to every client who has agreed
 * to texts or emails and is at the location's visit threshold; by text if they agreed to texts,
 * otherwise by email.
 */
export const ReviewFollowUpSchema = z.object({
  enabled: z.boolean().default(false),
  /** Hours after the ticket is paid. */
  delayHours: z.number().int().min(1, "Send 1 to 48 hours after the visit").max(48, "Send 1 to 48 hours after the visit").default(3),
  /** Ask the same client at this location at most once in this many days (0: after every visit). */
  repeatDays: z.number().int().min(0, "Ask again after 0 to 365 days").max(365, "Ask again after 0 to 365 days").default(90),
});
export type ReviewFollowUp = z.output<typeof ReviewFollowUpSchema>;

export function reviewFollowUp(raw: unknown): ReviewFollowUp {
  const r = ReviewFollowUpSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  return r.success ? r.data : { ...REVIEW_FOLLOW_UP_DEFAULT };
}

/** Tickets paid longer ago than the delay plus this aren't asked any more (a cron that was down for a day). */
export const FOLLOW_UP_LOOKBACK_HOURS = 24;

// ───────────────────────────── When to ask: visit count and a pause after a tap ─────────────────────────────

const minVisits = z.number().int().min(1, "Start at visit 1 to 50").max(50, "Start at visit 1 to 50");
const snoozeDays = z.number().int().min(0, "Pause 0 to 365 days").max(365, "Pause 0 to 365 days");

/**
 * The brand's rules for showing the review link (on the receipt and in the follow-up): from the
 * client's Nth completed visit, counted across every location, and not again at a location for some
 * days after they tapped its link. Visit count and taps only: never ratings, tips or refunds.
 */
export const ReviewRulesSchema = z.object({ minVisits: minVisits.default(3), snoozeDays: snoozeDays.default(90) });
export type ReviewRules = z.output<typeof ReviewRulesSchema>;
export const REVIEW_RULES_DEFAULT: ReviewRules = { minVisits: 3, snoozeDays: 90 };

export function reviewRules(raw: unknown): ReviewRules {
  const r = ReviewRulesSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  return r.success ? r.data : { ...REVIEW_RULES_DEFAULT };
}

/** A location's overrides, saved with its receipt settings; null uses the brand's. */
export const ReviewMinVisitsSchema = minVisits.nullable().default(null);
export const ReviewSnoozeDaysSchema = snoozeDays.nullable().default(null);
export const storedOverride = (raw: unknown, schema: typeof ReviewMinVisitsSchema | typeof ReviewSnoozeDaysSchema): number | null => {
  const r = schema.safeParse(raw ?? null);
  return r.success ? r.data : null;
};

export function locationReviewRules(brand: ReviewRules, shop: { reviewMinVisits: number | null; reviewSnoozeDays: number | null }): ReviewRules {
  return { minVisits: shop.reviewMinVisits ?? brand.minVisits, snoozeDays: shop.reviewSnoozeDays ?? brand.snoozeDays };
}

export type ReviewHold = "few_visits" | "snoozed";

/**
 * Whether this visit gets the review link. `visit` is which completed visit this ticket is for the
 * client (1 for their first, counted across all locations); `tappedRecently` is a tap on this
 * location's link from another of their tickets within the pause.
 */
export function reviewHold(o: { visit: number; rules: ReviewRules; tappedRecently: boolean }): ReviewHold | null {
  if (o.visit < o.rules.minVisits) return "few_visits";
  if (o.tappedRecently) return "snoozed";
  return null;
}

export const ordinal = (n: number) => {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

/** The text: the same for everyone, with the tracked link. */
export function reviewRequestSms(o: { title: string; firstName: string | null; url: string }): string {
  return `${o.firstName ? `Hi ${o.firstName}, thanks` : "Thanks"} for visiting ${o.title}. We'd appreciate an honest review on Google: ${o.url} Reply STOP to opt out.`;
}

/** The app push: no link in the text; tapping it opens the review link from the push data. */
export function reviewRequestPush(o: { title: string; firstName: string | null }): string {
  return `${o.firstName ? `Hi ${o.firstName}, how` : "How"} was your visit to ${o.title}? We'd appreciate an honest review on Google. Tap to leave one.`;
}

export function reviewRequestEmail(o: { title: string; firstName: string | null; url: string; receiptUrl: string; footer: string }): { subject: string; body: string } {
  return {
    subject: `Review your visit to ${o.title} on Google`,
    body: [
      o.firstName ? `Hi ${o.firstName},` : "Hi,",
      "",
      `Thanks for visiting ${o.title}. If you have a minute, we'd appreciate an honest review on Google:`,
      o.url,
      "",
      `Your receipt, and the option to stop these emails: ${o.receiptUrl}`,
      "",
      o.footer,
    ].join("\n"),
  };
}

// ───────────────────────────── Clicks ─────────────────────────────

export const REVIEW_CLICK_SOURCES = ["receipt", "follow_up"] as const;
export type ReviewClickSource = (typeof REVIEW_CLICK_SOURCES)[number];
export const REVIEW_CLICK_SOURCE_LABEL: Record<ReviewClickSource, string> = { receipt: "Receipt page", follow_up: "Follow-up" };

/**
 * Link previews (iMessage, WhatsApp, Slack…) and email security scanners open links on their own.
 * They're still sent on to Google, but not counted as a client's click.
 */
const AUTOMATED =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|skype|embedly|pinterest|vkshare|ms-office|microsoft office|google-safety|proofpoint|mimecast|barracuda|symantec|forcepoint|headless|python-requests|curl\/|wget/i;
export const isAutomatedOpen = (userAgent: string | null | undefined) => !userAgent?.trim() || AUTOMATED.test(userAgent);
