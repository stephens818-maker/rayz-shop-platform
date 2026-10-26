import type { DBorTx } from "@/db";
import type { Native, SyncArea, SyncType } from "@/domain/brand-sync";
import type { Permission } from "@/domain/permissions";
import type { Actor } from "../audit";
import type { StaffContext } from "../auth/staff";

/** Who's making a change: a person in a request, or the scheduler running what they scheduled (no context). */
export interface Who {
  actor: Actor;
  ctx: StaffContext | null;
}

/** What to write at one shop: the brand value (follow) or a value of its own. */
export interface ShopWrite<V = unknown> {
  follow: boolean;
  value: V;
}

export interface SyncItem {
  id: string;
  label: string;
  area?: SyncArea;
  /** Shown under the label, e.g. a service's category. */
  hint?: string;
}

/**
 * One kind of brand-controlled setting. B is the brand's value as its editor saves it; V is the
 * part a shop uses, which is what's compared, previewed and synced.
 *
 * - "native": the shop's value lives where it always has (a shops column, shop_services, ...).
 *   `live` ones read the brand at run time while the shop has nothing of its own (null price,
 *   no override key); the rest hold a copy that a sync writes.
 * - "local": the setting used to be brand-only, so a shop's own value is kept in
 *   shop_sync_state.local (null follows the brand) and its readers resolve it per shop.
 */
export interface SyncAdapter<B = unknown, V = unknown> {
  type: SyncType;
  /** What one of these is called: "Service", "Card fee". */
  noun: string;
  area: SyncArea;
  store: "native" | "local";
  live: boolean;
  /** To change the brand value. People also need every shop. */
  brandPerms: readonly Permission[];
  /** Whether shop managers change their shop's own value somewhere, so the brand can lock it. */
  lockable: boolean;
  /** Shown in the sync dialog, e.g. what stays brand-wide. */
  note?: string;
  /** Pages to refresh after a change. */
  paths: readonly string[];
  items(tx: DBorTx): Promise<SyncItem[]>;
  /** The brand's current values; an item that doesn't exist yet is missing. */
  brand(tx: DBorTx, ids: readonly string[]): Promise<Map<string, B>>;
  view(b: B): V;
  /** A local setting's value at a shop where nothing applies yet (a new campaign template): stored for shops it doesn't go to. */
  absent?: V;
  /** Validates what the editor sent; `before` is the current brand value (null for a new item). */
  parse(who: Who, raw: unknown, item: string, before: B | null, tx: DBorTx): Promise<B>;
  /** Native settings: each shop's value, keyed "<shopId>|<item>". Missing: the setting doesn't apply there (a product it doesn't carry). */
  shops?(tx: DBorTx, ids: readonly string[], shopIds: readonly string[], brand: ReadonlyMap<string, B>): Promise<Map<string, Native<V>>>;
  /**
   * Writes the brand value (when `brand` is set) and the shops' values, in the order the storage
   * needs. A local setting's shop values are the engine's; it only passes the brand here.
   * `brand.to` null takes back an item a sync created (on undo).
   */
  write(tx: DBorTx, who: Who, item: string, brand: { from: B | null; to: B | null } | null, shops: ReadonlyMap<string, ShopWrite<V>>): Promise<void>;
  /** Field label to display text, for previews, the matrix and the history. */
  describe(v: V, item: string): Record<string, string>;
  /** One line for a matrix cell or tooltip. */
  short(v: V, item: string): string;
  /** After the change commits, for what can't happen inside it (a card reader's tip screen). Gets the shops whose value changed. */
  afterCommit?(shopIds: readonly string[]): Promise<void>;
  /** Who may lock or unlock shop edits; card fee keeps its own switch. */
  control?: { get(tx: DBorTx): Promise<boolean>; set(tx: DBorTx, who: Who, on: boolean): Promise<void> };
}

export type AnyAdapter = SyncAdapter<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
