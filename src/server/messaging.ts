import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { callLogs, contactOptOuts, customers, messageThreads, messages, notificationJobs, shops, staff } from "@/db/schema";
import type { CallDirection, CallKind, CallStatus } from "@/db/schema";
import { Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { NotificationKind, processDueJobs } from "./notifications/queue";

/**
 * The shop line's texts and calls: STOP and call opt-outs, the per-shop inbox threads, every text the
 * shop sends to a client, and the call log. Numbers stay on the server; pages mask them.
 */

// ───────────────────────────── Opt-outs ─────────────────────────────

export async function optedOut(phone: string, channel: "sms" | "voice", tx: DBorTx = db) {
  const [hit] = await tx
    .select({ id: contactOptOuts.id })
    .from(contactOptOuts)
    .where(and(eq(contactOptOuts.phone, phone), eq(contactOptOuts.channel, channel)))
    .limit(1);
  return !!hit;
}

/** "sms:+1…" and "voice:+1…" for each of these numbers that opted out. */
export async function optOutKeys(phones: readonly string[], tx: DBorTx = db) {
  if (!phones.length) return new Set<string>();
  const rows = await tx.select({ phone: contactOptOuts.phone, channel: contactOptOuts.channel }).from(contactOptOuts).where(inArray(contactOptOuts.phone, [...phones]));
  return new Set(rows.map((r) => `${r.channel}:${r.phone}`));
}

/**
 * STOP (texts) or 9 on an automated call (calls). STOP also turns off "OK to text" for every client
 * on file with the number, and remembers which, so START turns it back on for those clients only.
 */
export async function recordOptOut(phone: string, channel: "sms" | "voice", source: "reply" | "keypad" | "staff", tx: DBorTx = db) {
  let ids: string[] = [];
  if (channel === "sms") {
    const rows = await tx
      .update(customers)
      .set({ smsOptIn: false })
      .where(and(eq(customers.phone, phone), eq(customers.smsOptIn, true)))
      .returning({ id: customers.id });
    ids = rows.map((r) => r.id);
  }
  await tx
    .insert(contactOptOuts)
    .values({ phone, channel, source, customerIds: ids })
    .onConflictDoUpdate({ target: [contactOptOuts.phone, contactOptOuts.channel], set: { customerIds: sql`${contactOptOuts.customerIds} || ${JSON.stringify(ids)}::jsonb` } });
  return ids;
}

/** START: texts may go to the number again, and the clients STOP turned off are back on. */
export async function recordOptIn(phone: string, tx: DBorTx = db) {
  const [row] = await tx
    .delete(contactOptOuts)
    .where(and(eq(contactOptOuts.phone, phone), eq(contactOptOuts.channel, "sms")))
    .returning();
  const ids = row?.customerIds ?? [];
  if (ids.length) await tx.update(customers).set({ smsOptIn: true }).where(and(inArray(customers.id, ids), eq(customers.phone, phone)));
  return ids;
}

// ───────────────────────────── Who a number is ─────────────────────────────

export async function customersWithPhone(phone: string, tx: DBorTx = db) {
  return tx
    .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName, smsOptIn: customers.smsOptIn })
    .from(customers)
    .where(eq(customers.phone, phone))
    .orderBy(desc(customers.createdAt));
}

/** The client a number belongs to, when exactly one is on file with it (families share numbers). */
export async function onlyCustomerWith(phone: string, tx: DBorTx = db): Promise<string | null> {
  const rows = await customersWithPhone(phone, tx);
  return rows.length === 1 ? rows[0].id : null;
}

// ───────────────────────────── Inbox threads ─────────────────────────────

export async function threadFor(shopId: string, phone: string, tx: DBorTx = db) {
  const customerId = await onlyCustomerWith(phone, tx);
  const [t] = await tx
    .insert(messageThreads)
    .values({ shopId, phone, customerId })
    .onConflictDoUpdate({ target: [messageThreads.shopId, messageThreads.phone], set: { customerId: sql`coalesce(${messageThreads.customerId}, excluded.customer_id)` } })
    .returning();
  return t;
}

export async function logMessage(
  threadId: string,
  m: { direction: "in" | "out" | "note"; body: string; staffId?: string | null; auto?: boolean; jobId?: string | null; providerMessageId?: string | null; unread?: boolean },
  tx: DBorTx = db,
  now = new Date(),
) {
  await tx.insert(messages).values({
    threadId,
    direction: m.direction,
    body: m.body,
    staffId: m.staffId ?? null,
    auto: m.auto ?? false,
    jobId: m.jobId ?? null,
    providerMessageId: m.providerMessageId ?? null,
    createdAt: now,
  });
  await tx
    .update(messageThreads)
    .set({
      lastMessageAt: now,
      ...(m.direction === "in" ? { lastInboundAt: now } : {}),
      ...(m.unread ? { unread: sql`${messageThreads.unread} + 1` } : {}),
    })
    .where(eq(messageThreads.id, threadId));
}

