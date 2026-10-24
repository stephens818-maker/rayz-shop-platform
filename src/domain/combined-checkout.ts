/**
 * Combined checkout: one ticket for several people (a family, a booking group, or walk-in siblings
 * combined at the counter), itemized by person and barber, paid with one tender or split across
 * several, with the tip split per barber.
 */

import { CardFeeConfig, CardFunding, cardFeeFor } from "./checkout";

// ───────────────────────────── Split payment ─────────────────────────────

export const MAX_SPLIT_TENDERS = 6;
export const PAYER_LABEL_MAX = 40;

export interface SplitTenderIn {
  key: string;
  method: "cash" | "card";
  /** What this tender pays of the ticket before any card surcharge, its share of the tip included. */
  amountCents: number;
  /** Card tenders: from the processor. Only credit carries the surcharge. */
  funding?: CardFunding | null;
}

export interface SplitTenderPart {
  key: string;
  method: "cash" | "card";
  baseCents: number;
  tipCents: number;
  feeCents: number;
  /** What the surcharge rate was applied to; 0 without one. */
  feeBasisCents: number;
  /** baseCents + feeCents: what's charged to the card, or taken in cash. */
  chargeCents: number;
}

export interface SplitTenderPlan {
  parts: SplitTenderPart[];
  cardFeeCents: number;
  cardFeeBaseCents: number;
  chargeCents: number;
}

/** Why these tenders can't pay `dueCents` (the ticket less any gift card, before surcharges), or null. */
export function splitTenderProblem(dueCents: number, tenders: readonly SplitTenderIn[]): string | null {
  if (tenders.length < 2) return "Split payment needs at least two payments";
  if (tenders.length > MAX_SPLIT_TENDERS) return `Up to ${MAX_SPLIT_TENDERS} payments on one ticket`;
  if (tenders.some((t) => !Number.isInteger(t.amountCents) || t.amountCents <= 0)) return "Each payment must be more than $0, in whole cents";
  if (new Set(tenders.map((t) => t.key)).size !== tenders.length) return "Each payment must be different";
  const sum = tenders.reduce((a, t) => a + t.amountCents, 0);
  if (sum !== dueCents) {
    const diff = dueCents - sum;
    return diff > 0 ? `The payments are ${cents(diff)} short of the ${cents(dueCents)} due` : `The payments are ${cents(-diff)} over the ${cents(dueCents)} due`;
  }
  return null;
}

/**
 * How a split payment carries the tip and the surcharge. The tip goes on as few payments as it can,
 * largest first, so a per-barber tip stays exact (each payment's tip is split by the same weights).
 * Each credit card carries the surcharge on its own part, as it would paying alone.
 */
export function planSplitTenders(o: { tipCents: number; cardFee: CardFeeConfig; tenders: readonly SplitTenderIn[] }): SplitTenderPlan {
  let tipLeft = Math.max(0, o.tipCents);
  const tipOf = new Map<string, number>();
  const order = o.tenders.map((t, i) => ({ t, i })).sort((a, b) => b.t.amountCents - a.t.amountCents || a.i - b.i);
  for (const { t } of order) {
    const take = Math.min(tipLeft, t.amountCents);
    tipOf.set(t.key, take);
    tipLeft -= take;
  }
  const parts = o.tenders.map((t): SplitTenderPart => {
    const tipCents = tipOf.get(t.key) ?? 0;
    const fee = t.method === "card" ? cardFeeFor(o.cardFee, t.funding ?? null, { chargeCents: t.amountCents, tipCents }) : null;
    const feeCents = fee?.feeCents ?? 0;
    return { key: t.key, method: t.method, baseCents: t.amountCents, tipCents, feeCents, feeBasisCents: fee?.reason === "applies" ? fee.basisCents : 0, chargeCents: t.amountCents + feeCents };
  });
  const sum = (f: (p: SplitTenderPart) => number) => parts.reduce((a, p) => a + f(p), 0);
  return { parts, cardFeeCents: sum((p) => p.feeCents), cardFeeBaseCents: sum((p) => p.feeBasisCents), chargeCents: sum((p) => p.chargeCents) };
}

/** Evenly by number of payers, the remainder on the first ones: the "split evenly" button. */
export function evenSplit(dueCents: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(dueCents / n);
  return Array.from({ length: n }, (_, i) => base + (i < dueCents - base * n ? 1 : 0));
}

/** A typed payer name, tidied: no control characters, no digits runs that could be a card number, at most 40 characters. */
export function cleanPayerLabel(raw: string | null | undefined): string | null {
  const s = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\d[\d\s-]{6,}\d/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PAYER_LABEL_MAX)
    .trim();
  return s || null;
}

