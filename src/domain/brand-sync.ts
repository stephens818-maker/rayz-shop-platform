/**
 * Brand change scope. Every brand-controlled setting a shop uses resolves to the shop's own value
 * when it has one (overridden), else the brand's. When a brand admin changes the brand value they
 * choose where it goes: every shop, selected shops, or the brand only for now. Shops it doesn't go
 * to keep what they had and show out of sync until it's pushed. A shop with its own value keeps it
 * unless the admin replaces it. Each sync records every shop's before and after, so it can be
 * undone as one batch.
 *
 * A setting is "<type>:<item>": one service, one product, one location default, or the single
 * item of a setting like the card fee ("card_fee:brand").
 */

export const SYNC_AREAS = [
  { id: "services", label: "Services & prices" },
  { id: "products", label: "Products & retail prices" },
  { id: "card_fee", label: "Card fee" },
  { id: "checkout_prompts", label: "Checkout prompts" },
  { id: "milestones", label: "Milestones & celebrations" },
  { id: "loyalty", label: "Loyalty rules" },
  { id: "policies", label: "Booking & cancellation policies" },
  { id: "hours", label: "Hours template" },
  { id: "campaign_templates", label: "Campaign Center templates" },
  { id: "taxes", label: "Taxes" },
  { id: "tips", label: "Tip presets" },
  { id: "roles", label: "Roles & permissions" },
  { id: "branding", label: "Receipt & branding" },
  { id: "app", label: "App config" },
  { id: "team", label: "Time off, blocks & time clock" },
  { id: "payroll", label: "Payroll, pay & tip payouts" },
  { id: "messages", label: "Client messages & outreach" },
  { id: "marketing", label: "Campaign Center settings" },
  { id: "clients", label: "Clients, privacy & badges" },
  { id: "lists", label: "Pick lists & brand lists" },
  { id: "security", label: "Sign-in & security" },
  { id: "features", label: "Features on/off" },
  { id: "inventory", label: "Inventory & purchasing" },
  { id: "reports", label: "Reports & Morning Dashboard" },
] as const;
export type SyncArea = (typeof SYNC_AREAS)[number]["id"];
export const AREA_LABEL = Object.fromEntries(
  SYNC_AREAS.map((a) => [a.id, a.label]),
) as Record<SyncArea, string>;
export const isSyncArea = (s: string): s is SyncArea => s in AREA_LABEL;

export const SYNC_TYPES = [
  "service",
  "product",
  "card_fee",
  "checkout_prompts",
  "milestones",
  "loyalty",
  "location_default",
  "hours",
  "campaign_template",
  "taxes",
  "tips",
  "role",
  "receipt",
  "app",
  "setting",
  "list",
  "service_rule",
] as const;
export type SyncType = (typeof SYNC_TYPES)[number];
export const isSyncType = (s: string): s is SyncType =>
  (SYNC_TYPES as readonly string[]).includes(s);

export const syncKey = (type: SyncType, item: string) => `${type}:${item}`;
export function parseSyncKey(
  key: string,
): { type: SyncType; item: string } | null {
  const i = key.indexOf(":");
  if (i < 1) return null;
  const type = key.slice(0, i);
  const item = key.slice(i + 1);
  return isSyncType(type) && item ? { type, item } : null;
}

export type SyncMode = "inherit" | "override";
export type CellStatus = "in_sync" | "overridden" | "out_of_sync";
export type ShownStatus = CellStatus | "pending";
export const STATUS_LABEL: Record<ShownStatus, string> = {
  in_sync: "In sync",
  overridden: "Overridden",
  out_of_sync: "Out of sync",
  pending: "Pending",
};

/** A shop's value of one setting as stored, and whether it's read from the brand at run time (nothing of its own stored). */
export interface Native<V = unknown> {
  value: V;
  follows: boolean;
}

/** One shop's state of one setting, as a sync change records it before and after. */
export interface CellState<V = unknown> extends Native<V> {
  mode: SyncMode;
}

/** JSON with sorted keys, so two values compare equal whatever order their keys were written in. */
export function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}
export const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** A shop without a recorded mode follows the brand when it reads the brand's value or has the same; otherwise it's its own. */
export const modeOf = (
  stored: SyncMode | null | undefined,
  n: Native,
  brand: unknown,
): SyncMode =>
  stored ?? (n.follows || same(n.value, brand) ? "inherit" : "override");

export const statusOf = (
  mode: SyncMode,
  n: Native,
  brand: unknown,
): CellStatus =>
  mode === "override"
    ? "overridden"
    : same(n.value, brand)
      ? "in_sync"
      : "out_of_sync";

export const SYNC_SCOPES = ["all", "selected", "brand_only"] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];
export const SCOPE_LABEL: Record<SyncScope, string> = {
  all: "All shops",
  selected: "Selected shops",
  brand_only: "Brand only",
};
export const SCOPE_HINT: Record<SyncScope, string> = {
  all: "Every shop gets the new value now",
  selected: "Only the shops you tick",
  brand_only: "Save it to the brand; don't push it to any shop yet",
};

