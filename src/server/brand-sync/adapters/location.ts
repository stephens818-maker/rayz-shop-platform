import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { brandSettings, roles, shopHours, shops } from "@/db/schema";
import { SyncArea, clip, onOff } from "@/domain/brand-sync";
import { ReceiptBranding, receiptBranding } from "@/domain/connect";
import { hoursProblem } from "@/domain/hours";
import { DEFAULT_FIELDS, DEFAULT_KEYS, DefaultKey, DefaultSection, DefaultValue, brandDefaults, cleanPartial, columnPatch, formatDefault, isDefaultKey, parseDefault } from "@/domain/location-defaults";
import { DEFAULT_HOURS } from "@/domain/location-lifecycle";
import { audit } from "../../audit";
import { AppError } from "../../errors";
import { brandValue, putBrandValue } from "../store";
import type { SyncAdapter } from "../types";

// ───────────────────────────── Location defaults ─────────────────────────────

const SECTION_AREA: Record<DefaultSection, SyncArea> = { policies: "policies", notifications: "policies", booking: "branding", integrations: "app", roles: "roles" };
export const defaultArea = (key: DefaultKey): SyncArea => SECTION_AREA[DEFAULT_FIELDS[key].section];

const keyOf = (item: string): DefaultKey => {
  if (!isDefaultKey(item)) throw new AppError("bad_request", "Unknown setting");
  return item;
};
const jsonKey = (key: string) => sql`${key}::text`;

/** One location default (booking rules, policies wording, reminders, booking site, tracking IDs, the starting role) per item. */
export const locationDefaultAdapter: SyncAdapter<DefaultValue, DefaultValue> = {
  type: "location_default",
  columns: ["locationDefaults"],
  noun: "Location default",
  area: "policies",
  store: "native",
  live: true,
  brandPerms: ["settings.brand"],
  lockable: true,
  paths: ["/admin/brand-defaults", "/admin/settings"],
  items: async () => DEFAULT_KEYS.map((k) => ({ id: k, label: DEFAULT_FIELDS[k].label, area: defaultArea(k), hint: DEFAULT_FIELDS[k].hint })),
  async brand(tx, ids) {
    const [b] = await tx.select({ d: brandSettings.locationDefaults }).from(brandSettings).limit(1);
    const all = brandDefaults(b?.d);
    return new Map(ids.filter(isDefaultKey).map((k) => [k, all[k]]));
  },
  view: (b) => b,
  async parse(_who, raw, item, _before, tx) {
    const key = keyOf(item);
    const p = parseDefault(key, raw);
    if (!p.ok) throw new AppError("bad_request", `${DEFAULT_FIELDS[key].label}: ${p.error}`);
    if (DEFAULT_FIELDS[key].kind === "role") {
      const [r] = await tx.select({ key: roles.key, scope: roles.defaultScope }).from(roles).where(eq(roles.key, String(p.value)));
      if (!r || r.key === "shop_login" || r.scope === "all") throw new AppError("bad_request", "Pick a role for people who work at a shop");
    }
    return p.value;
  },
  async shops(tx, ids, shopIds, brand) {
    if (!shopIds.length) return new Map();
    const rows = await tx.select({ id: shops.id, o: shops.brandOverrides }).from(shops).where(inArray(shops.id, [...shopIds]));
    const out = new Map<string, { value: DefaultValue; follows: boolean }>();
    for (const r of rows) {
      const own = cleanPartial(r.o);
      for (const k of ids.filter(isDefaultKey)) out.set(`${r.id}|${k}`, k in own ? { value: own[k] as DefaultValue, follows: false } : { value: brand.get(k) as DefaultValue, follows: true });
    }
    return out;
  },
  async write(tx, who, item, brand, writes) {
    const key = keyOf(item);
    for (const [shopId, w] of writes) {
      if (w.follow) await tx.update(shops).set({ brandOverrides: sql`${shops.brandOverrides} - ${key}::text` }).where(eq(shops.id, shopId));
      else
        await tx
          .update(shops)
          .set({ brandOverrides: sql`${shops.brandOverrides} || jsonb_build_object(${jsonKey(key)}, ${JSON.stringify(w.value)}::jsonb)`, ...columnPatch({ [key]: w.value }) })
          .where(eq(shops.id, shopId));
      if (!w.follow) await audit(who.actor, "shop.location_override", "shop", shopId, { key, to: w.value, via: "brand_sync" }, shopId, tx);
    }
    if (brand)
      await tx
        .update(brandSettings)
        .set({ locationDefaults: sql`${brandSettings.locationDefaults} || jsonb_build_object(${jsonKey(key)}, ${JSON.stringify(brand.to)}::jsonb)`, updatedAt: new Date() })
        .where(eq(brandSettings.id, 1));
    const [b] = await tx.select({ d: brandSettings.locationDefaults }).from(brandSettings).limit(1);
    const patch = columnPatch({ [key]: brandDefaults(b?.d)[key] });
    if (Object.keys(patch).length) await tx.update(shops).set(patch).where(sql`not (${shops.brandOverrides} ? ${key})`);
    if (brand) await audit(who.actor, "brand.location_default", "brand_settings", key, { key, from: brand.from, to: brand.to, via: "brand_sync" }, null, tx);
  },
  describe: (v, item) => ({ [isDefaultKey(item) ? DEFAULT_FIELDS[item].label : "Value"]: isDefaultKey(item) ? formatDefault(item, v) : String(v) }),
  short: (v, item) => clip(isDefaultKey(item) ? formatDefault(item, v) : String(v), 28),
};