// ───────────────────────────── Per-barber tips ─────────────────────────────

export interface StaffTip {
  staffId: string;
  cents: number;
}

/** A tip typed per barber: every barber is on the ticket's services, no one twice, whole cents adding up to the tip. */
export function perBarberTipProblem(byStaff: readonly StaffTip[], barbers: readonly string[], tipCents: number): string | null {
  if (!barbers.length) return "Tips per barber need the barbers on the services";
  const seen = new Set<string>();
  for (const t of byStaff) {
    if (!barbers.includes(t.staffId)) return "A tip is for a barber who isn't on this ticket";
    if (seen.has(t.staffId)) return "Each barber's tip once";
    seen.add(t.staffId);
    if (!Number.isInteger(t.cents) || t.cents < 0) return "Tips must be $0 or more, in whole cents";
  }
  const sum = byStaff.reduce((a, t) => a + t.cents, 0);
  if (sum !== tipCents) return `The barbers' tips add up to ${cents(sum)}, not the ${cents(tipCents)} tip`;
  return null;
}

// ───────────────────────────── Itemized by person ─────────────────────────────

export interface TicketPerson {
  appointmentId: string;
  name: string;
}

export interface PersonGroup<L> {
  /** Null: lines that aren't anyone's visit (retail, gift cards). */
  appointmentId: string | null;
  name: string;
  barbers: { staffId: string | null; lines: L[] }[];
  lines: L[];
}

/**
 * A combined ticket's lines by person, then by barber, people in ticket order. Service lines not tagged
 * to anyone are the ticket's own appointment's; retail and gift cards come last on their own.
 */
export function groupByPerson<L extends { kind: string; appointmentId?: string | null; staffId?: string | null }>(
  lines: readonly L[],
  people: readonly TicketPerson[],
  o: { leadAppointmentId: string | null; otherLabel?: string } = { leadAppointmentId: null },
): PersonGroup<L>[] {
  const known = new Set(people.map((p) => p.appointmentId));
  const whose = (l: L): string | null => {
    if (l.appointmentId && known.has(l.appointmentId)) return l.appointmentId;
    if (l.kind === "service" || l.kind === "addon") return o.leadAppointmentId && known.has(o.leadAppointmentId) ? o.leadAppointmentId : null;
    return null;
  };
  const out: PersonGroup<L>[] = [];
  const add = (appointmentId: string | null, name: string) => {
    const mine = lines.filter((l) => whose(l) === appointmentId);
    if (!mine.length) return;
    const barbers: PersonGroup<L>["barbers"] = [];
    for (const l of mine) {
      const s = l.staffId ?? null;
      const b = barbers.find((x) => x.staffId === s);
      if (b) b.lines.push(l);
      else barbers.push({ staffId: s, lines: [l] });
    }
    out.push({ appointmentId, name, barbers, lines: mine });
  };
  for (const p of people) add(p.appointmentId, p.name);
  add(null, o.otherLabel ?? "Retail and other");
  return out;
}

// ───────────────────────────── Combining tickets ─────────────────────────────

export interface MergeTicket {
  id: string;
  shopId: string;
  status: string;
  payments: number;
  withClient: boolean;
}

/** Why `sources` can't be combined into `target`, or null. Any open tickets at the shop can, family or not. */
export function mergeProblem(target: MergeTicket, sources: readonly MergeTicket[]): string | null {
  if (!sources.length) return "Pick a ticket to combine";
  for (const t of [target, ...sources]) {
    if (t.status !== "open") return "Only open tickets can be combined";
    if (t.payments > 0) return "A ticket that has taken a payment can't be combined";
    if (t.withClient) return "A ticket is with the client on the customer screen. Take it back first.";
  }
  if (sources.some((s) => s.id === target.id)) return "A ticket can't be combined with itself";
  if (new Set(sources.map((s) => s.id)).size !== sources.length) return "Each ticket once";
  if (sources.some((s) => s.shopId !== target.shopId)) return "Tickets at different shops can't be combined";
  return null;
}

/** "2 of 3 ready": of the people on a ticket, how many their barber has sent to checkout. */
export function readiness(people: readonly { readyAt: Date | string | null }[]): { ready: number; total: number; all: boolean } {
  const ready = people.filter((p) => !!p.readyAt).length;
  return { ready, total: people.length, all: people.length > 0 && ready === people.length };
}

const cents = (c: number) => `$${(c / 100).toFixed(2)}`;
