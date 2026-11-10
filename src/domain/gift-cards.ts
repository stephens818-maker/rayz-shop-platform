import { z } from "zod";

export const GIFT_CARD_MAX_BALANCE_CENTS = 100_000;

interface CardLike {
  id: string;
  code: string;
  status: string;
  balanceCents: number;
  expiresAt: Date | null;
}

/** Why a card can't take a reload on this ticket, or null. */
export function reloadProblem(g: CardLike | undefined, o: { qty: number; now: Date; payingWith: string | null; amountCents?: number }): string | null {
  if (!g) return "That gift card wasn't found";
  if (g.status !== "active") return `Gift card ${g.code} is ${g.status === "void" ? "voided" : g.status}, so it can't be reloaded`;
  if (g.expiresAt && g.expiresAt < o.now) return `Gift card ${g.code} has expired`;
  if (o.qty !== 1) return "Reload one card per line";
  if (o.payingWith === g.id) return "A card can't pay for its own reload";
  if (o.amountCents != null && g.balanceCents + o.amountCents > GIFT_CARD_MAX_BALANCE_CENTS) return "That would put more than $1,000 on one card";
  return null;
}

export const GiftCardSearch = z.object({
  q: z.string().trim().max(60).optional().default(""),
  status: z.enum(["active", "spent", "void", "all"]).optional().default("active"),
});

const cents = (label: string, max: number) => z.number().int(`${label} must be whole cents`).min(100, `${label} is at least $1`).max(max, `${label} is at most $${max / 100}`);

export const IssueCompInput = z.object({
  shopId: z.uuid(),
  amountCents: cents("The amount", 50_000),
  reason: z.string().trim().min(1, "Add a reason").max(300),
  customerId: z.uuid().nullish(),
});

export const CompReloadInput = z.object({
  id: z.uuid(),
  amountCents: cents("The amount", 50_000),
  reason: z.string().trim().min(1, "Add a reason").max(300),
});

export const VoidInput = z.object({ id: z.uuid(), reason: z.string().trim().min(1, "Add a reason").max(300) });

export const LEDGER_LABEL: Record<string, string> = {
  issue: "Issued",
  reload: "Reloaded",
  comp: "Comp value added",
  redeem: "Spent",
  refund: "Refunded to the card",
  refund_cut: "Taken back by a refund",
  reload_refund: "Reload refunded",
  void: "Voided",
  forfeit: "Deposit kept",
  import: "Imported balance",
  adjust: "Adjusted",
};
export const ledgerLabel = (kind: string) => LEDGER_LABEL[kind] ?? kind.replace(/_/g, " ");
