import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx } from "@/db";
import { brandSettings, shopSyncState } from "@/db/schema";
import { BadgeSettingsSchema, badgeSettings, thresholdsProblem } from "@/domain/badges";
import { SyncArea, clip, money, onOff, syncKey } from "@/domain/brand-sync";
import { cleanLimits, cleanShopLoginCap, isShopLoginCap, SHOP_LOGIN_CAP_LABEL } from "@/domain/client-privacy";
import { compensationSettings, settingsProblem as compensationProblem } from "@/domain/compensation";
import { analyticsSettings } from "@/domain/analytics";
import { AssistantSettingsSchema, assistantSettings } from "@/domain/assistant";
import { FamilySettingsSchema, familySettings } from "@/domain/family";
import { LOOKUP_DEFS, LOOKUP_KEYS, LookupKey, cleanList, listProblem } from "@/domain/lookups";
import { MarketingSettingsSchema, marketingSettings } from "@/domain/marketing";
import { TEMPLATE_DEFS, TemplateKind, templateProblem } from "@/domain/message-templates";
import { morningSettings, parseMorningSettings } from "@/domain/morning-dashboard";
import { BrandNetworkSchema, brandNetworkSettings } from "@/domain/network-access";
import { OpeningsSettingsSchema, openingsSettings, openingsTemplatesProblem } from "@/domain/openings";
import { cleanOutreachRules, outreachRules, outreachRulesProblem } from "@/domain/outreach";
import { EXPORT_COLUMNS, FT_BASIS_LABEL, payrollSettings } from "@/domain/payroll/calc";
import type { Permission } from "@/domain/permissions";
import { ReviewRulesSchema, reviewRules } from "@/domain/reviews";
import { FILING_LABEL, cleanTaxFiling } from "@/domain/sales-tax";
import { cleanRules, rulesProblem, shopRules } from "@/domain/staff-time";
import { clockRules, parseColumnMapping } from "@/domain/time-clock";
import { intervalProblem } from "@/domain/timing";
import { TIP_METHODS, brandTipPolicy } from "@/domain/tips";
import { audit } from "../audit";
import { AppError } from "../errors";
import type { SyncAdapter, SyncItem, Who } from "./types";

/**
 * The settings registry. Every brand-level setting is one entry here: where it's stored, who may
 * change it, how it's checked and how it reads. From the entry alone the setting gets the brand
 * change scope (all, selected or brand-only shops, previews, keep or replace, schedule), a row on
 * Sync status, history and undo, and a per-shop value: readers call brandColumn(column, shopId) and
 * get the column as that shop has it. A new brand_settings column with no entry fails
 * tests/db/brand-sync-coverage.test.ts.
 *
 * A setting is the whole column, or one entry of a column that's edited an entry at a time (one
 * message's wording, one pick list). `toColumn` writes a value back into the column; for a shop it's
 * applied over the brand's column, so a part a setting doesn't cover (bookkeeping) stays the brand's.
 */

export type BrandRow = typeof brandSettings.$inferSelect;
export type BrandColumn = Exclude<keyof BrandRow, "id" | "updatedAt">;

export interface SettingDef<V = unknown> {
  key: string;
  label: string;
  area: SyncArea;
  column: BrandColumn;
  /** To change it. People also need every shop. */
  perms: readonly Permission[];
  paths: readonly string[];
  note?: string;
  hint?: string;
  /**
   * Why one value has to cover every shop (payroll adds hours up across shops into one export).
   * Such a setting still saves through the brand change scope, with history and undo, but has no
   * per-shop value.
   */
  wholeBrand?: string;
  /** The brand's value from its stored column, defaults filled in. */
  read(column: unknown): V;
  /** Validates an editor's value (an object is merged over the current value first). */
  parse(raw: unknown, before: V, who: Who, tx: DBorTx): V | Promise<V>;
  /** Writes a value into the column. Default: the value is the column. */
  toColumn?(v: V, column: unknown): unknown;
  /** Audit action for a brand change. */
  audit: string;
  /** Inside the change's transaction, after the brand's value is written. */
  after?(tx: DBorTx, from: V | null, to: V): Promise<void>;
  labels?: Record<string, string>;
  describe?(v: V): Record<string, string>;
  short?(v: V): string;
}

const def = <V>(d: SettingDef<V>): SettingDef => d as unknown as SettingDef;

