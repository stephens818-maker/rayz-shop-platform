import { z } from "zod";

/** Only deposits that left Stripe can be on a bank statement. */
export const RECONCILABLE_STATUSES = ["paid", "in_transit"] as const;
export const isReconcilable = (status: string) => (RECONCILABLE_STATUSES as readonly string[]).includes(status);

export const ReconcileInput = z.object({
  payoutId: z.uuid(),
  bankReference: z
    .string()
    .trim()
    .max(60, "Keep the bank reference to 60 characters")
    .optional()
    .transform((s) => s || null),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((s) => s || null),
});

export interface Reconciliation {
  payoutId: string;
  bankReference: string | null;
  note: string | null;
  reconciledAt: Date;
  reconciledByName: string | null;
}

/** What an account took in but Stripe hasn't paid out or started paying out yet, never below zero. */
export const notYetPaidOut = (netCents: number, paidCents: number, transitCents: number) => Math.max(0, netCents - paidCents - transitCents);

/** Deposits that reached or are heading to a bank and nobody has matched to the statement yet. */
export function unmatched<T extends { id: string; status: string; amountCents: number }>(payouts: readonly T[], matched: ReadonlyMap<string, unknown>) {
  const rows = payouts.filter((p) => isReconcilable(p.status) && !matched.has(p.id));
  return { rows, count: rows.length, cents: rows.reduce((a, p) => a + p.amountCents, 0) };
}
