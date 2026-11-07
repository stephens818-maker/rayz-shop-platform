"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { BULK_ACTIONS, SYNC_SCOPES, SYNC_TYPES } from "@/domain/brand-sync";
import type { Permission } from "@/domain/permissions";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import {
  batchDetail,
  bulkSync,
  cancelScheduled,
  commitBrandChange,
  previewBrandChange,
  rollbackSync,
  runScheduledNow,
  setSyncControl,
} from "@/server/brand-sync/engine";
import { ADAPTERS } from "@/server/brand-sync/registry";
import type { Who } from "@/server/brand-sync/types";

const Change = z.object({ type: z.enum(SYNC_TYPES), item: z.string().min(1).max(200), value: z.unknown() });
const Changes = z.array(Change).min(1, "Nothing to save").max(200);
const Commit = z.object({
  changes: Changes,
  scope: z.enum(SYNC_SCOPES),
  shopIds: z.array(z.uuid()).max(1000),
  overrides: z.record(z.uuid(), z.enum(["keep", "replace"])).default({}),
  runAt: z.iso.datetime({ offset: true }).nullable().optional(),
  label: z.string().max(120).optional(),
});
const Cells = z.array(z.object({ key: z.string().min(3).max(220), shopId: z.uuid() })).min(1, "Pick at least one cell").max(20_000);

const ANY_SYNC_PERM = [...new Set(Object.values(ADAPTERS).flatMap((a) => a.brandPerms))] as Permission[];
const permsFor = (changes: readonly { type: string; item: string }[]) =>
  [
    ...new Set(
      changes.flatMap((c) => {
        const a = ADAPTERS[c.type as keyof typeof ADAPTERS];
        return a ? (a.itemPerms?.(c.item) ?? a.brandPerms) : [];
      }),
    ),
  ] as Permission[];

async function who(perms: Permission[] = ANY_SYNC_PERM): Promise<Who> {
  const ctx = await authorize(perms.length ? perms : ANY_SYNC_PERM);
  return { actor: ctx.actor, ctx };
}

function refresh(paths: readonly string[]) {
  for (const p of new Set([...paths, "/admin/sync-status"])) revalidatePath(p);
}

export async function previewBrandSyncAction(raw: z.input<typeof Changes>) {
  return safe(async () => {
    const changes = Changes.parse(raw);
    return previewBrandChange(await who(permsFor(changes)), changes);
  });
}

export async function commitBrandSyncAction(raw: z.input<typeof Commit>) {
  return safe(async () => {
    const input = Commit.parse(raw);
    const r = await commitBrandChange(await who(permsFor(input.changes)), input);
    refresh(r.paths);
    return r;
  });
}

export async function bulkSyncAction(action: string, raw: z.input<typeof Cells>) {
  return safe(async () => {
    const cells = Cells.parse(raw);
    const r = await bulkSync(await who(), z.enum(BULK_ACTIONS).parse(action), cells);
    refresh(r.paths);
    return r;
  });
}

export async function rollbackSyncAction(batchId: string) {
  return safe(async () => {
    const r = await rollbackSync(await who(), z.uuid().parse(batchId));
    refresh(r.paths);
    return r;
  });
}

export async function runScheduledNowAction(batchId: string) {
  return safe(async () => {
    refresh(await runScheduledNow(await who(), z.uuid().parse(batchId)));
    return null;
  });
}

export async function cancelScheduledAction(batchId: string) {
  return safe(async () => {
    await cancelScheduled(await who(), z.uuid().parse(batchId));
    refresh([]);
    return null;
  });
}

export async function batchDetailAction(batchId: string) {
  return safe(async () => {
    await who();
    return batchDetail(z.uuid().parse(batchId));
  });
}

export async function setSyncControlAction(type: string, on: boolean) {
  return safe(async () => {
    const t = z.enum(SYNC_TYPES).parse(type);
    refresh(await setSyncControl(await who(permsFor([{ type: t, item: "" }])), t, z.boolean().parse(on)));
    return null;
  });
}