const bad = (message: string): never => {
  throw new AppError("bad_request", message);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
function zparse<T extends z.ZodType>(schema: T, raw: unknown, fallback: string): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) bad(r.error.issues[0]?.message ?? fallback);
  return (r as { data: z.output<T> }).data;
}

// ───────────────────────────── Describing any value ─────────────────────────────

const humanize = (k: string) => {
  const s = k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]/g, " ")
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function fmt(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return onOff(v);
  if (typeof v === "number") return /cents$/i.test(key) ? money(v) : String(v);
  if (typeof v === "string") return clip(v, 48);
  if (Array.isArray(v)) return v.every((x) => typeof x !== "object" || x === null) ? clip(v.join(", "), 48) || "None" : `${v.length} item${v.length === 1 ? "" : "s"}`;
  const n = Object.keys(v as object).length;
  return n ? `${n} set` : "None";
}

/** Field label to display text for any setting value: one level of nested objects is spread out. */
export function describeValue(v: unknown, label: string, labels: Record<string, string> = {}): Record<string, string> {
  if (!isObj(v)) return { [label]: fmt(label, v) };
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    const name = labels[k] ?? humanize(k);
    if (isObj(x) && Object.values(x).every((y) => !isObj(y)) && Object.keys(x).length <= 8) for (const [k2, y] of Object.entries(x)) out[`${name} · ${labels[`${k}.${k2}`] ?? humanize(k2)}`] = fmt(k2, y);
    else out[name] = fmt(k, x);
  }
  return out;
}

const shortOf = (d: Record<string, string>) =>
  clip(
    Object.entries(d)
      .slice(0, 2)
      .map(([k, v]) => (Object.keys(d).length === 1 ? v : `${k}: ${v}`))
      .join(" · "),
    40,
  );

// ───────────────────────────── The settings ─────────────────────────────

const LimitsInput = z.object({
  windowMinutes: z.number().int().min(1).max(1440),
  alertProfiles: z.number().int().min(1).max(10_000),
  blockProfiles: z.number().int().min(1).max(10_000),
  alertSearches: z.number().int().min(1).max(100_000),
  blockSearches: z.number().int().min(1).max(100_000),
});

const PayrollInput = z.object({
  trainingCountsTowardOt: z.boolean(),
  trainingPayInCost: z.boolean(),
  roundExport2dp: z.boolean(),
  ftHoursPerWeek: z.number().min(1).max(60),
  ftBasis: z.enum(Object.keys(FT_BASIS_LABEL) as [keyof typeof FT_BASIS_LABEL, ...(keyof typeof FT_BASIS_LABEL)[]]),
  ftWindowWeeks: z.number().int().min(1).max(26),
  otThresholdHours: z.number().min(1).max(80),
  dailyOtHours: z.number().min(1).max(24).nullable(),
  otMultiplier: z.number().min(1).max(3),
  tipsInPayrollHeader: z.string().trim().min(1, "Name the iSolved earning for tips paid in payroll").max(60),
});

const ClockInput = z.object({
  unpaidBreakFromMinutes: z.number().int().min(0).max(240),
  autoMealMinutes: z.number().int().min(0).max(120),
  autoMealAfterHours: z.number().int().min(1).max(16),
  forgotOutAfterMinutes: z.number().int().min(10).max(720),
  maxShiftHours: z.number().int().min(4).max(24),
  graceMinutes: z.number().int().min(0).max(60),
});

const TipPolicyInput = z.object({
  methods: z.array(z.enum(TIP_METHODS)).min(1, "Allow at least one payout method"),
  employeeChooses: z.boolean(),
  instantAllowed: z.boolean(),
});

const messageSetting = (kind: TemplateKind) => {
  const d = TEMPLATE_DEFS[kind];
  type T = { subject: string; body: string };
  const read = (col: unknown): T => {
    const t = obj(obj(col)[kind]);
    return { subject: typeof t.subject === "string" ? t.subject : d.subject, body: typeof t.body === "string" ? t.body : d.body };
  };
  return def<T>({
    key: `message.${kind}`,
    label: `Message: ${d.label}`,
    hint: d.when,
    area: "messages",
    column: "messageTemplates",
    perms: ["settings.lists"],
    paths: ["/admin/messages"],
    read,
    parse(raw) {
      if (raw === null) return { subject: d.subject, body: d.body };
      const t = z.object({ subject: z.string(), body: z.string() }).parse(raw);
      const problem = templateProblem(kind, t);
      if (problem) bad(problem);
      return { subject: t.subject.trim(), body: t.body.trim() };
    },
    toColumn(v, col) {
      const rest = { ...obj(col) };
      delete rest[kind];
      return v.subject === d.subject && v.body === d.body ? rest : { ...rest, [kind]: v };
    },
    audit: "settings.template",
    describe: (v) => ({ Subject: clip(v.subject, 60), Message: clip(v.body, 60) }),
    short: (v) => (v.subject === d.subject && v.body === d.body ? "Built-in wording" : clip(v.body, 32)),
  });
};

