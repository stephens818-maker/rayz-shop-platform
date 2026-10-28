import { and, asc, desc, eq, lte, ne, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSyncBatches, brandSyncChanges, shops, type BrandSyncBatchKind } from "@/db/schema";
import {
  AREA_LABEL,
  BULK_LABEL,
  BulkAction,
  CellAction,
  CellState,
  CellStatus,
  FieldChange,
  Native,
  OverrideChoice,
  SCOPE_LABEL,
  SyncArea,
  SyncMode,
  SyncScope,
  SyncType,
  bulkCell,
  fieldChanges,
  modeOf,
  parseSyncKey,
  planCell,
  same,
  scheduleProblem,
  scopeSummary,
  statusOf,
  syncKey,
  targetShops,
  unchangedSince,
} from "@/domain/brand-sync";
import { audit } from "../audit";
import { AppError, forbidden, notFound } from "../errors";
import { ADAPTERS, areaOf } from "./registry";
import { StateRow, controlRows, dropStates, lockSync, putControl, putState, stateRows } from "./store";
import type { AnyAdapter, ShopWrite, SyncItem, Who } from "./types";

export interface RawChange {
  type: SyncType;
  item: string;
  value: unknown;
}

export interface SyncPlan {
  changes: RawChange[];
  scope: SyncScope;
  shopIds: string[];
  /** Per shop: keep its own value or replace it, where it has one. Missing: keep. */
  overrides: Record<string, OverrideChoice>;
  label?: string;
}

interface ShopRow {
  id: string;
  name: string;
}

async function activeShops(tx: DBorTx): Promise<ShopRow[]> {
  return tx.select({ id: shops.id, name: shops.name }).from(shops).where(ne(shops.status, "archived")).orderBy(asc(shops.name));
}

function adapterOf(type: string): AnyAdapter {
  const a = ADAPTERS[type as SyncType];
  if (!a) throw new AppError("bad_request", "Unknown setting");
  return a;
}

const nounOf = (a: AnyAdapter, item: string) => a.itemNoun?.(item) ?? a.noun;
const pathsFor = (a: AnyAdapter, item: string) => a.itemPaths?.(item) ?? a.paths;

function assertBrandMay(who: Who, a: AnyAdapter, item: string) {
  if (!who.ctx) return;
  const noun = nounOf(a, item);
  if (!who.ctx.brandWide) throw forbidden(`${noun} is set for the whole brand, so it needs access to every shop`);
  const perms = a.itemPerms?.(item) ?? a.brandPerms;
  if (!perms.some((p) => who.ctx!.permissions.has(p))) throw forbidden(`You can't change the brand's ${noun.toLowerCase()}`);
}

/** Each shop's value of these items, keyed "<shopId>|<item>". A local setting reads the shop's stored value, else the brand's. */
async function nativeOf(tx: DBorTx, a: AnyAdapter, items: readonly string[], shopIds: readonly string[], brand: ReadonlyMap<string, unknown>, states?: ReadonlyMap<string, StateRow>): Promise<Map<string, Native>> {
  if (a.store === "native") return a.shops!(tx, items, shopIds, brand);
  const st = states ?? (await stateRows(tx, items.map((i) => syncKey(a.type, i)), shopIds));
  const layers = a.layer ? await a.layer.read(tx, items, shopIds) : null;
  const out = new Map<string, Native>();
  for (const item of items) {
    if (a.itemAtShops?.(item) === false) continue;
    const fallback = brand.has(item) ? a.view(brand.get(item)) : a.absent;
    for (const shopId of shopIds) {
      const local = st.get(`${shopId}|${syncKey(a.type, item)}`)?.local ?? null;
      const own = layers?.get(`${shopId}|${item}`);
      const base = local ?? fallback;
      if (base === undefined || base === null) continue;
      if (own === undefined) out.set(`${shopId}|${item}`, { value: base, follows: local === null });
      else out.set(`${shopId}|${item}`, { value: a.layer!.merge(item, base, own), follows: false, ...(local === null ? { partial: true } : {}) });
    }
  }
  return out;
}

/** Writes shop values: through the adapter for native settings; into shop_sync_state.local for local ones. Always records the mode. */
async function writeCells(
  tx: DBorTx,
  who: Who,
  a: AnyAdapter,
  item: string,
  brand: { from: unknown; to: unknown } | null,
  cells: Map<string, { write: ShopWrite | null; mode: SyncMode; hadRow: boolean; modeWas: SyncMode | null; hold?: boolean }>,
) {
  const key = syncKey(a.type, item);
  const writes = new Map([...cells].filter(([, c]) => c.write).map(([shopId, c]) => [shopId, c.write!] as const));
  await a.write(tx, who, item, brand, a.store === "native" ? writes : new Map());
  // A hold writes the shop's current value, which already has its own layer folded in, so the layer can stay.
  if (a.layer) for (const [shopId, c] of cells) if (c.write && !c.hold) await a.layer.clear(tx, item, shopId);
  for (const [shopId, c] of cells) {
    const local = a.store === "local" && c.write ? (c.write.follow ? null : c.write.value) : undefined;
    if (local !== undefined || !c.hadRow || c.modeWas !== c.mode) await putState(tx, shopId, key, c.mode, local);
  }
}

interface ChangeRow {
  shopId: string;
  key: string;
  action: CellAction;
  from: CellState;
  to: CellState;
}

