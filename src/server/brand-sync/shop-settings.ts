import { inArray } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx } from "@/db";
import { shops } from "@/db/schema";
import { SyncArea, SyncFormField, clip } from "@/domain/brand-sync";
import { AFTER_PAYMENT, DEFAULT_SHOP_HANDOFF, ShopHandoff, THANK_YOU_SECONDS, TIP_ENTRY, UNLOCK_RULES, effectiveTips, shopHandoff } from "@/domain/handoff";
import type { Permission } from "@/domain/permissions";
import { DEFAULT_OPERATOR, OPERATOR_ANSWER_LABEL, PhoneOperator, cleanOperator, operatorProblem } from "@/domain/phone-operator";
import { BrandTipPolicy, DEFAULT_SHOP_TIP_SETTINGS, METHOD_LABEL, SCHEDULE_LABEL, ShopTipSettings, TIP_METHODS, TIP_SCHEDULES, settingsProblem, shopTipSettings } from "@/domain/tips";
import { audit } from "../audit";
import { AppError } from "../errors";
import { brandValue, putBrandValue } from "./store";
import { describeValue, settingAt } from "./settings";
import type { SyncAdapter, SyncItem } from "./types";

/**
 * The shop settings registry: a setting each shop has in a column of its own (whether it takes
 * online bookings, its phone operator, its customer screen) with nothing brand-wide behind it. The
 * brand still sets it once and picks the shops: its value is kept in brand_sync_values and a sync
 * writes it into each shop's column. Shops keep editing their own; that shows as overridden. A
 * shops column that's a setting and has no entry here (or in another sync type) fails
 * tests/db/brand-sync-coverage.test.ts.
 */

export type ShopRow = typeof shops.$inferSelect;
export type ShopColumn = Exclude<keyof ShopRow, never>;

export interface ShopSettingDef<V extends Record<string, unknown> = Record<string, unknown>> {
  key: string;
  label: string;
  area: SyncArea;
  /** To change it for the brand. People also need every shop. */
  perms: readonly Permission[];
  paths: readonly string[];
  hint?: string;
  note?: string;
  /** The shops columns it's stored in (all of a column, or the part `read` takes). */
  columns: readonly ShopColumn[];
  /** The brand's value until the brand sets one. */
  builtin: V;
  /** The brand editor's form: one input per key of the value. */
  fields: readonly SyncFormField[];
  read(row: ShopRow): V;
  /** Validates an editor's value, merged over the current one. */
  parse(raw: Record<string, unknown>, before: V): V;
  /** The shop's columns with this value written in. Throws when it can't apply at that shop. */
  patch(v: V, row: ShopRow, tx: DBorTx): Partial<ShopRow> | Promise<Partial<ShopRow>>;
  audit: string;
  /** After the change commits, at the shops whose value changed (a card reader's tip screen). */
  afterCommit?(shopIds: readonly string[]): Promise<void>;
}

const def = <V extends Record<string, unknown>>(d: ShopSettingDef<V>): ShopSettingDef => d as unknown as ShopSettingDef;
const bad = (message: string): never => {
  throw new AppError("bad_request", message);
};
function zparse<T extends z.ZodType>(schema: T, raw: unknown, fallback: string): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) bad(r.error.issues[0]?.message ?? fallback);
  return (r as { data: z.output<T> }).data;
}
const choices = <K extends string>(keys: readonly K[], label: Record<K, string>) => keys.map((k) => ({ value: k, label: label[k] }));

type Screen = Omit<ShopHandoff, "tips">;
const screenOf = (h: ShopHandoff): Screen => ({ tipEntry: h.tipEntry, signature: h.signature, unlock: h.unlock, afterPayment: h.afterPayment, thankYouSeconds: h.thankYouSeconds });
const ScreenInput = z.object({
  tipEntry: z.enum(TIP_ENTRY),
  signature: z.boolean(),
  unlock: z.enum(UNLOCK_RULES),
  afterPayment: z.enum(AFTER_PAYMENT),
  thankYouSeconds: z
    .number()
    .int()
    .min(THANK_YOU_SECONDS.min, `The thank-you screen shows for ${THANK_YOU_SECONDS.min} to ${THANK_YOU_SECONDS.max} seconds`)
    .max(THANK_YOU_SECONDS.max, `The thank-you screen shows for ${THANK_YOU_SECONDS.min} to ${THANK_YOU_SECONDS.max} seconds`),
});

