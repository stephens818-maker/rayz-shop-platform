"use server";

import { safe } from "@/server/action";
import { stopReceiptEmails } from "@/server/receipts";

export async function stopEmailsAction(token: string) {
  return safe(async () => {
    await stopReceiptEmails(String(token ?? ""));
    return null;
  });
}
