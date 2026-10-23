import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, notificationJobs, shops } from "@/db/schema";
import { maskPhone } from "@/domain/client-privacy";
import { audit } from "./audit";
import { StaffContext, can } from "./auth/staff";
import { recordClientAccess } from "./client-privacy";
import { customerAccess } from "./customers";
import { AppError, notFound } from "./errors";
import { logCall, optedOut, queueShopText } from "./messaging";
import { processDueJobs } from "./notifications/queue";

export const STAFF_TEXT_MAX = 320;

/**
 * A call or text to a client from the shop, without the staff member ever seeing the number: the
 * system looks it up and hands it to the provider. Calls ring the shop phone, then connect the client
 * showing the shop's Twilio number, and go in the client's call log; texts go out from the shop's
 * number into the shop inbox, only to clients who agreed to texts and haven't replied STOP.
 */
export async function contactClient(ctx: StaffContext, customerId: string, input: { channel: "sms" | "call"; message?: string }) {
  if (!(await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, customerId))) throw notFound("Client");
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c) throw notFound("Client");
  if (!c.phone) throw new AppError("bad_request", "There's no phone number on file for this client");
  const shopId = ctx.currentShopId ?? ctx.shopIds[0] ?? null;
  const shop = shopId ? await db.query.shops.findFirst({ where: eq(shops.id, shopId) }) : null;
  const from = `Ray'z ${shop?.name ?? "Barber Shop"}`;
  let jobId: string;
  if (input.channel === "sms") {
    const message = (input.message ?? "").trim();
    if (!message) throw new AppError("bad_request", "Write a message");
    if (message.length > STAFF_TEXT_MAX) throw new AppError("bad_request", `Keep it under ${STAFF_TEXT_MAX} characters`);
    if (!c.smsOptIn) throw new AppError("conflict", "This client hasn't agreed to texts. Call them through the shop line instead.");
    if (await optedOut(c.phone, "sms")) throw new AppError("conflict", "This number replied STOP, so it can't be texted until it replies START.");
    jobId = shopId
      ? await queueShopText({ shopId, to: c.phone, body: `${from}: ${message}`, kind: "staff_text", customerId: c.id, staffId: ctx.staff.id, auto: false })
      : (await db.insert(notificationJobs).values({ kind: "staff_text", channel: "sms", to: c.phone, body: `${from}: ${message}`, customerId: c.id, shopId, runAt: new Date() }).returning({ id: notificationJobs.id }))[0].id;
  } else {
    const [row] = await db
      .insert(notificationJobs)
      .values({
        kind: "staff_call",
        channel: "voice",
        to: c.phone,
        subject: shop?.phone ?? null,
        body: `${ctx.staff.displayLabel} called ${c.firstName} through the ${from} line.`,
        customerId: c.id,
        shopId,
        runAt: new Date(),
      })
      .returning({ id: notificationJobs.id });
    jobId = row.id;
  }
  await processDueJobs({ ids: [jobId], limit: 1 });
  const sent = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.id, jobId), columns: { status: true, providerMessageId: true } });
  if (input.channel === "call") {
    await logCall({ shopId, phone: c.phone, direction: "out", kind: "click_to_call", status: sent?.status === "sent" ? "initiated" : "failed", providerCallId: sent?.providerMessageId ?? null, staffId: ctx.staff.id, customerId: c.id });
  }
  await recordClientAccess(ctx, { kind: "contact", customerId: c.id, detail: { channel: input.channel } });
  await audit(ctx.actor, input.channel === "sms" ? "client.text" : "client.call", "customer", c.id, { jobId }, shopId);
  return { status: sent?.status ?? "pending", to: maskPhone(c.phone) };
}
