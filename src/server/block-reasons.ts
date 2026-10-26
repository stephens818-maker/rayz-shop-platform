import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import {
  blockReasons,
  timeBlockSeries,
  timeBlocks,
  timeOffRequests,
} from "@/db/schema";
import {
  BlockReason,
  PICKABLE_USES,
  ReasonUse,
  ReasonViewer,
  ReasonedEntry,
  ShownReason,
  USE_LABEL,
  forBlocks,
  forTimeOff,
  reasonProblem,
  showReason,
  slugKey,
} from "@/domain/block-reasons";
import { Actor, audit } from "./audit";
import type { StaffContext } from "./auth/staff";
import { hiddenAt, markNewListItem, offeredAt } from "./brand-sync/lists";
import { AppError, notFound } from "./errors";

type Row = typeof blockReasons.$inferSelect;
const toReason = (r: Row): BlockReason => ({
  id: r.id,
  key: r.key,
  label: r.label,
  color: r.color,
  usedFor: r.usedFor,
  countsAsLunch: r.countsAsLunch,
  noticeExempt: r.noticeExempt,
  private: r.private,
  sortOrder: r.sortOrder,
  archived: r.archivedAt !== null,
});

/** The whole list, archived ones too (old entries still carry them), in the brand's order. */
export async function listReasons(tx: DBorTx = db): Promise<BlockReason[]> {
  const rows = await tx
    .select()
    .from(blockReasons)
    .orderBy(asc(blockReasons.sortOrder), asc(blockReasons.label));
  return rows.map(toReason);
}

export async function reasonMap(
  tx: DBorTx = db,
): Promise<Map<string, BlockReason>> {
  return new Map((await listReasons(tx)).map((r) => [r.id, r]));
}

/** Shows entries' reasons to one viewer. */
export async function reasonShower(viewer: ReasonViewer, tx: DBorTx = db) {
  const map = await reasonMap(tx);
  return (e: ReasonedEntry, timeOff = false): ShownReason =>
    showReason(e, map, viewer, timeOff);
}

/** A reason that can be picked for this, or a message saying why not. With a shop, it has to be one the shop offers. */
export async function usableReason(
  id: string,
  use: "blocks" | "time_off",
  tx: DBorTx = db,
  shopId?: string | null,
): Promise<BlockReason> {
  const row = await tx.query.blockReasons.findFirst({
    where: eq(blockReasons.id, id),
  });
  if (!row) throw new AppError("bad_request", "Pick a reason");
  const r = toReason(row);
  if (r.archived)
    throw new AppError(
      "bad_request",
      `"${r.label}" is no longer on the reasons list. Pick another.`,
    );
  if (use === "blocks" ? !forBlocks(r) : !forTimeOff(r))
    throw new AppError(
      "bad_request",
      `"${r.label}" is for ${USE_LABEL[r.usedFor].toLowerCase()} only`,
    );
  if ((await hiddenAt("block_reason", shopId, tx)).has(r.id))
    throw new AppError(
      "bad_request",
      `"${r.label}" isn't on this shop's reasons list. Pick another.`,
    );
  return r;
}

/** The reason "Lunch now" uses: the first one that counts as lunch. */
export async function lunchReason(
  shopId?: string | null,
  tx: DBorTx = db,
): Promise<BlockReason> {
  const r = (
    await offeredAt("block_reason", shopId, await listReasons(tx), tx)
  ).find((x) => x.countsAsLunch && forBlocks(x));
  if (!r)
    throw new AppError(
      "bad_request",
      "There's no lunch reason on the list. Ask a manager to add one.",
    );
  return r;
}

export interface ReasonEdit {
  id: string | null;
  label: string;
  color: string;
  usedFor: ReasonUse;
  countsAsLunch: boolean;
  noticeExempt: boolean;
  private: boolean;
}

const auditView = (
  r: Pick<
    BlockReason,
    "label" | "color" | "usedFor" | "countsAsLunch" | "noticeExempt" | "private"
  >,
) => ({
  label: r.label,
  color: r.color,
  usedFor: r.usedFor,
  countsAsLunch: r.countsAsLunch,
  noticeExempt: r.noticeExempt,
  private: r.private,
});

