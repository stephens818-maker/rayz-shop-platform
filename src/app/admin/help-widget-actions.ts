"use server";

import { handbookFor } from "@/domain/handbook";
import { handbookAnswer, helpWidgetOn } from "@/domain/help-widget";
import { safe } from "@/server/action";
import { requireStaff } from "@/server/auth/staff";
import { AppError } from "@/server/errors";

/** Handbook topics this person can already open. No tools, no client records, no paid call when the cap is 0. */
export async function askHelpAction(question: string) {
  return safe(async () => {
    if (!helpWidgetOn()) throw new AppError("forbidden", "The how-to assistant is off.");
    const ctx = await requireStaff();
    const topics = handbookFor(ctx.permissions);
    return { answer: handbookAnswer(topics, question.slice(0, 400)) };
  });
}