// ───────────────────────────── Hours template ─────────────────────────────

const HoursRow = z.object({ weekday: z.number().int().min(0).max(6), openMin: z.number().int().min(0).max(1440), closeMin: z.number().int().min(0).max(1440) });
export type HoursValue = z.output<typeof HoursRow>[];
const sortHours = (rows: HoursValue): HoursValue => [...rows].map((r) => ({ weekday: r.weekday, openMin: r.openMin, closeMin: r.closeMin })).sort((a, b) => a.weekday - b.weekday);
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const clock = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${((h + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${h < 12 || h === 24 ? "a" : "p"}`;
};

export const hoursAdapter: SyncAdapter<HoursValue, HoursValue> = {
  type: "hours",
  values: ["hours"],
  noun: "Hours template",
  area: "hours",
  store: "native",
  live: false,
  brandPerms: ["settings.brand"],
  lockable: true,
  note: "Pushing replaces the shop's weekly hours. Closed dates stay with each shop.",
  paths: ["/admin/settings", "/admin/brand-defaults"],
  items: async () => [{ id: "week", label: "Weekly opening hours" }],
  async brand(tx, ids) {
    if (!ids.includes("week")) return new Map();
    const stored = await brandValue<HoursValue>("hours", tx);
    return new Map([["week", sortHours(stored ? z.array(HoursRow).parse(stored) : DEFAULT_HOURS)]]);
  },
  view: sortHours,
  async parse(_who, raw) {
    const rows = z.array(HoursRow).max(7).parse(raw);
    const problem = hoursProblem(rows, { canSetSunday: true, currentSunday: null });
    if (problem) throw new AppError(problem.code, problem.message);
    return sortHours(rows);
  },
  async shops(tx, ids, shopIds) {
    if (!ids.includes("week") || !shopIds.length) return new Map();
    const rows = await tx.select().from(shopHours).where(inArray(shopHours.shopId, [...shopIds])).orderBy(asc(shopHours.weekday));
    return new Map(shopIds.map((id) => [`${id}|week`, { value: sortHours(rows.filter((r) => r.shopId === id)), follows: false }]));
  },
  async write(tx, who, _item, brand, writes) {
    if (brand?.to) {
      await putBrandValue(tx, "hours", brand.to, who.actor);
      await audit(who.actor, "brand.hours_template", "brand_settings", "1", { from: brand.from, to: brand.to }, null, tx);
    }
    for (const [shopId, w] of writes) {
      await tx.delete(shopHours).where(eq(shopHours.shopId, shopId));
      if (w.value.length) await tx.insert(shopHours).values(w.value.map((r) => ({ ...r, shopId })));
      await audit(who.actor, "shop.hours", "shop", shopId, { rows: w.value, via: "brand_sync" }, shopId, tx);
    }
  },
  describe: (v) => Object.fromEntries(DAY.map((d, i) => [d, ((r) => (r ? `${clock(r.openMin)}–${clock(r.closeMin)}` : "Closed"))(v.find((x) => x.weekday === i))])),
  short: (v) => {
    const open = v.length;
    const wk = v.find((r) => r.weekday >= 1 && r.weekday <= 5);
    return `${open} day${open === 1 ? "" : "s"}${wk ? ` · ${clock(wk.openMin)}–${clock(wk.closeMin)}` : ""}`;
  },
};

// ───────────────────────────── Receipt branding ─────────────────────────────

export const ReceiptInput = z.object({
  headline: z.string().trim().max(60).nullable(),
  footer: z.string().trim().max(200).nullable(),
  showLogo: z.boolean(),
  showAddress: z.boolean(),
  showPhone: z.boolean(),
  allowPrint: z.boolean(),
});
export type ReceiptValue = z.output<typeof ReceiptInput>;
/** The parts of a shop's receipt the brand sets. The review link and follow-up are each shop's own. */
export const receiptValue = (r: Pick<ReceiptBranding, keyof ReceiptValue>): ReceiptValue => ({
  headline: r.headline || null,
  footer: r.footer || null,
  showLogo: r.showLogo,
  showAddress: r.showAddress,
  showPhone: r.showPhone,
  allowPrint: r.allowPrint,
});

export const receiptAdapter: SyncAdapter<ReceiptValue, ReceiptValue> = {
  type: "receipt",
  values: ["receipt"],
  noun: "Receipt branding",
  area: "branding",
  store: "native",
  live: false,
  brandPerms: ["settings.brand"],
  lockable: true,
  note: "Each shop keeps its own Google review link and follow-up.",
  paths: ["/admin/settings", "/admin/brand-defaults"],
  items: async () => [{ id: "branding", label: "Receipt headline, footer and what it shows" }],
  async brand(tx, ids) {
    if (!ids.includes("branding")) return new Map();
    const stored = await brandValue<ReceiptValue>("receipt", tx);
    return new Map([["branding", receiptValue(stored ? { ...receiptBranding({}), ...ReceiptInput.partial().parse(stored) } : receiptBranding({}))]]);
  },
  view: (b) => receiptValue(b),
  async parse(_who, raw) {
    const v = ReceiptInput.parse(raw);
    return receiptValue(v);
  },
  async shops(tx, ids, shopIds) {
    if (!ids.includes("branding") || !shopIds.length) return new Map();
    const rows = await tx.select({ id: shops.id, r: shops.receipt }).from(shops).where(inArray(shops.id, [...shopIds]));
    return new Map(rows.map((r) => [`${r.id}|branding`, { value: receiptValue(receiptBranding(r.r)), follows: false }]));
  },
  async write(tx, who, _item, brand, writes) {
    if (brand?.to) {
      await putBrandValue(tx, "receipt", brand.to, who.actor);
      await audit(who.actor, "brand.receipt", "brand_settings", "1", { from: brand.from, to: brand.to }, null, tx);
    }
    for (const [shopId, w] of writes) {
      const [r] = await tx.select({ r: shops.receipt }).from(shops).where(eq(shops.id, shopId));
      const before = receiptBranding(r?.r);
      const after = { ...before, ...w.value };
      await tx.update(shops).set({ receipt: after as unknown as Record<string, unknown> }).where(eq(shops.id, shopId));
      await audit(who.actor, "shop.receipt", "shop", shopId, { before, after, via: "brand_sync" }, shopId, tx);
    }
  },
  describe: (v) => ({ Headline: clip(v.headline) === "—" ? "Default" : clip(v.headline), Footer: clip(v.footer) === "—" ? "Default" : clip(v.footer), Logo: onOff(v.showLogo), Address: onOff(v.showAddress), Phone: onOff(v.showPhone), "Print button": onOff(v.allowPrint) }),
  short: (v) => clip(v.headline, 24) === "—" ? "Default headline" : clip(v.headline, 24),
};
