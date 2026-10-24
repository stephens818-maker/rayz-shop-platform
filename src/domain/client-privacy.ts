/**
 * Client data protection. Pure: which client fields there are, how visible each is to a person
 * (hidden, masked or full), the brand's built-in defaults per role, how rules from the brand portal
 * are resolved, and how a value is masked. The server loads the rules and applies them before
 * anything is rendered or sent, so a hidden value never reaches the browser.
 */
import { BRAND_ADMIN_ROLE_KEY, OWNER_ROLE_KEY, type RoleTemplateKey } from "./permissions";

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
  { key: "photo", label: "Photo", revealable: false, example: "Photo on file" },
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
const FULL: Defaults = { phone: "full", email: "full", address: "full", birthday: "full", notes: "full", preferred_barber: "full", ratings: "full", photo: "full", custom: "full" };
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
  shop_login: { ...FULL, phone: "masked", email: "masked", address: "hidden", birthday: "masked", custom: "masked" },
  barber: { ...FULL, phone: "masked", email: "hidden", address: "hidden", birthday: "masked", custom: "hidden" },
};

/** Contact details a shared shop login sees at most, whatever its role's rules say. */
export const SHOP_LOGIN_CONTACT_FIELDS = ["phone", "email", "address", "birthday"] as const satisfies readonly BuiltinField[];
export const SHOP_LOGIN_CAPS = ["masked", "hidden", "role"] as const;
export type ShopLoginCap = (typeof SHOP_LOGIN_CAPS)[number];
export const SHOP_LOGIN_CAP_LABEL: Record<ShopLoginCap, string> = {
  masked: "Masked at most (recommended)",
  hidden: "Hidden",
  role: "As the login's role allows",
};
export const isShopLoginCap = (v: unknown): v is ShopLoginCap => typeof v === "string" && (SHOP_LOGIN_CAPS as readonly string[]).includes(v);
export const cleanShopLoginCap = (v: unknown): ShopLoginCap => (isShopLoginCap(v) ? v : "masked");

/** A shop login's level for a field: its role's level, capped for contact details. */
export function shopLoginLevel(cap: ShopLoginCap, field: FieldKey, level: Level): Level {
  if (cap === "role" || !(SHOP_LOGIN_CONTACT_FIELDS as readonly string[]).includes(field)) return level;
  return minLevel(level, cap);
}
/** Custom roles start as locked down as a barber's contact details, with masked email. */
export const CUSTOM_ROLE_DEFAULTS: Defaults = { ...ROLE_FIELD_DEFAULTS.barber, email: "masked" };

export function defaultLevel(roleKey: string | null, field: FieldKey): Level {
  const d = (roleKey && ROLE_FIELD_DEFAULTS[roleKey as RoleTemplateKey]) || CUSTOM_ROLE_DEFAULTS;
  return isBuiltinField(field) ? d[field] : d.custom;
}

// ───────────────────────────── Entry: adding and editing ─────────────────────────────

/**
 * Entering client details is set apart from seeing them: "add" fills in a field that's empty (a new
 * client, a booking, a walk-in, checkout), "edit" replaces or clears one that's on file. Someone
 * may be allowed to enter a detail they can't see; once saved it shows at their view level.
 */
export const SETTINGS = ["view", "add", "edit"] as const;
export type Setting = (typeof SETTINGS)[number];
export type EntrySetting = Exclude<Setting, "view">;
export const SETTING_LABEL: Record<Setting, string> = { view: "Can view", add: "Can add", edit: "Can edit" };
export const ENTRY = ["allow", "deny"] as const;
export type Entry = (typeof ENTRY)[number];
export const ENTRY_LABEL: Record<Entry, string> = { allow: "Yes", deny: "No" };
export const isEntry = (v: unknown): v is Entry => v === "allow" || v === "deny";
export const RULE_VALUE_LABEL: Record<Level | Entry, string> = { ...LEVEL_LABEL, ...ENTRY_LABEL };
export const ruleValues = (setting: Setting): readonly (Level | Entry)[] => (setting === "view" ? LEVELS : ENTRY);
export const isSetting = (v: unknown): v is Setting => typeof v === "string" && (SETTINGS as readonly string[]).includes(v);