interface Applied {
  brand: { key: string; from: unknown; to: unknown }[];
  changes: ChangeRow[];
  targets: string[];
  /** Targeted shops that kept their own value for every setting in the change. */
  kept: number;
  keys: string[];
  paths: Set<string>;
}

function dedupe(changes: RawChange[]): RawChange[] {
  const m = new Map<string, RawChange>();
  for (const c of changes) m.set(syncKey(c.type, c.item), c);
  return [...m.values()];
}

/** Works out and writes one brand change at every shop. The caller records the batch. */
async function applyPlan(tx: DBorTx, who: Who, plan: SyncPlan): Promise<Applied> {
  await lockSync(tx);
  const all = (await activeShops(tx)).map((s) => s.id);
  const targets = targetShops(plan.scope, plan.shopIds, all);
  const out: Applied = { brand: [], changes: [], targets: [...targets], kept: 0, keys: [], paths: new Set() };
  const keptAt = new Set<string>();
  const tookAt = new Set<string>();
  for (const raw of dedupe(plan.changes)) {
    const a = adapterOf(raw.type);
    assertBrandMay(who, a, raw.item);
    const key = syncKey(a.type, raw.item);
    const brandMap = await a.brand(tx, [raw.item]);
    const existed = brandMap.has(raw.item);
    const before = existed ? brandMap.get(raw.item) : null;
    const after = await a.parse(who, raw.value, raw.item, before, tx);
    const v0 = existed ? a.view(before) : null;
    const v1 = a.view(after);
    const states = await stateRows(tx, [key], all);
    const native = await nativeOf(tx, a, [raw.item], all, brandMap, states);
    const cells = new Map<string, { write: ShopWrite | null; mode: SyncMode; hadRow: boolean; modeWas: SyncMode | null; hold?: boolean }>();
    const shopsSeeChange = !existed || !same(v0, v1);
    for (const shopId of shopsSeeChange ? all : []) {
      const n = native.get(`${shopId}|${raw.item}`);
      if (!n) continue;
      const st = states.get(`${shopId}|${key}`);
      const mode = existed ? modeOf(st?.mode, n, v0) : (st?.mode ?? "inherit");
      const p = planCell({ mode, follows: n.follows || !!n.partial, live: a.live, targeted: targets.has(shopId), choice: plan.overrides[shopId] });
      const write: ShopWrite | null = p.write === "follow" ? { follow: true, value: v1 } : p.write === "hold" ? { follow: false, value: n.value } : null;
      cells.set(shopId, { write, mode: p.mode, hadRow: !!st, modeWas: st?.mode ?? null, hold: p.write === "hold" });
      if (targets.has(shopId)) (p.mode === "override" ? keptAt : tookAt).add(shopId);
      const from: CellState = { value: n.value, follows: n.follows, mode };
      const to: CellState = write ? { value: write.value, follows: write.follow && a.live, mode: p.mode } : { ...from, mode: p.mode };
      if (p.action && (p.action === "keep" || !same(from, to))) out.changes.push({ shopId, key, action: p.action, from, to });
    }
    const brandChanged = !existed || !same(before, after);
    await writeCells(tx, who, a, raw.item, brandChanged ? { from: before, to: after } : null, cells);
    if (brandChanged) out.brand.push({ key, from: existed ? before : null, to: after });
    out.keys.push(key);
    pathsFor(a, raw.item).forEach((p) => out.paths.add(p));
  }
  out.kept = [...keptAt].filter((id) => !tookAt.has(id)).length;
  return out;
}

/** Runs each adapter's afterCommit for the shops a committed batch changed. Failures are logged; the change stands. */
async function afterCommit(changes: readonly Pick<ChangeRow, "key" | "shopId" | "action">[]) {
  const byType = new Map<SyncType, { shops: Set<string>; items: Set<string> }>();
  for (const c of changes) {
    const k = parseSyncKey(c.key);
    if (!k || c.action === "keep" || c.action === "freeze" || !ADAPTERS[k.type].afterCommit) continue;
    const t = byType.get(k.type) ?? { shops: new Set<string>(), items: new Set<string>() };
    t.shops.add(c.shopId);
    t.items.add(k.item);
    byType.set(k.type, t);
  }
  for (const [type, t] of byType) await ADAPTERS[type].afterCommit!([...t.shops], [...t.items]).catch((e: Error) => console.error(`After ${type} sync: ${e.message}`));
}

async function recordChanges(tx: DBorTx, batchId: string, changes: ChangeRow[]) {
  for (let i = 0; i < changes.length; i += 500)
    await tx.insert(brandSyncChanges).values(
      changes.slice(i, i + 500).map((c) => ({ batchId, shopId: c.shopId, key: c.key, action: c.action, from: c.from as unknown as object, to: c.to as unknown as object })),
    );
}

/** Each shop's own audit trail gets what reached it, so a shop's history shows brand syncs too. */
async function auditShops(tx: DBorTx, who: Who, batchId: string, label: string, changes: ChangeRow[]) {
  const byShop = new Map<string, ChangeRow[]>();
  for (const c of changes) byShop.set(c.shopId, [...(byShop.get(c.shopId) ?? []), c]);
  for (const [shopId, list] of byShop)
    await audit(who.actor, "brand_sync.shop", "shop", shopId, { batchId, label, settings: list.map((c) => ({ key: c.key, action: c.action, from: c.from, to: c.to })) }, shopId, tx);
}