const lookupSetting = (key: LookupKey) => {
  const d = LOOKUP_DEFS[key];
  return def<string[]>({
    key: `lookup.${key}`,
    label: d.label,
    hint: d.hint,
    area: "lists",
    column: "lookups",
    perms: ["settings.lists"],
    paths: ["/admin/lists"],
    read: (col) => {
      const v = obj(col)[key];
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [...d.defaults];
    },
    parse(raw) {
      const items = z.array(z.string()).parse(raw);
      const problem = listProblem(items);
      if (problem) bad(problem);
      return cleanList(items);
    },
    toColumn: (v, col) => ({ ...obj(col), [key]: v }),
    audit: "settings.lookups",
    describe: (v) => ({ Entries: clip(v.join(", "), 60), Count: String(v.length) }),
    short: (v) => `${v.length} entr${v.length === 1 ? "y" : "ies"}`,
  });
};

export const SETTINGS: readonly SettingDef[] = [
  def<string>({
    key: "brand_name",
    label: "Brand name",
    area: "branding",
    column: "name",
    perms: ["settings.brand"],
    paths: ["/admin/brand-defaults"],
    note: "Where a shop prints the brand's name: purchase orders and brand emails.",
    read: (v) => (typeof v === "string" && v.trim() ? v : "Ray'z Barber Shop"),
    parse: (raw) => zparse(z.string().trim().min(2, "Give the brand a name").max(60, "Keep the name to 60 characters"), raw, "Check the brand name"),
    audit: "brand.name",
  }),
  def<number>({
    key: "slot_interval",
    label: "Booking slot interval",
    area: "policies",
    column: "slotIntervalMinutes",
    perms: ["scheduling.timing"],
    paths: ["/admin/booking-times"],
    note: "A shop or barber that set its own interval under Booking times keeps it.",
    read: (v) => (typeof v === "number" && !intervalProblem(v) ? v : 15),
    parse(raw) {
      const problem = intervalProblem(raw);
      if (problem) bad(problem);
      return raw as number;
    },
    audit: "timing.brand_interval",
    describe: (v) => ({ "Slot interval": `${v} min` }),
    short: (v) => `${v} min`,
  }),
  def<number | null>({
    key: "po_approval",
    label: "Purchase order approval limit",
    area: "inventory",
    column: "poApprovalThresholdCents",
    perms: ["settings.brand"],
    paths: ["/admin/inventory/settings", "/admin/purchase-orders"],
    read: (v) => (typeof v === "number" ? v : null),
    parse(raw) {
      if (raw === null) return null;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) bad("Enter a dollar amount, or leave it blank for no approval step");
      return raw as number;
    },
    audit: "inventory.po_approval_limit",
    describe: (v) => ({ "Needs approval above": v === null ? "No approval step" : money(v) }),
    short: (v) => (v === null ? "No approval" : `Above ${money(v)}`),
  }),
  def({
    key: "staff_time",
    label: "Lunch, blocks and time off rules",
    area: "team",
    column: "staffTime",
    perms: ["settings.shop"],
    paths: ["/admin/time-off"],
    note: "Changes a shop made to its own rules under Time off stay on top.",
    read: (v) => shopRules(v, {}),
    parse(raw, before) {
      const merged = { ...before, ...obj(raw) };
      const problem = rulesProblem(merged);
      if (problem) bad(problem);
      return shopRules(cleanRules(merged), {});
    },
    audit: "staff_time.rules",
  }),
  def({
    key: "time_clock",
    label: "Time clock rules",
    area: "team",
    column: "timeClock",
    perms: ["payroll.run"],
    paths: ["/admin/time-clock"],
    note: "Each shop's clock-in place and devices stay its own.",
    read: clockRules,
    parse(raw, before) {
      const r = obj(raw);
      const v = ClockInput.partial().parse(r);
      let cols = before.isolvedColumns;
      if (typeof r.mapping === "string") {
        const m = parseColumnMapping(r.mapping);
        if (m.problems.length) bad(m.problems.join(" "));
        cols = m.columns;
      } else if (Array.isArray(r.isolvedColumns)) cols = clockRules({ isolvedColumns: r.isolvedColumns }).isolvedColumns;
      return clockRules({ ...before, ...v, isolvedColumns: cols });
    },
    audit: "timeclock.rules",
    describe: (v) => ({ ...describeValue({ ...v, isolvedColumns: undefined }, "Time clock"), "iSolved columns": String(v.isolvedColumns.length) }),
  }),
  def({
    key: "payroll",
    label: "Payroll rules",
    area: "payroll",
    column: "payroll",
    perms: ["payroll.run"],
    paths: ["/admin/payroll", "/admin/payroll/setup"],
    wholeBrand: "Payroll adds each person's hours up across shops into one overtime count and one export, so these rules are the same at every shop.",
    read: payrollSettings,
    parse: (raw, before) => payrollSettings(PayrollInput.parse({ ...before, ...obj(raw) })),
    labels: { otThresholdHours: "Weekly OT after (hours)", dailyOtHours: "Daily OT after (hours)", otMultiplier: "OT multiplier", ftBasis: "Full-time basis" },
    audit: "payroll.settings",
  }),
  def({
    key: "compensation",
    label: "Compensation fields",
    area: "payroll",
    column: "compensation",
    perms: ["compensation.settings"],
    paths: ["/admin/compensation"],
    wholeBrand: "A person's pay plan covers every shop they work at and comes out in the brand's one payroll export, so these fields are the same at every shop.",
    read: compensationSettings,
    async parse(raw, before, _who, tx) {
      const clean = compensationSettings({ ...before, ...obj(raw) });
      const [b] = await tx.select({ p: brandSettings.payroll }).from(brandSettings).where(eq(brandSettings.id, 1));
      const problem = compensationProblem(clean, [...EXPORT_COLUMNS.map((c) => c.header), payrollSettings(b?.p).tipsInPayrollHeader]);
      if (problem) bad(problem);
      return clean;
    },
    audit: "compensation.settings",
  }),
  def({
    key: "tip_payouts",
    label: "Tip payout policy",
    area: "payroll",
    column: "tipPayouts",
    perms: ["tips.settings"],
    paths: ["/admin/tips", "/admin/tips/settings"],
    note: "Each shop's payout schedule and default method stay its own.",
    read: brandTipPolicy,
    parse: (raw, before) => brandTipPolicy(TipPolicyInput.parse({ ...before, ...obj(raw) })),
    audit: "tips.policy",
  }),
  def({
    key: "outreach",
    label: "Call-in outreach rules",
    area: "messages",
    column: "outreach",
    perms: ["settings.brand"],
    paths: ["/admin/call-ins"],
    read: outreachRules,
    parse(raw, before) {
      const merged = { ...before, ...obj(raw) };
      const problem = outreachRulesProblem(merged);
      if (problem) bad(problem);
      return outreachRules(cleanOutreachRules(merged));
    },
    audit: "callin.rules",
  }),
  ...(Object.keys(TEMPLATE_DEFS) as TemplateKind[]).map(messageSetting),
  def({
    key: "reviews",
    label: "Google review link timing",
    area: "branding",
    column: "reviews",
    perms: ["settings.brand"],
    paths: ["/admin/settings"],
    note: "A shop that set its own visit count or pause on its receipt keeps it.",
    read: reviewRules,
    parse: (raw, before) => zparse(ReviewRulesSchema, { ...before, ...obj(raw) }, "Check the review settings"),
    labels: { minVisits: "From visit", snoozeDays: "Pause after a tap (days)" },
    audit: "brand.review_rules",
  }),
  def({
    key: "digest",
    label: "Morning Dashboard email",
    area: "reports",
    column: "digest",
    perms: ["settings.lists"],
    paths: ["/admin/digest", "/admin/morning"],
    wholeBrand: "One email covers each person's shops together and goes out on one schedule, so these settings are the same at every shop.",
    read: morningSettings,
    parse: (raw, before) => {
      const r = parseMorningSettings({ ...before, ...obj(raw) });
      if (!r.success) bad(r.error.issues[0]?.message ?? "Check the Morning Dashboard settings");
      return r.data!;
    },
    audit: "settings.digest",
  }),
  def({
    key: "marketing",
    label: "Campaign Center settings",
    area: "marketing",
    column: "marketing",
    perms: ["campaign_center.create"],
    paths: ["/admin/campaign-center", "/admin/campaign-center/settings"],
    read: marketingSettings,
    parse(raw, before) {
      const r = zparse(MarketingSettingsSchema, { ...before, ...obj(raw) }, "Check the Campaign Center settings");
      if (r.quietStart === r.quietEnd) bad("Quiet hours need a different start and end");
      if (r.capPerMonth < r.capPerWeek) bad("The monthly limit can't be lower than the weekly limit");
      return r;
    },
    toColumn: (v, col) => ({ ...obj(col), ...v }),
    audit: "brand.campaign_center_settings",
  }),
  def({
    key: "openings",
    label: "We have openings rules",
    area: "marketing",
    column: "marketing",
    perms: ["campaign_center.create"],
    paths: ["/admin/campaign-center/openings"],
    read: (col) => openingsSettings(obj(col).openings),
    parse(raw, before) {
      const r = zparse(OpeningsSettingsSchema, { ...before, ...obj(raw) }, "Check the We have openings settings");
      const problem = openingsTemplatesProblem(r.templates);
      if (problem) bad(problem);
      return { ...r, shops: Object.fromEntries(Object.entries(r.shops).filter(([, x]) => x.perDay !== null || x.perWeek !== null || x.approval !== null)) };
    },
    toColumn: (v, col) => ({ ...obj(col), openings: v }),
    audit: "brand.openings_settings",
    describe: (v) => ({ ...describeValue({ ...v, templates: undefined, shops: undefined }, "Openings"), "Location limits": String(Object.keys(v.shops).length), Text: clip(v.templates.sms, 48) }),
  }),
  def({
    key: "lookup_limits",
    label: "Client lookup limits",
    area: "clients",
    column: "clientLookupLimits",
    perms: ["clients.privacy"],
    paths: ["/admin/client-data"],
    read: cleanLimits,
    parse(raw, before) {
      const p = LimitsInput.parse({ ...before, ...obj(raw) });
      if (p.blockProfiles < p.alertProfiles || p.blockSearches < p.alertSearches) bad("The pause level can't be below the alert level");
      return cleanLimits(p);
    },
    toColumn: (v) => ({ ...v }),
    audit: "client_data.limits",
  }),
  def<string>({
    key: "shop_login_contact",
    label: "What shop logins see of client contact details",
    area: "clients",
    column: "shopLogin",
    perms: ["clients.privacy"],
    paths: ["/admin/client-data"],
    read: (col) => cleanShopLoginCap(obj(col).clientContact),
    parse(raw) {
      if (!isShopLoginCap(raw)) bad("Shop logins see contact details masked or hidden, never in full");
      return raw as string;
    },
    toColumn: (v, col) => ({ ...obj(col), clientContact: v }),
    audit: "client_privacy.shop_login_cap",
    describe: (v) => ({ "Contact details": SHOP_LOGIN_CAP_LABEL[cleanShopLoginCap(v)] }),
    short: (v) => SHOP_LOGIN_CAP_LABEL[cleanShopLoginCap(v)],
  }),
  def({
    key: "badges",
    label: "Client badges",
    area: "clients",
    column: "badges",
    perms: ["badges.settings"],
    paths: ["/admin/client-badges"],
    note: "Who has a badge is worked out once for the brand from its thresholds; shops can show and hide badges and roles differently.",
    read: badgeSettings,
    parse(raw, before) {
      const p = zparse(BadgeSettingsSchema, { ...before, ...obj(raw) }, "Check the badge settings");
      const order = thresholdsProblem(p.thresholds);
      if (order) bad(order);
      return p;
    },
    async after(tx, from, to) {
      if (!from || JSON.stringify(from.thresholds) !== JSON.stringify(to.thresholds)) await (await import("../badges")).markAllStale(tx);
    },
    describe: (v) => ({
      Badges: onOff(v.enabled),
      "Turned off": String(v.off.length),
      ...Object.fromEntries(Object.entries(v.thresholds).map(([k, n]) => [`Threshold · ${humanize(k)}`, String(n)])),
      "Role rules": String(Object.keys(v.roles).length),
      "Shown to clients": String(Object.values(v.customer).filter(Boolean).length),
    }),
    audit: "settings.badges",
  }),
  def({
    key: "family",
    label: "Family accounts",
    area: "clients",
    column: "family",
    perms: ["settings.brand"],
    paths: ["/admin/settings"],
    note: "A family booked or checked out at a shop follows that shop's rules; the app outside a shop uses the brand's. Whose loyalty card a child's visits earn on is the brand's, since a card covers every shop.",
    read: familySettings,
    parse: (raw, before) => zparse(FamilySettingsSchema, { ...before, ...obj(raw) }, "Check the family settings"),
    audit: "brand.family_settings",
  }),
  ...LOOKUP_KEYS.map(lookupSetting),
  def({
    key: "tax_filing",
    label: "Sales tax filing schedule",
    area: "taxes",
    column: "taxFiling",
    perms: ["settings.taxes"],
    paths: ["/admin/settings", "/admin/reports"],
    read: cleanTaxFiling,
    parse(raw, before) {
      const next = cleanTaxFiling(raw);
      if (!Object.keys(next).length) bad("Pick a state and monthly or quarterly");
      return { ...before, ...next };
    },
    audit: "brand.tax_filing",
    describe: (v) => (Object.keys(v).length ? Object.fromEntries(Object.entries(v).map(([s, f]) => [s, FILING_LABEL[f]])) : { Filing: "Defaults" }),
    short: (v) => (Object.keys(v).length ? Object.entries(v).map(([s, f]) => `${s} ${FILING_LABEL[f].toLowerCase()}`).join(" · ") : "Defaults"),
  }),
  def({
    key: "network",
    label: "Blocked sign-in alert",
    area: "security",
    column: "networkAccess",
    perms: ["network.settings"],
    paths: ["/admin/sign-in-security"],
    note: "Each location's own sign-in restriction stays under Sign-in security.",
    read: brandNetworkSettings,
    parse: (raw, before) => zparse(BrandNetworkSchema, { ...before, ...obj(raw) }, "Check the sign-in settings"),
    audit: "network.settings",
  }),
  def({
    key: "assistant",
    label: "Rayz Assistant",
    area: "features",
    column: "assistant",
    perms: ["assistant.settings"],
    paths: ["/admin/assistant"],
    read: assistantSettings,
    parse: (raw, before) => zparse(AssistantSettingsSchema, { ...before, ...obj(raw) }, "Check the assistant settings"),
    describe: (v) => ({ Assistant: onOff(v.enabled), "Roles turned off": String(Object.values(v.roles).filter((x) => !x).length), "Per minute": String(v.perMinute), "Per day": String(v.perDay), Drafting: onOff(v.actions) }),
    audit: "settings.assistant",
  }),
  def<boolean>({
    key: "memberships",
    label: "Memberships",
    area: "features",
    column: "membershipsEnabled",
    perms: ["memberships.manage"],
    paths: ["/admin/memberships"],
    read: (v) => v === true,
    parse: (raw) => zparse(z.boolean(), raw, "Turn memberships on or off"),
    audit: "memberships.settings",
    describe: (v) => ({ Memberships: onOff(v) }),
    short: onOff,
  }),
  def<boolean>({
    key: "visit_question",
    label: "Post-visit 1-5 question",
    area: "features",
    column: "analytics",
    perms: ["analytics.settings"],
    paths: ["/admin/analytics"],
    hint: "Asked on the receipt",
    read: (col) => analyticsSettings(col).satisfaction,
    parse: (raw) => zparse(z.boolean(), raw, "Turn the question on or off"),
    toColumn: (v, col) => ({ ...obj(col), satisfaction: v }),
    audit: "analytics.settings",
    describe: (v) => ({ "Post-visit question": onOff(v) }),
    short: onOff,
  }),
  def<boolean>({
    key: "warehouse",
    label: "Nightly warehouse copy",
    area: "features",
    column: "analytics",
    perms: ["analytics.settings"],
    paths: ["/admin/analytics"],
    wholeBrand: "The brand's whole event log goes to one warehouse in one nightly copy, so this is the same at every shop.",
    read: (col) => analyticsSettings(col).warehouse,
    parse: (raw) => zparse(z.boolean(), raw, "Turn the warehouse copy on or off"),
    toColumn: (v, col) => ({ ...obj(col), warehouse: v }),
    audit: "analytics.settings",
    describe: (v) => ({ "Warehouse copy": onOff(v) }),
    short: onOff,
  }),
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const BY_COLUMN = new Map<BrandColumn, SettingDef[]>();
for (const s of SETTINGS) BY_COLUMN.set(s.column, [...(BY_COLUMN.get(s.column) ?? []), s]);

