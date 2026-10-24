/**
 * Digital receipts: a text with a link, or an email with the receipt and a link, or no receipt.
 * Pure rules: who may be sent what, and the wording. Paper is off unless a shop turns it on.
 */
import { formatCents } from "@/lib/money";

export type ReceiptSendChannel = "sms" | "email";

/**
 * Why a receipt went out.
 * - counter, handoff: the client chose it at checkout (at the counter, or on the customer screen).
 * - refund, void: the updated receipt after the ticket changed.
 * - resend: staff sent it again from the ticket or the client's history.
 * - request: the client asked for a copy themselves.
 * - review: the location's Google review follow-up after the visit (src/domain/reviews.ts).
 */
export const RECEIPT_PURPOSES = ["counter", "handoff", "refund", "void", "resend", "request", "review"] as const;
export type ReceiptPurpose = (typeof RECEIPT_PURPOSES)[number];
export const RECEIPT_PURPOSE_LABEL: Record<ReceiptPurpose, string> = {
  counter: "At checkout",
  handoff: "On the customer screen",
  refund: "Refund update",
  void: "Void update",
  resend: "Sent again by staff",
  request: "Requested by the client",
  review: "Google review request",
};

/**
 * Why a message wasn't sent. Review follow-ups only: `recent`, already asked at this location lately;
 * `few_visits`, before the visit the review link starts at; `snoozed`, tapped this location's link lately.
 */
export type ReceiptSkip = "opted_out" | "no_consent" | "recent" | "few_visits" | "snoozed";

/** Purposes where the client is choosing it right then: their choice is the consent for this one message. */
const CLIENT_ASKED: readonly ReceiptPurpose[] = ["counter", "handoff", "request"];

export type ConsentResult = { ok: true } | { ok: false; code: "opted_out" | "no_consent"; message: string };

/**
 * Whether a receipt may go to this destination.
 * - An opt-out always wins: a number that replied STOP, or an email that turned receipts off.
 * - The client choosing it at checkout, or asking for a copy, is consent for that message.
 * - Anything else (a refund update, a resend by staff to what's on file) needs the client to have
 *   chosen that destination for this ticket before, or to have agreed to texts or emails from us.
 *   A destination staff type in for a resend counts as the client asking.
 * - A review request isn't a receipt: only agreeing to texts or emails counts, not choosing a receipt.
 */
export function receiptConsent(o: { channel: ReceiptSendChannel; purpose: ReceiptPurpose; optedOut: boolean; optedIn: boolean; chosenForSale: boolean; typed?: boolean }): ConsentResult {
  if (o.optedOut)
    return {
      ok: false,
      code: "opted_out",
      message: o.channel === "sms" ? "That number has turned off texts from us (it replied STOP). Send it by email instead." : "That email has turned off receipt emails from us. Send it by text instead.",
    };
  if (o.purpose === "review") {
    if (o.optedIn) return { ok: true };
    return { ok: false, code: "no_consent", message: o.channel === "sms" ? "The client hasn't agreed to texts." : "The client hasn't agreed to emails." };
  }
  if (CLIENT_ASKED.includes(o.purpose) || o.chosenForSale || o.optedIn || (o.purpose === "resend" && o.typed)) return { ok: true };
  return {
    ok: false,
    code: "no_consent",
    message:
      o.channel === "sms"
        ? "The client hasn't agreed to texts and didn't ask for this receipt by text. Enter the number they give you, or send it to an email they chose."
        : "The client hasn't agreed to emails and didn't ask for this receipt by email. Enter the address they give you, or text it instead.",
  };
}

/** "Visa •••• 4242": brand and last 4 only, never more of the card. */
export function cardLabel(brand: string | null | undefined, last4: string | null | undefined): string {
  const b = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Card";
  const four = last4 && /^\d{4}$/.test(last4) ? last4 : null;
  return four ? `${b} •••• ${four}` : b;
}

export function tenderLabel(p: { method: string; cardBrand?: string | null; cardLast4?: string | null }): string {
  if (p.method === "card") return cardLabel(p.cardBrand, p.cardLast4);
  if (p.method === "gift_card") return "Gift card";
  if (p.method === "cash") return "Cash";
  return p.method.replace("_", " ");
}

/** The barber's first name only: "Taylor R." and "Taylor" both show as "Taylor". */
export function barberFirstName(s: { firstName?: string | null; displayLabel?: string | null } | null | undefined): string | null {
  const n = (s?.firstName ?? s?.displayLabel ?? "").trim().split(/\s+/)[0];
  return n || null;
}

export type ReceiptUpdate = { kind: "refund"; refundedCents: number } | { kind: "void" } | null;