async function labelFor(changes: RawChange[], tx: DBorTx): Promise<string> {
  const first = changes[0];
  if (!first) return "Brand change";
  const a = adapterOf(first.type);
  const items = await a.items(tx);
  const name = items.find((i) => i.id === first.item)?.label ?? (first.value && typeof first.value === "object" && "name" in first.value ? String((first.value as { name: unknown }).name) : null);
  const head = a.itemNoun ? nounOf(a, first.item) : name && items.length > 1 ? `${a.noun}: ${name}` : a.noun;
  return changes.length > 1 ? `${head} + ${changes.length - 1} more` : head;
}

export interface CommitInput extends SyncPlan {
  /** ISO time to run it at; missing or null applies now. */
  runAt?: string | null;
}

export interface CommitResult {
  batchId: string;
  status: "applied" | "scheduled";
  /** Shops the change reached, not counting those that kept their own value. */
  shops: number;
  kept: number;
  changed: number;
  runAt: string | null;
  paths: string[];
}

/**
 * Saves a brand change and syncs it to the chosen shops, now or at a set time. Shops it doesn't go
 * to keep their value; shops with their own keep it unless the admin replaced it. Recorded as one
 * batch with every shop's before and after, audited on the brand and on each shop. `within`: as a
 * savepoint in the caller's transaction (a catalog upload), so both land or neither.
 */
export async function commitBrandChange(who: Who, input: CommitInput, now = new Date(), within?: DBorTx): Promise<CommitResult> {
  if (!input.changes.length) throw new AppError("bad_request", "Nothing to save");
  if (input.scope === "selected" && !input.shopIds.length) throw new AppError("bad_request", `Tick at least one shop, or choose "${SCOPE_LABEL.brand_only}"`);
  if (!within) await runDueSyncs(now).catch((e: Error) => console.error(`Scheduled brand syncs: ${e.message}`));
  let done: ChangeRow[] = [];
  const result = await (within ?? db).transaction(async (tx): Promise<CommitResult> => {
    const label = input.label?.trim().slice(0, 120) || (await labelFor(input.changes, tx));
    if (input.runAt) {
      const runAt = new Date(input.runAt);
      const problem = scheduleProblem(runAt, now);
      if (problem) throw new AppError("bad_request", problem);
      const all = (await activeShops(tx)).map((s) => s.id);
      const paths = new Set<string>();
      for (const c of dedupe(input.changes)) {
        const a = adapterOf(c.type);
        assertBrandMay(who, a, c.item);
        const m = await a.brand(tx, [c.item]);
        await a.parse(who, c.value, c.item, m.has(c.item) ? m.get(c.item) : null, tx);
        pathsFor(a, c.item).forEach((p) => paths.add(p));
      }
      const targets = [...targetShops(input.scope, input.shopIds, all)];
      const plan: SyncPlan = { changes: dedupe(input.changes), scope: input.scope, shopIds: input.shopIds, overrides: input.overrides };
      const [b] = await tx
        .insert(brandSyncBatches)
        .values({
          kind: "apply",
          label,
          status: "scheduled",
          runAt,
          createdBy: who.actor.staffId ?? null,
          createdByLabel: who.actor.label,
          scope: input.scope,
          shopIds: targets,
          keys: plan.changes.map((c) => syncKey(c.type, c.item)),
          plan: plan as unknown as object,
        })
        .returning({ id: brandSyncBatches.id });
      await audit(who.actor, "brand_sync.scheduled", "brand_sync_batch", b.id, { label, runAt: runAt.toISOString(), scope: input.scope, shopIds: targets, keys: plan.changes.map((c) => syncKey(c.type, c.item)) }, null, tx);
      return { batchId: b.id, status: "scheduled", shops: targets.length, kept: 0, changed: 0, runAt: runAt.toISOString(), paths: [...paths] };
    }
    const r = await applyPlan(tx, who, input);
    const [b] = await tx
      .insert(brandSyncBatches)
      .values({ kind: "apply", label, status: "applied", appliedAt: now, createdBy: who.actor.staffId ?? null, createdByLabel: who.actor.label, scope: input.scope, shopIds: r.targets, keys: r.keys, brand: r.brand })
      .returning({ id: brandSyncBatches.id });
    await recordChanges(tx, b.id, r.changes);
    await audit(who.actor, "brand_sync.apply", "brand_sync_batch", b.id, { label, scope: input.scope, shopIds: r.targets, keys: r.keys, brand: r.brand, changed: r.changes.length }, null, tx);
    await auditShops(tx, who, b.id, label, r.changes);
    done = r.changes;
    return { batchId: b.id, status: "applied", shops: r.targets.length - r.kept, kept: r.kept, changed: r.changes.length, runAt: null, paths: [...r.paths] };
  });
  await afterCommit(done);
  return result;
}

/**
 * Runs scheduled syncs that are due, each in its own transaction, as whoever scheduled it. A sync
 * that no longer applies (the value doesn't pass any more) is marked failed with why. Called by the
 * cron route, and before the Sync status page or a new change reads anything.
 */
export async function runDueSyncs(now = new Date()): Promise<{ ran: number; failed: number }> {
  const due = await db
    .select({ id: brandSyncBatches.id })
    .from(brandSyncBatches)
    .where(and(eq(brandSyncBatches.status, "scheduled"), lte(brandSyncBatches.runAt, now)))
    .orderBy(asc(brandSyncBatches.runAt))
    .limit(20);
  let ran = 0;
  let failed = 0;
  for (const { id } of due) {
    try {
      const ok = await runScheduled(id, now);
      if (ok) ran++;
    } catch (e) {
      failed++;
      const message = e instanceof AppError ? e.message : "Something went wrong running it";
      if (!(e instanceof AppError)) console.error(e);
      await db.update(brandSyncBatches).set({ status: "failed", error: message }).where(and(eq(brandSyncBatches.id, id), eq(brandSyncBatches.status, "scheduled")));
      await audit({ staffId: null, label: "system" }, "brand_sync.failed", "brand_sync_batch", id, { error: message });
    }
  }
  return { ran, failed };
}

