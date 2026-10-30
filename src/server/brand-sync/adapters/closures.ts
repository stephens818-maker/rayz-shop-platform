import { and, inArray } from "drizzle-orm";
import { z } from "zod";
import { shopClosures } from "@/db/schema";
import { clip } from "@/domain/brand-sync";
import { audit } from "../../audit";
import { AppError } from "../../errors";
import { brandValue, brandValuesLike, dropBrandValue, putBrandValue } from "../store";
import type { SyncAdapter } from "../types";

/**
 * Holiday closures the brand sets: one item per date, closed or open at each shop. A shop's own
 * closed days (a burst pipe) are its own; the brand picks which shops close on a date and can open
 * them again the same way.
 */
export type ClosureValue = { closed: boolean; reason: string | null };

const PREFIX = "closure:";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ClosureInput = z.object({ closed: z.boolean(), reason: z.string().trim().max(60).nullable() });
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

export const closureAdapter: SyncAdapter<ClosureValue, ClosureValue> = {
  type: "closure",
  valuePrefixes: [PREFIX],
  noun: "Holiday closure",
  area: "hours",
  store: "native",
  live: false,
  brandPerms: ["settings.brand"],
  lockable: false,
  note: "Shops it goes to are closed (or open again) that day; online booking stops for the day. A shop's own closed days stay its own.",
  paths: ["/admin/settings", "/admin/brand-defaults", "/admin/calendar"],
  async items(tx) {
    const from = yesterday();
    const all = await brandValuesLike<ClosureValue>(PREFIX, tx);
    return [...all]
      .filter(([d]) => d >= from)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, v]) => ({ id: d, label: v.reason ? `${d} · ${v.reason}` : d }));
  },
  async brand(tx, ids) {
    const out = new Map<string, ClosureValue>();
    for (const d of ids) {
      const v = await brandValue<ClosureValue>(`${PREFIX}${d}`, tx);
      if (v) out.set(d, { closed: v.closed !== false, reason: v.reason ?? null });
    }
    return out;
  },
  view: (b) => ({ closed: b.closed, reason: b.reason || null }),
  async parse(_who, raw, item, before) {
    if (!DATE.test(item) || Number.isNaN(Date.parse(`${item}T00:00:00Z`))) throw new AppError("bad_request", "Pick a date");
    if (!before && item < yesterday()) throw new AppError("bad_request", "Pick a date that hasn't passed");
    const r = ClosureInput.safeParse({ ...(before ?? { closed: true, reason: null }), ...(raw && typeof raw === "object" ? raw : {}) });
    if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the closure");
    return { closed: r.data.closed, reason: r.data.reason || null };
  },
  async shops(tx, ids, shopIds) {
    if (!ids.length || !shopIds.length) return new Map();
    const rows = await tx.select().from(shopClosures).where(and(inArray(shopClosures.date, [...ids]), inArray(shopClosures.shopId, [...shopIds])));
    const at = new Map(rows.map((r) => [`${r.shopId}|${r.date}`, r.reason]));
    const out = new Map<string, { value: ClosureValue; follows: boolean }>();
    for (const shopId of shopIds) for (const d of ids) out.set(`${shopId}|${d}`, { value: at.has(`${shopId}|${d}`) ? { closed: true, reason: at.get(`${shopId}|${d}`) || null } : { closed: false, reason: null }, follows: false });
    return out;
  },
  async write(tx, who, item, brand, writes) {
    if (brand?.to === null) await dropBrandValue(tx, `${PREFIX}${item}`);
    else if (brand?.to) await putBrandValue(tx, `${PREFIX}${item}`, brand.to, who.actor);
    for (const [shopId, w] of writes) {
      await tx.delete(shopClosures).where(and(inArray(shopClosures.shopId, [shopId]), inArray(shopClosures.date, [item])));
      if (w.value.closed) await tx.insert(shopClosures).values({ shopId, date: item, reason: w.value.reason || "Closed" });
      await audit(who.actor, w.value.closed ? "shop.closure_add" : "shop.closure_remove", "shop", shopId, { date: item, reason: w.value.reason, via: "brand_sync" }, shopId, tx);
    }
  },
  describe: (v) => ({ Closed: v.closed ? "Closed" : "Open", Reason: v.closed ? clip(v.reason ?? "Closed", 48) : "—" }),
  short: (v) => (v.closed ? `Closed${v.reason ? ` · ${clip(v.reason, 24)}` : ""}` : "Open"),
};
