import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { catalogCategories, products, services } from "@/db/schema";
import { Actor, audit } from "./audit";
import { AppError } from "./errors";

export type CategoryKind = "service" | "product";
export interface CategoryRow {
  name: string;
  /** Items in it now. */
  count: number;
}

/** A category's place in the list; ones not ordered yet go last, by name. */
export const UNORDERED = 100_000;

/** The brand's categories in order, with any in use but not yet ordered at the end. */
export async function listCategories(kind: CategoryKind): Promise<CategoryRow[]> {
  const table = kind === "service" ? services : products;
  const [ordered, used] = await Promise.all([
    db.select().from(catalogCategories).where(eq(catalogCategories.kind, kind)).orderBy(asc(catalogCategories.sortOrder), asc(catalogCategories.name)),
    db
      .select({ name: table.category, n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.active, true))
      .groupBy(table.category),
  ]);
  const count = new Map(used.map((u) => [u.name.toLowerCase(), u.n]));
  const known = new Set(ordered.map((o) => o.name.toLowerCase()));
  return [
    ...ordered.filter((o) => count.has(o.name.toLowerCase())).map((o) => ({ name: o.name, count: count.get(o.name.toLowerCase()) ?? 0 })),
    ...used
      .filter((u) => !known.has(u.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((u) => ({ name: u.name, count: u.n })),
  ];
}

/** Saves the category order as given; every category in use must be in it once. */
export async function saveCategoryOrder(kind: CategoryKind, names: string[], actor: Actor) {
  const current = await listCategories(kind);
  const want = new Set(current.map((c) => c.name.toLowerCase()));
  const got = names.map((n) => n.trim().toLowerCase());
  if (got.length !== want.size || new Set(got).size !== got.length || got.some((n) => !want.has(n))) throw new AppError("conflict", "The categories changed while you were ordering them. Reload and try again.");
  const byLower = new Map(current.map((c) => [c.name.toLowerCase(), c.name]));
  await db.transaction(async (tx) => {
    for (const [i, n] of got.entries()) {
      const name = byLower.get(n)!;
      const hit = await tx
        .update(catalogCategories)
        .set({ sortOrder: (i + 1) * 10, name })
        .where(and(eq(catalogCategories.kind, kind), sql`lower(${catalogCategories.name}) = ${n}`))
        .returning({ id: catalogCategories.id });
      if (!hit.length) await tx.insert(catalogCategories).values({ kind, name, sortOrder: (i + 1) * 10 });
    }
    await audit(actor, "catalog.category_order", "catalog_categories", kind, { order: got.map((n) => byLower.get(n)) }, null, tx);
  });
}
