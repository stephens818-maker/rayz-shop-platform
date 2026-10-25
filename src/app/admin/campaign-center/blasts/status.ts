export type Tone = "gray" | "green" | "blue" | "amber" | "red" | "violet";

export const BLAST_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "gray" },
  scheduled: { label: "Scheduled", tone: "blue" },
  paused: { label: "Paused", tone: "amber" },
  testing: { label: "A/B testing", tone: "violet" },
  sending: { label: "Sending", tone: "amber" },
  sent: { label: "Sent", tone: "green" },
  cancelled: { label: "Cancelled", tone: "red" },
};

/** The list's filters: "Scheduled" includes A/B tests waiting on their winner and blasts sending right now. */
export const STATUS_FILTERS = {
  all: { label: "All", statuses: null },
  scheduled: { label: "Scheduled", statuses: ["scheduled", "testing", "sending"] },
  paused: { label: "Paused", statuses: ["paused"] },
  draft: { label: "Draft", statuses: ["draft"] },
  sent: { label: "Sent", statuses: ["sent"] },
} as const;
export type StatusFilter = keyof typeof STATUS_FILTERS;
