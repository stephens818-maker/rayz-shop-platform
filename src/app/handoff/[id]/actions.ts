"use server";

import { cookies } from "next/headers";
import { safe } from "@/server/action";
import { HANDOFF_COOKIE } from "@/server/auth/cookies";
import { handoffIdFrom } from "@/server/auth/handoff-lock";
import { forbidden } from "@/server/errors";
import {
  HandoffTender,
  chooseReceipt,
  chooseTip,
  collectOnReader,
  finishHandoff,
  handoffView,
  inspectCard,
  payHandoff,
  requestCash,
  sign,
  unlockHandoff,
  unlockPeople,
} from "@/server/handoff";

/** Only the browser the ticket was handed on drives its customer screen. */
async function onThisDevice(id: string) {
  const jar = await cookies();
  if ((await handoffIdFrom(jar.get(HANDOFF_COOKIE)?.value)) !== id) throw forbidden("This customer screen isn't open on this device");
}

async function release() {
  (await cookies()).delete(HANDOFF_COOKIE);
}

export async function viewAction(id: string) {
  return safe(async () => (await onThisDevice(id), handoffView(id)));
}

export async function tipAction(id: string, choice: string, cents: number, byStaff?: { staffId: string; cents: number }[] | null) {
  return safe(async () => (await onThisDevice(id), chooseTip(id, choice, cents, byStaff)));
}

export async function signAction(id: string, path: string) {
  return safe(async () => (await onThisDevice(id), sign(id, path)));
}

export async function receiptAction(id: string, input: { channel: "sms" | "email" | "none"; onFile: boolean; to?: string }) {
  return safe(async () => (await onThisDevice(id), chooseReceipt(id, input)));
}

export async function readerAction(id: string, input: { testCard: string; readerId: string; tip?: { choice: string; cents: number } | null }) {
  return safe(async () => (await onThisDevice(id), collectOnReader(id, input)));
}

export async function cardAction(id: string, paymentMethodId: string) {
  return safe(async () => (await onThisDevice(id), inspectCard(id, paymentMethodId)));
}

export async function payAction(id: string, tender: HandoffTender, expectedTotalCents: number) {
  return safe(async () => (await onThisDevice(id), payHandoff(id, tender, expectedTotalCents)));
}

export async function cashAction(id: string) {
  return safe(async () => (await onThisDevice(id), requestCash(id)));
}

export async function unlockPeopleAction(id: string) {
  return safe(async () => (await onThisDevice(id), unlockPeople(id)));
}

export async function unlockAction(id: string, staffId: string, pin: string) {
  return safe(async () => {
    await onThisDevice(id);
    const r = await unlockHandoff(id, staffId, pin);
    await release();
    return r;
  });
}

export async function finishAction(id: string) {
  return safe(async () => {
    await onThisDevice(id);
    const r = await finishHandoff(id);
    await release();
    return r;
  });
}