export const settingDef = (key: string): SettingDef | undefined => BY_KEY.get(key);
const settingOf = (key: string): SettingDef => BY_KEY.get(key) ?? bad("Unknown setting");
const toColumn = (d: SettingDef, v: unknown, col: unknown) => (d.toColumn ? d.toColumn(v, col) : v);

async function brandRow(tx: DBorTx): Promise<Partial<BrandRow>> {
  const [row] = await tx.select().from(brandSettings).where(eq(brandSettings.id, 1));
  return row ?? {};
}

/**
 * A brand_settings column as one shop has it: the brand's, with the shop's own value of each setting
 * stored in it applied on top. No shop (brand-wide work, the brand's own editor): the brand's.
 */
export async function brandColumn<C extends BrandColumn>(column: C, shopId?: string | null, tx: DBorTx = db): Promise<BrandRow[C] | undefined> {
  const [row] = await tx.select({ v: brandSettings[column] }).from(brandSettings).where(eq(brandSettings.id, 1));
  let v: unknown = row?.v;
  const defs = BY_COLUMN.get(column);
  if (!shopId || !defs) return v as BrandRow[C] | undefined;
  const own = await tx
    .select({ key: shopSyncState.key, local: shopSyncState.local })
    .from(shopSyncState)
    .where(
      and(
        eq(shopSyncState.shopId, shopId),
        inArray(
          shopSyncState.key,
          defs.map((d) => syncKey("setting", d.key)),
        ),
        isNotNull(shopSyncState.local),
      ),
    );
  for (const r of own) {
    const d = BY_KEY.get(r.key.slice("setting:".length));
    if (d) v = toColumn(d, r.local, v);
  }
  return v as BrandRow[C] | undefined;
}

