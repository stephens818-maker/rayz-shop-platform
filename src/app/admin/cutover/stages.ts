import type { CutoverStage } from "@/server/cutover";

export const STAGE: Record<CutoverStage, { label: string; tone: "gray" | "amber" | "blue" | "green" | "violet" }> = {
  on_squire: { label: "Books on Squire", tone: "gray" },
  frozen: { label: "Squire frozen, reconciling", tone: "amber" },
  reconciled: { label: "Matched, waiting for sign-off", tone: "blue" },
  signed_off: { label: "Signed off", tone: "blue" },
  live: { label: "Books here", tone: "green" },
  handed_back: { label: "Handed back to Squire", tone: "violet" },
};
