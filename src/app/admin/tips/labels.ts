import type { TipBatchKind, TipBatchStatus, TipPayoutStatus } from "@/db/schema";

export const BATCH_KIND_LABEL: Record<TipBatchKind, string> = {
  end_of_night: "End of night",
  daily_delay: "Daily",
  weekly: "Weekly",
  manual: "Manual",
  payroll: "Payroll",
  opening: "Before tip payouts",
};
export const BATCH_STATUS_TONE = { draft: "amber", approved: "blue", completed: "green", cancelled: "gray" } as const satisfies Record<TipBatchStatus, string>;
export const BATCH_STATUS_LABEL: Record<TipBatchStatus, string> = { draft: "Waiting for approval", approved: "Approved, paying out", completed: "Completed", cancelled: "Cancelled" };
export const PAYOUT_STATUS_TONE = {
  pending: "amber",
  held: "amber",
  approved: "blue",
  processing: "blue",
  paid: "green",
  failed: "red",
  cancelled: "gray",
} as const satisfies Record<TipPayoutStatus, string>;
