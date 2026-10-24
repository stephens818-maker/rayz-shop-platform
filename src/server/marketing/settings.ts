import { eq } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings } from "@/db/schema";
import { MarketingSettings, MarketingSettingsSchema, marketingSettings } from "@/domain/marketing";
import { OpeningsSettings, OpeningsSettingsSchema, openingsSettings, openingsTemplatesProblem } from "@/domain/openings";
import { Actor, audit } from "../audit";
import { AppError } from "../errors";

async function rawMarketing(tx: DBorTx = db): Promise<Record<string, unknown>> {
  const [b] = await tx.select({ m: brandSettings.marketing }).from(brandSettings).where(eq(brandSettings.id, 1));
  return b?.m && typeof b.m === "object" ? (b.m as Record<string, unknown>) : {};
}

export async function loadMarketingSettings(tx: DBorTx = db): Promise<MarketingSettings> {
  return marketingSettings(await rawMarketing(tx));
}

/** We have openings' rules, kept with the Campaign Center settings under `openings`. */
export async function loadOpeningsSettings(tx: DBorTx = db): Promise<OpeningsSettings> {
  return openingsSettings((await rawMarketing(tx)).openings);
}

export async function saveMarketingSettings(input: unknown, actor: Actor): Promise<MarketingSettings> {
  const r = MarketingSettingsSchema.safeParse(input);
  if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the Campaign Center settings");
  if (r.data.quietStart === r.data.quietEnd) throw new AppError("bad_request", "Quiet hours need a different start and end");
  if (r.data.capPerMonth < r.data.capPerWeek) throw new AppError("bad_request", "The monthly limit can't be lower than the weekly limit");
  const raw = await rawMarketing();
  const before = marketingSettings(raw);
  await db
    .update(brandSettings)
    .set({ marketing: { ...r.data, ...(raw.openings ? { openings: raw.openings } : {}) }, updatedAt: new Date() })
    .where(eq(brandSettings.id, 1));
  await audit(actor, "brand.campaign_center_settings", "brand_settings", "1", { before, after: r.data }, null);
  return r.data;
}

export async function saveOpeningsSettings(input: unknown, actor: Actor): Promise<OpeningsSettings> {
  const r = OpeningsSettingsSchema.safeParse(input);
  if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the We have openings settings");
  const problem = openingsTemplatesProblem(r.data.templates);
  if (problem) throw new AppError("bad_request", problem);
  const shops = Object.fromEntries(Object.entries(r.data.shops).filter(([, x]) => x.perDay !== null || x.perWeek !== null || x.approval !== null));
  const next = { ...r.data, shops };
  const raw = await rawMarketing();
  const before = openingsSettings(raw.openings);
  await db
    .update(brandSettings)
    .set({ marketing: { ...raw, openings: next }, updatedAt: new Date() })
    .where(eq(brandSettings.id, 1));
  await audit(actor, "brand.openings_settings", "brand_settings", "1", { before, after: next }, null);
  return next;
}
