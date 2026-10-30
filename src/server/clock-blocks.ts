import { and, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { blockReasons, clockBlockReleases, shops, staffSchedules, timeBlocks, timePunches } from "@/db/schema";
import { CLOCK_BLOCK_LABEL, CLOCK_REASON_KEY, CLOCK_ROLL_MS, clockBlocks, clockKindOf, onlyRolled, type ClockBlockSettings, type ClockPunch, type WantedBlock } from "@/domain/clock-blocks";
import { DEFAULT_SHOP_CLOCK, scheduledOn, shopClockSettings, type ClockRules } from "@/domain/time-clock";
import { addDays, endOfLocalDay, localDateOf, localMinutesOf, startOfLocalDay, todayLocal, weekdayOf } from "@/lib/time";
import { settingFor } from "./brand-sync/settings";
import { audit, SYSTEM, type Actor } from "./audit";
import { AppError, notFound } from "./errors";

/**
 * Writes the time clock's block-outs (src/domain/clock-blocks.ts) to time_blocks, as source "clock",
 * keyed and linked to their punches. Run after every punch and punch edit, by the cron, and when
 * the calendar or Today loads, so a break running on keeps its block ahead of now. A block a
 * manager changed by hand is left alone; one they released isn't written again.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NONE = ["00000000-0000-0000-0000-000000000000"];

type BlockRow = typeof timeBlocks.$inferSelect;

export interface SyncResult {
  created: number;
  updated: number;
  removed: number;
}

/** What the audit log keeps of a clock block. */
const details = (b: Pick<BlockRow, "staffId" | "category" | "reasonId" | "reason" | "startsAt" | "endsAt" | "clockKey" | "punchId" | "endPunchId">, isPrivate: boolean) => ({
  staffId: b.staffId,
  category: b.category,
  reasonId: b.reasonId,
  reason: b.reason,
  note: null,
  private: isPrivate,
  startsAt: b.startsAt.toISOString(),
  endsAt: b.endsAt.toISOString(),
  clock: clockKindOf(b.clockKey),
  punchId: b.punchId,
  endPunchId: b.endPunchId,
  via: "clock",
});

/**
 * Brings these barbers' clock blocks that start within a day of [from, to] in line with their
 * punches. Reads everything in a fixed number of queries and writes only what changed.
 */
export async function syncClockBlocks(staffIds: readonly string[], around: { from: Date; to: Date }, o: { tx?: DBorTx; now?: Date; actor?: Actor } = {}): Promise<SyncResult> {
  const tx = o.tx ?? db;
  const now = o.now ?? new Date();
  const actor = o.actor ?? SYSTEM;
  const ids = [...new Set(staffIds)];
  const result: SyncResult = { created: 0, updated: 0, removed: 0 };
  if (!ids.length) return result;
  const from = new Date(around.from.getTime() - DAY);
  const to = new Date(around.to.getTime() + DAY);

  const [punches, sched, used, off] = await Promise.all([
    tx
      .select({ id: timePunches.id, staffId: timePunches.staffId, shopId: timePunches.shopId, type: timePunches.type, at: timePunches.at, reasonId: timePunches.reasonId, plannedMin: timePunches.plannedMin })
      .from(timePunches)
      .where(and(inArray(timePunches.staffId, ids), gte(timePunches.at, new Date(from.getTime() - 36 * HOUR)), lt(timePunches.at, new Date(to.getTime() + 36 * HOUR)), isNull(timePunches.voidedAt))),
    tx.select().from(staffSchedules).where(inArray(staffSchedules.staffId, ids)),
    tx
      .selectDistinct({ staffId: timePunches.staffId })
      .from(timePunches)
      .where(and(inArray(timePunches.staffId, ids), gte(timePunches.at, new Date(now.getTime() - 30 * DAY)), isNull(timePunches.voidedAt))),
    tx
      .select({ staffId: timeBlocks.staffId, shopId: timeBlocks.shopId, start: timeBlocks.startsAt, end: timeBlocks.endsAt })
      .from(timeBlocks)
      .where(and(inArray(timeBlocks.staffId, ids), eq(timeBlocks.source, "manual"), or(eq(timeBlocks.category, "time_off"), eq(timeBlocks.kind, "day_off")), lt(timeBlocks.startsAt, to), gt(timeBlocks.endsAt, from))),
  ]);
  const shopIds = [...new Set([...punches.map((p) => p.shopId), ...sched.map((s) => s.shopId)])];
  const shopRows = shopIds.length ? await tx.select({ id: shops.id, timeClock: shops.timeClock }).from(shops).where(inArray(shops.id, shopIds)) : [];
  const rules = await settingFor<ClockRules>("time_clock", shopIds, tx);
  const byShop = new Map(shopRows.map((s) => [s.id, shopClockSettings(s.timeClock)]));
  const settings = (shopId: string): ClockBlockSettings => {
    const s = byShop.get(shopId) ?? DEFAULT_SHOP_CLOCK;
    return { blockOnBreak: s.blockOnBreak, breakHoldMinutes: s.breakHoldMinutes, blockAfterClockOut: s.blockAfterClockOut, notInBlock: s.notInBlock, graceMinutes: s.graceMinutes ?? rules(shopId).graceMinutes };
  };
  const dates: string[] = [];
  for (let d = localDateOf(from); d <= localDateOf(to); d = addDays(d, 1)) dates.push(d);
  const usesClock = new Set(used.map((u) => u.staffId));

  const wanted: WantedBlock[] = [];
  for (const staffId of ids) {
    const mine = sched.filter((s) => s.staffId === staffId);
    const scheduled = dates.flatMap((d) =>
      [...new Set(mine.map((s) => s.shopId))].flatMap((shopId) =>
        scheduledOn(
          d,
          weekdayOf(d),
          mine.filter((s) => s.shopId === shopId),
        ).map((x) => ({ ...x, shopId })),
      ),
    );
    wanted.push(
      ...clockBlocks({
        staffId,
        punches: punches.filter((p) => p.staffId === staffId) as ClockPunch[],
        from,
        to,
        now,
        settings,
        scheduled,
        usesClock: usesClock.has(staffId),
        off: off.filter((b) => b.staffId === staffId),
      }),
    );
  }

  const keys = wanted.map((w) => w.key);
  const [existing, released, reasons] = await Promise.all([
    tx
      .select()
      .from(timeBlocks)
      .where(and(inArray(timeBlocks.staffId, ids), eq(timeBlocks.source, "clock"), or(and(gte(timeBlocks.startsAt, from), lt(timeBlocks.startsAt, to)), inArray(timeBlocks.clockKey, keys.length ? keys : NONE)))),
    keys.length ? tx.select({ key: clockBlockReleases.clockKey }).from(clockBlockReleases).where(inArray(clockBlockReleases.clockKey, keys)) : [],
    tx.select().from(blockReasons),
  ]);
  const gone = new Set(released.map((r) => r.key));
  const reasonById = new Map(reasons.map((r) => [r.id, r]));
  const reasonByKey = new Map(reasons.map((r) => [r.key, r]));
  const have = new Map(existing.map((e) => [e.clockKey!, e]));

  for (const w of wanted) {
    if (gone.has(w.key)) continue;
    const reason = (w.reasonId ? reasonById.get(w.reasonId) : undefined) ?? reasonByKey.get(CLOCK_REASON_KEY[w.kind]) ?? null;
    const values = {
      staffId: w.staffId,
      shopId: w.shopId,
      startsAt: w.start,
      endsAt: w.end,
      kind: "block",
      category: reason?.countsAsLunch ? ("lunch" as const) : ("other" as const),
      reasonId: reason?.id ?? null,
      reason: reason?.label ?? CLOCK_BLOCK_LABEL[w.kind],
      source: "clock" as const,
      clockKey: w.key,
      punchId: w.punchId,
      endPunchId: w.endPunchId,
      clockOpen: w.open,
    };
    const ex = have.get(w.key);
    if (!ex) {
      const [row] = await tx.insert(timeBlocks).values(values).onConflictDoNothing({ target: timeBlocks.clockKey }).returning();
      if (!row) continue;
      result.created++;
      await audit(actor, "block.create", "time_block", row.id, details(row, !!reason?.private), w.shopId, tx);
      continue;
    }
    if (ex.overriddenAt) continue;
    const same =
      ex.startsAt.getTime() === w.start.getTime() &&
      ex.endsAt.getTime() === w.end.getTime() &&
      ex.clockOpen === w.open &&
      ex.punchId === w.punchId &&
      ex.endPunchId === w.endPunchId &&
      ex.reasonId === values.reasonId &&
      ex.shopId === w.shopId &&
      ex.category === values.category;
    if (same) continue;
    await tx.update(timeBlocks).set(values).where(eq(timeBlocks.id, ex.id));
    result.updated++;
    if (!onlyRolled(ex, { ...w, reasonId: values.reasonId }))
      await audit(
        actor,
        "block.update",
        "time_block",
        ex.id,
        { ...details({ ...ex, ...values }, !!reason?.private), before: { startsAt: ex.startsAt.toISOString(), endsAt: ex.endsAt.toISOString() } },
        w.shopId,
        tx,
      );
  }
  const want = new Set(keys);
  for (const ex of existing) {
    if (want.has(ex.clockKey!) || ex.overriddenAt || ex.startsAt < from || ex.startsAt >= to) continue;
    await tx.delete(timeBlocks).where(eq(timeBlocks.id, ex.id));
    result.removed++;
    await audit(actor, "block.delete", "time_block", ex.id, details(ex, !!reasonById.get(ex.reasonId ?? "")?.private), ex.shopId, tx);
  }
  return result;
}

/**
 * Keeps clock blocks current without a punch: breaks still going move on ahead of now, and at
 * shops with "Not in yet" on, it appears once the scheduled start has passed. `shopIds` limits the
 * "Not in yet" pass to those shops (the calendar and Today); the cron does every live shop.
 */
export async function refreshClockBlocks(now = new Date(), shopIds?: readonly string[]): Promise<SyncResult> {
  const open = await db
    .selectDistinct({ staffId: timeBlocks.staffId })
    .from(timeBlocks)
    .where(and(eq(timeBlocks.clockOpen, true), isNull(timeBlocks.overriddenAt), lt(timeBlocks.endsAt, new Date(now.getTime() + CLOCK_ROLL_MS - 60_000)), shopIds ? inArray(timeBlocks.shopId, shopIds.length ? [...shopIds] : NONE) : undefined));
  const live = await db
    .select({ id: shops.id, timeClock: shops.timeClock })
    .from(shops)
    .where(and(ne(shops.status, "archived"), shopIds ? inArray(shops.id, shopIds.length ? [...shopIds] : NONE) : eq(shops.status, "live")));
  const notIn = live.filter((s) => shopClockSettings(s.timeClock).notInBlock).map((s) => s.id);
  const today = todayLocal(now);
  const started = notIn.length
    ? await db
        .selectDistinct({ staffId: staffSchedules.staffId })
        .from(staffSchedules)
        .where(and(inArray(staffSchedules.shopId, notIn), eq(staffSchedules.weekday, weekdayOf(today)), sql`${staffSchedules.startMin} <= ${localMinutesOf(now)}`, sql`${staffSchedules.endMin} > ${localMinutesOf(now) - 60}`))
    : [];
  const ids = [...new Set([...open.map((r) => r.staffId), ...started.map((r) => r.staffId)])];
  if (!ids.length) return { created: 0, updated: 0, removed: 0 };
  return syncClockBlocks(ids, { from: startOfLocalDay(today), to: now }, { now });
}

// ───────────────────────────── A manager's override ─────────────────────────────

async function clockBlock(id: string, tx: DBorTx = db): Promise<BlockRow> {
  const [b] = await tx.select().from(timeBlocks).where(eq(timeBlocks.id, id));
  if (!b || b.source !== "clock") throw notFound("Time clock block");
  return b;
}

const isPrivate = async (b: BlockRow, tx: DBorTx) => (b.reasonId ? !!(await tx.query.blockReasons.findFirst({ where: eq(blockReasons.id, b.reasonId) }))?.private : false);

function cleanNote(note: string | null | undefined) {
  const n = note?.trim() || null;
  if (n && n.length > 200) throw new AppError("bad_request", "Keep the note to 200 characters");
  return n;
}

/** A manager sets a clock block's times by hand. From then on punches don't move it, until it's handed back to the clock. */
export async function overrideClockBlock(id: string, change: { startsAt: Date; endsAt: Date }, actor: Actor, note?: string | null) {
  if (Number.isNaN(change.startsAt.getTime()) || Number.isNaN(change.endsAt.getTime())) throw new AppError("bad_request", "Enter a start and an end");
  if (change.endsAt <= change.startsAt) throw new AppError("bad_request", "End must be after start");
  const why = cleanNote(note);
  return db.transaction(async (tx) => {
    const b = await clockBlock(id, tx);
    await tx.update(timeBlocks).set({ startsAt: change.startsAt, endsAt: change.endsAt, clockOpen: false, overriddenAt: new Date(), overriddenBy: actor.staffId ?? null }).where(eq(timeBlocks.id, id));
    await audit(
      actor,
      "block.clock_override",
      "time_block",
      id,
      { ...details({ ...b, ...change }, await isPrivate(b, tx)), before: { startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), overridden: !!b.overriddenAt }, overrideNote: why, via: "manager" },
      b.shopId,
      tx,
    );
    return b;
  });
}

