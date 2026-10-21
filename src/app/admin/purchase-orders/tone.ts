import type { PoStatus } from "@/domain/inventory";

export const PO_TONE: Record<PoStatus, "gray" | "blue" | "violet" | "amber" | "green" | "red"> = {
  draft: "gray",
  approved: "blue",
  sent: "violet",
  partially_received: "amber",
  received: "green",
  cancelled: "red",
};