export type OverrideChoice = "keep" | "replace";
export type CellAction =
  "push" | "replace" | "keep" | "freeze" | "reset" | "restore";
export const ACTION_LABEL: Record<CellAction, string> = {
  push: "Pushed",
  replace: "Override replaced",
  keep: "Kept its own",
  freeze: "Held at the old value",
  reset: "Reset to brand",
  restore: "Restored",
};

export function targetShops(
  scope: SyncScope,
  picked: readonly string[],
  all: readonly string[],
): Set<string> {
  if (scope === "all") return new Set(all);
  if (scope === "brand_only") return new Set();
  const want = new Set(picked);
  return new Set(all.filter((id) => want.has(id)));
}

export interface CellPlan {
  action: CellAction | null;
  /** follow: take the brand value (read live, or copied in); hold: keep the current value as the shop's own stored value. */
  write: "follow" | "hold" | null;
  mode: SyncMode;
}

/**
 * What a brand change does to one shop's setting. A shop it goes to takes the brand value, unless
 * it has its own and the admin keeps that. A shop it doesn't go to keeps what it has; where that's
 * read from the brand at run time (`live` and following) the current value is stored for it first.
 */
export function planCell(o: {
  mode: SyncMode;
  follows: boolean;
  live: boolean;
  targeted: boolean;
  choice?: OverrideChoice;
}): CellPlan {
  const hold = o.live && o.follows;
  if (o.targeted && o.mode === "override" && o.choice !== "replace")
    return {
      action: hold ? "keep" : null,
      write: hold ? "hold" : null,
      mode: "override",
    };
  if (o.targeted)
    return {
      action: o.mode === "override" ? "replace" : "push",
      write: "follow",
      mode: "inherit",
    };
  return {
    action: hold ? "freeze" : null,
    write: hold ? "hold" : null,
    mode: o.mode,
  };
}

export const BULK_ACTIONS = ["push", "reset"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const BULK_LABEL: Record<BulkAction, string> = {
  push: "Push brand value",
  reset: "Reset to brand",
};
export const BULK_HINT: Record<BulkAction, string> = {
  push: "Shops that follow the brand get its current value. Overridden shops keep theirs.",
  reset: "Every selected shop drops its own value and follows the brand.",
};

/** A Sync status bulk action on one cell: push skips overrides; reset puts every cell back on the brand. Null: nothing to do. */
export function bulkCell(
  action: BulkAction,
  o: { mode: SyncMode; status: CellStatus; follows: boolean; live: boolean },
): CellPlan | null {
  if (action === "push" && o.mode === "override") return null;
  const settled =
    o.status === "in_sync" && o.mode === "inherit" && (o.follows || !o.live);
  if (settled) return null;
  return {
    action: action === "push" ? "push" : "reset",
    write: "follow",
    mode: "inherit",
  };
}

/** A rollback only goes through where nothing changed since: the brand and each shop are as the sync left them. */
export const unchangedSince = (now: Native, after: Native) =>
  now.follows === after.follows && same(now.value, after.value);

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

/** The fields that differ between two descriptions of a value (field label to display text). */
export function fieldChanges(
  a: Record<string, string> | null,
  b: Record<string, string> | null,
): FieldChange[] {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  return keys
    .filter((k) => (a?.[k] ?? "—") !== (b?.[k] ?? "—"))
    .map((k) => ({ field: k, from: a?.[k] ?? "—", to: b?.[k] ?? "—" }));
}

/** When a scheduled sync may run: in the future, within a year. */
export function scheduleProblem(runAt: Date, now = new Date()): string | null {
  if (Number.isNaN(runAt.getTime())) return "Pick a date and time";
  if (runAt.getTime() <= now.getTime() + 60_000)
    return "Pick a time at least a minute from now";
  if (runAt.getTime() > now.getTime() + 366 * 86_400_000)
    return "Pick a time within the next year";
  return null;
}

export const money = (c: number | null | undefined) =>
  c == null ? "—" : `$${(c / 100).toFixed(2)}`;
export const pct = (r: number | null | undefined, digits = 2) =>
  r == null ? "—" : `${Number((r * 100).toFixed(digits))}%`;
export const onOff = (b: boolean | null | undefined) =>
  b == null ? "—" : b ? "On" : "Off";
export const clip = (s: string | null | undefined, n = 48) =>
  !s ? "—" : s.length > n ? `${s.slice(0, n - 1)}…` : s;

export function scopeSummary(
  scope: SyncScope,
  n: number,
  total: number,
): string {
  if (scope === "brand_only") return "Brand only";
  if (scope === "all" || n === total)
    return `All ${total} shop${total === 1 ? "" : "s"}`;
  return `${n} of ${total} shop${total === 1 ? "" : "s"}`;
}