/**
 * Writes one brand_settings column. Only the brand change scope calls it (this module and the
 * adapters), so every brand-level change has a scope, history and undo.
 */
export async function writeBrandColumn<C extends BrandColumn>(tx: DBorTx, column: C, value: BrandRow[C]) {
  await tx
    .insert(brandSettings)
    .values({ id: 1, loyalty: {}, [column]: value })
    .onConflictDoUpdate({ target: brandSettings.id, set: { [column]: value, updatedAt: new Date() } });
}

/** brandColumn for several shops at once: `at(shopId)` is the column as that shop has it, `at(null)` the brand's. */
export async function brandColumnAt<C extends BrandColumn>(column: C, shopIds: readonly (string | null | undefined)[], tx: DBorTx = db): Promise<(shopId?: string | null) => BrandRow[C] | undefined> {
  const [row] = await tx.select({ v: brandSettings[column] }).from(brandSettings).where(eq(brandSettings.id, 1));
  const brand = row?.v as BrandRow[C] | undefined;
  const defs = BY_COLUMN.get(column);
  const ids = [...new Set(shopIds.filter((s): s is string => !!s))];
  if (!defs || !ids.length) return () => brand;
  const own = await tx
    .select({ shopId: shopSyncState.shopId, key: shopSyncState.key, local: shopSyncState.local })
    .from(shopSyncState)
    .where(
      and(
        inArray(shopSyncState.shopId, ids),
        inArray(
          shopSyncState.key,
          defs.map((d) => syncKey("setting", d.key)),
        ),
        isNotNull(shopSyncState.local),
      ),
    );
  const byShop = new Map<string, unknown>();
  for (const r of own) {
    const d = BY_KEY.get(r.key.slice("setting:".length));
    if (d) byShop.set(r.shopId, toColumn(d, r.local, byShop.has(r.shopId) ? byShop.get(r.shopId) : brand));
  }
  return (shopId) => (shopId && byShop.has(shopId) ? (byShop.get(shopId) as BrandRow[C]) : brand);
}