async function runScheduled(id: string, now: Date, by?: Who): Promise<boolean> {
  let done: ChangeRow[] = [];
  const ran = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(brandSyncBatches).where(and(eq(brandSyncBatches.id, id), eq(brandSyncBatches.status, "scheduled"))).for("update", { skipLocked: true });
    if (!b) return false;
    const who: Who = by ?? { actor: { staffId: b.createdBy, label: b.createdByLabel }, ctx: null };
    const r = await applyPlan(tx, who, b.plan as SyncPlan);
    await tx.update(brandSyncBatches).set({ status: "applied", appliedAt: now, shopIds: r.targets, keys: r.keys, brand: r.brand }).where(eq(brandSyncBatches.id, id));
    await recordChanges(tx, id, r.changes);
    await audit(who.actor, "brand_sync.run", "brand_sync_batch", id, { label: b.label, scheduledFor: b.runAt?.toISOString(), shopIds: r.targets, keys: r.keys, brand: r.brand, changed: r.changes.length }, null, tx);
    await auditShops(tx, who, id, b.label, r.changes);
    done = r.changes;
    return true;
  });
  await afterCommit(done);
  return ran;
}

/** Runs a scheduled sync now, as the person who pressed it. */
export async function runScheduledNow(who: Who, id: string, now = new Date()) {
  const [b] = await db.select().from(brandSyncBatches).where(eq(brandSyncBatches.id, id));
  if (!b) throw notFound("Sync");
  if (b.status !== "scheduled") throw new AppError("conflict", "That sync isn't scheduled any more");
  for (const c of (b.plan as SyncPlan).changes) assertBrandMay(who, adapterOf(c.type), c.item);
  if (!(await runScheduled(id, now, who))) throw new AppError("conflict", "That sync is already running");
  return pathsOf((b.plan as SyncPlan).changes);
}

export async function cancelScheduled(who: Who, id: string) {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(brandSyncBatches).where(eq(brandSyncBatches.id, id)).for("update");
    if (!b) throw notFound("Sync");
    if (b.status !== "scheduled") throw new AppError("conflict", "That sync isn't scheduled any more");
    for (const c of (b.plan as SyncPlan).changes) assertBrandMay(who, adapterOf(c.type), c.item);
    await tx.update(brandSyncBatches).set({ status: "cancelled" }).where(eq(brandSyncBatches.id, id));
    await audit(who.actor, "brand_sync.cancel", "brand_sync_batch", id, { label: b.label, runAt: b.runAt?.toISOString() }, null, tx);
  });
}

const pathsOf = (changes: readonly Pick<RawChange, "type" | "item">[]) => [...new Set(changes.flatMap((c) => pathsFor(adapterOf(c.type), c.item)))];

// ───────────────────────────── Bulk push and reset ─────────────────────────────

export interface CellRef {
  key: string;
  shopId: string;
}

/**
 * The Sync status bulk actions. Push: cells that follow the brand get its current value; overridden
 * ones are skipped. Reset: every cell drops its own value and follows the brand. One batch, undoable.
 */
export async function bulkSync(who: Who, action: BulkAction, cells: CellRef[], now = new Date()) {
  if (!cells.length) throw new AppError("bad_request", "Pick at least one cell");
  let done: ChangeRow[] = [];
  const result = await db.transaction(async (tx) => {
    await lockSync(tx);
    const active = new Set((await activeShops(tx)).map((s) => s.id));
    const byKey = new Map<string, Set<string>>();
    for (const c of cells) if (active.has(c.shopId)) byKey.set(c.key, (byKey.get(c.key) ?? new Set()).add(c.shopId));
    const changes: ChangeRow[] = [];
    const paths = new Set<string>();
    for (const [key, shopSet] of byKey) {
      const k = parseSyncKey(key);
      if (!k) throw new AppError("bad_request", "Unknown setting");
      const a = adapterOf(k.type);
      assertBrandMay(who, a, k.item);
      const brandMap = await a.brand(tx, [k.item]);
      if (!brandMap.has(k.item)) continue;
      const v = a.view(brandMap.get(k.item));
      const shopIds = [...shopSet];
      const states = await stateRows(tx, [key], shopIds);
      const native = await nativeOf(tx, a, [k.item], shopIds, brandMap, states);
      const plan = new Map<string, { write: ShopWrite | null; mode: SyncMode; hadRow: boolean; modeWas: SyncMode | null }>();
      for (const shopId of shopIds) {
        const n = native.get(`${shopId}|${k.item}`);
        if (!n) continue;
        const st = states.get(`${shopId}|${key}`);
        const mode = modeOf(st?.mode, n, v);
        const p = bulkCell(action, { mode, status: statusOf(mode, n, v), follows: n.follows, live: a.live });
        if (!p) continue;
        plan.set(shopId, { write: { follow: true, value: v }, mode: "inherit", hadRow: !!st, modeWas: st?.mode ?? null });
        changes.push({ shopId, key, action: p.action!, from: { ...n, mode }, to: { value: v, follows: a.live, mode: "inherit" } });
      }
      if (!plan.size) continue;
      await writeCells(tx, who, a, k.item, null, plan);
      pathsFor(a, k.item).forEach((p) => paths.add(p));
    }
    if (!changes.length) return { batchId: null as string | null, changed: 0, paths: [...paths] };
    const keys = [...new Set(changes.map((c) => c.key))];
    const shopIds = [...new Set(changes.map((c) => c.shopId))];
    const label = `${BULK_LABEL[action]}: ${keys.length} setting${keys.length === 1 ? "" : "s"} at ${shopIds.length} shop${shopIds.length === 1 ? "" : "s"}`;
    const [b] = await tx
      .insert(brandSyncBatches)
      .values({ kind: action as BrandSyncBatchKind, label, status: "applied", appliedAt: now, createdBy: who.actor.staffId ?? null, createdByLabel: who.actor.label, scope: "selected", shopIds, keys })
      .returning({ id: brandSyncBatches.id });
    await recordChanges(tx, b.id, changes);
    await audit(who.actor, `brand_sync.${action}`, "brand_sync_batch", b.id, { label, keys, shopIds, changed: changes.length }, null, tx);
    await auditShops(tx, who, b.id, label, changes);
    done = changes;
    return { batchId: b.id as string | null, changed: changes.length, paths: [...paths] };
  });
  await afterCommit(done);
  return result;
}

