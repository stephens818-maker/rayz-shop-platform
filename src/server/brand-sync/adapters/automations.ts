import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { marketingCampaigns, marketingLocationSettings } from "@/db/schema";
import { Native, clip, onOff } from "@/domain/brand-sync";
import { type Channel, TRIGGERS, type Templates, TemplatesSchema, isTriggerKey, templatesProblem, triggerSettings } from "@/domain/marketing";
import type { DBorTx } from "@/db";
import { audit } from "../../audit";
import { AppError, forbidden, notFound } from "../../errors";
import { AutomationInput, promoOk } from "../../marketing/campaigns";
import { channelsOf, templatesOf } from "../../marketing/engine";
import { brandValue, putBrandValue } from "../store";
import type { SyncAdapter } from "../types";

/**
 * Automated (trigger) campaigns. Each has two items: "on:<id>", whether it runs at a location, and
 * "wording:<id>", what it says and its timing settings. They're separate so the brand can switch a
 * campaign on at every shop without touching wording a location has of its own, and the other way
 * round. Channels and the coupon stay the brand's.
 */
type OnValue = { enabled: boolean };
type WordingBrand = { trigger: string; name: string; channels: Channel[]; templates: Templates; settings: Record<string, number>; promoId: string | null };
type WordingValue = { templates: Templates; settings: Record<string, number> };
type Brand = OnValue | WordingBrand;
type Value = OnValue | WordingValue;

const PREFIX = "automation:";
const split = (item: string) => {
  const i = item.indexOf(":");
  return { part: item.slice(0, i) as "on" | "wording", id: item.slice(i + 1) };
};
const isOn = (v: Brand | Value): v is OnValue => "enabled" in v;

async function campaigns(tx: DBorTx, ids?: readonly string[]) {
  return tx
    .select()
    .from(marketingCampaigns)
    .where(and(eq(marketingCampaigns.kind, "trigger"), ids ? inArray(marketingCampaigns.id, ids.length ? [...ids] : [crypto.randomUUID()]) : undefined))
    .orderBy(asc(marketingCampaigns.name));
}

const wordingOf = (c: typeof marketingCampaigns.$inferSelect): WordingBrand => ({
  trigger: c.trigger ?? "",
  name: c.name,
  channels: channelsOf(c.channels),
  templates: templatesOf(c.templates),
  settings: isTriggerKey(c.trigger) ? triggerSettings(c.trigger, c.settings) : { ...c.settings },
  promoId: c.promoId,
});

