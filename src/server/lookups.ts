import { sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, products, services } from "@/db/schema";
import { LookupKey, Lookups, SavedLookups, cleanList, listProblem, resolveLookups } from "@/domain/lookups";
import { Actor, audit } from "./audit";
import { AppError } from "./errors";

export async function savedLookups(tx: DBorTx = db): Promise<SavedLookups> {
  const [b] = await tx.select({ l: brandSettings.lookups }).from(brandSettings).limit(1);
  return (b?.l ?? {}) as SavedLookups;
}

/** The lists, plus categories already used on the menu and in retail so nothing in use goes missing. */
export async function lookups(tx: DBorTx = db): Promise<Lookups> {
  const [saved, svc, prod] = await Promise.all([
    savedLookups(tx),
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

export async function saveLookup(key: LookupKey, items: string[], actor: Actor) {
  const problem = listProblem(items);
  if (problem) throw new AppError("bad_request", problem);
  const clean = cleanList(items);
  const before = (await savedLookups())[key] ?? null;
  await db.update(brandSettings).set({ lookups: sql`${brandSettings.lookups} || ${JSON.stringify({ [key]: clean })}::jsonb` });
  await audit(actor, "settings.lookups", "brand_settings", key, { key, before, after: clean }, null);
  return clean;
}