/** One registered setting's value at a shop (or the brand's), read the way its editor sees it. */
export async function settingAt<V>(key: string, shopId?: string | null, tx: DBorTx = db): Promise<V> {
  const d = settingOf(key);
  return d.read(await brandColumn(d.column, shopId, tx)) as V;
}

/** settingAt for several shops at once: `at(shopId)` is the setting at that shop, `at()` the brand's. */
export async function settingFor<V>(key: string, shopIds: readonly (string | null | undefined)[], tx: DBorTx = db): Promise<(shopId?: string | null) => V> {
  const d = settingOf(key);
  const at = await brandColumnAt(d.column, shopIds, tx);
  const brand = d.read(at()) as V;
  const memo = new Map<string, V>();
  return (shopId) => {
    if (!shopId) return brand;
    if (!memo.has(shopId)) memo.set(shopId, d.read(at(shopId)) as V);
    return memo.get(shopId)!;
  };
}

/** Each shop's own value of one setting, for the shops that have one. */
export async function settingAtShops<V>(key: string, shopIds: readonly string[], tx: DBorTx = db): Promise<{ brand: V; byShop: Map<string, V> }> {
  const d = settingOf(key);
  const col = (await brandRow(tx))[d.column];
  const brand = d.read(col) as V;
  if (!shopIds.length) return { brand, byShop: new Map() };
  const rows = await tx
    .select({ shopId: shopSyncState.shopId, local: shopSyncState.local })
    .from(shopSyncState)
    .where(and(inArray(shopSyncState.shopId, [...shopIds]), eq(shopSyncState.key, syncKey("setting", key)), isNotNull(shopSyncState.local)));
  return { brand, byShop: new Map(rows.map((r) => [r.shopId, d.read(toColumn(d, r.local, col)) as V])) };
}