/** Ratings come from the rating tools, not from client forms. */
export const isEntryField = (f: FieldKey) => f !== "ratings";

type EntryDefaults = Record<EntrySetting, Record<BuiltinField | "custom", boolean>>;
const ANY: Record<BuiltinField | "custom", boolean> = {
  phone: true,
  email: true,
  address: true,
  birthday: true,
  notes: true,
  preferred_barber: true,
  ratings: false,
  photo: true,
  custom: true,
};
const NOTES_ONLY: Record<BuiltinField | "custom", boolean> = { ...ANY, phone: false, email: false, address: false, birthday: false, preferred_barber: false, photo: false, custom: false };
const DESK: EntryDefaults = { add: ANY, edit: ANY };

/**
 * Everyone can take down a client's details where their job has them do it. Replacing what's on
 * file is for the desk and managers; barbers can rewrite the cut notes but not contact details.
 */
export const ROLE_ENTRY_DEFAULTS: Record<RoleTemplateKey, EntryDefaults> = {
  brand_owner: DESK,
  brand_admin: DESK,
  regional_manager: DESK,
  shop_manager: DESK,
  front_desk: DESK,
  // A shared login can take down new details but not replace the phone or email a client signs in with.
  shop_login: { add: ANY, edit: { ...ANY, phone: false, email: false } },
  barber: { add: ANY, edit: NOTES_ONLY },
};
export const CUSTOM_ROLE_ENTRY_DEFAULTS: EntryDefaults = ROLE_ENTRY_DEFAULTS.barber;

export function defaultEntry(roleKey: string | null, field: FieldKey, setting: EntrySetting): boolean {
  if (!isEntryField(field)) return false;
  const d = ((roleKey && ROLE_ENTRY_DEFAULTS[roleKey as RoleTemplateKey]) || CUSTOM_ROLE_ENTRY_DEFAULTS)[setting];
  return isBuiltinField(field) ? d[field] : d.custom;
}

// ───────────────────────────── Rules ─────────────────────────────

/**
 * A rule from the brand portal: for one role or one person, brand-wide (shopId null) or at one shop.
 * A view rule holds a level; an add or edit rule holds allow or deny.
 */
export interface FieldRule {
  field: string;
  /** Missing means view. */
  setting?: Setting;
  level: string;
  roleId: string | null;
  staffId: string | null;
  shopId: string | null;
}

export const ruleSetting = (r: Pick<FieldRule, "setting">): Setting => r.setting ?? "view";
export const validRule = (r: FieldRule) => (ruleSetting(r) === "view" ? isLevel(r.level) : isEntry(r.level));

type Who = { staffId: string; roleId: string; roleKey: string | null };

/** The most specific rule: theirs at this shop, theirs brand-wide, their role's at this shop, their role's brand-wide. */
function pickRule(rules: readonly FieldRule[], who: Who, shopId: string | null, field: FieldKey, setting: Setting): string | undefined {
  const mine = rules.filter((r) => r.field === field && ruleSetting(r) === setting);
  const pick = (p: (r: FieldRule) => boolean) => mine.find(p)?.level;
  return (
    (shopId ? pick((r) => r.staffId === who.staffId && r.shopId === shopId) : undefined) ??
    pick((r) => r.staffId === who.staffId && r.shopId === null) ??
    (shopId ? pick((r) => r.roleId === who.roleId && r.staffId === null && r.shopId === shopId) : undefined) ??
    pick((r) => r.roleId === who.roleId && r.staffId === null && r.shopId === null)
  );
}

const RANK: Record<Level, number> = { hidden: 0, masked: 1, full: 2 };
export const minLevel = (...ls: Level[]): Level => ls.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), "full" as Level);
export const atLeast = (l: Level, want: Level) => RANK[l] >= RANK[want];

/**
 * How visible a field is to a person working at a shop (null: brand-wide, not in any one shop).
 * The most specific rule wins: theirs at this shop, theirs brand-wide, their role's at this shop,
 * their role's brand-wide, then the built-in default. The Brand Owner and Brand Admins always see everything.
 */