// ───────────────────────────── Rollback ─────────────────────────────

/**
 * Puts the brand and every shop back as they were before one sync, as one batch. Refused, with
 * what changed, if the brand value or any shop's value it touched has changed since. `within`: as a
 * savepoint in the caller's transaction (undoing a catalog upload).
 */
export async function rollbackSync(who: Who, batchId: string, now = new Date(), within?: DBorTx) {
  let done: ChangeRow[] = [];
  const result = await (within ?? db).transaction(async (tx) => {
    await lockSync(tx);
    const [b] = await tx.select().from(brandSyncBatches).where(eq(brandSyncBatches.id, batchId)).for("update");
    if (!b) throw notFound("Sync");
    if (b.kind === "rollback") throw new AppError("bad_request", "An undo can't be undone. Make the change again instead.");
    if (b.status !== "applied") throw new AppError("conflict", b.status === "rolled_back" ? "That sync was already undone" : "Only a sync that ran can be undone");
    const rows = await tx.select().from(brandSyncChanges).where(eq(brandSyncChanges.batchId, batchId));
    const keys = [...new Set([...b.brand.map((x) => x.key), ...rows.map((r) => r.key)])];
    const names = new Map((await tx.select({ id: shops.id, name: shops.name }).from(shops)).map((s) => [s.id, s.name]));
    const conflicts: string[] = [];
    const work: { a: AnyAdapter; item: string; key: string; brand: { from: unknown; to: unknown } | null; retire: boolean; cells: ChangeRow[]; rows: typeof rows }[] = [];
    for (const key of keys) {
      const k = parseSyncKey(key);
      if (!k) continue;
      const a = adapterOf(k.type);
      assertBrandMay(who, a, k.item);
      const entry = b.brand.find((x) => x.key === key) ?? null;
      const brandMap = await a.brand(tx, [k.item]);
      const label = await itemLabel(tx, a, k.item);
      if (entry && (!brandMap.has(k.item) || !same(brandMap.get(k.item), entry.to))) conflicts.push(`The brand's ${label} changed since`);
      const mine = rows.filter((r) => r.key === key);
      const shopIds = mine.map((r) => r.shopId);
      const native = await nativeOf(tx, a, [k.item], shopIds, brandMap);
      for (const r of mine.filter((x) => x.action !== "keep")) {
        const n = native.get(`${r.shopId}|${k.item}`);
        if (!n || !unchangedSince(n, r.to as CellState)) conflicts.push(`${names.get(r.shopId) ?? "A shop"}: ${label} changed since`);
      }
      const cells: ChangeRow[] = mine
        .filter((r) => r.action !== "keep")
        .map((r) => ({ shopId: r.shopId, key, action: "restore" as const, from: r.to as CellState, to: r.from as CellState }));
      work.push({ a, item: k.item, key, brand: entry ? { from: entry.to, to: entry.from } : null, retire: !!entry && entry.from === null, cells, rows: mine });
    }
    if (conflicts.length) {
      const more = conflicts.length > 4 ? ` and ${conflicts.length - 4} more` : "";
      throw new AppError("conflict", `Can't undo: ${conflicts.slice(0, 4).join("; ")}${more}. Change those back first, or make a new change.`, { conflicts });
    }
    const paths = new Set<string>();
    const restored: ChangeRow[] = [];
    for (const w of work) {
      const states = await stateRows(tx, [w.key], w.cells.map((c) => c.shopId));
      const plan = new Map(
        w.cells.map((c) => {
          const st = states.get(`${c.shopId}|${w.key}`);
          return [c.shopId, { write: { follow: c.to.follows, value: c.to.value } as ShopWrite, mode: c.to.mode, hadRow: !!st, modeWas: st?.mode ?? null }] as const;
        }),
      );
      await writeCells(tx, who, w.a, w.item, w.brand, plan);
      if (w.retire) await dropStates(tx, w.key);
      restored.push(...w.cells);
      pathsFor(w.a, w.item).forEach((p) => paths.add(p));
    }
    const label = `Undo: ${b.label}`.slice(0, 160);
    const [r] = await tx
      .insert(brandSyncBatches)
      .values({
        kind: "rollback",
        label,
        status: "applied",
        appliedAt: now,
        createdBy: who.actor.staffId ?? null,
        createdByLabel: who.actor.label,
        scope: "selected",
        shopIds: [...new Set(restored.map((c) => c.shopId))],
        keys,
        brand: b.brand.map((x) => ({ key: x.key, from: x.to, to: x.from })),
        rollbackOf: b.id,
      })
      .returning({ id: brandSyncBatches.id });
    await recordChanges(tx, r.id, restored);
    await tx.update(brandSyncBatches).set({ status: "rolled_back", rolledBackAt: now, rolledBackBy: who.actor.label }).where(eq(brandSyncBatches.id, b.id));
    await audit(who.actor, "brand_sync.rollback", "brand_sync_batch", b.id, { label: b.label, rollbackId: r.id, keys, shopIds: [...new Set(restored.map((c) => c.shopId))], changed: restored.length }, null, tx);
    await auditShops(tx, who, r.id, label, restored);
    done = restored;
    return { batchId: r.id, changed: restored.length, paths: [...paths] };
  });
  await afterCommit(done);
  return result;
}

