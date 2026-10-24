"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { LOOKUP_KEYS, LookupKey } from "@/domain/lookups";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { saveLookup } from "@/server/lookups";

export async function saveLookupAction(key: string, items: string[]) {
  return safe(async () => {
    const ctx = await authorize("settings.lists", "You can't edit the brand's picklists");
    const clean = await saveLookup(z.enum(LOOKUP_KEYS as [LookupKey, ...LookupKey[]]).parse(key), z.array(z.string().max(200)).max(200).parse(items), ctx.actor);
    for (const p of ["/admin/lists", "/admin/services", "/admin/inventory", "/admin/sales"]) revalidatePath(p);
    return clean;
  });
}
