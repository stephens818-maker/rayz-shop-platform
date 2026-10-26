import { and, asc, eq, isNotNull, isNull, like, ne } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx } from "@/db";
import {
  blockReasons,
  brandSyncValues,
  clientFields,
  customBadges,
  shopSyncState,
  staffCustomFields,
  staffMilestoneRules,
} from "@/db/schema";
import { onOff, syncKey } from "@/domain/brand-sync";
import type { Permission } from "@/domain/permissions";
import { audit } from "../audit";
import { AppError } from "../errors";
import { brandValue, putBrandValue, putState } from "./store";
import type { SyncAdapter, SyncItem, Who } from "./types";

/**
 * Brand lists: rows the brand keeps one list of (block reasons, client fields, staff fields, custom
 * badges, milestone rules). Each row is one sync item, "<list>:<row id>", whose value is whether
 * it's offered at a shop. A row's wording is the brand's; which shops have it goes through the
 * brand change scope like any setting. A row a shop has never been synced to follows the brand, so
 * a new list just works everywhere; a row made after this went out starts at no shop until the
 * brand picks its shops (markNewListItem). A new list table with no entry here fails
 * tests/db/brand-sync-coverage.test.ts.
 */

export interface ListDef {
  key: string;
  /** What one row is called: "Block reason". */
  noun: string;
  perms: readonly Permission[];
  paths: readonly string[];
  /** The rows that can be offered, in the editor's order. */
  rows(tx: DBorTx): Promise<SyncItem[]>;
  /** The table, for the coverage test. */
  table: string;
}

export const LISTS: readonly ListDef[] = [
  {
    key: "block_reason",
    noun: "Block reason",
    table: "block_reasons",
    perms: ["blocks.reasons"],
    paths: ["/admin/block-reasons", "/admin/calendar", "/admin/time-off"],
    rows: async (tx) =>
      (
        await tx
          .select({ id: blockReasons.id, label: blockReasons.label })
          .from(blockReasons)
          .where(
            and(
              isNull(blockReasons.archivedAt),
              ne(blockReasons.usedFor, "clock"),
            ),
          )
          .orderBy(asc(blockReasons.sortOrder), asc(blockReasons.label))
      ).map((r) => ({ id: r.id, label: r.label })),
  },
  {
    key: "client_field",
    noun: "Client field",
    table: "client_fields",
    perms: ["clients.privacy"],
    paths: ["/admin/client-data", "/admin/customers"],
    rows: async (tx) =>
      (
        await tx
          .select({ id: clientFields.id, label: clientFields.label })
          .from(clientFields)
          .where(eq(clientFields.active, true))
          .orderBy(asc(clientFields.sortOrder), asc(clientFields.label))
      ).map((r) => ({ id: r.id, label: r.label })),
  },
  {
    key: "staff_field",
    noun: "Employee field",
    table: "staff_custom_fields",
    perms: ["compensation.settings"],
    paths: ["/admin/compensation", "/admin/staff"],
    rows: async (tx) =>
      (
        await tx
          .select({ id: staffCustomFields.id, label: staffCustomFields.label })
          .from(staffCustomFields)
          .where(eq(staffCustomFields.active, true))
          .orderBy(
            asc(staffCustomFields.position),
            asc(staffCustomFields.label),
          )
      ).map((r) => ({
        id: r.id,
        label: r.label,
      })),
  },
  {
    key: "custom_badge",
    noun: "Custom badge",
    table: "custom_badges",
    perms: ["badges.settings"],
    paths: ["/admin/client-badges", "/admin/customers", "/admin/calendar"],
    rows: async (tx) =>
      (
        await tx
          .select({ id: customBadges.id, label: customBadges.label })
          .from(customBadges)
          .where(eq(customBadges.active, true))
          .orderBy(asc(customBadges.sortOrder), asc(customBadges.createdAt))
      ).map((r) => ({ id: r.id, label: r.label })),
  },
  {
    key: "milestone_rule",
    noun: "Milestone",
    table: "staff_milestone_rules",
    perms: ["milestones.settings"],
    paths: ["/admin/milestones", "/admin/milestones/settings"],
    rows: async (tx) =>
      (
        await tx
          .select({
            id: staffMilestoneRules.id,
            label: staffMilestoneRules.name,
          })
          .from(staffMilestoneRules)
          .where(eq(staffMilestoneRules.active, true))
          .orderBy(
            asc(staffMilestoneRules.sortOrder),
            asc(staffMilestoneRules.name),
          )
      ).map((r) => ({
        id: r.id,
        label: r.label,
      })),
  },
];

export type ListKey = (typeof LISTS)[number]["key"];
const BY_KEY = new Map(LISTS.map((l) => [l.key, l]));
export const listItem = (list: string, id: string) => `${list}:${id}`;
const split = (item: string) => {
  const i = item.indexOf(":");
  return { list: BY_KEY.get(item.slice(0, i)), id: item.slice(i + 1) };
};

export type ListValue = { available: boolean };
const ON: ListValue = { available: true };
const OFF: ListValue = { available: false };
const brandKey = (item: string) => syncKey("list", item);

/**
 * A row someone adds starts at no shop until the brand picks its shops (its editor opens the scope
 * next); someone who works at some shops only gets it at theirs. Rows a script adds (no person)
 * follow the brand. Call inside the row's insert.
 */
