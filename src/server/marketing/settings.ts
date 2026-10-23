import { eq } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings } from "@/db/schema";
import { MarketingSettings, MarketingSettingsSchema, marketingSettings } from "@/domain/marketing";
import { Actor, audit } from "../audit";
import { AppError } from "../errors";

export async function loadMarketingSettings(tx: DBorTx = db): Promise<MarketingSettings> {
  const [b] = await tx.select({ m: brandSettings.marketing }).from(brandSettings).where(eq(brandSettings.id, 1));
  return marketingSettings(b?.m);
}

export async function saveMarketingSettings(input: unknown, actor: Actor): Promise<MarketingSettings> {
  const r = MarketingSettingsSchema.safeParse(input);
  if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the Campaign Center settings");
  if (r.data.quietStart === r.data.quietEnd) throw new AppError("bad_request", "Quiet hours need a different start and end");
  if (r.data.capPerMonth < r.data.capPerWeek) throw new AppError("bad_request", "The monthly limit can't be lower than the weekly limit");
  const before = await loadMarketingSettings();
  await db.update(brandSettings).set({ marketing: { ...r.data }, updatedAt: new Date() }).where(eq(brandSettings.id, 1));
  await audit(actor, "brand.campaign_center_settings", "brand_settings", "1", { before, after: r.data }, null);
  return r.data;
}