// ───────────────────────────── Preview ─────────────────────────────

export interface PreviewCell {
  shopId: string;
  status: CellStatus;
  /** The shop's value now. */
  current: Record<string, string>;
  currentShort: string;
  /** What the shop would get if the change goes to it. */
  changes: FieldChange[];
}

export interface PreviewKey {
  key: string;
  label: string;
  noun: string;
  area: SyncArea;
  areaLabel: string;
  note: string | null;
  isNew: boolean;
  /** Brand value, before and after, as the shops see it. */
  brandChanges: FieldChange[];
  /** The brand saved something shops don't use (a service's name), so nothing changes at any shop. */
  brandOnly: boolean;
  next: Record<string, string>;
  nextShort: string;
  /** Shops where the setting doesn't apply (a product they don't carry) are left out. */
  cells: PreviewCell[];
  pending: { id: string; runAt: string; label: string }[];
}

export interface Preview {
  shops: ShopRow[];
  keys: PreviewKey[];
}

async function itemLabel(tx: DBorTx, a: AnyAdapter, item: string, fallback?: unknown): Promise<string> {
  const items = await a.items(tx);
  const found = items.find((i) => i.id === item)?.label;
  if (found) return items.length > 1 ? found : a.noun;
  const name = fallback && typeof fallback === "object" && "name" in fallback ? String((fallback as { name: unknown }).name) : null;
  return name ?? a.noun;
}

/** What a brand change would do at every shop, for the sync dialog. Validates the change the same way saving it does. */
export async function previewBrandChange(who: Who, changes: RawChange[]): Promise<Preview> {
  await runDueSyncs().catch(() => {});
  const tx = db;
  const shopRows = await activeShops(tx);
  const all = shopRows.map((s) => s.id);
  const scheduled = await tx
    .select({ id: brandSyncBatches.id, runAt: brandSyncBatches.runAt, label: brandSyncBatches.label, keys: brandSyncBatches.keys })
    .from(brandSyncBatches)
    .where(eq(brandSyncBatches.status, "scheduled"))
    .orderBy(asc(brandSyncBatches.runAt));
  const keys: PreviewKey[] = [];
  for (const raw of dedupe(changes)) {
    const a = adapterOf(raw.type);
    assertBrandMay(who, a, raw.item);
    const key = syncKey(a.type, raw.item);
    const brandMap = await a.brand(tx, [raw.item]);
    const existed = brandMap.has(raw.item);
    const before = existed ? brandMap.get(raw.item) : null;
    const after = await a.parse(who, raw.value, raw.item, before, tx);
    const v0 = existed ? a.view(before) : null;
    const v1 = a.view(after);
    const next = a.describe(v1, raw.item);
    const states = await stateRows(tx, [key], all);
    const native = await nativeOf(tx, a, [raw.item], all, brandMap, states);
    const items = await a.items(tx);
    const it: SyncItem | undefined = items.find((i) => i.id === raw.item);
    const cells: PreviewCell[] = [];
    for (const shopId of all) {
      const n = native.get(`${shopId}|${raw.item}`);
      if (!n) continue;
      const st = states.get(`${shopId}|${key}`);
      const mode = existed ? modeOf(st?.mode, n, v0) : (st?.mode ?? "inherit");
      const current = a.describe(n.value, raw.item);
      cells.push({ shopId, status: existed ? statusOf(mode, n, v0) : mode === "override" ? "overridden" : "out_of_sync", current, currentShort: a.short(n.value, raw.item), changes: fieldChanges(current, next) });
    }
    const area = areaOf(a, it);
    keys.push({
      key,
      label: await itemLabel(tx, a, raw.item, after),
      noun: nounOf(a, raw.item),
      area,
      areaLabel: AREA_LABEL[area],
      note: a.itemNote?.(raw.item) ?? a.note ?? null,
      isNew: !existed,
      brandChanges: fieldChanges(v0 === null ? null : a.describe(v0, raw.item), next),
      brandOnly: existed && same(v0, v1) && !same(before, after),
      next,
      nextShort: a.short(v1, raw.item),
      cells,
      pending: scheduled.filter((s) => s.keys.includes(key)).map((s) => ({ id: s.id, runAt: s.runAt!.toISOString(), label: s.label })),
    });
  }
  return { shops: shopRows, keys };
}

// ───────────────────────────── Sync status matrix ─────────────────────────────

