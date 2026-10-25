"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { safe } from "@/server/action";
import { requireStaff } from "@/server/auth/staff";
import { LIVE_KINDS } from "@/domain/milestones";
import { saveMyMilestonePrefs } from "@/server/milestones/admin";
import { celebrationsAt } from "@/server/milestones/day";
import { loadMilestoneSettings } from "@/server/milestones/engine";
import {
  cheerMilestone,
  markSeen,
  uncheerMilestone,
} from "@/server/milestones/views";

const Ids = z.array(z.uuid()).max(100);

/** The live toast never reaches back further than this, however stale the tab's clock is. */
const LIVE_LOOKBACK_MS = 15 * 60_000;

/**
 * Counts reached at the shop they're working in (every shop of theirs when they view them all)
 * since `since`, for the live toast. Everyone signed in there polls this.
 */
export async function milestoneToastsAction(since: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    const now = new Date();
    const s = await loadMilestoneSettings();
    if (!s.enabled || !s.liveToast)
      return { now: now.toISOString(), items: [] };
    const asked = Date.parse(z.string().max(40).parse(since));
    const from = new Date(
      Math.max(
        Number.isNaN(asked) ? 0 : asked,
        now.getTime() - LIVE_LOOKBACK_MS,
      ),
    );
    const shopIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
    const items = await celebrationsAt(shopIds, {
      now,
      s,
      since: from,
      kinds: LIVE_KINDS,
    });
    return {
      now: now.toISOString(),
      items: items.map((c) => ({
        id: c.id,
        text: c.text,
        mine: c.staffId === ctx.staff.id,
      })),
    };
  });
}

/** Dismisses their congratulations notice. */
export async function dismissCongratsAction(ids: string[]) {
  return safe(async () => {
    const ctx = await requireStaff();
    const n = await markSeen(ctx, Ids.parse(ids));
    revalidatePath("/admin");
    revalidatePath("/admin/milestones");
    return { n };
  });
}

export async function cheerAction(milestoneId: string, message: string | null) {
  return safe(async () => {
    const ctx = await requireStaff();
    await cheerMilestone(
      ctx,
      z.uuid().parse(milestoneId),
      z.string().max(500).nullable().parse(message),
    );
    revalidatePath("/admin/milestones");
    return null;
  });
}

export async function uncheerAction(milestoneId: string) {
  return safe(async () => {
    const ctx = await requireStaff();
    await uncheerMilestone(ctx, z.uuid().parse(milestoneId));
    revalidatePath("/admin/milestones");
    return null;
  });
}

/** Their birthday (month and day) and whether teammates and clients see their milestones. */
export async function saveMyMilestonePrefsAction(input: {
  birthday?: { month: number; day: number } | null;
  shared?: boolean;
}) {
  return safe(async () => {
    const ctx = await requireStaff();
    await saveMyMilestonePrefs(ctx, input);
    revalidatePath("/admin/milestones");
    return null;
  });
}