const OperatorInput = z.object({
  enabled: z.boolean(),
  answer: z.enum(["fallback", "first"]),
  minutesPerCall: z.number().int().min(1, "Minutes per call is 1 to 30").max(30, "Minutes per call is 1 to 30"),
  greeting: z.string().trim().max(300).nullable(),
  speech: z.boolean(),
  transcripts: z.boolean(),
});

export const SHOP_SETTINGS: readonly ShopSettingDef[] = [
  def<{ enabled: boolean }>({
    key: "online_booking",
    label: "Online booking",
    area: "policies",
    perms: ["settings.shop_booking"],
    paths: ["/admin/settings"],
    note: "A shop that isn't open yet, or books on another site, takes no online bookings whatever this says.",
    columns: ["bookingEnabled"],
    builtin: { enabled: true },
    fields: [{ key: "enabled", label: "Clients can book online", kind: "bool" }],
    read: (r) => ({ enabled: r.bookingEnabled }),
    parse: (raw, before) => zparse(z.object({ enabled: z.boolean() }), { ...before, ...raw }, "Turn online booking on or off"),
    patch: (v, r) => (r.status === "archived" ? {} : { bookingEnabled: v.enabled }),
    audit: "shop.settings",
  }),
  def<{ policy: "block" | "warn" }>({
    key: "negative_stock",
    label: "Selling with no stock on hand",
    area: "inventory",
    perms: ["inventory.manage"],
    paths: ["/admin/inventory/settings", "/admin/inventory"],
    columns: ["negativeStock"],
    builtin: { policy: "block" },
    fields: [{ key: "policy", label: "At checkout", kind: "choice", options: [{ value: "block", label: "Stop the sale" }, { value: "warn", label: "Warn and allow it" }] }],
    read: (r) => ({ policy: r.negativeStock }),
    parse: (raw, before) => zparse(z.object({ policy: z.enum(["block", "warn"]) }), { ...before, ...raw }, "Pick stop or warn"),
    patch: (v) => ({ negativeStock: v.policy }),
    audit: "inventory.settings",
  }),
  def<PhoneOperator & Record<string, unknown>>({
    key: "phone_operator",
    label: "Phone operator",
    area: "features",
    perms: ["settings.shop_phone"],
    paths: ["/admin/settings", "/admin/phone-agent"],
    note: "A shop needs its own Twilio number before the operator can answer there.",
    columns: ["phoneOperator"],
    builtin: { ...DEFAULT_OPERATOR },
    fields: [
      { key: "enabled", label: "Operator answers", kind: "bool" },
      { key: "answer", label: "When", kind: "choice", options: choices(["fallback", "first"], OPERATOR_ANSWER_LABEL) },
      { key: "minutesPerCall", label: "Minutes per call", kind: "number", min: 1, max: 30 },
      { key: "greeting", label: "Greeting (blank: thanks for calling the shop)", kind: "text", max: 300 },
      { key: "speech", label: "Callers can say what they want", kind: "bool" },
      { key: "transcripts", label: "Keep transcripts", kind: "bool" },
    ],
    read: (r) => cleanOperator(r.phoneOperator) as PhoneOperator & Record<string, unknown>,
    parse(raw, before) {
      const v = zparse(OperatorInput, { ...before, ...raw, greeting: (raw.greeting ?? before.greeting) || null }, "Check the phone operator");
      const problem = operatorProblem(v);
      if (problem) bad(problem);
      return cleanOperator(v) as PhoneOperator & Record<string, unknown>;
    },
    patch(v, r) {
      if (v.enabled && !r.twilioNumber) bad(`${r.name} has no Twilio number yet, so the operator can't answer there. Untick it, or give it a number first.`);
      return { phoneOperator: { ...v } };
    },
    audit: "shop.phone_operator",
  }),
  def<Screen & Record<string, unknown>>({
    key: "customer_screen",
    label: "Customer screen at checkout",
    area: "tips",
    perms: ["handoff.settings"],
    paths: ["/admin/settings"],
    note: "The tip presets are their own setting. With tips on the reader, each shop's Stripe Terminal readers are updated.",
    columns: ["handoff"],
    builtin: screenOf(DEFAULT_SHOP_HANDOFF) as Screen & Record<string, unknown>,
    fields: [
      { key: "tipEntry", label: "Client tips on", kind: "choice", options: [{ value: "screen", label: "This screen" }, { value: "reader", label: "The card reader" }] },
      { key: "signature", label: "Ask for a signature", kind: "bool" },
      { key: "unlock", label: "Who takes the device back", kind: "choice", options: [{ value: "staff", label: "Anyone at the shop" }, { value: "manager", label: "A manager" }] },
      { key: "afterPayment", label: "After paying", kind: "choice", options: [{ value: "auto", label: "Goes back to staff by itself" }, { value: "pin", label: "Waits for a PIN" }] },
      { key: "thankYouSeconds", label: "Thank-you screen (seconds)", kind: "number", min: THANK_YOU_SECONDS.min, max: THANK_YOU_SECONDS.max },
    ],
    read: (r) => screenOf(shopHandoff(r.handoff)) as Screen & Record<string, unknown>,
    parse: (raw, before) => zparse(ScreenInput, { ...before, ...raw }, "Check the customer screen") as Screen & Record<string, unknown>,
    patch: (v, r) => ({ handoff: { ...shopHandoff(r.handoff), ...screenOf(v as unknown as ShopHandoff) } as unknown as Record<string, unknown> }),
    audit: "handoff.settings",
    async afterCommit(shopIds) {
      const { brandHandoffConfig, syncReaderTipping } = await import("../handoff");
      const brand = await brandHandoffConfig();
      const rows = await db.select({ id: shops.id, h: shops.handoff }).from(shops).where(inArray(shops.id, [...shopIds]));
      for (const r of rows) {
        const h = shopHandoff(r.h);
        if (h.tipEntry === "reader") await syncReaderTipping(r.id, effectiveTips(h, brand)).catch((e: Error) => console.error(`Reader tips at ${r.id}: ${e.message}`));
      }
    },
  }),
  def<ShopTipSettings & Record<string, unknown>>({
    key: "tip_schedule",
    label: "Tip payout schedule",
    area: "payroll",
    perms: ["tips.settings"],
    paths: ["/admin/tips", "/admin/tips/settings"],
    note: "Which payout methods are allowed is the tip payout policy.",
    columns: ["tipPayouts"],
    builtin: { ...DEFAULT_SHOP_TIP_SETTINGS },
    fields: [
      { key: "schedule", label: "Pay tips out", kind: "choice", options: choices(TIP_SCHEDULES, SCHEDULE_LABEL) },
      { key: "cardDelayDays", label: "Card tips wait (days)", kind: "number", min: 0, max: 14 },
      { key: "weeklyDay", label: "Weekly on (0 Sunday to 6 Saturday)", kind: "number", min: 0, max: 6 },
      { key: "defaultMethod", label: "Default method", kind: "choice", options: choices(TIP_METHODS, METHOD_LABEL) },
      { key: "netCardFee", label: "Take the card fee out of card tips", kind: "bool" },
    ],
    read: (r) => shopTipSettings(r.tipPayouts) as ShopTipSettings & Record<string, unknown>,
    parse(raw, before) {
      const v = shopTipSettings({ ...before, ...raw });
      if (raw.schedule !== undefined && v.schedule !== raw.schedule) bad("Pick a payout schedule");
      return v as ShopTipSettings & Record<string, unknown>;
    },
    async patch(v, r, tx) {
      const policy = await settingAt<BrandTipPolicy>("tip_payouts", r.id, tx);
      const problem = settingsProblem(shopTipSettings(v, policy), policy);
      if (problem || shopTipSettings(v, policy).defaultMethod !== v.defaultMethod) bad(`${r.name}: ${problem ?? "the tip payout policy there doesn't allow that method"}`);
      return { tipPayouts: { ...v } };
    },
    audit: "tips.settings",
  }),
];

