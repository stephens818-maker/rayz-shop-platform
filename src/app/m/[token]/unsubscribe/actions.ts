"use server";

import { safe } from "@/server/action";
import { AppError } from "@/server/errors";
import { unsubscribeByToken } from "@/server/marketing/links";

export async function unsubscribeAction(token: string) {
  return safe(async () => {
    if (!(await unsubscribeByToken(String(token ?? "")))) throw new AppError("not_found", "This link has expired");
    return null;
  });
}
