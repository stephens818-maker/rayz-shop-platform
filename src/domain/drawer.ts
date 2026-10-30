/**
 * The cash drawer through one business day: it opens with a counted balance, cash sales go in,
 * cash refunds, tip payouts and paid-outs come out, and at close the count is compared with what
 * should be there. Pure: the server loads the events and this lays out the running balance.
 */

export type DrawerEventKind = "open" | "sale" | "refund" | "tip_payout" | "paid_in" | "paid_out" | "no_sale" | "close";

export const DRAWER_EVENT_LABEL: Record<DrawerEventKind, string> = {
  open: "Opened",
  sale: "Cash sale",
  refund: "Cash refund",
  tip_payout: "Cash tip payout",
  paid_in: "Paid in",
  paid_out: "Paid out",
  no_sale: "Opened, no sale",
  close: "Closed",
};

export interface DrawerEvent {
  kind: DrawerEventKind;
  at: Date;
  /** Always positive; the kind says which way it moves the balance. For "close", what was counted. */
  cents: number;
  label?: string | null;
  by?: string | null;
}

export interface DrawerLine extends DrawerEvent {
  /** What should be in the drawer after this event. */
  balanceCents: number;
  /** On the close line: counted less expected. */
  varianceCents?: number;
}

const SIGN: Record<Exclude<DrawerEventKind, "open" | "close">, 1 | -1 | 0> = { sale: 1, paid_in: 1, refund: -1, tip_payout: -1, paid_out: -1, no_sale: 0 };

/** Events in time order with the running balance. Without an "open" event the drawer starts at `startCents`. */
export function drawerTimeline(events: readonly DrawerEvent[], startCents = 0): DrawerLine[] {
  const order = (k: DrawerEventKind) => (k === "open" ? 0 : k === "close" ? 2 : 1);
  const sorted = [...events].sort((a, b) => order(a.kind) - order(b.kind) || a.at.getTime() - b.at.getTime());
  let balance = startCents;
  return sorted.map((e) => {
    if (e.kind === "open") {
      balance = e.cents;
      return { ...e, balanceCents: balance };
    }
    if (e.kind === "close") return { ...e, balanceCents: balance, varianceCents: e.cents - balance };
    balance += SIGN[e.kind] * e.cents;
    return { ...e, balanceCents: balance };
  });
}

/** Paid-outs less paid-ins: what the moves took out of the drawer. */
export const movesOut = (moves: readonly { kind: "paid_in" | "paid_out" | "no_sale"; amountCents: number }[]) =>
  moves.reduce((a, m) => a + (m.kind === "paid_out" ? m.amountCents : m.kind === "paid_in" ? -m.amountCents : 0), 0);

export function openingProblem(cents: number): string | null {
  if (!Number.isInteger(cents) || cents < 0) return "Enter what's in the drawer";
  if (cents > 500_000) return "That's more than $5,000. Count again";
  return null;
}

export function moveProblem(m: { kind: string; amountCents: number; reason: string }): string | null {
  if (m.kind !== "paid_in" && m.kind !== "paid_out") return "Pick paid in or paid out";
  if (!Number.isInteger(m.amountCents) || m.amountCents <= 0) return "Enter an amount";
  if (m.amountCents > 500_000) return "That's more than $5,000";
  if (m.reason.trim().length < 3) return "Say what it was for";
  return null;
}