export type MatrixCell = { s: CellStatus | "pending"; t: string; o?: 1 } | null;

export interface MatrixRow {
  key: string;
  type: SyncType;
  item: string;
  label: string;
  hint: string | null;
  area: SyncArea;
  brand: string;
  live: boolean;
  /** One per shop, in the order of `shops`; null where it doesn't apply. `o`: the shop has its own value under a pending sync. */
  cells: MatrixCell[];
  counts: Record<CellStatus | "pending", number>;
}

export interface Matrix {
  shops: ShopRow[];
  rows: MatrixRow[];
  totals: Record<CellStatus | "pending", number>;
  scheduled: number;
}

/** Every brand-controlled setting at every shop that isn't archived: in sync, overridden, out of sync or pending a scheduled sync. */
export async function syncMatrix(): Promise<Matrix> {
  await runDueSyncs().catch((e: Error) => console.error(`Scheduled brand syncs: ${e.message}`));
  const tx = db;
  const shopRows = await activeShops(tx);
  const all = shopRows.map((s) => s.id);
  const scheduled = await tx.select({ keys: brandSyncBatches.keys, shopIds: brandSyncBatches.shopIds }).from(brandSyncBatches).where(eq(brandSyncBatches.status, "scheduled"));
  const pending = new Set(scheduled.flatMap((s) => s.keys.flatMap((k) => s.shopIds.map((id) => `${id}|${k}`))));
  const totals = { in_sync: 0, overridden: 0, out_of_sync: 0, pending: 0 };
  const groups = await Promise.all(
    Object.values(ADAPTERS).map(async (a) => {
      const items = await a.items(tx);
      if (!items.length) return [] as MatrixRow[];
      const ids = items.map((i) => i.id);
      const brandMap = await a.brand(tx, ids);
      const states = await stateRows(
        tx,
        ids.map((i) => syncKey(a.type, i)),
        all,
      );
      const native = await nativeOf(tx, a, ids, all, brandMap, states);
      return items
        .filter((it) => brandMap.has(it.id))
        .map((it): MatrixRow => {
          const key = syncKey(a.type, it.id);
          const v = a.view(brandMap.get(it.id));
          const counts = { in_sync: 0, overridden: 0, out_of_sync: 0, pending: 0 };
          const cells = all.map((shopId): MatrixCell => {
            const n = native.get(`${shopId}|${it.id}`);
            if (!n) return null;
            const st = states.get(`${shopId}|${key}`);
            const status = statusOf(modeOf(st?.mode, n, v), n, v);
            const shown = pending.has(`${shopId}|${key}`) ? "pending" : status;
            counts[shown]++;
            return { s: shown, t: a.short(n.value, it.id), ...(shown === "pending" && status === "overridden" ? { o: 1 as const } : {}) };
          });
          for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += counts[k];
          return { key, type: a.type, item: it.id, label: it.label, hint: it.hint ?? null, area: areaOf(a, it), brand: a.short(v, it.id), live: a.live, cells, counts };
        });
    }),
  );
  return { shops: shopRows, rows: groups.flat(), totals, scheduled: scheduled.length };
}

// ───────────────────────────── History ─────────────────────────────

export interface HistoryBatch {
  id: string;
  kind: BrandSyncBatchKind;
  label: string;
  status: string;
  scope: SyncScope;
  scopeText: string;
  at: string;
  runAt: string | null;
  by: string;
  shops: number;
  changed: number;
  keys: string[];
  error: string | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  rollbackOf: string | null;
}

export async function syncHistory(limit = 60): Promise<HistoryBatch[]> {
  const total = (await activeShops(db)).length;
  const rows = await db
    .select({
      b: brandSyncBatches,
      n: sql<number>`(select count(*)::int from brand_sync_changes c where c.batch_id = "brand_sync_batches"."id" and c.action <> 'keep')`,
    })
    .from(brandSyncBatches)
    .orderBy(sql`case when ${brandSyncBatches.status} = 'scheduled' then 0 else 1 end`, desc(sql`coalesce(${brandSyncBatches.appliedAt}, ${brandSyncBatches.createdAt})`))
    .limit(limit);
  return rows.map(({ b, n }) => ({
    id: b.id,
    kind: b.kind,
    label: b.label,
    status: b.status,
    scope: b.scope,
    scopeText: b.kind === "apply" ? scopeSummary(b.scope, b.shopIds.length, total) : `${b.shopIds.length} shop${b.shopIds.length === 1 ? "" : "s"}`,
    at: (b.appliedAt ?? b.createdAt).toISOString(),
    runAt: b.runAt?.toISOString() ?? null,
    by: b.createdByLabel,
    shops: b.shopIds.length,
    changed: n,
    keys: b.keys,
    error: b.error,
    rolledBackAt: b.rolledBackAt?.toISOString() ?? null,
    rolledBackBy: b.rolledBackBy,
    rollbackOf: b.rollbackOf,
  }));
}

export interface BatchDetail {
  brand: { key: string; label: string; changes: FieldChange[]; created: boolean }[];
  shops: { shopId: string; name: string; settings: { key: string; label: string; action: CellAction; changes: FieldChange[]; modeFrom: SyncMode; modeTo: SyncMode }[] }[];
  plan: { label: string; scope: SyncScope; shops: string[]; keys: string[] } | null;
}