/** Add a reason or change one. Renaming changes what every entry with it shows. */
export async function saveReason(
  input: ReasonEdit,
  actor: Actor,
  ctx: StaffContext | null = null,
): Promise<BlockReason> {
  const problem = reasonProblem(input);
  if (problem) throw new AppError("bad_request", problem);
  const label = input.label.trim();
  const color = input.color.toLowerCase();
  return db.transaction(async (tx) => {
    const dup = await tx.query.blockReasons.findFirst({
      where: and(
        sql`lower(${blockReasons.label}) = lower(${label})`,
        isNull(blockReasons.archivedAt),
        input.id ? ne(blockReasons.id, input.id) : undefined,
      ),
    });
    if (dup)
      throw new AppError(
        "conflict",
        `There's already a reason called "${dup.label}"`,
      );
    const before = input.id
      ? await tx.query.blockReasons.findFirst({
          where: eq(blockReasons.id, input.id),
        })
      : undefined;
    if (input.id && !before) throw notFound("Reason");
    const clock = before?.usedFor === "clock";
    if (!clock && !PICKABLE_USES.includes(input.usedFor))
      throw new AppError("bad_request", "Pick blocks, time off or both");
    const values = clock
      ? {
          label,
          color,
          usedFor: "clock" as const,
          countsAsLunch: false,
          noticeExempt: false,
          private: input.private,
        }
      : {
          label,
          color,
          usedFor: input.usedFor,
          countsAsLunch: input.countsAsLunch,
          noticeExempt: input.noticeExempt,
          private: input.private,
        };
    if (input.id && before) {
      const [row] = await tx
        .update(blockReasons)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(blockReasons.id, input.id))
        .returning();
      if (before.label !== row.label) {
        await tx
          .update(timeBlocks)
          .set({ reason: row.label })
          .where(eq(timeBlocks.reasonId, row.id));
        await tx
          .update(timeBlockSeries)
          .set({ reason: row.label })
          .where(eq(timeBlockSeries.reasonId, row.id));
        await tx
          .update(timeOffRequests)
          .set({ reason: row.label })
          .where(eq(timeOffRequests.reasonId, row.id));
      }
      await audit(
        actor,
        "block_reason.update",
        "block_reason",
        row.id,
        {
          before: auditView(toReason(before)),
          after: auditView(toReason(row)),
        },
        null,
        tx,
      );
      return toReason(row);
    }
    const taken = new Set(
      (await tx.select({ key: blockReasons.key }).from(blockReasons)).map(
        (r) => r.key,
      ),
    );
    let key = slugKey(label);
    for (let n = 2; taken.has(key); n++) key = `${slugKey(label)}_${n}`;
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${blockReasons.sortOrder}), 0)` })
      .from(blockReasons);
    const [row] = await tx
      .insert(blockReasons)
      .values({ ...values, key, sortOrder: Number(max) + 10 })
      .returning();
    await markNewListItem(tx, "block_reason", row.id, { actor, ctx });
    await audit(
      actor,
      "block_reason.create",
      "block_reason",
      row.id,
      auditView(toReason(row)),
      null,
      tx,
    );
    return toReason(row);
  });
}

/** Take a reason off the list (entries that have it keep it) or put it back. */
export async function archiveReason(
  id: string,
  archived: boolean,
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    const before = await tx.query.blockReasons.findFirst({
      where: eq(blockReasons.id, id),
    });
    if (!before) throw notFound("Reason");
    if (!archived) {
      const dup = await tx.query.blockReasons.findFirst({
        where: and(
          sql`lower(${blockReasons.label}) = lower(${before.label})`,
          isNull(blockReasons.archivedAt),
          ne(blockReasons.id, id),
        ),
      });
      if (dup)
        throw new AppError(
          "conflict",
          `There's already a reason called "${dup.label}". Rename one first.`,
        );
    }
    await tx
      .update(blockReasons)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(blockReasons.id, id));
    await audit(
      actor,
      archived ? "block_reason.archive" : "block_reason.restore",
      "block_reason",
      id,
      { label: before.label },
      null,
      tx,
    );
  });
}

/** Move a reason up or down the list the pickers show. */
export async function moveReason(id: string, dir: -1 | 1, actor: Actor) {
  return db.transaction(async (tx) => {
    const list = await listReasons(tx);
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) throw notFound("Reason");
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    for (const [n, r] of list.entries()) {
      if (r.sortOrder !== (n + 1) * 10)
        await tx
          .update(blockReasons)
          .set({ sortOrder: (n + 1) * 10 })
          .where(eq(blockReasons.id, r.id));
    }
    await audit(
      actor,
      "block_reason.move",
      "block_reason",
      id,
      { label: list[j].label, to: j + 1 },
      null,
      tx,
    );
  });
}

/** What a break can be for at break start: the block reasons, Break first. */
export async function breakReasons(shopId?: string | null, tx: DBorTx = db) {
  const list = (
    await offeredAt("block_reason", shopId, await listReasons(tx), tx)
  ).filter(forBlocks);
  return [
    ...list.filter((r) => r.key === "break"),
    ...list.filter((r) => r.key !== "break"),
  ].map((r) => ({ id: r.id, label: r.label }));
}

/** The reasons a picker offers for blocks or for time off, at a shop (none: every one on the brand's list). */
export async function pickerReasons(
  use: "blocks" | "time_off",
  shopId?: string | null,
  tx: DBorTx = db,
) {
  return (await offeredAt("block_reason", shopId, await listReasons(tx), tx))
    .filter((r) => (use === "blocks" ? forBlocks(r) : forTimeOff(r)))
    .map((r) => ({
      id: r.id,
      label: r.label,
      color: r.color,
      private: r.private,
      countsAsLunch: r.countsAsLunch,
      noticeExempt: r.noticeExempt,
    }));
}
