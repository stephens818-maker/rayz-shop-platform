"use server";

import { safe } from "@/server/action";
import { rateVisit } from "@/server/analytics";
import { stopReceiptEmails } from "@/server/receipts";

export async function stopEmailsAction(token: string) {
  return safe(async () => {
    await stopReceiptEmails(String(token ?? ""));
    return null;
  });
}

export async function rateVisitAction(token: string, stars: number) {
  return safe(() => rateVisit(String(token ?? ""), Number(stars)));
}
