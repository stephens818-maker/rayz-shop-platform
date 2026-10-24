"use server";

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { messageThreads, notificationJobs, shops } from "@/db/schema";
import { normalizePhone } from "@/lib/phone";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import { StaffContext, assertShopAccess, authorize } from "@/server/auth/staff";
import { AppError, forbidden, notFound } from "@/server/errors";
import { liveTwilio } from "@/server/notifications/providers";
import { handleCallStatus, handleDialResult, handleIncomingCall, handleInboundSms, handleOperatorChoice, voiceOutreachAnswer, voiceOutreachGather } from "@/server/shop-line";
import { requireInTenant } from "@/server/tenant";

const sid = (p: string) => `${p}sim${randomBytes(12).toString("hex")}`;

async function simulator() {
  const ctx = await authorize("notifications.send", "You can't use the call simulator");
  if (liveTwilio()) throw forbidden("Twilio is connected, so the simulator is off");
  return ctx;
}

/** The shop line and the client's number for a simulated text or call: a thread the tester can see, or a number typed in. */
async function lineAndPhone(ctx: StaffContext, shopId: string, from: { threadId?: string | null; phone?: string | null }) {
  assertShopAccess(ctx, shopId);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  if (!shop.twilioNumber) throw new AppError("conflict", "Give this shop a Twilio number in Shop settings first");
  let phone: string | null = null;
  if (from.threadId) {
    await requireInTenant(ctx, "message_thread", from.threadId);
    phone = (await db.query.messageThreads.findFirst({ where: eq(messageThreads.id, from.threadId) }))?.phone ?? null;
  } else if (from.phone) phone = normalizePhone(from.phone);
  if (!phone) throw new AppError("bad_request", "Pick a conversation or type a phone number");
  return { shop, line: shop.twilioNumber, phone };
}

export async function simulateTextAction(shopId: string, from: { threadId?: string | null; phone?: string | null }, body: string) {
  return safe(async () => {
    const ctx = await simulator();
    if (!body.trim()) throw new AppError("bad_request", "Write the text");
    const { line, phone, shop } = await lineAndPhone(ctx, shopId, from);
    const r = await handleInboundSms({ from: phone, to: line, body: body.trim(), messageSid: sid("SM") });
    await audit(ctx.actor, "simulator.sms", "message_thread", r.threadId, { handled: r.handled }, shop.id);
    revalidatePath("/admin/notifications/simulator");
    revalidatePath("/admin/inbox");
    return { handled: r.handled, threadId: r.threadId };
  });
}

/**
 * A call to the shop line: "answered" or "missed" by the shop phone, unless it's after hours. When the
 * phone operator answers, `key` is what the caller presses on its menu (none: they press nothing).
 */
export async function simulateCallAction(shopId: string, from: { threadId?: string | null; phone?: string | null }, outcome: "answered" | "missed", key?: string | null) {
  return safe(async () => {
    const ctx = await simulator();
    const { line, phone, shop } = await lineAndPhone(ctx, shopId, from);
    const callSid = sid("CA");
    const dialed = () => handleDialResult({ callSid, dialStatus: outcome === "answered" ? "completed" : "no-answer", duration: outcome === "answered" ? 95 : 0 });
    const twiml = [await handleIncomingCall({ from: phone, to: line, callSid })];
    if (twiml[0].includes("<Dial")) twiml.push(await dialed());
    if (twiml[twiml.length - 1].includes("voice/operator")) {
      const k = key && /^[0-9]$/.test(key) ? key : "";
      twiml.push(await handleOperatorChoice({ callSid, digits: k, none: !k }));
      if (twiml[twiml.length - 1].includes("<Dial")) twiml.push(await dialed());
    }
    await audit(ctx.actor, "simulator.call", "shop", shop.id, { outcome, key: key ?? null }, shop.id);
    revalidatePath("/admin/notifications/simulator");
    return { twiml };
  });
}

/** An automated call-in call reaches the client: a person (then a key), voicemail, or nobody. */
export async function simulateOutreachCallAction(jobId: string, answer: "human" | "machine" | "no_answer", digits?: string | null) {
  return safe(async () => {
    const ctx = await simulator();
    const job = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.id, jobId) });
    if (!job || job.kind !== "callin_voice" || !job.outreachId || !job.providerMessageId) throw notFound("Call");
    if (!job.shopId) throw notFound("Call");
    assertShopAccess(ctx, job.shopId);
    const callSid = job.providerMessageId;
    const twiml: string[] = [];
    if (answer === "no_answer") {
      await handleCallStatus({ callSid, callStatus: "no-answer", duration: 0 });
    } else {
      twiml.push(await voiceOutreachAnswer({ outreachId: job.outreachId, callSid, answeredBy: answer === "human" ? "human" : "machine_end_beep" }));
      if (answer === "human" && digits) twiml.push(await voiceOutreachGather({ outreachId: job.outreachId, callSid, digits }));
      await handleCallStatus({ callSid, callStatus: "completed", duration: 40 });
    }
    await audit(ctx.actor, "simulator.outreach_call", "notification_job", jobId, { answer, digits: digits ?? null }, job.shopId);
    revalidatePath("/admin/notifications/simulator");
    revalidatePath("/admin/call-ins");
    return { twiml };
  });
}
