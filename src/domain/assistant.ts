/**
 * Rayz Assistant, kept pure: its settings (on or off per role, the limits, drafting), what the
 * answers show (cards with numbers and links), the reports it may run, the system prompt, and the
 * dev stub's keyword router. The server (src/server/assistant) runs every tool with the asking
 * person's own permissions and locations; nothing here reaches data.
 */
import { z } from "zod";
import { REPORTS, type ReportKey } from "./permissions";
import { PRESETS } from "./report-range";

// ───────────────────────────── Settings ─────────────────────────────

export const AssistantSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Role id to on or off. Roles that aren't listed (new ones too) have it on. */
  roles: z.record(z.string(), z.boolean()).default({}),
  /** Questions per person. */
  perMinute: z
    .number()
    .int()
    .min(1, "Allow at least one question a minute")
    .max(30, "Up to 30 questions a minute")
    .default(6),
  perDay: z
    .number()
    .int()
    .min(5, "Allow at least 5 questions a day")
    .max(1000, "Up to 1,000 questions a day")
    .default(100),
  /** May draft blasts and purchase orders for the person to confirm. */
  actions: z.boolean().default(true),
});
export type AssistantSettings = z.output<typeof AssistantSettingsSchema>;
export const DEFAULT_ASSISTANT: AssistantSettings =
  AssistantSettingsSchema.parse({});

/** Stored settings with missing or broken keys at their defaults. */
export function assistantSettings(raw: unknown): AssistantSettings {
  const r = AssistantSettingsSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const o =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_ASSISTANT };
  for (const k of Object.keys(
    AssistantSettingsSchema.shape,
  ) as (keyof AssistantSettings)[]) {
    const v = AssistantSettingsSchema.shape[k].safeParse(o[k]);
    if (v.success) (out as Record<string, unknown>)[k] = v.data;
  }
  return out;
}

/** Whether someone working under this role gets the assistant. */
export const assistantOn = (s: AssistantSettings, roleId: string) =>
  s.enabled && s.roles[roleId] !== false;

// ───────────────────────────── Answers ─────────────────────────────

export const QUESTION_MAX = 1000;
/** Tool rounds and calls per question. */
export const MAX_ROUNDS = 5;
export const MAX_TOOL_CALLS = 6;
/** Earlier questions and answers sent back with a new question. */
export const HISTORY_MESSAGES = 10;
/** A drafted blast or purchase order can be confirmed for this long. */
export const ACTION_TTL_MS = 60 * 60 * 1000;

export interface AssistantLink {
  label: string;
  href: string;
}
export type AssistantActionStatus =
  "pending" | "confirmed" | "cancelled" | "failed";

/** What shows under an answer. The numbers come from the tools, never from the model's text. */
export type AssistantCard =
  | {
      kind: "report";
      title: string;
      subtitle: string;
      stats: { label: string; value: string; hint?: string }[];
      table: {
        title: string;
        headers: string[];
        rows: string[][];
        more: number;
      } | null;
      links: AssistantLink[];
    }
  | { kind: "help"; title: string; steps: string[]; links: AssistantLink[] }
  | {
      kind: "action";
      actionId: string;
      title: string;
      lines: string[];
      status: AssistantActionStatus;
      links: AssistantLink[];
    };

export interface AssistantMessageView {
  id: string;
  role: "user" | "assistant";
  body: string;
  cards: AssistantCard[];
  at: string;
}

// ───────────────────────────── Reports ─────────────────────────────

/**
 * Reports the assistant can run, when the person may view them. The audit log and client ratings
 * carry people's notes and edits, and the Morning Dashboard is its own page, so they stay out.
 */
export const ASSISTANT_REPORTS = REPORTS.filter(
  (r) => !["audit_log", "client_ratings", "morning_dashboard"].includes(r.key),
);
export const assistantReport = (k: string) =>
  ASSISTANT_REPORTS.find((r) => r.key === k) ?? null;
export const PRESET_IDS = PRESETS.map((p) => p.id) as [string, ...string[]];

/** Report columns that would name or reach a client; dropped before anything reaches the model. */
export const CONTACT_COLUMN =
  /phone|e-?mail|address|birthday|\bnotes?\b|card|bank|ssn|password/i;

// ───────────────────────────── Prompt ─────────────────────────────

export interface PromptPerson {
  firstName: string;
  roleName: string;
  shopLogin: boolean;
  shops: string[];
  everyShop: boolean;
  today: string;
  tools: string[];
}