/**
 * Bookkeeping the app keeps in brand_settings that isn't a setting anyone edits: which history
 * tables the event log has already backfilled.
 */
export async function noteBackfilled(table: string, tx: DBorTx = db) {
  await tx.execute(sql`update brand_settings set analytics = jsonb_set(analytics, '{backfilled}', coalesce(analytics->'backfilled', '[]'::jsonb) || to_jsonb(${table}::text))
    where id = 1 and not coalesce(analytics->'backfilled', '[]'::jsonb) ? ${table}`);
}

// ───────────────────────────── The adapter ─────────────────────────────

export const settingAdapter: SyncAdapter<unknown, unknown> = {
  type: "setting",
  noun: "Setting",
  area: "policies",
  store: "local",
  live: true,
  brandPerms: [...new Set(SETTINGS.flatMap((s) => s.perms))],
  lockable: false,
  paths: [...new Set(SETTINGS.flatMap((s) => s.paths))],
  items: async (): Promise<SyncItem[]> => SETTINGS.map((s) => ({ id: s.key, label: s.label, area: s.area, hint: s.hint ?? (s.wholeBrand ? "Same at every shop" : undefined) })),
  async brand(tx, ids) {
    const row = await brandRow(tx);
    return new Map(ids.flatMap((id) => (BY_KEY.has(id) ? [[id, BY_KEY.get(id)!.read(row[BY_KEY.get(id)!.column])] as const] : [])));
  },
  view: (b) => b,
  async parse(who, raw, item, before, tx) {
    const d = settingOf(item);
    return d.parse(raw, before ?? d.read(undefined), who, tx);
  },
  async write(tx, who, item, brand) {
    if (!brand || brand.to === null) return;
    const d = settingOf(item);
    const col = (await brandRow(tx))[d.column];
    await writeBrandColumn(tx, d.column, toColumn(d, brand.to, col) as never);
    await d.after?.(tx, brand.from, brand.to);
    await audit(who.actor, d.audit, "brand_settings", d.key, { setting: d.key, before: brand.from, after: brand.to, via: "brand_sync" }, null, tx);
  },
  describe: (v, item) => {
    const d = BY_KEY.get(item);
    return d?.describe ? d.describe(v) : describeValue(v, d?.label ?? "Value", d?.labels);
  },
  short: (v, item) => {
    const d = BY_KEY.get(item);
    return d?.short ? d.short(v) : shortOf(d?.describe ? d.describe(v) : describeValue(v, d?.label ?? "Value", d?.labels));
  },
  itemPerms: (item) => BY_KEY.get(item)?.perms ?? [],
  itemNote: (item) => BY_KEY.get(item)?.wholeBrand ?? BY_KEY.get(item)?.note,
  itemAtShops: (item) => !BY_KEY.get(item)?.wholeBrand,
  itemPaths: (item) => BY_KEY.get(item)?.paths ?? [],
  itemNoun: (item) => BY_KEY.get(item)?.label ?? "Setting",
  columns: [...BY_COLUMN.keys()],
};