/** A manager takes a clock block off the calendar. The clock won't write it again. */
export async function releaseClockBlock(id: string, actor: Actor, note?: string | null) {
  const why = cleanNote(note);
  return db.transaction(async (tx) => {
    const b = await clockBlock(id, tx);
    await tx
      .insert(clockBlockReleases)
      .values({ clockKey: b.clockKey!, staffId: b.staffId, shopId: b.shopId, releasedBy: actor.staffId ?? null, note: why })
      .onConflictDoNothing();
    await tx.delete(timeBlocks).where(eq(timeBlocks.id, id));
    await audit(actor, "block.clock_release", "time_block", id, { ...details(b, await isPrivate(b, tx)), overrideNote: why, via: "manager" }, b.shopId, tx);
    return b;
  });
}

/** Hands an overridden clock block back to the clock: its times follow the punches again. */
export async function resetClockBlock(id: string, actor: Actor, now = new Date()) {
  const b = await db.transaction(async (tx) => {
    const row = await clockBlock(id, tx);
    if (!row.overriddenAt) throw new AppError("conflict", "This block already follows the clock");
    await tx.update(timeBlocks).set({ overriddenAt: null, overriddenBy: null }).where(eq(timeBlocks.id, id));
    await audit(actor, "block.clock_reset", "time_block", id, { ...details(row, await isPrivate(row, tx)), via: "manager" }, row.shopId, tx);
    return row;
  });
  await syncClockBlocks([b.staffId], { from: b.startsAt, to: b.startsAt }, { now, actor });
  return b;
}

/** Clock blocks at these shops on one day, for the fallout alerts: the ones overlapping a client still to be seen. */
export async function clockBlocksOn(shopIds: readonly string[], date: string, tx: DBorTx = db) {
  if (!shopIds.length) return [];
  return tx
    .select()
    .from(timeBlocks)
    .where(and(eq(timeBlocks.source, "clock"), inArray(timeBlocks.shopId, [...shopIds]), lt(timeBlocks.startsAt, endOfLocalDay(date)), gt(timeBlocks.endsAt, startOfLocalDay(date))));
}