export async function markNewListItem(
  tx: DBorTx,
  list: ListKey,
  id: string,
  who: Who,
) {
  if (!who.ctx) return;
  const item = listItem(list, id);
  await putBrandValue(tx, brandKey(item), OFF, who.actor);
  if (who.ctx && !who.ctx.brandWide)
    for (const shopId of who.ctx.shopIds)
      await putState(tx, shopId, brandKey(item), "override", ON);
}

/**
 * The rows of a list a shop doesn't offer. No shop (brand-wide work): none, so the brand sees and
 * manages every row.
 */
export async function hiddenAt(
  list: ListKey,
  shopId: string | null | undefined,
  tx: DBorTx = db,
): Promise<Set<string>> {
  if (!shopId) return new Set();
  const prefix = `list:${list}:`;
  const [brand, own] = await Promise.all([
    tx
      .select({ key: brandSyncValues.key, value: brandSyncValues.value })
      .from(brandSyncValues)
      .where(like(brandSyncValues.key, `${prefix}%`)),
    tx
      .select({ key: shopSyncState.key, local: shopSyncState.local })
      .from(shopSyncState)
      .where(
        and(
          eq(shopSyncState.shopId, shopId),
          like(shopSyncState.key, `${prefix}%`),
          isNotNull(shopSyncState.local),
        ),
      ),
  ]);
  const at = new Map<string, boolean>();
  for (const r of brand)
    at.set(
      r.key.slice(prefix.length),
      (r.value as ListValue | null)?.available !== false,
    );
  for (const r of own)
    at.set(
      r.key.slice(prefix.length),
      (r.local as ListValue | null)?.available !== false,
    );
  return new Set([...at].filter(([, on]) => !on).map(([id]) => id));
}

/** hiddenAt for several shops: the shops each row isn't offered at. */
export async function hiddenAtShops(
  list: ListKey,
  shopIds: readonly string[],
  tx: DBorTx = db,
): Promise<(shopId: string | null | undefined) => Set<string>> {
  const ids = [...new Set(shopIds.filter(Boolean))];
  const sets = new Map(
    await Promise.all(
      ids.map(async (s) => [s, await hiddenAt(list, s, tx)] as const),
    ),
  );
  return (shopId) => (shopId && sets.get(shopId)) || new Set();
}

export const listAdapter: SyncAdapter<ListValue, ListValue> = {
  type: "list",
  noun: "List entry",
  area: "lists",
  store: "local",
  live: true,
  brandPerms: [...new Set(LISTS.flatMap((l) => l.perms))],
  lockable: false,
  note: "The entry's wording is the brand's. Shops it doesn't go to keep offering it, or not, as they do now.",
  paths: [...new Set(LISTS.flatMap((l) => l.paths))],
  async items(tx) {
    const all = await Promise.all(
      LISTS.map(async (l) =>
        (await l.rows(tx)).map((r) => ({
          id: listItem(l.key, r.id),
          label: r.label,
          hint: l.noun,
          area: "lists" as const,
        })),
      ),
    );
    return all.flat();
  },
  async brand(tx, ids) {
    const out = new Map<string, ListValue>();
    const byList = new Map<string, string[]>();
    for (const item of ids) {
      const { list, id } = split(item);
      if (list) byList.set(list.key, [...(byList.get(list.key) ?? []), id]);
    }
    for (const [key, rowIds] of byList) {
      const live = new Set((await BY_KEY.get(key)!.rows(tx)).map((r) => r.id));
      for (const id of rowIds) {
        if (!live.has(id)) continue;
        const item = listItem(key, id);
        out.set(item, (await brandValue<ListValue>(brandKey(item), tx)) ?? ON);
      }
    }
    return out;
  },
  view: (b) => ({ available: b.available !== false }),
  async parse(_who, raw, item, before) {
    if (!before)
      throw new AppError(
        "bad_request",
        "That entry isn't on the list any more",
      );
    if (!split(item).list) throw new AppError("bad_request", "Unknown list");
    return {
      available: z.object({ available: z.boolean() }).parse(raw).available,
    };
  },
  async write(tx, who, item, brand) {
    if (!brand?.to) return;
    await putBrandValue(tx, brandKey(item), brand.to, who.actor);
    await audit(
      who.actor,
      "brand.list_entry",
      "list",
      item,
      { before: brand.from, after: brand.to, via: "brand_sync" },
      null,
      tx,
    );
  },
  describe: (v) => ({ Offered: onOff(v.available) }),
  short: (v) => (v.available ? "Offered" : "Not offered"),
  itemPerms: (item) => split(item).list?.perms ?? [],
  itemPaths: (item) => split(item).list?.paths ?? [],
  itemNoun: (item) => split(item).list?.noun ?? "List entry",
  valuePrefixes: ["list:"],
};

/** Filters rows of a list to the ones a shop offers. */
export async function offeredAt<T extends { id: string }>(
  list: ListKey,
  shopId: string | null | undefined,
  rows: readonly T[],
  tx: DBorTx = db,
): Promise<T[]> {
  const hidden = await hiddenAt(list, shopId, tx);
  return hidden.size ? rows.filter((r) => !hidden.has(r.id)) : [...rows];
}
