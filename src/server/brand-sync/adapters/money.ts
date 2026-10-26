import { eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { brandSettings, shops } from "@/db/schema";
import { clip, money, onOff, pct } from "@/domain/brand-sync";
import { CardFeeOverride, CardFeePolicy, OVERRIDE_KEYS, brandCardFeePolicy, cleanOverride, policyDiff, policyProblem, shopCardFeePolicy } from "@/domain/card-fee-policy";
import { TipScreen, TipScreenSchema, brandHandoff, effectiveTips, shopHandoff } from "@/domain/handoff";
import { audit } from "../../audit";
import { AppError } from "../../errors";
import { auditShops, brandFeePolicy, commitFeeChange, saveBrandRow } from "../../payments/card-fee";
import { brandValue, putBrandValue } from "../store";
import type { SyncAdapter } from "../types";

// ───────────────────────────── Card fee ─────────────────────────────

/** The surcharge settings a shop can have its own of. Which shops the brand applies it to stays on the card fee page. */
export type CardFeeValue = Required<Pick<CardFeePolicy, (typeof OVERRIDE_KEYS)[number]>>;
const feeValue = (p: CardFeePolicy): CardFeeValue => Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, p[k]])) as CardFeeValue;
const FEE_TYPE: Record<string, string> = { percent: "Percent", flat: "Flat amount", both: "Percent + flat" };
const listOn = (o: Record<string, boolean>) =>
  Object.entries(o)
    .filter(([, v]) => v)
    .map(([k]) => k.replace(/_/g, " "))
    .join(", ") || "None";

export const cardFeeAdapter: SyncAdapter<CardFeePolicy, CardFeeValue> = {
  type: "card_fee",
  noun: "Card surcharge",
  area: "card_fee",
  store: "native",
  live: true,
  brandPerms: ["settings.card_fee"],
  lockable: true,
  note: "Which shops the brand applies the surcharge to stays under Setup → Credit card surcharge.",
  paths: ["/admin/card-fee", "/admin/settings"],
  items: async () => [{ id: "brand", label: "Credit card surcharge" }],
  async brand(tx, ids) {
    return ids.includes("brand") ? new Map([["brand", await brandFeePolicy(tx)]]) : new Map();
  },
  view: feeValue,
  async parse(_who, raw, _item, before, tx) {
    const clean = brandCardFeePolicy({ ...(before ?? {}), ...(raw && typeof raw === "object" ? raw : {}) });
    const problem = policyProblem(clean);
    if (problem) throw new AppError("bad_request", problem);
    if (clean.appliesTo === "selected") {
      const known = new Set((await tx.select({ id: shops.id }).from(shops)).map((s) => s.id));
      if (clean.shopIds.some((id) => !known.has(id))) throw new AppError("bad_request", "One of the selected shops no longer exists");
    }
    return clean;
  },
  async shops(tx, ids, shopIds, brand) {
    const b = brand.get("brand");
    if (!ids.includes("brand") || !b || !shopIds.length) return new Map();
    const rows = await tx.select({ id: shops.id, o: shops.cardFeeOverride }).from(shops).where(inArray(shops.id, [...shopIds]));
    return new Map(rows.map((r) => [`${r.id}|brand`, { value: feeValue(shopCardFeePolicy(b, r.o)), follows: !cleanOverride(b, r.o) }]));
  },
  async write(tx, who, _item, brand, writes) {
    const before = brand?.from ?? (await brandFeePolicy(tx));
    const after = brand?.to ?? before;
    const overrides = new Map<string, CardFeeOverride | null>([...writes].map(([shopId, w]) => [shopId, w.follow ? null : cleanOverride(after, w.value)]));
    const changes = await commitFeeChange(tx, before, after, overrides);
    if (brand?.to) {
      await saveBrandRow(tx, after);
      await audit(who.actor, "card_fee.brand", "brand_settings", null, { changes: policyDiff(before, after), after, shopIds: changes.map((c) => c.shopId), shops: changes, via: "brand_sync" }, null, tx);
    }
    await auditShops(tx, who.actor, "brand_sync", changes);
  },
  describe: (v) => ({
    Surcharge: onOff(v.enabled),
    Type: FEE_TYPE[v.type] ?? v.type,
    Rate: v.type === "flat" ? "—" : pct(v.rate),
    "Flat amount": v.type === "percent" ? "—" : money(v.flatCents),
    "On tips": onOff(v.appliesToTip),
    Cap: money(v.capCents),
    Minimum: money(v.minCents),
    Notice: clip(v.notice),
    Channels: listOn(v.channels),
    "Other cards": listOn(v.funding),
  }),
  short: (v) => (!v.enabled ? "Off" : v.type === "flat" ? money(v.flatCents) : v.type === "both" ? `${pct(v.rate)} + ${money(v.flatCents)}` : pct(v.rate)),
  control: {
    get: async (tx) => (await brandFeePolicy(tx)).shopsCanEdit,
    async set(tx, who, on) {
      const p = await brandFeePolicy(tx);
      await saveBrandRow(tx, { ...p, shopsCanEdit: on });
      await audit(who.actor, "card_fee.brand", "brand_settings", null, { changes: policyDiff(p, { ...p, shopsCanEdit: on }), via: "brand_sync.control" }, null, tx);
    },
  },
};

