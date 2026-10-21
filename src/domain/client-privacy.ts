/**
 * Client data protection. Pure: which client fields there are, how visible each is to a person
 * (hidden, masked or full), the brand's built-in defaults per role, how rules from the brand portal
 * are resolved, and how a value is masked. The server loads the rules and applies them before
 * anything is rendered or sent, so a hidden value never reaches the browser.
 */
import { OWNER_ROLE_KEY, type RoleTemplateKey } from "./permissions";

export const LEVELS = ["hidden", "masked", "full"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<Level, string> = { hidden: "Hidden", masked: "Masked", full: "Full" };
export const isLevel = (v: unknown): v is Level => typeof v === "string" && (LEVELS as readonly string[]).includes(v);

export const BUILTIN_FIELDS = [
  { key: "phone", label: "Phone", revealable: true, example: "***-***-4321" },
  { key: "email", label: "Email", revealable: true, example: "j***@gmail.com" },
  { key: "address", label: "Address", revealable: true, example: "***, Moline, IL 61265" },
  { key: "birthday", label: "Birthday", revealable: true, example: "Jul **" },
  { key: "notes", label: "Client notes", revealable: true, example: "On file" },
  { key: "preferred_barber", label: "Preferred barber", revealable: true, example: "T***" },
  { key: "ratings", label: "Ratings", revealable: false, example: "Average only" },
] as const;
export type BuiltinField = (typeof BUILTIN_FIELDS)[number]["key"];
/** A brand-defined field, by its id. */
export type CustomField = `custom:${string}`;
export type FieldKey = BuiltinField | CustomField;

const BUILTIN = new Set<string>(BUILTIN_FIELDS.map((f) => f.key));
export const isBuiltinField = (f: string): f is BuiltinField => BUILTIN.has(f);
export const customFieldKey = (id: string): CustomField => `custom:${id}`;
export const customFieldId = (f: FieldKey) => (f.startsWith("custom:") ? f.slice(7) : null);
export const isRevealable = (f: FieldKey) => !isBuiltinField(f) || BUILTIN_FIELDS.find((b) => b.key === f)!.revealable;

export function fieldLabel(f: FieldKey, custom: readonly { id: string; label: string }[] = []): string {
  const b = BUILTIN_FIELDS.find((x) => x.key === f);
  if (b) return b.label;
  return custom.find((c) => c.id === customFieldId(f))?.label ?? "Custom field";
}

/** What "masked" means for ratings: the average stars, no individual ratings or notes. */
export const RATINGS_MASKED_HINT = "Average stars only, no individual ratings or notes";

// ───────────────────────────── Built-in brand defaults ─────────────────────────────

type Defaults = Record<BuiltinField | "custom", Level>;
const FULL: Defaults = { phone: "full", email: "full", address: "full", birthday: "full", notes: "full", preferred_barber: "full", ratings: "full", custom: "full" };
const MANAGER: Defaults = { ...FULL, phone: "masked", email: "masked", address: "masked" };

/**
 * Brand defaults for each built-in role, used wherever the brand portal has no rule. Managers see
 * contact details masked and can reveal them with a reason; barbers never see contact details in
 * full. Calls and texts go through the shop line instead.
 */
export const ROLE_FIELD_DEFAULTS: Record<RoleTemplateKey, Defaults> = {
  brand_owner: FULL,
  brand_admin: FULL,
  regional_manager: MANAGER,
  shop_manager: MANAGER,
  front_desk: { ...FULL, phone: "masked", email: "masked", address: "hidden", birthday: "masked", custom: "masked" },
  barber: { ...FULL, phone: "masked", email: "hidden", address: "hidden", birthday: "masked", custom: "hidden" },
};
/** Custom roles start as locked down as a barber's contact details, with masked email. */
export const CUSTOM_ROLE_DEFAULTS: Defaults = { ...ROLE_FIELD_DEFAULTS.barber, email: "masked" };

export function defaultLevel(roleKey: string | null, field: FieldKey): Level {
  const d = (roleKey && ROLE_FIELD_DEFAULTS[roleKey as RoleTemplateKey]) || CUSTOM_ROLE_DEFAULTS;
  return isBuiltinField(field) ? d[field] : d.custom;
}

// ───────────────────────────── Rules ─────────────────────────────

/** A rule from the brand portal: for one role or one person, brand-wide (shopId null) or at one shop. */
export interface FieldRule {
  field: string;
  level: Level;
  roleId: string | null;
  staffId: string | null;
  shopId: string | null;
}

const RANK: Record<Level, number> = { hidden: 0, masked: 1, full: 2 };
export const minLevel = (...ls: Level[]): Level => ls.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), "full" as Level);
export const atLeast = (l: Level, want: Level) => RANK[l] >= RANK[want];

/**
 * How visible a field is to a person working at a shop (null: brand-wide, not in any one shop).
 * The most specific rule wins: theirs at this shop, theirs brand-wide, their role's at this shop,
 * their role's brand-wide, then the built-in default. The Brand Owner always sees everything.
 */
