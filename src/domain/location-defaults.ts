/**
 * Brand defaults every location inherits: booking policies, the booking site, client reminders,
 * integrations and the starting role for new staff. A location follows the brand ("all shops")
 * until someone sets its own value ("this shop only"); clearing that puts it back on the brand.
 * Fields backed by a shops column are written through to every following shop, so code that
 * reads the column sees the effective value.
 */
import { z } from "zod";
import { FIRST_REMINDER_HOURS, SECOND_REMINDER_HOURS } from "./staff-notifications";

export const DEFAULT_SECTIONS = [
  { id: "policies", label: "Policies", hint: "Booking rules and the cancellation and no-show wording clients see." },
  { id: "booking", label: "Booking site", hint: "How the booking pages look." },
  { id: "notifications", label: "Client notifications", hint: "When clients are reminded. A barber's own reminder times still win." },
  { id: "integrations", label: "Integrations", hint: "Conversion tracking on the booking site." },
  { id: "roles", label: "Roles", hint: "The role new staff start with." },
] as const;
export type DefaultSection = (typeof DEFAULT_SECTIONS)[number]["id"];

const minutes = (max: number) => z.number().int("Whole minutes").min(0).max(max, `At most ${max}`);
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`);
const optionalId = (re: RegExp, msg: string) =>
  z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => s === "" || re.test(s), msg)
    .transform((s) => s || null)
    .nullable();

type Field<T extends z.ZodType> = {
  section: DefaultSection;
  label: string;
  hint?: string;
  kind: "minutes" | "days" | "cents" | "text" | "longtext" | "color" | "hours" | "id" | "role";
  schema: T;
  builtin: z.output<T>;
  /** The shops column it's written through to. */
  column?: keyof ColumnPatch;
  options?: readonly number[];
};
const field = <T extends z.ZodType>(f: Field<T>) => f;

export const DEFAULT_FIELDS = {
  cancelCutoffMinutes: field({ section: "policies", label: "Cancel cutoff", hint: "Minutes before the start a client can still cancel online", kind: "minutes", schema: minutes(1440), builtin: 30, column: "cancelCutoffMinutes" }),
  minLeadMinutes: field({ section: "policies", label: "Minimum notice", hint: "Minutes ahead a client must book", kind: "minutes", schema: minutes(1440), builtin: 15, column: "minLeadMinutes" }),
  bookingWindowDays: field({ section: "policies", label: "Booking window", hint: "Days ahead clients can book", kind: "days", schema: z.number().int().min(1, "At least a day").max(365, "At most 365 days"), builtin: 60, column: "bookingWindowDays" }),
  bufferMinutes: field({ section: "policies", label: "Buffer between appointments", kind: "minutes", schema: minutes(60), builtin: 0, column: "bufferMinutes" }),
  drawerOpeningCents: field({ section: "policies", label: "Cash drawer opening balance", kind: "cents", schema: z.number().int().min(0).max(500_000), builtin: 30_000, column: "drawerOpeningCents" }),
  cancellationPolicy: field({ section: "policies", label: "Cancellation policy", hint: "Shown on the booking site before a client confirms", kind: "longtext", schema: text(500), builtin: "" }),
  noShowPolicy: field({ section: "policies", label: "No-show policy", kind: "longtext", schema: text(500), builtin: "" }),
  accentColor: field({
    section: "booking",
    label: "Accent colour",
    kind: "color",
    schema: z
      .string()
      .trim()
      .refine((s) => s === "" || /^#[0-9a-fA-F]{6}$/.test(s), "Use a colour like #c81e1e")
      .transform((s) => s.toLowerCase() || null)
      .nullable(),
    builtin: null,
    column: "accentColor",
  }),
  bookingHeadline: field({ section: "booking", label: "Booking page headline", hint: "Blank shows the shop name", kind: "text", schema: text(80), builtin: "" }),
  reminderFirstHours: field({
    section: "notifications",
    label: "First reminder",
    hint: "Hours before; 0 is off",
    kind: "hours",
    schema: z.number().refine((n) => (FIRST_REMINDER_HOURS as readonly number[]).includes(n), "Pick one of the listed times"),
    builtin: 24,
    options: FIRST_REMINDER_HOURS,
  }),
  reminderSecondHours: field({
    section: "notifications",
    label: "Second reminder",
    hint: "Hours before; 0 is off",
    kind: "hours",
    schema: z.number().refine((n) => (SECOND_REMINDER_HOURS as readonly number[]).includes(n), "Pick one of the listed times"),
    builtin: 2,
    options: SECOND_REMINDER_HOURS,
  }),
  ga4MeasurementId: field({ section: "integrations", label: "Google Analytics 4 measurement ID", hint: "G-XXXXXXX", kind: "id", schema: optionalId(/^G-[A-Z0-9]{4,15}$/, "A GA4 ID looks like G-ABC123XYZ"), builtin: null }),
  metaPixelId: field({ section: "integrations", label: "Meta Pixel ID", hint: "Digits only", kind: "id", schema: optionalId(/^\d{6,20}$/, "A Meta Pixel ID is 6 to 20 digits"), builtin: null }),
  newStaffRole: field({ section: "roles", label: "Starting role for new staff", hint: "Preselected on Add staff", kind: "role", schema: z.string().trim().regex(/^[a-z_]{2,40}$/, "Pick a role"), builtin: "barber" }),
};

export type DefaultKey = keyof typeof DEFAULT_FIELDS;
export const DEFAULT_KEYS = Object.keys(DEFAULT_FIELDS) as DefaultKey[];
export type LocationDefaults = { [K in DefaultKey]: z.output<(typeof DEFAULT_FIELDS)[K]["schema"]> };
export type DefaultValue = LocationDefaults[DefaultKey];

export const isDefaultKey = (k: string): k is DefaultKey => k in DEFAULT_FIELDS;
export const keysIn = (s: DefaultSection) => DEFAULT_KEYS.filter((k) => DEFAULT_FIELDS[k].section === s);

/** Parses one value for a field, or returns the reason it isn't valid. */
export function parseDefault<K extends DefaultKey>(key: K, raw: unknown): { ok: true; value: LocationDefaults[K] } | { ok: false; error: string } {
  const r = DEFAULT_FIELDS[key].schema.safeParse(raw);
  return r.success ? { ok: true, value: r.data as LocationDefaults[K] } : { ok: false, error: r.error.issues[0]?.message ?? "Not a valid value" };
}

/** Only the valid keys of a stored overrides or defaults object; anything else is dropped. */
export function cleanPartial(raw: unknown): Partial<LocationDefaults> {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Partial<Record<DefaultKey, DefaultValue>> = {};
  for (const k of DEFAULT_KEYS) {
    if (!(k in r)) continue;
    const p = parseDefault(k, r[k]);
    if (p.ok) out[k] = p.value;
  }
  return out as Partial<LocationDefaults>;
}

export function brandDefaults(raw: unknown): LocationDefaults {
  const builtins = Object.fromEntries(DEFAULT_KEYS.map((k) => [k, DEFAULT_FIELDS[k].builtin])) as LocationDefaults;
  return { ...builtins, ...cleanPartial(raw) };
}

export type Effective = { [K in DefaultKey]: { value: LocationDefaults[K]; scope: "all" | "shop" } };

/** A location's values: its own where it has one ("this shop only"), else the brand's ("all shops"). */
export function effectiveDefaults(brand: LocationDefaults, overrides: Partial<LocationDefaults>): Effective {
  return Object.fromEntries(DEFAULT_KEYS.map((k) => [k, k in overrides ? { value: overrides[k], scope: "shop" } : { value: brand[k], scope: "all" }])) as Effective;
}

export const valuesOf = (e: Effective): LocationDefaults => Object.fromEntries(DEFAULT_KEYS.map((k) => [k, e[k].value])) as LocationDefaults;

/** The shops columns these values write through to. */
export type ColumnPatch = Partial<Record<"cancelCutoffMinutes" | "minLeadMinutes" | "bookingWindowDays" | "bufferMinutes" | "drawerOpeningCents", number> & { accentColor: string | null }>;
export function columnPatch(values: Partial<LocationDefaults>): ColumnPatch {
  const out: Record<string, unknown> = {};
  for (const k of DEFAULT_KEYS) {
    const c = DEFAULT_FIELDS[k].column;
    if (c && k in values) out[c] = values[k];
  }
  return out as ColumnPatch;
}

/** Settings forms elsewhere save these columns directly; a change there makes the value this shop's own. */
export function overridesFromColumns(changed: Record<string, unknown>): Partial<LocationDefaults> {
  const out: Record<string, unknown> = {};
  for (const k of DEFAULT_KEYS) {
    const c = DEFAULT_FIELDS[k].column;
    if (c && c in changed) {
      const p = parseDefault(k, changed[c]);
      if (p.ok) out[k] = p.value;
    }
  }
  return out as Partial<LocationDefaults>;
}

/** Who may give a location its own value, by section. Brand values need brand settings and every shop. */
export const SECTION_SHOP_PERMISSIONS = {
  policies: ["settings.shop", "settings.shop_booking"],
  booking: ["settings.shop", "settings.shop_details"],
  notifications: ["settings.shop", "settings.shop_booking"],
  integrations: ["settings.shop", "settings.shop_details"],
  roles: ["settings.shop", "permissions.manage"],
} as const satisfies Record<DefaultSection, readonly string[]>;

export function formatDefault(key: DefaultKey, v: DefaultValue): string {
  const f = DEFAULT_FIELDS[key];
  if (v === null || v === "") return "—";
  switch (f.kind) {
    case "minutes":
      return `${v} min`;
    case "days":
      return `${v} days`;
    case "cents":
      return `$${(Number(v) / 100).toFixed(2)}`;
    case "hours":
      return Number(v) === 0 ? "Off" : `${v} h before`;
    case "longtext":
      return String(v).length > 40 ? `${String(v).slice(0, 40)}…` : String(v);
    default:
      return String(v);
  }
}