export const automationAdapter: SyncAdapter<Brand, Value> = {
  type: "automation",
  valuePrefixes: [PREFIX],
  noun: "Automated campaign",
  area: "marketing",
  store: "native",
  live: true,
  brandPerms: ["campaign_center.create", "campaign_center.send"],
  lockable: false,
  note: "Locations can still switch a campaign on or off and give it their own wording; channels and the coupon are the brand's.",
  paths: ["/admin/campaign-center", "/admin/campaign-center/automations"],
  async items(tx) {
    const rows = await campaigns(tx);
    return rows.flatMap((c) => [
      { id: `on:${c.id}`, label: `${c.name}: on or off` },
      { id: `wording:${c.id}`, label: `${c.name}: wording` },
    ]);
  },
  async brand(tx, ids) {
    const rows = await campaigns(tx, ids.map((i) => split(i).id));
    const out = new Map<string, Brand>();
    for (const item of ids) {
      const { part, id } = split(item);
      const c = rows.find((r) => r.id === id);
      if (!c) continue;
      if (part === "on") out.set(item, { enabled: (await brandValue<OnValue>(`${PREFIX}${id}`, tx))?.enabled === true });
      else if (part === "wording") out.set(item, wordingOf(c));
    }
    return out;
  },
  view: (b) => (isOn(b) ? { enabled: b.enabled } : { templates: { ...b.templates }, settings: { ...b.settings } }),
  async parse(who, raw, item, before) {
    if (!before) throw notFound("Campaign");
    const { part } = split(item);
    const perms = who.ctx?.permissions;
    if (part === "on") {
      if (perms && !perms.has("campaign_center.send")) throw forbidden("Switching a campaign on or off needs Campaign Center: send");
      return { enabled: z.object({ enabled: z.boolean() }).parse(raw).enabled };
    }
    if (perms && !perms.has("campaign_center.create")) throw forbidden("Changing a campaign's wording needs Campaign Center: create");
    const b = before as WordingBrand;
    const r = AutomationInput.safeParse({ name: b.name, channels: b.channels, templates: b.templates, settings: b.settings, promoId: b.promoId, ...(raw && typeof raw === "object" ? raw : {}) });
    if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the campaign");
    if (!isTriggerKey(b.trigger)) throw new AppError("bad_request", "That isn't an automated campaign");
    const promo = await promoOk(r.data.promoId);
    const templates = TemplatesSchema.parse(r.data.templates);
    const problem = templatesProblem(templates, r.data.channels, { hasCoupon: !!promo, extraFields: Object.keys(TRIGGERS[b.trigger].fields ?? {}) });
    if (problem) throw new AppError("bad_request", problem);
    return { trigger: b.trigger, name: r.data.name, channels: r.data.channels, templates, settings: triggerSettings(b.trigger, r.data.settings), promoId: promo?.id ?? null };
  },
  async shops(tx, ids, shopIds, brand) {
    if (!ids.length || !shopIds.length) return new Map();
    const campaignIds = [...new Set(ids.map((i) => split(i).id))];
    const rows = await tx.select().from(marketingLocationSettings).where(and(inArray(marketingLocationSettings.campaignId, campaignIds), inArray(marketingLocationSettings.shopId, [...shopIds])));
    const at = new Map(rows.map((r) => [`${r.shopId}|${r.campaignId}`, r]));
    const wording = new Map<string, WordingBrand>();
    for (const c of await campaigns(tx, campaignIds)) wording.set(c.id, wordingOf(c));
    const out = new Map<string, Native<Value>>();
    for (const item of ids) {
      const { part, id } = split(item);
      const w = (brand.get(`wording:${id}`) as WordingBrand | undefined) ?? wording.get(id);
      if (!w) continue;
      for (const shopId of shopIds) {
        const l = at.get(`${shopId}|${id}`);
        if (part === "on") out.set(`${shopId}|${item}`, { value: { enabled: !!l?.enabled }, follows: false });
        else
          out.set(`${shopId}|${item}`, {
            value: { templates: templatesOf(w.templates, l?.templates), settings: isTriggerKey(w.trigger) ? triggerSettings(w.trigger, { ...w.settings, ...(l?.settings ?? {}) }) : { ...w.settings } },
            follows: !l || (l.templates === null && l.settings === null),
            // Wording or timings the location left blank read the brand's.
            ...(l && (l.templates !== null || l.settings !== null) ? { partial: true } : {}),
          });
      }
    }
    return out;
  },
  async write(tx, who, item, brand, writes) {
    const { part, id } = split(item);
    if (brand?.to && isOn(brand.to)) await putBrandValue(tx, `${PREFIX}${id}`, brand.to, who.actor);
    else if (brand?.to) {
      const b = brand.to as WordingBrand;
      await tx.update(marketingCampaigns).set({ name: b.name, channels: b.channels, templates: { ...b.templates }, settings: b.settings, promoId: b.promoId, updatedAt: new Date() }).where(eq(marketingCampaigns.id, id));
      await audit(who.actor, "campaign_center.automation_saved", "marketing_campaign", id, { trigger: b.trigger, channels: b.channels, settings: b.settings, promoId: b.promoId, via: "brand_sync" }, null, tx);
    }
    for (const [shopId, w] of writes) {
      const set =
        part === "on"
          ? { enabled: (w.value as OnValue).enabled }
          : w.follow
            ? { templates: null, settings: null }
            : { templates: { ...(w.value as WordingValue).templates } as Record<string, string>, settings: { ...(w.value as WordingValue).settings } };
      await tx
        .insert(marketingLocationSettings)
        .values({ campaignId: id, shopId, enabled: false, ...set, updatedBy: who.actor.staffId ?? null, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [marketingLocationSettings.campaignId, marketingLocationSettings.shopId], set: { ...set, updatedBy: who.actor.staffId ?? null, updatedAt: new Date() } });
      if (part === "on") await audit(who.actor, (w.value as OnValue).enabled ? "campaign_center.automation_on" : "campaign_center.automation_off", "marketing_campaign", id, { via: "brand_sync" }, shopId, tx);
    }
  },
  describe: (v): Record<string, string> =>
    isOn(v)
      ? { Running: onOff(v.enabled) }
      : { Text: clip(v.templates.sms, 60), "Email subject": clip(v.templates.emailSubject, 60), "Push title": clip(v.templates.pushTitle, 60), ...Object.fromEntries(Object.entries(v.settings).map(([k, n]) => [k, String(n)])) },
  short: (v) => (isOn(v) ? (v.enabled ? "On" : "Off") : clip(v.templates.sms || v.templates.emailSubject || v.templates.pushTitle, 32) || "No wording"),
  itemPerms: (item) => (split(item).part === "on" ? ["campaign_center.send"] : ["campaign_center.create"]),
  itemNoun: (item) => (split(item).part === "on" ? "Automated campaign on/off" : "Automated campaign wording"),
};
