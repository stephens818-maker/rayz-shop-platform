"use server";

import { revalidatePath } from "next/cache";
import { unsubscribeByEmailLink } from "@/server/notifications/email-events";

export async function stopEmailsAction(token: string): Promise<void> {
  await unsubscribeByEmailLink(token);
  revalidatePath(`/u/e/${token}`);
}