/** One sync's brand and per-shop before and after, for the history drawer. */
export async function batchDetail(id: string): Promise<BatchDetail> {
  const [b] = await db.select().from(brandSyncBatches).where(eq(brandSyncBatches.id, id));
  if (!b) throw notFound("Sync");
  const rows = await db.select().from(brandSyncChanges).where(eq(brandSyncChanges.batchId, id));
  const names = new Map((await db.select({ id: shops.id, name: shops.name }).from(shops)).map((s) => [s.id, s.name]));
  const labels = new Map<string, string>();
  const labelOf = async (key: string) => {
    if (labels.has(key)) return labels.get(key)!;
    const k = parseSyncKey(key);
    const l = k ? await itemLabel(db, adapterOf(k.type), k.item, b.brand.find((x) => x.key === key)?.to) : key;
    labels.set(key, l);
    return l;
  };
  const describe = (key: string, v: unknown) => {
    const k = parseSyncKey(key);
    if (!k || v === null || v === undefined) return null;
    try {
      return adapterOf(k.type).describe(v, k.item);
    } catch {
      return { Value: JSON.stringify(v).slice(0, 60) };
    }
  };
  const viewOf = (key: string, v: unknown) => {
    const k = parseSyncKey(key);
    return k && v !== null && v !== undefined ? adapterOf(k.type).view(v) : null;
  };
  const brand = [];
  for (const x of b.brand) brand.push({ key: x.key, label: await labelOf(x.key), changes: fieldChanges(describe(x.key, viewOf(x.key, x.from)), describe(x.key, viewOf(x.key, x.to))), created: x.from === null });
  const byShop = new Map<string, BatchDetail["shops"][number]>();
  for (const r of rows) {
    const from = r.from as CellState;
    const to = r.to as CellState;
    const s = byShop.get(r.shopId) ?? { shopId: r.shopId, name: names.get(r.shopId) ?? "Removed shop", settings: [] };
    s.settings.push({ key: r.key, label: await labelOf(r.key), action: r.action, changes: fieldChanges(describe(r.key, from.value), describe(r.key, to.value)), modeFrom: from.mode, modeTo: to.mode });
    byShop.set(r.shopId, s);
  }
  let plan: BatchDetail["plan"] = null;
  if (b.status === "scheduled" || b.status === "cancelled" || (b.status === "failed" && b.plan)) {
    const p = b.plan as SyncPlan;
    plan = { label: b.label, scope: p.scope, shops: b.shopIds.map((id) => names.get(id) ?? id), keys: await Promise.all(p.changes.map((c) => labelOf(syncKey(c.type, c.item)))) };
  }
  return { brand, shops: [...byShop.values()].sort((x, y) => x.name.localeCompare(y.name)), plan };
}

// ───────────────────────────── Shop edit controls ─────────────────────────────

export interface ControlRow {
  type: SyncType;
  noun: string;
  area: SyncArea;
  areaLabel: string;
  shopsCanEdit: boolean;
}

/** For each setting shops change in their own settings: whether shop managers may. Off unless the brand allows it. */
export async function syncControls(): Promise<ControlRow[]> {
  const stored = await controlRows();
  const out: ControlRow[] = [];
  for (const a of Object.values(ADAPTERS)) {
    if (!a.lockable) continue;
    out.push({ type: a.type, noun: a.noun, area: a.area, areaLabel: AREA_LABEL[a.area], shopsCanEdit: a.control ? await a.control.get(db) : (stored.get(a.type) ?? false) });
  }
  return out;
}

export async function setSyncControl(who: Who, type: SyncType, on: boolean) {
  const a = adapterOf(type);
  if (!a.lockable) throw new AppError("bad_request", "Shops don't change that one themselves");
  assertBrandMay(who, a, "");
  await db.transaction(async (tx) => {
    if (a.control) await a.control.set(tx, who, on);
    else await putControl(tx, a.type, on, who.actor);
    await audit(who.actor, "brand_sync.control", "brand_sync_control", type, { setting: a.noun, shopsCanEdit: on }, null, tx);
  });
  return a.paths;
}

/** Whether this person may change a shop's own value of a brand-controlled setting: staff with every shop always; shop managers where the brand allows it. */
export async function shopMayEdit(ctx: Who["ctx"], type: SyncType, tx: DBorTx = db): Promise<boolean> {
  const a = adapterOf(type);
  if (ctx?.brandWide) return true;
  if (a.control) return a.control.get(tx);
  return (await controlRows(tx)).get(type) ?? false;
}

export async function assertShopMayEdit(ctx: Who["ctx"], type: SyncType, tx: DBorTx = db) {
  if (!(await shopMayEdit(ctx, type, tx))) {
    const a = adapterOf(type);
    throw forbidden(`${a.noun} is set by the brand. Ask a brand admin to change it, or to let shop managers under Setup → Sync status.`);
  }
}

/** After a shop saves its own value: it's overridden, or back in sync if it matches the brand. */
export async function noteShopEdit(type: SyncType, items: readonly string[], shopId: string, tx: DBorTx = db) {
  const a = adapterOf(type);
  if (!items.length) return;
  const brandMap = await a.brand(tx, items);
  const native = await nativeOf(tx, a, items, [shopId], brandMap);
  for (const item of items) {
    const n = native.get(`${shopId}|${item}`);
    if (!n || !brandMap.has(item)) continue;
    await putState(tx, shopId, syncKey(a.type, item), n.follows || same(n.value, a.view(brandMap.get(item))) ? "inherit" : "override");
  }
}

/** Area filter values for the page: every area with at least one setting. */
export const areasIn = (rows: Pick<MatrixRow, "area">[]) => [...new Set(rows.map((r) => r.area))];

