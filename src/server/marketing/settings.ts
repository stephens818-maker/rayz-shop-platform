import { DBorTx, db } from "@/db";
import type { MarketingSettings } from "@/domain/marketing";
import type { OpeningsSettings } from "@/domain/openings";
import { settingAt } from "../brand-sync/settings";

/**
 * The Campaign Center settings at a shop. Sending from one shop (We have openings, the shop line's
 * HELP reply, quiet hours on its messages) uses that shop's; a blast or report across shops, and
 * each client's message caps across every campaign, use the brand's.
 */
export async function loadMarketingSettings(shopId?: string | null, tx: DBorTx = db): Promise<MarketingSettings> {
  return settingAt<MarketingSettings>("marketing", shopId, tx);
}

/** We have openings' rules at a shop, kept with the Campaign Center settings under `openings`. */
export async function loadOpeningsSettings(shopId?: string | null, tx: DBorTx = db): Promise<OpeningsSettings> {
  return settingAt<OpeningsSettings>("openings", shopId, tx);
}