// ───────────────────────────── Taxes ─────────────────────────────

export const TaxInput = z.object({ serviceRate: z.number().min(0).max(0.2), productRate: z.number().min(0).max(0.2) });
export type TaxValue = z.output<typeof TaxInput>;
const rate = (n: number) => Number(n.toFixed(5));

export const taxesAdapter: SyncAdapter<TaxValue, TaxValue> = {
  type: "taxes",
  noun: "Tax rates",
  area: "taxes",
  store: "native",
  live: false,
  brandPerms: ["settings.taxes"],
  lockable: true,
  note: "Sales tax depends on where each shop is. Check local rates before you push them.",
  paths: ["/admin/settings", "/admin/taxes"],
  items: async () => [{ id: "rates", label: "Sales tax rates" }],
  async brand(tx, ids) {
    if (!ids.includes("rates")) return new Map();
    const stored = await brandValue<TaxValue>("taxes", tx);
    if (stored) return new Map([["rates", TaxInput.parse(stored)]]);
    // Until the brand sets its own, the rates most shops use.
    const rows = await tx.select({ s: shops.serviceTaxRate, p: shops.productTaxRate }).from(shops).where(ne(shops.status, "archived"));
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(`${Number(r.s)}|${Number(r.p)}`, (counts.get(`${Number(r.s)}|${Number(r.p)}`) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "0|0";
    const [s, p] = top.split("|").map(Number);
    return new Map([["rates", { serviceRate: s, productRate: p }]]);
  },
  view: (b) => ({ serviceRate: rate(b.serviceRate), productRate: rate(b.productRate) }),
  async parse(_who, raw) {
    const v = TaxInput.parse(raw);
    return { serviceRate: rate(v.serviceRate), productRate: rate(v.productRate) };
  },
  async shops(tx, ids, shopIds) {
    if (!ids.includes("rates") || !shopIds.length) return new Map();
    const rows = await tx.select({ id: shops.id, s: shops.serviceTaxRate, p: shops.productTaxRate }).from(shops).where(inArray(shops.id, [...shopIds]));
    return new Map(rows.map((r) => [`${r.id}|rates`, { value: { serviceRate: rate(Number(r.s)), productRate: rate(Number(r.p)) }, follows: false }]));
  },
  async write(tx, who, _item, brand, writes) {
    if (brand?.to) {
      await putBrandValue(tx, "taxes", brand.to, who.actor);
      await audit(who.actor, "brand.tax_rates", "brand_settings", "1", { from: brand.from, to: brand.to }, null, tx);
    }
    for (const [shopId, w] of writes) {
      const [before] = await tx.select({ s: shops.serviceTaxRate, p: shops.productTaxRate }).from(shops).where(eq(shops.id, shopId));
      await tx
        .update(shops)
        .set({ serviceTaxRate: w.value.serviceRate.toFixed(5), productTaxRate: w.value.productRate.toFixed(5) })
        .where(eq(shops.id, shopId));
      await audit(who.actor, "shop.tax_fee", "shop", shopId, { before: before && { serviceTaxRate: before.s, productTaxRate: before.p }, after: w.value, via: "brand_sync" }, shopId, tx);
    }
  },
  describe: (v) => ({ "Service tax": pct(v.serviceRate, 3), "Product tax": pct(v.productRate, 3) }),
  short: (v) => `${pct(v.serviceRate, 3)} / ${pct(v.productRate, 3)}`,
};

// ───────────────────────────── Tip presets ─────────────────────────────

export const tipsAdapter: SyncAdapter<TipScreen, TipScreen> = {
  type: "tips",
  noun: "Tip presets",
  area: "tips",
  store: "native",
  live: true,
  brandPerms: ["handoff.settings"],
  lockable: true,
  paths: ["/admin/settings", "/admin/tips"],
  items: async () => [{ id: "screen", label: "Tip presets on the customer screen" }],
  async brand(tx, ids) {
    if (!ids.includes("screen")) return new Map();
    const [b] = await tx.select({ h: brandSettings.handoff }).from(brandSettings).where(eq(brandSettings.id, 1));
    return new Map([["screen", brandHandoff(b?.h).tips]]);
  },
  view: (b) => ({ type: b.type, values: [...b.values], allowCustom: b.allowCustom, allowNoTip: b.allowNoTip }),
  async parse(_who, raw) {
    const t = TipScreenSchema.parse(raw);
    return { type: t.type, values: [...t.values], allowCustom: t.allowCustom, allowNoTip: t.allowNoTip };
  },
  async shops(tx, ids, shopIds, brand) {
    const b = brand.get("screen");
    if (!b || !shopIds.length) return new Map();
    const rows = await tx.select({ id: shops.id, h: shops.handoff }).from(shops).where(inArray(shops.id, [...shopIds]));
    return new Map(
      rows.map((r) => {
        const h = shopHandoff(r.h);
        return [`${r.id}|screen`, { value: effectiveTips(h, { tips: b }), follows: !h.tips }];
      }),
    );
  },
  async write(tx, who, _item, brand, writes) {
    if (brand?.to) {
      await tx
        .update(brandSettings)
        .set({ handoff: { tips: brand.to } as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(brandSettings.id, 1));
      await audit(who.actor, "handoff.brand_settings", "brand_settings", "1", { before: { tips: brand.from }, after: { tips: brand.to }, via: "brand_sync" }, null, tx);
    }
    const [b] = await tx.select({ h: brandSettings.handoff }).from(brandSettings).where(eq(brandSettings.id, 1));
    const current = brandHandoff(b?.h).tips;
    const rows = await tx.select({ id: shops.id, h: shops.handoff }).from(shops);
    for (const r of rows) {
      const h = shopHandoff(r.h);
      const w = writes.get(r.id);
      const tips = w ? (w.follow ? null : w.value) : h.tips;
      if (!w && tips) continue;
      const eff = tips ?? current;
      await tx
        .update(shops)
        .set({ ...(w ? { handoff: { ...h, tips } as unknown as Record<string, unknown> } : {}), ...(eff.type === "percent" ? { tipPresets: eff.values } : {}) })
        .where(eq(shops.id, r.id));
      if (w) await audit(who.actor, "handoff.settings", "shop", r.id, { before: h, after: { ...h, tips }, via: "brand_sync" }, r.id, tx);
    }
  },
  describe: (v) => ({
    Presets: v.values.map((x) => (v.type === "percent" ? `${x}%` : money(x * 100))).join(", ") || "None",
    "Custom amount": onOff(v.allowCustom),
    "No tip": onOff(v.allowNoTip),
  }),
  short: (v) => v.values.map((x) => (v.type === "percent" ? `${x}%` : `$${x}`)).join(" · ") || "None",
};
