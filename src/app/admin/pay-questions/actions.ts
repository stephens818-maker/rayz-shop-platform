"use server";

import { revalidatePath } from "next/cache";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { answerPayQuestion, askPayQuestion, escalatePayQuestion, resolvePayQuestion } from "@/server/pay-questions";

const OWN = ["timesheet.own"] as const;
const ANSWER = ["timesheet.approve", "payroll.run", "payroll.export", "payroll.approve"] as const;

export async function askPayQuestionAction(input: { shopId: string; periodStart: string | null; topic: string; detail: string }) {
  return safe(async () => {
    const ctx = await authorize(OWN, "You can't ask about your pay here");
    const q = await askPayQuestion({ staffId: ctx.staff.id, actor: ctx.actor }, input);
    revalidatePath("/admin/pay-questions");
    return { id: q.id };
  });
}

export async function escalatePayQuestionAction(id: string, note: string) {
  return safe(async () => {
    const ctx = await authorize(OWN, "You can't ask about your pay here");
    await escalatePayQuestion({ staffId: ctx.staff.id, actor: ctx.actor }, id, note || null);
    revalidatePath("/admin/pay-questions");
    return null;
  });
}

export async function resolvePayQuestionAction(id: string) {
  return safe(async () => {
    const ctx = await authorize(OWN, "You can't ask about your pay here");
    await resolvePayQuestion({ staffId: ctx.staff.id, actor: ctx.actor }, id);
    revalidatePath("/admin/pay-questions");
    return null;
  });
}

export async function answerPayQuestionAction(id: string, answer: string) {
  return safe(async () => {
    const ctx = await authorize(ANSWER, "You can't answer pay questions");
    await answerPayQuestion({ staffId: ctx.staff.id, actor: ctx.actor, isOwner: ctx.isOwner, shopIds: ctx.shopIds, permissions: ctx.permissions }, id, answer);
    revalidatePath("/admin/pay-questions");
    return null;
  });
}