export interface ShopText {
  shopId: string;
  to: string;
  body: string;
  kind: NotificationKind;
  customerId?: string | null;
  appointmentId?: string | null;
  outreachId?: string | null;
  staffId?: string | null;
  /** Sent by the system, not typed by staff. */
  auto: boolean;
  runAt?: Date;
}

/** Queues a text from the shop's number and files it in the shop's thread with that number. Returns the job. */
export async function queueShopText(t: ShopText, tx: DBorTx = db, now = new Date()): Promise<string> {
  const [job] = await tx
    .insert(notificationJobs)
    .values({
      kind: t.kind,
      channel: "sms",
      to: t.to,
      body: t.body,
      shopId: t.shopId,
      customerId: t.customerId ?? null,
      appointmentId: t.appointmentId ?? null,
      outreachId: t.outreachId ?? null,
      runAt: t.runAt ?? now,
      createdAt: now,
    })
    .returning({ id: notificationJobs.id });
  const thread = await threadFor(t.shopId, t.to, tx);
  await logMessage(thread.id, { direction: "out", body: t.body, staffId: t.staffId, auto: t.auto, jobId: job.id }, tx, now);
  return job.id;
}

/** Sends now whatever of these jobs is due (the rest wait for their time, e.g. the end of quiet hours). */
export const sendDue = (ids: string[]) => (ids.length ? processDueJobs({ ids, limit: ids.length }) : Promise.resolve({ sent: 0, suppressed: 0, failed: 0 }));

// ───────────────────────────── Staff in the inbox ─────────────────────────────

export const REPLY_MAX = 320;
/** A client who texted the shop can be answered within this window even without "OK to text". */
export const REPLY_WINDOW_HOURS = 24;

export async function inboxThreads(shopIds: readonly string[], o: { limit?: number } = {}) {
  if (!shopIds.length) return [];
  const last = db
    .select({ threadId: messages.threadId, body: messages.body, direction: messages.direction, at: messages.createdAt, n: sql<number>`row_number() over (partition by ${messages.threadId} order by ${messages.createdAt} desc)`.as("n") })
    .from(messages)
    .as("last");
  return db
    .select({
      id: messageThreads.id,
      shopId: messageThreads.shopId,
      shopName: shops.name,
      phone: messageThreads.phone,
      customerId: messageThreads.customerId,
      firstName: customers.firstName,
      lastName: customers.lastName,
      unread: messageThreads.unread,
      lastMessageAt: messageThreads.lastMessageAt,
      preview: last.body,
      previewDirection: last.direction,
    })
    .from(messageThreads)
    .innerJoin(shops, eq(shops.id, messageThreads.shopId))
    .leftJoin(customers, eq(customers.id, messageThreads.customerId))
    .leftJoin(last, and(eq(last.threadId, messageThreads.id), eq(last.n, 1)))
    .where(inArray(messageThreads.shopId, [...shopIds]))
    .orderBy(desc(messageThreads.lastMessageAt))
    .limit(o.limit ?? 100);
}

