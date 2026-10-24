import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings, products, services } from "@/db/schema";
import { type BrandStandards, type ContentPolicy, brandStandards, localContentAllowed, localPriceProblem, localServiceProblem, shopPolicyProblems } from "@/domain/brand-standards";
import { AppError, forbidden } from "./errors";

/**
 * Brand standards at the server: what a location may change of the brand's catalog and settings.
 * People with access to every shop (the brand) aren't held to them; everyone else is, franchisees
 * and location managers alike. Actions call these before saving.
 */

interface Editor {
  brandWide: boolean;
}

export async function loadStandards(): Promise<BrandStandards> {
  const [row] = await db.select({ standards: brandSettings.standards }).from(brandSettings).where(eq(brandSettings.id, 1));
  return brandStandards(row?.standards);
}

/** Refuses changes to shop settings the brand governs (only changed fields are checked). */
export async function assertShopPolicies(who: Editor, before: Record<string, unknown>, after: Record<string, unknown>) {
  if (who.brandWide) return;
  const problems = shopPolicyProblems(await loadStandards(), before, after);
  if (problems.length) throw forbidden(problems.join(". "));
}

/** A location's price, name and duration for a service, within the brand's standard for it. */
export async function assertLocalService(who: Editor, serviceId: string, o: { priceCents: number | null; nameOverride: string | null; durationMin: number | null }) {
  if (who.brandWide) return;
  const s = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!s) throw new AppError("not_found", "Service not found");
  const problem =
    localPriceProblem({ name: s.name, brandPriceCents: s.defaultPriceCents, localPrice: s.localPrice, priceFloorCents: s.priceFloorCents, priceCeilingCents: s.priceCeilingCents }, o.priceCents) ??
    localServiceProblem({ name: s.name, localName: s.localName, localDuration: s.localDuration }, { nameOverride: o.nameOverride, durationMin: o.durationMin });
  if (problem) throw forbidden(problem);
}

/** A location's retail price for a product, within the brand's standard for it. */
export async function assertLocalProductPrice(who: Editor, productId: string, priceCents: number) {
  if (who.brandWide) return;
  const p = await db.query.products.findFirst({ where: eq(products.id, productId) });
  if (!p) throw new AppError("not_found", "Product not found");
  const problem = localPriceProblem({ name: p.name, brandPriceCents: p.priceCents, localPrice: p.localPrice, priceFloorCents: p.priceFloorCents, priceCeilingCents: p.priceCeilingCents }, priceCents);
  if (problem) throw forbidden(problem);
}

/** Brand content (templates, badges, coupons) locations may only add to when the brand allows it. */
export async function assertLocalContent(who: Editor, k: ContentPolicy, label: string) {
  if (who.brandWide) return;
  if (!localContentAllowed(await loadStandards(), k)) throw forbidden(`${label} are the brand's; locations can't add their own`);
}