export function resolveLevel(rules: readonly FieldRule[], who: { staffId: string; roleId: string; roleKey: string | null }, shopId: string | null, field: FieldKey): Level {
  if (who.roleKey === OWNER_ROLE_KEY) return "full";
  const mine = rules.filter((r) => r.field === field);
  const pick = (p: (r: FieldRule) => boolean) => mine.find(p)?.level;
  return (
    (shopId ? pick((r) => r.staffId === who.staffId && r.shopId === shopId) : undefined) ??
    pick((r) => r.staffId === who.staffId && r.shopId === null) ??
    (shopId ? pick((r) => r.roleId === who.roleId && r.staffId === null && r.shopId === shopId) : undefined) ??
    pick((r) => r.roleId === who.roleId && r.staffId === null && r.shopId === null) ??
    defaultLevel(who.roleKey, field)
  );
}

/**
 * Who may change a rule. Nobody changes what they see themselves (their own rules or their role's)
 * unless they're the Brand Owner, the Brand Owner's role is always full, and nobody sets a level
 * above what they see themselves.
 */
export function fieldRuleChangeDenied(
  caller: { staffId: string; roleId: string; isOwner: boolean; levelAt: (shopId: string | null, field: FieldKey) => Level },
  rule: { field: FieldKey; roleId: string | null; roleKey: string | null; staffId: string | null; shopId: string | null; level: Level | null },
): string | null {
  if (!!rule.roleId === !!rule.staffId) return "Pick a role or a person";
  if (rule.roleKey === OWNER_ROLE_KEY) return "The Brand Owner always sees every client detail";
  if (caller.isOwner) return null;
  if (rule.staffId === caller.staffId || rule.roleId === caller.roleId) return "You can't change what you see yourself. Ask the Brand Owner.";
  if (rule.level && !atLeast(caller.levelAt(rule.shopId, rule.field), rule.level)) return "You can't give anyone more than you see yourself";
  return null;
}

// ───────────────────────────── Masking ─────────────────────────────

/** +13195551234 → ***-***-1234 */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const d = e164.replace(/\D/g, "");
  return d.length >= 4 ? `***-***-${d.slice(-4)}` : "***-***-****";
}

/** jordan@gmail.com → j***@gmail.com */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** "1701 2nd Street, Moline, IL 61265" → "***, Moline, IL 61265": the town, not the house. */
export function maskAddress(address: string | null | undefined): string | null {
  if (!address?.trim()) return null;
  const parts = address.split(",");
  return parts.length > 1 ? ["***", ...parts.slice(1).map((p) => p.trim())].join(", ") : "***";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 1988-07-14 → "Jul **": the month for a birthday offer, without the day or year. */
export function maskBirthday(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(iso);
  return m ? `${MONTHS[Number(m[1]) - 1] ?? "***"} **` : "***";
}

export function formatBirthday(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
}

/** Free text: the first letter and that there is something on file. */
export function maskText(v: string | null | undefined): string | null {
  const t = v?.trim();
  if (!t) return null;
  return `${t[0]}***`;
}

export function maskValue(field: FieldKey, raw: string | null | undefined): string | null {
  switch (field) {
    case "phone":
      return maskPhone(raw);
    case "email":
      return maskEmail(raw);
    case "address":
      return maskAddress(raw);
    case "birthday":
      return maskBirthday(raw);
    case "notes":
      return raw?.trim() ? "On file" : null;
    default:
      return maskText(raw);
  }
}

// ───────────────────────────── Lookup limits ─────────────────────────────

export interface LookupLimits {
  windowMinutes: number;
  /** Different client profiles opened (or revealed) in the window before admins are alerted. */
  alertProfiles: number;
  /** ...and before lookups are paused. */
  blockProfiles: number;
  /** Client searches and list pages in the window before admins are alerted. */
  alertSearches: number;
  blockSearches: number;
}

export const DEFAULT_LIMITS: LookupLimits = { windowMinutes: 10, alertProfiles: 25, blockProfiles: 50, alertSearches: 150, blockSearches: 300 };

export function cleanLimits(raw: unknown): LookupLimits {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: keyof LookupLimits, max: number) => {
    const v = r[k];
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : DEFAULT_LIMITS[k];
  };
  const out = {
    windowMinutes: n("windowMinutes", 1440),
    alertProfiles: n("alertProfiles", 10_000),
    blockProfiles: n("blockProfiles", 10_000),
    alertSearches: n("alertSearches", 100_000),
    blockSearches: n("blockSearches", 100_000),
  };
  if (out.blockProfiles < out.alertProfiles) out.blockProfiles = out.alertProfiles;
  if (out.blockSearches < out.alertSearches) out.blockSearches = out.alertSearches;
  return out;
}

export const ACCESS_KINDS = {
  view: "Opened profile",
  search: "Searched clients",
  list: "Browsed client list",
  reveal: "Revealed",
  export: "Exported",
  contact: "Contacted",
  blocked: "Paused",
} as const;
export type AccessKind = keyof typeof ACCESS_KINDS;