/** The text: short, with the link. Under two SMS segments for any shop name the settings allow. */
export function receiptSms(o: { title: string; number: number; totalCents: number; url: string; update?: ReceiptUpdate }): string {
  const what =
    o.update?.kind === "void"
      ? `ticket #${o.number} was voided and ${formatCents(o.totalCents)} goes back to you`
      : o.update?.kind === "refund"
        ? `${formatCents(o.update.refundedCents)} was refunded on ticket #${o.number}`
        : `${formatCents(o.totalCents)}, ticket #${o.number}`;
  const lead = o.update ? `Updated receipt from ${o.title}: ${what}.` : `Your receipt from ${o.title}: ${what}.`;
  return `${lead} ${o.url} Reply STOP to opt out.`;
}

/** Several receipts in one message, for a client who asked for copies. */
export function receiptListSms(o: { title: string; items: { date: string; totalCents: number; url: string }[] }): string {
  return [`Your receipts from ${o.title}:`, ...o.items.map((i) => `${i.date} ${formatCents(i.totalCents)}: ${i.url}`), "Reply STOP to opt out."].join("\n");
}

export interface ReceiptEmailInput {
  title: string;
  number: number;
  when: string;
  barber: string | null;
  lines: { name: string; qty: number; cents: number; refunded?: boolean }[];
  /** A combined ticket: the same lines by person, each with their barbers. Replaces the flat list. */
  people?: ReceiptPerson[] | null;
  discounts: { label: string; cents: number }[];
  taxCents: number;
  tipCents: number;
  fee: { label: string; cents: number } | null;
  totalCents: number;
  tenders: { label: string; cents: number }[];
  refunds: { label: string; cents: number }[];
  loyalty: string | null;
  footer: string;
  url: string;
  update?: ReceiptUpdate;
}

export interface ReceiptPerson {
  name: string;
  barbers: string[];
  cents: number;
  lines: { id?: string; name: string; qty: number; cents: number; refunded?: boolean; refundedQty?: number; barber?: string | null }[];
}

/** "Leo · with Marcus & Tia": a person's heading on a combined ticket's receipt. */
export const personHeading = (p: Pick<ReceiptPerson, "name" | "barbers">) => `${p.name}${p.barbers.length ? ` · with ${p.barbers.join(" & ")}` : ""}`;

export function receiptEmail(o: ReceiptEmailInput): { subject: string; body: string } {
  const subject = o.update ? `Updated receipt from ${o.title}` : `Your receipt from ${o.title}`;
  const row = (l: string, c: number, neg = false) => `${l}  ${neg ? "-" : ""}${formatCents(c)}`;
  const body = [
    o.title,
    `Ticket #${o.number} · ${o.when}${o.barber ? ` · Barber: ${o.barber}` : ""}`,
    ...(o.update?.kind === "void" ? ["", "This ticket was voided. Everything you paid goes back to how you paid."] : []),
    ...(o.update?.kind === "refund" ? ["", `${formatCents(o.update.refundedCents)} was refunded. Your updated receipt is below.`] : []),
    "",
    ...(o.people?.length
      ? o.people.flatMap((p, i) => [
          ...(i ? [""] : []),
          `${personHeading(p)}  ${formatCents(p.cents)}`,
          ...p.lines.map((l) => `  ${l.name}${l.qty > 1 ? ` × ${l.qty}` : ""}  ${formatCents(l.cents)}${l.refunded ? " (refunded)" : ""}`),
        ])
      : o.lines.map((l) => `${l.name}${l.qty > 1 ? ` × ${l.qty}` : ""}  ${formatCents(l.cents)}${l.refunded ? " (refunded)" : ""}`)),
    ...(o.people?.length ? [""] : []),
    ...o.discounts.map((d) => row(d.label, d.cents, true)),
    row("Tax", o.taxCents),
    row("Tip", o.tipCents),
    ...(o.fee ? [row(o.fee.label, o.fee.cents)] : []),
    row("Total", o.totalCents),
    ...o.tenders.map((t) => row(`Paid with ${t.label}`, t.cents)),
    ...o.refunds.map((r) => row(r.label, r.cents, true)),
    ...(o.refunds.length ? [row("You paid, after refunds", o.totalCents - o.refunds.reduce((a, r) => a + r.cents, 0))] : []),
    ...(o.loyalty ? ["", o.loyalty] : []),
    "",
    `See your receipt or rebook: ${o.url}`,
    "",
    o.footer,
  ];
  return { subject, body: body.join("\n") };
}

export function receiptListEmail(o: { title: string; items: { date: string; number: number; totalCents: number; url: string }[]; footer: string }): { subject: string; body: string } {
  return {
    subject: `Your receipts from ${o.title}`,
    body: [`Here are your recent receipts from ${o.title}.`, "", ...o.items.map((i) => `${i.date} · ticket #${i.number} · ${formatCents(i.totalCents)}\n${i.url}`), "", o.footer].join("\n"),
  };
}

/** A client asking for copies: how many sends per destination per hour, and how many visits back. */
export const REQUEST_LIMIT = { perHour: 3, visits: 3, months: 13 } as const;

export const DEFAULT_RECEIPT_FOOTER = "Thank you! Book again at rayzbarbershop.com";
