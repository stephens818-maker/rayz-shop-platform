"use server";

import { safe } from "@/server/action";
import { requestReceiptCopies } from "@/server/receipts";

/** The answer doesn't say whether the number or email matched a client. */
export async function requestReceiptAction(contact: string) {
  return safe(async () => {
    const r = await requestReceiptCopies(String(contact ?? ""));
    return { channel: r.channel, masked: r.masked };
  });
}
