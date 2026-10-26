import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, shops } from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { matchCustomer } from "./customers";
import { readSquireCsv, shopFinder } from "./importer";

export interface ShopMatchLine {
  shop: string;
  rows: number;
  /** Squire's walk-in placeholders and rows with no name: not imported. */
  skipped: number;
  newProfiles: number;
  bySquireId: number;
  byEmail: number;
  byPhone: number;
  /** No phone and no email: the client can't sign in until the desk adds one. */
  noContact: number;
  /** A number several people in the file share (a family, a shop phone): sign-in asks which profile, never lists them. */
  sharedPhone: number;
  /** A number already on another profile here that the row doesn't match by name. */
  phoneOnOtherProfile: number;
}

/**
 * Before a clients import (C21): how each shop's Squire clients will land, one line per shop, from a
 * read-only pass with the importer's own matching. Shared and reused numbers are where a wrong person
 * could sign in, so they're counted for the desk to check before the shop moves.
 */
export async function clientMatchReport(csv: string): Promise<ShopMatchLine[]> {
  const { rows, get } = readSquireCsv("clients", csv);
  const findShop = shopFinder(await db.select().from(shops));
  const phoneCount = new Map<string, Set<string>>();
  const parsed = rows.map((r, i) => {
    const phone = normalizePhone(get(r, "phone"));
    const key = get(r, "squireId") ?? `row${i}`;
    if (phone) phoneCount.set(phone, (phoneCount.get(phone) ?? new Set()).add(key));
    const [first, ...rest] = (get(r, "fullName") ?? "").split(/\s+/).filter(Boolean);
    return {
      shop: findShop(get(r, "shop"))?.name ?? (get(r, "shop") ? `Unknown shop: ${get(r, "shop")}` : "No shop"),
      squireId: get(r, "squireId"),
      firstName: get(r, "firstName") ?? first,
      lastName: get(r, "lastName") ?? (rest.join(" ") || undefined),
      phone,
      email: normalizeEmail(get(r, "email")),
    };
  });
  const phones = [...phoneCount.keys()];
  const onFile = phones.length
    ? new Map(
        (
          await db
            .select({ phone: customers.phone, n: sql<number>`count(*)::int` })
            .from(customers)
            .where(inArray(customers.phone, phones))
            .groupBy(customers.phone)
        ).map((r) => [r.phone!, r.n]),
      )
    : new Map<string, number>();
  const lines = new Map<string, ShopMatchLine>();
  for (const p of parsed) {
    const l = lines.get(p.shop) ?? { shop: p.shop, rows: 0, skipped: 0, newProfiles: 0, bySquireId: 0, byEmail: 0, byPhone: 0, noContact: 0, sharedPhone: 0, phoneOnOtherProfile: 0 };
    lines.set(p.shop, l);
    l.rows++;
    if (!p.firstName || /^(walk[\s-]?in|guest|no name|unknown|n\/a|none|client)$/i.test(`${p.firstName} ${p.lastName ?? ""}`.trim())) {
      l.skipped++;
      continue;
    }
    if (!p.phone && !p.email) l.noContact++;
    if (p.phone && (phoneCount.get(p.phone)?.size ?? 0) > 1) l.sharedPhone++;
    const m = await matchCustomer(db, { squireIds: p.squireId ? [p.squireId] : [], firstName: p.firstName, lastName: p.lastName, phone: p.phone, email: p.email });
    if (!m) {
      l.newProfiles++;
      if (p.phone && (onFile.get(p.phone) ?? 0) > 0) l.phoneOnOtherProfile++;
    } else if (m.via === "squire_id") l.bySquireId++;
    else if (m.via === "email") l.byEmail++;
    else l.byPhone++;
  }
  return [...lines.values()].sort((a, b) => b.rows - a.rows);
}