export function systemPrompt(p: PromptPerson): string {
  const where = p.everyShop
    ? `every location (${p.shops.length})`
    : p.shops.length
      ? p.shops.join(", ")
      : "no locations";
  return [
    "You are Rayz Assistant, the helper built into the Ray'z Barber Shop admin software.",
    `You're talking with ${p.shopLogin ? `the shared ${p.firstName} shop login` : p.firstName} (${p.roleName}). Today is ${p.today}, shop time (America/Chicago). Their access covers ${where}.`,
    "Rules:",
    "- Answer only from tool results. Never guess or invent numbers, names or dates.",
    "- The tools already run with this person's permissions and locations. If a tool says something is outside their access, say so plainly and don't suggest a way around it.",
    '- run_report gives business numbers (sales, barbers, locations, inventory, purchase orders, tips, labor hours, campaigns, lapsed clients, utilization, rebook rate and 2nd-visit retention). Use view "shops" to compare locations and "barbers" to compare barbers.',
    p.tools.includes("customer_report")
      ? "- customer_report lists or counts clients with filters (lapsed, visits, spend)."
      : "",
    p.tools.includes("event_report")
      ? "- event_report counts and totals logged actions from the event log (bookings and cancellations with their lead time, the online booking funnel and where people drop off, wait and chair times, no-shows, ticket edits, voids, refunds, tips, stock, clock punches, block-outs, messages, calls), grouped by up to two fields."
      : "",
    p.tools.includes("client_notes")
      ? "- client_notes reads one client's notes from every location (pinned profile notes, cut and formula notes, private notes for managers). Notes never hold contact details; don't look for any."
      : "",
    '- help answers "how do I..." questions about using the software.',
    p.tools.includes("draft_blast") || p.tools.includes("draft_po")
      ? "- draft_blast and draft_po only prepare a draft. Nothing is created until the person presses Confirm under your answer, so tell them that."
      : "",
    "- Money in tool results is in dollars. Hours are hours.",
    "- Be brief: lead with the answer, then one to three supporting numbers. The app shows the full numbers and links under your answer, so don't paste tables or URLs.",
    "- Never ask for, repeat or store card numbers, bank details, SSNs, IDs or passwords. The software doesn't keep them.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ───────────────────────────── Dev stub ─────────────────────────────

export interface StubCall {
  name: string;
  args: Record<string, unknown>;
}

const has = (q: string, re: RegExp) => re.test(q);
/** "Coralville" in a question names "Ray'z Coralville". */
const mentions = (q: string, shop: string) =>
  q.includes(shop.toLowerCase().replace(/^ray'?z\s+/, ""));

const REPORT_WORDS: [RegExp, ReportKey][] = [
  [
    /lapsed|haven'?t been back|not been back|overdue|win.?back/,
    "lapsed_clients",
  ],
  [/low stock|running low|reorder|out of stock/, "low_stock"],
  [/purchase order|\bpos?\b|vendor spend/, "purchasing"],
  [/inventory|stock|on hand/, "inventory"],
  [/payroll|hours|labor|overtime/, "labor"],
  [/attendance|late|missed punch/, "attendance"],
  [/tip/, "tip_payouts"],
  [/opening/, "openings"],
  [/campaign|blast|marketing|roi\b/, "campaign_center"],
  [/review/, "google_reviews"],
  [/busiest|heat ?map|peak/, "heatmap"],
  [
    /utiliz|chair.?hour|lifetime|\bltv\b|cohort|on.?time start|attach rate|retail per|average ticket|satisfaction|operations kpi/,
    "operations",
  ],
  [/booked|capacity|schedule|working/, "staffing"],
  [
    /rebook|re-book|2nd visit|second visit|return rate|came back within|pre-?booked|booked ahead|future appointments/,
    "rebook_rate",
  ],
  [/rebook|retention|kpi/, "kpis"],
  [/service time|wait time|chair time/, "service_times"],
  [/gift card/, "gift_cards"],
  [/loyalty/, "loyalty"],
  [/discount|refund/, "discounts_refunds"],
  [/\bcard\b|cash|tender/, "card_vs_cash"],
  [/product|retail|services? (vs|and) products/, "services_vs_products"],
  [/call.?in|sick/, "call_ins"],
  [/barber|stylist|who sold|top (seller|earner)/, "sales_by_barber"],
  [
    /sales|revenue|how much|compare|trend|location|shop|money|ticket/,
    "sales_summary",
  ],
];

/** Questions about single logged actions go to the event log: which events, grouped by what. */
const EVENT_WORDS: [RegExp, string[], string[]][] = [
  [/funnel|abandon|drop.?off|left without booking/, ["funnel"], ["event"]],
  [/late cancel|cancell?ations?|cancelled/, ["booking.cancelled"], ["subtype"]],
  [/no.?shows?/, ["appointment.no_show"], ["location"]],
  [
    /voids?|voided|price (change|override)s?/,
    ["ticket.voided", "payment.voided", "ticket.price_override"],
    ["event", "reason"],
  ],
  [/missed calls?|phone calls?|calls? (answered|booked)/, ["call"], ["event"]],
  [/block.?outs?/, ["block"], ["subtype"]],
  [
    /lead time|booked ahead|booking source|how (do|did) (clients|people) book/,
    ["booking.created"],
    ["channel"],
  ],
  [/event log|how many times/, [], ["event"]],
];

const PRESET_WORDS: [RegExp, string][] = [
  [/today/, "today"],
  [/yesterday/, "yesterday"],
  [/last pay period/, "lastpayperiod"],
  [/pay period/, "payperiod"],
  [/this week/, "week"],
  [/last week|past week|7 days/, "7d"],
  [/last month/, "lastmonth"],
  [/this month|month to date|mtd/, "month"],
  [/30 days|past month/, "30d"],
  [/year|ytd/, "ytd"],
];

/**
 * What the stub calls for a question: a keyword router over the tools offered, so the assistant
 * runs in development without an API key. It names only locations and barbers the person can see.
 */
export function stubPlan(
  question: string,
  o: { tools: string[]; reports: string[]; shops: string[]; barbers: string[] },
): StubCall | null {
  const q = question.toLowerCase();
  const offered = (t: string) => o.tools.includes(t);
  const drafting = has(q, /\b(draft|create|make|start|write|set up)\b/);
  if (
    drafting &&
    has(q, /purchase order|\bpo\b|reorder/) &&
    offered("draft_po")
  ) {
    const shop = o.shops.find((s) => mentions(q, s));
    return { name: "draft_po", args: shop ? { location: shop } : {} };
  }
  if (
    drafting &&
    has(q, /blast|campaign|text|email/) &&
    offered("draft_blast")
  ) {
    const weeks = q.match(/(\d+)\s*weeks?/);
    const email = has(q, /email/) && !has(q, /text|sms/);
    return {
      name: "draft_blast",
      args: {
        name: "We miss you",
        channel: email ? "email" : "sms",
        message: email
          ? "Hi {first_name}, it's been a while! Book your next cut at {shop}: {book_link}"
          : "Hi {first_name}, it's been a while! Book your next cut at {shop}: {book_link} Reply STOP to opt out.",
        lastVisitOverDays: weeks ? Number(weeks[1]) * 7 : 42,
      },
    };
  }
  if (
    has(q, /\b(notes?|formula|usual cut|last cut|guard numbers?)\b/) &&
    !has(q, /how (do|can|should) i|how to/) &&
    offered("client_notes")
  ) {
    const client = (
      question.match(
        /\b(?:for|on|about)\s+(?:client\s+)?(.+?)\s*[?.!]*$/i,
      )?.[1] ??
      question.match(
        /([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)'s\s+(?:notes?|usual|last|cut|formula|guard)/,
      )?.[1]
    )?.replace(/'s\b.*$/, "");
    if (client && client.trim().length >= 2) {
      const kind = has(q, /formula|cut|guard/)
        ? "visit"
        : has(q, /private|manager/)
          ? "private"
          : has(q, /profile|pinned/)
            ? "profile"
            : "any";
      return { name: "client_notes", args: { client: client.trim(), kind } };
    }
  }
  if (
    has(
      q,
      /how (do|can|should) i|how to|where (do|can|is)|what does|help me|can i\b/,
    ) &&
    offered("help")
  )
    return { name: "help", args: { question } };
  if (
    has(q, /(list|which|who are|show me|top \d+|top) .*clients|clients who/) &&
    offered("customer_report")
  ) {
    const weeks = q.match(/(\d+)\s*weeks?/);
    if (has(q, /running (low|out)|run out|ran out|restock|refill/))
      return {
        name: "customer_report",
        args: {
          columns: ["name", "products_running_out", "last_product", "last_product_date", "next_refill_due"],
          refillStatus: [has(q, /ran out|have run out|already out/) ? "ran_out" : "running_out"],
          sort: "next_refill_due",
        },
      };
    const status = weeks
      ? null
      : has(q, /overdue/)
        ? "overdue"
        : has(q, /\bdue\b/)
          ? "due"
          : null;
    if (status)
      return {
        name: "customer_report",
        args: {
          columns: [
            "name",
            "last_visit",
            "cadence_label",
            "next_visit_due",
            "visit_status",
          ],
          visitStatus: [status],
          sort: "next_visit_due",
        },
      };
    const lapsed = has(q, /lapsed|haven'?t been back|not been back|overdue/);
    return {
      name: "customer_report",
      args: {
        columns: ["name", "home_location", "last_visit", "visits"],
        ...(lapsed
          ? { lastVisitOverDays: weeks ? Number(weeks[1]) * 7 : 42 }
          : {}),
        sort: lapsed ? "last_visit" : "visits",
        descending: !lapsed,
      },
    };
  }
  const ev = offered("event_report")
    ? EVENT_WORDS.find(([re]) => has(q, re))
    : undefined;
  if (ev)
    return {
      name: "event_report",
      args: {
        eventTypes: ev[1],
        groupBy: ev[2],
        preset: PRESET_WORDS.find(([re]) => has(q, re))?.[1] ?? "30d",
      },
    };
  if (offered("run_report")) {
    const report =
      REPORT_WORDS.find(
        ([re, k]) => has(q, re) && o.reports.includes(k),
      )?.[1] ??
      (o.reports.includes("sales_summary")
        ? "sales_summary"
        : o.reports.includes("my_sales")
          ? "my_sales"
          : null);
    if (report) {
      const args: Record<string, unknown> = {
        report,
        preset: PRESET_WORDS.find(([re]) => has(q, re))?.[1] ?? "7d",
      };
      const shops = o.shops.filter((s) => mentions(q, s));
      if (shops.length) args.locations = shops;
      else if (
        has(
          q,
          /all (locations|shops)|every (location|shop)|each location|by location|per location|compare/,
        )
      )
        args.locations = ["all"];
      const barbers = o.barbers.filter((b) =>
        new RegExp(
          `\\b${b
            .toLowerCase()
            .split(" ")[0]
            .replace(/[^a-z]/g, "")}\\b`,
        ).test(q),
      );
      if (barbers.length) args.barbers = barbers;
      if (has(q, /by barber|each barber|per barber|which barber|top barber/))
        args.view = "barbers";
      else if (
        has(
          q,
          /by location|each location|per location|compare|which (location|shop)/,
        )
      )
        args.view = "shops";
      return { name: "run_report", args };
    }
  }
  return offered("help") ? { name: "help", args: { question } } : null;
}

/** The stub's answer once the tools have run: their one-line summaries. */
export function stubAnswer(
  results: { name: string; content: string }[],
): string {
  const lines = results
    .map((r) => r.content.split("\n")[0].replace(/^SUMMARY:\s*/, ""))
    .filter(Boolean);
  if (!lines.length)
    return "I couldn't find anything for that. Try asking about sales, barbers, inventory, tips, hours or campaigns.";
  return `${lines.join(" ")} (Answered by the built-in demo assistant: set an OpenAI or Anthropic API key for full answers.)`;
}

/** Example questions for the empty chat, from what the person may run. */
export function suggestions(o: {
  reports: string[];
  tools: string[];
}): string[] {
  const out: string[] = [];
  if (o.reports.includes("sales_summary"))
    out.push("Compare sales by location this month");
  if (o.reports.includes("sales_by_barber"))
    out.push("Who were the top barbers last week?");
  if (o.reports.includes("my_sales") && !o.reports.includes("sales_summary"))
    out.push("How were my sales this week?");
  if (o.reports.includes("lapsed_clients"))
    out.push("How many lapsed clients do we have?");
  if (o.reports.includes("low_stock")) out.push("What's running low on stock?");
  if (o.reports.includes("labor"))
    out.push("How many hours did we work this pay period?");
  if (o.tools.includes("draft_po"))
    out.push("Draft a purchase order for what's low");
  out.push("How do I block out time for lunch?");
  return out.slice(0, 5);
}