export async function unreadCount(shopIds: readonly string[]) {
  if (!shopIds.length) return 0;
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${messageThreads.unread}), 0)::int` })
    .from(messageThreads)
    .where(and(inArray(messageThreads.shopId, [...shopIds]), gt(messageThreads.unread, 0)));
  return r?.n ?? 0;
}

export async function threadView(threadId: string) {
  const t = await db.query.messageThreads.findFirst({ where: eq(messageThreads.id, threadId) });
  if (!t) throw notFound("Conversation");
  const [shop, rows, people] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, t.shopId), columns: { id: true, name: true, twilioNumber: true } }),
    db
      .select({ m: messages, staffLabel: staff.displayLabel, jobStatus: notificationJobs.status, delivered: notificationJobs.deliveredAt, jobError: notificationJobs.lastError })
      .from(messages)
      .leftJoin(staff, eq(staff.id, messages.staffId))
      .leftJoin(notificationJobs, eq(notificationJobs.id, messages.jobId))
      .where(eq(messages.threadId, threadId))
      .orderBy(messages.createdAt),
    customersWithPhone(t.phone),
  ]);
  return { thread: t, shop: shop!, messages: rows, people };
}

export async function markThreadRead(threadId: string) {
  await db.update(messageThreads).set({ unread: 0 }).where(eq(messageThreads.id, threadId));
}

/** Why the shop can't text this thread right now, or null. */
export async function replyProblem(thread: { phone: string; lastInboundAt: Date | null }, now = new Date()): Promise<string | null> {
  if (await optedOut(thread.phone, "sms")) return "This number replied STOP, so it can't be texted until it replies START.";
  const recent = thread.lastInboundAt && now.getTime() - thread.lastInboundAt.getTime() < REPLY_WINDOW_HOURS * 3_600_000;
  if (recent) return null;
  const people = await customersWithPhone(thread.phone);
  if (people.some((p) => p.smsOptIn)) return null;
  return `This number hasn't agreed to texts and hasn't texted the shop in the last ${REPLY_WINDOW_HOURS} hours. Call through the shop line instead.`;
}

/** A staff reply, from the shop's number. The staff member never sees or types the client's number. */
export async function replyInThread(threadId: string, body: string, who: { staffId: string; actor: Actor }, now = new Date()) {
  const text = body.trim();
  if (!text) throw new AppError("bad_request", "Write a message");
  if (text.length > REPLY_MAX) throw new AppError("bad_request", `Keep it under ${REPLY_MAX} characters`);
  const t = await db.query.messageThreads.findFirst({ where: eq(messageThreads.id, threadId) });
  if (!t) throw notFound("Conversation");
  const problem = await replyProblem(t, now);
  if (problem) throw new AppError("conflict", problem);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, t.shopId), columns: { name: true } });
  const jobId = await db.transaction(async (tx) => {
    const id = await queueShopText({ shopId: t.shopId, to: t.phone, body: `Ray'z ${shop?.name ?? ""}: ${text}`, kind: "shop_reply", customerId: t.customerId, staffId: who.staffId, auto: false }, tx, now);
    await tx.update(messageThreads).set({ unread: 0 }).where(eq(messageThreads.id, threadId));
    await audit(who.actor, "inbox.reply", "message_thread", threadId, { jobId: id, length: text.length }, t.shopId, tx);
    return id;
  });
  await sendDue([jobId]);
  const job = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.id, jobId), columns: { status: true } });
  return { status: job?.status ?? "pending" };
}

// ───────────────────────────── Call log ─────────────────────────────

export interface NewCall {
  shopId: string | null;
  phone: string;
  direction: CallDirection;
  kind: CallKind;
  status: CallStatus;
  providerCallId?: string | null;
  staffId?: string | null;
  outreachId?: string | null;
  customerId?: string | null;
  operator?: boolean;
}

export async function logCall(c: NewCall, tx: DBorTx = db, now = new Date()) {
  const customerId = c.customerId !== undefined ? c.customerId : await onlyCustomerWith(c.phone, tx);
  const [row] = await tx
    .insert(callLogs)
    .values({ ...c, customerId, providerCallId: c.providerCallId ?? null, createdAt: now })
    .onConflictDoNothing({ target: callLogs.providerCallId })
    .returning();
  if (row) return row;
  return (await tx.query.callLogs.findFirst({ where: eq(callLogs.providerCallId, c.providerCallId!) }))!;
}

export async function updateCall(providerCallId: string, patch: Partial<Pick<typeof callLogs.$inferInsert, "status" | "durationSec" | "digits" | "autoTextSent" | "endedAt" | "operator" | "operatorChoice">>, tx: DBorTx = db) {
  const [row] = await tx.update(callLogs).set(patch).where(eq(callLogs.providerCallId, providerCallId)).returning();
  return row ?? null;
}

/** Calls with this number at these shops (every shop when null), newest first: shown on the client's profile. */
export async function callsWith(phone: string, shopIds: readonly string[] | null, limit = 20) {
  return db
    .select({ c: callLogs, shopName: shops.name, staffLabel: staff.displayLabel })
    .from(callLogs)
    .leftJoin(shops, eq(shops.id, callLogs.shopId))
    .leftJoin(staff, eq(staff.id, callLogs.staffId))
    .where(and(eq(callLogs.phone, phone), shopIds ? (shopIds.length ? inArray(callLogs.shopId, [...shopIds]) : sql`false`) : undefined))
    .orderBy(desc(callLogs.createdAt))
    .limit(limit);
}

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  ringing: "Ringing",
  answered: "Answered",
  missed: "Missed",
  after_hours: "After hours",
  voicemail: "Voicemail left",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Failed",
  initiated: "Calling",
  completed: "Completed",
};
export const CALL_KIND_LABEL: Record<CallKind, string> = { inbound: "Called the shop", outreach: "Automated call-in call", click_to_call: "Called from the profile" };
