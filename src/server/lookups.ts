import { db, DBorTx } from "@/db";
import { products, services } from "@/db/schema";
import { Lookups, SavedLookups, cleanList, resolveLookups } from "@/domain/lookups";
import { brandColumn } from "./brand-sync/settings";

/** The pick lists at a shop (the lookup.<key> settings); no shop, the brand's. They change through the brand change scope. */
export async function savedLookups(shopId?: string | null, tx: DBorTx = db): Promise<SavedLookups> {
  return ((await brandColumn("lookups", shopId, tx)) ?? {}) as SavedLookups;
}

/** The lists, plus categories already used on the menu and in retail so nothing in use goes missing. */
export async function lookups(shopId?: string | null, tx: DBorTx = db): Promise<Lookups> {
  const [saved, svc, prod] = await Promise.all([
    savedLookups(shopId, tx),
    tx.selectDistinct({ c: services.category }).from(services),
    tx.selectDistinct({ c: products.category }).from(products),
  ]);
  const l = resolveLookups(saved);
  return {
    ...l,
    serviceCategories: cleanList([...l.serviceCategories, ...svc.map((r) => r.c)]),
    productCategories: cleanList([...l.productCategories, ...prod.map((r) => r.c)]),
  };
}