export function resolveLevel(rules: readonly FieldRule[], who: Who, shopId: string | null, field: FieldKey): Level {
  if (who.roleKey === OWNER_ROLE_KEY || who.roleKey === BRAND_ADMIN_ROLE_KEY) return "full";
  const l = pickRule(rules, who, shopId, field, "view");
  return isLevel(l) ? l : defaultLevel(who.roleKey, field);
}

/** Whether a person may add or edit a field at a shop, by the same precedence as viewing. */
export function resolveEntry(rules: readonly FieldRule[], who: Who, shopId: string | null, field: FieldKey, setting: EntrySetting): boolean {
  if (!isEntryField(field)) return false;
  if (who.roleKey === OWNER_ROLE_KEY) return true;
  const e = pickRule(rules, who, shopId, field, setting);
  return isEntry(e) ? e === "allow" : defaultEntry(who.roleKey, field, setting);
}

/**
 * Who may change a rule. Nobody changes what applies to themselves (their own rules or their
 * role's) unless they're the Brand Owner, the Brand Owner's role always has everything, and nobody
 * gives a level or an entry right they don't have themselves.
 */
export function fieldRuleChangeDenied(
  caller: {
    staffId: string;
    roleId: string;
    isOwner: boolean;
    levelAt: (shopId: string | null, field: FieldKey) => Level;
    entryAt?: (shopId: string | null, field: FieldKey, setting: EntrySetting) => boolean;
  },
  rule: { field: FieldKey; setting?: Setting; roleId: string | null; roleKey: string | null; staffId: string | null; shopId: string | null; level: string | null },
): string | null {
  const setting = rule.setting ?? "view";
  if (!!rule.roleId === !!rule.staffId) return "Pick a role or a person";
  if (rule.roleKey === OWNER_ROLE_KEY) return "The Brand Owner always sees every client detail";
  if (rule.roleKey === BRAND_ADMIN_ROLE_KEY && setting === "view") return "Brand Admins always see every client detail";
  if (setting !== "view" && !isEntryField(rule.field)) return "Ratings are entered with the rating tools, not client forms";
  if (rule.level !== null && (setting === "view" ? !isLevel(rule.level) : !isEntry(rule.level))) return "Pick a level";
  if (caller.isOwner) return null;
  if (rule.staffId === caller.staffId || rule.roleId === caller.roleId) return "You can't change what you see yourself. Ask the Brand Owner.";
  if (setting === "view" && isLevel(rule.level) && !atLeast(caller.levelAt(rule.shopId, rule.field), rule.level)) return "You can't give anyone more than you see yourself";
  if (setting !== "view" && rule.level === "allow" && !caller.entryAt?.(rule.shopId, rule.field, setting))
    return `You can't let anyone ${setting} a detail you can't ${setting} yourself`;
  return null;
}

/**
 * A client field as one person gets it on a page or in an action's result. `value` is already
 * masked, or null when hidden; `saved` says something is on file without saying what.
 */
export interface ShownField {
  key: string;
  label: string;
  level: Level;
  value: string | null;
  saved: boolean;
  canAdd: boolean;
  canEdit: boolean;
}

/** What a person may do with one field on a form. */
export interface FieldEntry {
  level: Level;
  canAdd: boolean;
  canEdit: boolean;
}

/**
 * Whether a form may write `next` into a field holding `before` (undefined: the form left it alone).
 * A field the person sees in full is compared with what's stored, so re-sending it unchanged is
 * fine. Anything else is never compared: filling an empty field needs "add", writing over or
 * clearing one on file needs "edit", even when the new value happens to match, so a refusal can't
 * confirm a guess.
 */
export function entryDenied(e: FieldEntry, before: string | null | undefined, next: string | null | undefined): EntrySetting | null {
  if (next === undefined) return null;
  const had = before != null && before !== "";
  const value = next ?? "";
  if (e.level === "full" && (before ?? "") === value) return null;
  if (!had) return value === "" || e.canAdd ? null : "add";
  return e.canEdit ? null : "edit";
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
    case "photo":
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
