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
import { processDueJobs } from "./notifications/queue";

export const STAFF_TEXT_MAX = 320;

/**
 * A call or text to a client from the shop, without the staff member ever seeing the number: the
 * system looks it up and hands it to the provider (a stub until go-live). Calls ring the shop line
 * and connect the client; texts go out from the shop, only to clients who agreed to texts.
 */
export async function contactClient(ctx: StaffContext, customerId: string, input: { channel: "sms" | "call"; message?: string }) {
  if (!(await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, customerId))) throw notFound("Client");
  const c = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c) throw notFound("Client");
  if (!c.phone) throw new AppError("bad_request", "There's no phone number on file for this client");
  const shopId = ctx.currentShopId ?? ctx.shopIds[0] ?? null;
  const shop = shopId ? await db.query.shops.findFirst({ where: eq(shops.id, shopId) }) : null;
  const from = `Ray'z ${shop?.name ?? "Barber Shop"}`;
  let job: typeof notificationJobs.$inferInsert;
  if (input.channel === "sms") {
    const message = (input.message ?? "").trim();
    if (!message) throw new AppError("bad_request", "Write a message");
    if (message.length > STAFF_TEXT_MAX) throw new AppError("bad_request", `Keep it under ${STAFF_TEXT_MAX} characters`);
    if (!c.smsOptIn) throw new AppError("conflict", "This client hasn't agreed to texts. Call them through the shop line instead.");
    job = { kind: "staff_text", channel: "sms", to: c.phone, body: `${from}: ${message}`, customerId: c.id, shopId, runAt: new Date() };
  } else {
    job = {
      kind: "staff_call",
      channel: "voice",
      to: c.phone,
      subject: shop?.phone ?? null,
      body: `${ctx.staff.displayLabel} called ${c.firstName} through the ${from} line.`,
      customerId: c.id,
      shopId,
      runAt: new Date(),
    };
  }
  const [row] = await db.insert(notificationJobs).values(job).returning({ id: notificationJobs.id });
  await processDueJobs({ ids: [row.id], limit: 1 });
  const sent = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.id, row.id), columns: { status: true } });
  await recordClientAccess(ctx, { kind: "contact", customerId: c.id, detail: { channel: input.channel } });
  await audit(ctx.actor, input.channel === "sms" ? "client.text" : "client.call", "customer", c.id, { jobId: row.id }, shopId);
  return { status: sent?.status ?? "pending", to: maskPhone(c.phone) };
}
