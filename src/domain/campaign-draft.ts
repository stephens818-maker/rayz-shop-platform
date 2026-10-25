/**
 * "Describe what you want": the assistant's language model (or, without one, a keyword drafter)
 * turns a sentence into a blast draft: its wording on each channel, its audience and an existing
 * coupon. It only ever drafts. The person reviews every step and sends it themselves; nothing about
 * clients is sent to the model, only the request, the brand's coupon codes and badge names.
 */
import { z } from "zod";
import { CHANNELS, EMPTY_SEGMENT, MARKETING_FIELDS, STOP_LINE, SegmentSchema, TemplatesSchema, type Channel, type Segment, type Templates } from "./marketing";
import { VISIT_STATUSES } from "./visit-cadence";

const n = (max: number) => z.number().int().min(0).max(max).nullable().optional();

/** The audience filters a draft may set: the ones that say who a client is, never contact details. */
export const DraftAudienceSchema = z.object({
  lastVisitOverDays: n(3650),
  lastVisitWithinDays: n(3650),
  notBooked: z.boolean().optional(),
  firstVisitWithinDays: n(3650),
  minVisits: n(10000),
  maxVisits: n(10000),
  minAvgGapDays: n(3650),
  maxAvgGapDays: n(3650),
  visitStatus: z.array(z.enum(VISIT_STATUSES)).max(3).optional(),
  badges: z.array(z.string()).max(20).optional(),
  birthdayMonths: z.array(z.number().int().min(1).max(12)).max(12).optional(),
  upcoming: z.enum(["any", "yes", "no"]).optional(),
});

export const DraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  campaignType: z.enum(["update", "promotion"]),
  channels: z.array(z.enum(CHANNELS)).min(1).max(3),
  templates: TemplatesSchema,
  audience: DraftAudienceSchema.default({}),
  couponCode: z.string().trim().max(40).nullable().optional(),
  /** One or two sentences on why this audience and wording, shown to the person reviewing. */
  rationale: z.string().trim().max(400).default(""),
});
export type RawDraft = z.input<typeof DraftSchema>;

export interface DraftCoupon {
  id: string;
  code: string;
  summary: string;
  usable: boolean;
}

export interface CampaignDraft {
  name: string;
  campaignType: "update" | "promotion";
  channels: Channel[];
  templates: Templates;
  segment: Segment;
  promoId: string | null;
  rationale: string;
  /** What was changed to fit the rules, for the reviewer. */
  notes: string[];
}

/** The tool the model fills in: its arguments are the draft. */
export const DRAFT_TOOL = {
  name: "draft_campaign",
  description: "Draft one marketing blast for a barbershop brand: its name, type, channels, wording and audience. A person reviews and edits it before anything is sent.",
  parameters: {
    type: "object",
    required: ["name", "campaignType", "channels", "templates"],
    properties: {
      name: { type: "string", description: "A short internal name, e.g. 'Spring beard special'." },
      campaignType: { type: "string", enum: ["update", "promotion"], description: "promotion when it carries a coupon code, otherwise update." },
      channels: { type: "array", items: { type: "string", enum: [...CHANNELS] }, description: "Channels in the order tried." },
      templates: {
        type: "object",
        required: ["sms", "emailSubject", "emailBody", "pushTitle", "pushBody"],
        properties: {
          sms: { type: "string", description: `Under 300 characters, starting with {shop}: and ending with '${STOP_LINE}'` },
          emailSubject: { type: "string", description: "Under 80 characters." },
          emailBody: { type: "string", description: "Plain text, a few short lines, with {book_link}." },
          pushTitle: { type: "string", description: "Under 60 characters." },
          pushBody: { type: "string", description: "Under 200 characters." },
        },
      },
      audience: {
        type: "object",
        properties: {
          lastVisitOverDays: { type: "integer", description: "Last visit more than this many days ago (lapsed clients)." },
          lastVisitWithinDays: { type: "integer", description: "Last visit within this many days." },
          notBooked: { type: "boolean", description: "Nothing booked since their last visit." },
          firstVisitWithinDays: { type: "integer", description: "New clients: first visit within this many days." },
          minVisits: { type: "integer" },
          maxVisits: { type: "integer" },
          minAvgGapDays: { type: "integer", description: "Usual days between visits, at least." },
          maxAvgGapDays: { type: "integer", description: "Usual days between visits, at most." },
          visitStatus: { type: "array", items: { type: "string", enum: [...VISIT_STATUSES] }, description: "Against their usual time between visits." },
          badges: { type: "array", items: { type: "string" }, description: "Badge keys from the list given." },
          birthdayMonths: { type: "array", items: { type: "integer" } },
          upcoming: { type: "string", enum: ["any", "yes", "no"], description: "Has an appointment booked." },
        },
      },
      couponCode: { type: "string", description: "One of the brand's coupon codes listed, for a promotion. Never invent one." },
      rationale: { type: "string", description: "One or two sentences on the audience and wording." },
    },
  },
} as const;