const BY_KEY = new Map(SHOP_SETTINGS.map((s) => [s.key, s]));
export const shopSettingDef = (key: string) => BY_KEY.get(key);
const defOf = (key: string): ShopSettingDef => BY_KEY.get(key) ?? bad("Unknown setting");
const PREFIX = "shop_setting:";

async function brandOf(d: ShopSettingDef, tx: DBorTx) {
  const stored = await brandValue<Record<string, unknown>>(`${PREFIX}${d.key}`, tx);
  return stored ? d.parse(stored, d.builtin) : d.builtin;
}

/** Each registered shop setting with the brand's value, for the brand's editor. */
export async function brandShopSettings(tx: DBorTx = db) {
  return Promise.all(SHOP_SETTINGS.map(async (d) => ({ key: d.key, label: d.label, hint: d.hint ?? null, note: d.note ?? null, fields: d.fields, perms: d.perms, value: await brandOf(d, tx) })));
}

/** After a shop saves its own value of one of these, so Sync status shows it as the shop's own. */
export async function noteShopSetting(key: string, shopId: string, tx: DBorTx = db) {
  const { noteShopEdit } = await import("./engine");
  await noteShopEdit("shop_setting", [key], shopId, tx);
}

export const shopSettingAdapter: SyncAdapter<Record<string, unknown>, Record<string, unknown>> = {
  type: "shop_setting",
  valuePrefixes: [PREFIX],
  noun: "Shop setting",
  area: "features",
  store: "native",
  live: false,
  brandPerms: [...new Set(SHOP_SETTINGS.flatMap((s) => s.perms))],
  lockable: false,
  paths: [...new Set(SHOP_SETTINGS.flatMap((s) => s.paths))],
  items: async (): Promise<SyncItem[]> => SHOP_SETTINGS.map((s) => ({ id: s.key, label: s.label, area: s.area, hint: s.hint })),
  async brand(tx, ids) {
    const out = new Map<string, Record<string, unknown>>();
    for (const id of ids) {
      const d = BY_KEY.get(id);
      if (d) out.set(id, await brandOf(d, tx));
    }
    return out;
  },
  view: (b) => ({ ...b }),
  async parse(_who, raw, item, before) {
    const d = defOf(item);
    return d.parse(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}, before ?? d.builtin);
  },
  async shops(tx, ids, shopIds) {
    const defs = ids.flatMap((id) => (BY_KEY.has(id) ? [BY_KEY.get(id)!] : []));
    if (!defs.length || !shopIds.length) return new Map();
    const rows = await tx.select().from(shops).where(inArray(shops.id, [...shopIds]));
    return new Map(rows.flatMap((r) => defs.map((d) => [`${r.id}|${d.key}`, { value: d.read(r), follows: false }] as const)));
  },
  async write(tx, who, item, brand, writes) {
    const d = defOf(item);
    if (brand?.to) {
      await putBrandValue(tx, `${PREFIX}${d.key}`, brand.to, who.actor);
      await audit(who.actor, d.audit, "brand_settings", d.key, { setting: d.key, before: brand.from, after: brand.to, via: "brand_sync" }, null, tx);
    }
    if (!writes.size) return;
    const rows = await tx.select().from(shops).where(inArray(shops.id, [...writes.keys()]));
    for (const r of rows) {
      const v = writes.get(r.id)!.value;
      const set = await d.patch(v, r, tx);
      if (!Object.keys(set).length) continue;
      await tx.update(shops).set(set).where(inArray(shops.id, [r.id]));
      await audit(who.actor, d.audit, "shop", r.id, { setting: d.key, before: d.read(r), after: v, via: "brand_sync" }, r.id, tx);
    }
  },
  async afterCommit(shopIds, items) {
    for (const item of items) await BY_KEY.get(item)?.afterCommit?.(shopIds);
  },
  describe: (v, item) => {
    const d = BY_KEY.get(item);
    const labels = Object.fromEntries((d?.fields ?? []).map((f) => [f.key, f.label]));
    const out = describeValue(v, d?.label ?? "Value", labels);
    for (const f of d?.fields ?? []) if (f.kind === "choice" && typeof v[f.key] === "string") out[f.label] = f.options.find((o) => o.value === v[f.key])?.label ?? String(v[f.key]);
    return out;
  },
  short: (v, item) => {
    const d = BY_KEY.get(item);
    const f = d?.fields[0];
    if (!f) return "";
    const x = v[f.key];
    if (f.kind === "bool") return x ? "On" : "Off";
    if (f.kind === "choice") return clip(f.options.find((o) => o.value === x)?.label ?? String(x), 32);
    return clip(String(x ?? "—"), 32);
  },
  itemPerms: (item) => BY_KEY.get(item)?.perms ?? [],
  itemNote: (item) => BY_KEY.get(item)?.note,
  itemPaths: (item) => BY_KEY.get(item)?.paths ?? [],
  itemNoun: (item) => BY_KEY.get(item)?.label ?? "Shop setting",
};
