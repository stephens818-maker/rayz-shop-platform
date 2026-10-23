/**
 * Why time is blocked: the brand's list of reasons (Lunch, Break, Bank, Doctor...) that every block
 * and time off entry carries, with a color for the calendar and whether it's private. Pure: the
 * defaults, validation and the rule for what a viewer is shown. The list lives in block_reasons;
 * src/server/block-reasons.ts loads it.
 */

export type ReasonUse = "blocks" | "time_off" | "both";

export interface BlockReason {
  id: string;
  key: string;
  label: string;
  /** #rrggbb */
  color: string;
  usedFor: ReasonUse;
  /** Held to the shop's longest lunch instead of the longest block. */
  countsAsLunch: boolean;
  /** Time off for it can be asked for without the shop's notice (sick time). */
  noticeExempt: boolean;
  /** Staff without "See private reasons" are shown "Blocked" or "Time off" instead, unless it's their own. */
  private: boolean;
  sortOrder: number;
  archived: boolean;
}

export type ReasonSeed = Omit<BlockReason, "id" | "archived">;

export const DEFAULT_BLOCK_REASONS: readonly ReasonSeed[] = [
  { key: "lunch", label: "Lunch", color: "#f59e0b", usedFor: "blocks", countsAsLunch: true, noticeExempt: false, private: false, sortOrder: 10 },
  { key: "break", label: "Break", color: "#14b8a6", usedFor: "blocks", countsAsLunch: false, noticeExempt: false, private: false, sortOrder: 20 },
  { key: "bank", label: "Bank", color: "#6366f1", usedFor: "blocks", countsAsLunch: false, noticeExempt: false, private: false, sortOrder: 30 },
  { key: "doctor", label: "Doctor", color: "#ef4444", usedFor: "both", countsAsLunch: false, noticeExempt: false, private: true, sortOrder: 40 },
  { key: "personal", label: "Personal", color: "#8b5cf6", usedFor: "both", countsAsLunch: false, noticeExempt: false, private: false, sortOrder: 50 },
  { key: "vacation", label: "Vacation", color: "#0ea5e9", usedFor: "time_off", countsAsLunch: false, noticeExempt: false, private: false, sortOrder: 60 },
  { key: "sick", label: "Sick", color: "#f43f5e", usedFor: "both", countsAsLunch: false, noticeExempt: true, private: true, sortOrder: 70 },
  { key: "emergency", label: "Emergency", color: "#ec4899", usedFor: "time_off", countsAsLunch: false, noticeExempt: true, private: true, sortOrder: 75 },
  { key: "training", label: "Training", color: "#22c55e", usedFor: "both", countsAsLunch: false, noticeExempt: false, private: false, sortOrder: 80 },
  { key: "meeting", label: "Meeting", color: "#64748b", usedFor: "blocks", countsAsLunch: false, noticeExempt: false, private: false, sortOrder: 90 },
];

/** Colors offered as swatches; any #rrggbb is accepted. */
export const REASON_COLORS = ["#f59e0b", "#14b8a6", "#6366f1", "#ef4444", "#8b5cf6", "#0ea5e9", "#f43f5e", "#22c55e", "#64748b", "#ec4899", "#84cc16", "#a16207"] as const;
/** Hidden reasons and entries saved before reasons existed. */
export const NEUTRAL_COLOR = "#a1a1aa";
export const PRIVATE_BLOCK_LABEL = "Blocked";
export const PRIVATE_TIME_OFF_LABEL = "Time off";
export const MAX_NOTE = 200;

export const USE_LABEL: Record<ReasonUse, string> = { blocks: "Blocks", time_off: "Time off", both: "Blocks and time off" };

export const isHexColor = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

/** A key for a new reason from its label: "Kid pickup" → "kid_pickup". */
export const slugKey = (label: string) =>
  label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "reason";

export interface ReasonInput {
  label: string;
  color: string;
  usedFor: string;
}

export function reasonProblem(r: ReasonInput): string | null {
  const label = r.label.trim();
  if (!label) return "Name the reason";
  if (label.length > 30) return "Keep the name to 30 characters";
  if (!isHexColor(r.color)) return "Pick a color";
  if (!(r.usedFor in USE_LABEL)) return "Pick blocks, time off or both";
  return null;
}

export const forBlocks = (r: Pick<BlockReason, "usedFor" | "archived">) => !r.archived && r.usedFor !== "time_off";
export const forTimeOff = (r: Pick<BlockReason, "usedFor" | "archived">) => !r.archived && r.usedFor !== "blocks";

/** Light fill for a block in the reason's color, with the solid color on its edge. */
export const tint = (color: string) => `${isHexColor(color) ? color : NEUTRAL_COLOR}33`;

export interface ReasonViewer {
  staffId: string | null;
  /** Holds "See private reasons". */
  seesPrivate: boolean;
}

/** Someone who is shown no private reason: the shop login and anything sent beyond the person asking. */
export const NO_PRIVATE: ReasonViewer = { staffId: null, seesPrivate: false };

export interface ReasonedEntry {
  staffId: string;
  reasonId: string | null;
  /** The label saved with the entry; shown when the reason is gone from the list or the entry predates reasons. */
  reason: string;
  note: string | null;
}

export interface ShownReason {
  reasonId: string | null;
  label: string;
  color: string;
  note: string | null;
  /** The viewer was shown "Blocked" or "Time off" in place of a private reason. */
  hidden: boolean;
}

/**
 * What a viewer is shown of an entry's reason. A private reason is masked for staff without the
 * permission, except on their own entries; masked, nothing of it is left (label, color, note or id).
 */
export function showReason(e: ReasonedEntry, reasons: ReadonlyMap<string, BlockReason>, viewer: ReasonViewer, timeOff = false): ShownReason {
  const r = e.reasonId ? reasons.get(e.reasonId) : undefined;
  const hide = !!r?.private && !viewer.seesPrivate && viewer.staffId !== e.staffId;
  if (hide) return { reasonId: null, label: timeOff ? PRIVATE_TIME_OFF_LABEL : PRIVATE_BLOCK_LABEL, color: NEUTRAL_COLOR, note: null, hidden: true };
  return { reasonId: r?.id ?? null, label: r?.label ?? e.reason, color: r?.color ?? NEUTRAL_COLOR, note: e.note?.trim() || null, hidden: false };
}

/** "Doctor · Dentist at 2" for a tooltip or a list. */
export const reasonText = (s: Pick<ShownReason, "label" | "note">) => (s.note && s.note !== s.label ? `${s.label} · ${s.note}` : s.label);

const TIME_OFF_ENTITIES = new Set(["time_off_request"]);

/** The audit entry about a private reason, as a viewer who can't see it is shown it: "Blocked" or "Time off", no note. */
export function redactReasonDetails(entity: string, details: unknown, viewer: ReasonViewer): unknown {
  if (!details || typeof details !== "object") return details;
  const d = details as Record<string, unknown>;
  if (d.private !== true || viewer.seesPrivate || (viewer.staffId && d.staffId === viewer.staffId)) return details;
  const timeOff = TIME_OFF_ENTITIES.has(entity) || d.category === "time_off";
  return { ...d, reasonId: null, reason: timeOff ? PRIVATE_TIME_OFF_LABEL : PRIVATE_BLOCK_LABEL, note: null };
}