export function draftSystemPrompt(o: { brand: string; shops: string[]; coupons: readonly DraftCoupon[]; badges: readonly { key: string; label: string }[] }): string {
  const fields = Object.entries(MARKETING_FIELDS)
    .map(([k, v]) => `{${k}}: ${v}`)
    .join("; ");
  const coupons = o.coupons.filter((c) => c.usable);
  return [
    `You draft marketing blasts for ${o.brand}, a barbershop brand with locations ${o.shops.join(", ") || "(several)"}. Call draft_campaign once with the draft.`,
    `Write like a friendly local barbershop: short, warm, no hype, no emoji, no ALL CAPS. Use merge fields, never made-up names: ${fields}. Every message links {book_link}.`,
    `The text starts with "{shop}: " and ends with "${STOP_LINE}". Use {coupon_code} and {expiry} only with a coupon.`,
    coupons.length ? `Coupons you may use (code: what it gives): ${coupons.map((c) => `${c.code}: ${c.summary}`).join("; ")}. Pick one only for a promotion.` : "There are no coupons to use, so it's an update without an offer.",
    o.badges.length ? `Client badges (key: label): ${o.badges.map((b) => `${b.key}: ${b.label}`).join("; ")}.` : "",
    "Lapsed means no visit in a while and nothing booked since: set lastVisitOverDays and notBooked. New clients: firstVisitWithinDays. Regulars: minVisits 3 and lastVisitWithinDays 60.",
    "You never send anything and never see client data. A person reviews the draft.",
  ]
    .filter(Boolean)
    .join("\n");
}

const MAX = { sms: 300, emailSubject: 120, emailBody: 2000, pushTitle: 60, pushBody: 200 } as const;

/** The model's draft made to fit the rules: known merge fields, the opt-out line, a real coupon, filters the person may use. */
export function normalizeDraft(raw: unknown, o: { coupons: readonly DraftCoupon[]; badges: readonly string[] }): CampaignDraft {
  const parsed = DraftSchema.safeParse(raw);
  const notes: string[] = [];
  const d = parsed.success ? parsed.data : DraftSchema.parse(stubDraftRaw("", o.coupons));
  if (!parsed.success) notes.push("The assistant's answer didn't fit, so this is a plain starting point.");
  const coupon = d.couponCode ? o.coupons.find((c) => c.code.toUpperCase() === d.couponCode!.toUpperCase() && c.usable) : undefined;
  if (d.couponCode && !coupon) notes.push(`${d.couponCode} isn't one of your active coupons, so no coupon is attached.`);
  const hasCoupon = !!coupon;
  const known = Object.keys(MARKETING_FIELDS);
  const clean = (s: string, k: keyof Templates) => {
    let t = s.replace(/\{([a-z_]+)\}/g, (m, f: string) => (known.includes(f) && (hasCoupon || (f !== "coupon_code" && f !== "expiry")) ? m : ""));
    t = t.replace(/[ \t]{2,}/g, " ").trim();
    if (t.length > MAX[k]) t = t.slice(0, MAX[k]).trim();
    return t;
  };
  const t: Templates = {
    sms: clean(d.templates.sms, "sms"),
    emailSubject: clean(d.templates.emailSubject, "emailSubject"),
    emailBody: clean(d.templates.emailBody, "emailBody"),
    pushTitle: clean(d.templates.pushTitle, "pushTitle"),
    pushBody: clean(d.templates.pushBody, "pushBody"),
  };
  if (!t.sms.startsWith("{shop}")) t.sms = `{shop}: ${t.sms}`;
  if (!t.sms.includes("{book_link}")) t.sms = `${t.sms.replace(new RegExp(`\\s*${STOP_LINE.replace(/\./g, "\\.")}$`), "")} {book_link}`;
  if (!/\bSTOP\b/.test(t.sms)) t.sms = `${t.sms} ${STOP_LINE}`;
  if (!t.emailBody.includes("{book_link}")) t.emailBody = `${t.emailBody}\n\nBook: {book_link}`;
  if (!t.emailSubject) t.emailSubject = "News from {shop}";
  if (!t.pushTitle) t.pushTitle = "{shop}";
  if (!t.pushBody) t.pushBody = "Tap to book your next cut.";
  const a = d.audience ?? {};
  const badges = (a.badges ?? []).filter((b) => o.badges.includes(b));
  if ((a.badges ?? []).length > badges.length) notes.push("Badges you can't filter on were left out.");
  const seg = SegmentSchema.safeParse({ ...EMPTY_SEGMENT, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined)), badges });
  if (!seg.success) notes.push("The audience didn't fit the filters, so it's everyone at the locations; set it in the next step.");
  const channels = [...new Set(d.channels)] as Channel[];
  return {
    name: d.name,
    campaignType: hasCoupon ? "promotion" : "update",
    channels: channels.length ? channels : ["sms", "email", "push"],
    templates: t,
    segment: seg.success ? seg.data : EMPTY_SEGMENT,
    promoId: coupon?.id ?? null,
    rationale: d.rationale,
    notes,
  };
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };

/** Without a language model: reads the request for who (lapsed, new, regulars, birthdays, a badge), an offer and channels. */
export function stubDraftRaw(prompt: string, coupons: readonly DraftCoupon[], badges: readonly { key: string; label: string }[] = []): RawDraft {
  const p = prompt.toLowerCase();
  const audience: NonNullable<RawDraft["audience"]> = {};
  const span = p.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(day|week|month)s?/);
  const amount = span ? (Number(span[1]) || WORD_NUM[span[1]] || 0) * (span[2] === "day" ? 1 : span[2] === "week" ? 7 : 30) : 0;
  let who = "clients";
  const lapsed = /laps|miss|haven'?t (seen|been)|not been in|come back|win.?back|been a while/;
  const fresh = /new client|first.?time|first visit|newcomer/;
  const regular = badges.some((b) => b.key === "vip") ? /regular|loyal|best client/ : /regular|loyal|best client|vip/;
  const due = /overdue|due for|\bdue\b/;
  const stage = [lapsed, fresh, regular, due].find((re) => re.test(p)) ?? null;
  if (stage === lapsed) {
    audience.lastVisitOverDays = amount || 42;
    audience.notBooked = true;
    who = "lapsed clients";
  } else if (stage === fresh) {
    audience.firstVisitWithinDays = amount || 30;
    who = "new clients";
  } else if (stage === regular) {
    audience.minVisits = 3;
    audience.lastVisitWithinDays = 60;
    who = "regulars";
  } else if (stage === due) {
    audience.visitStatus = ["due", "overdue"];
    who = "clients due for a cut";
  }
  if (/birthday/.test(p)) {
    audience.birthdayMonths = [new Date().getMonth() + 1];
    who = "clients with a birthday this month";
  }
  // "Lapsed", "We miss you", "New client" and the like are badges too; requiring the badge on top of the same rule only shrinks the audience.
  const badge = badges.find((b) => p.includes(b.label.toLowerCase()) && !stage?.test(b.label.toLowerCase()));
  if (badge) audience.badges = [badge.key];
  const usable = coupons.filter((c) => c.usable);
  const named = usable.find((c) => p.includes(c.code.toLowerCase()));
  const pct = p.match(/(\d+)\s*%/);
  const offer = named ?? (pct ? usable.find((c) => c.summary.startsWith(`${pct[1]}%`)) : undefined) ?? (/% ?off|\$\d+ ?off|discount|promo|coupon|deal|offer|special/.test(p) ? usable[0] : undefined);
  const channels: Channel[] = /text only|sms only|just text/.test(p) ? ["sms"] : /email only|just email/.test(p) ? ["email"] : ["sms", "email", "push"];
  const topic = /holiday|closed|closing/.test(p) ? "holiday" : /hours/.test(p) ? "hours" : /new barber|welcome/.test(p) ? "barber" : null;
  const line = offer
    ? "here's {coupon_code} for your next cut, good till {expiry}."
    : topic === "holiday"
      ? "heads up, we're closed for the holiday. Book before or after."
      : topic === "hours"
        ? "our hours are changing. See the new times and book."
        : topic === "barber"
          ? "we've got a new barber taking bookings."
          : who === "lapsed clients"
            ? "it's been a while! We'd love to see you back in the chair."
            : "we'd love to see you soon.";
  const name = offer ? `${offer.code} for ${who}` : topic ? `${topic[0].toUpperCase()}${topic.slice(1)} update` : `Note to ${who}`;
  return {
    name: name.slice(0, 80),
    campaignType: offer ? "promotion" : "update",
    channels,
    templates: {
      sms: `{shop}: Hi {first_name}, ${line} {book_link} ${STOP_LINE}`,
      emailSubject: offer ? "A little something from {shop}" : topic === "holiday" ? "Holiday hours at {shop}" : "News from {shop}",
      emailBody: `Hi {first_name},\n\n${line[0].toUpperCase()}${line.slice(1)}\n\nBook here: {book_link}`,
      pushTitle: offer ? "An offer from {shop}" : "{shop}",
      pushBody: offer ? "Use {coupon_code} till {expiry}." : "Tap to book your next cut.",
    },
    audience,
    couponCode: offer?.code ?? null,
    rationale: `Drafted from your request for ${who}${offer ? ` with ${offer.code}` : ""}. Check the audience and wording before you send it.`,
  };
}
