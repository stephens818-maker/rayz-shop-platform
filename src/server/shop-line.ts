import "server-only";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { appointmentOutreach, appointments, callIns, callLogs, customers, notificationJobs, shopClosures, shopHours, shops, staff } from "@/db/schema";
import { advance, isOpen, missedCallText, parseReply, reachable, shopOpenAt, voiceScript } from "@/domain/outreach";
import { EMPTY_RESPONSE, dial, gather, hangup, pause, response, say } from "@/domain/twiml";
import { appBaseUrl } from "@/lib/deployment";
import { normalizePhone } from "@/lib/phone";
import { formatDate, formatTime, localDateOf } from "@/lib/time";
import { SYSTEM, audit } from "./audit";
import { answerByText, loadOutreachRules, noteInThread, openOutreachFor } from "./call-ins";
import { logCall, logMessage, optedOut, queueShopText, recordOptIn, recordOptOut, sendDue, threadFor, updateCall } from "./messaging";
import { issueLink } from "./rebook-links";
import { webhookUrl } from "./twilio/client";

/**
 * What happens when a client texts or calls a shop's Twilio number, and the scripts for automated
 * call-in calls. The Twilio webhooks (src/app/api/twilio) and the dev call simulator both call these,
 * so the simulator runs exactly what production runs. Every function returns the TwiML to answer with.
 */

async function shopByLine(to: string) {
  const n = normalizePhone(to) ?? to;
  return (await db.query.shops.findFirst({ where: eq(shops.twilioNumber, n) })) ?? null;
}

const spokenShop = (name: string) => `Rays ${name}`;

// ───────────────────────────── Texts in ─────────────────────────────

export interface InboundSms {
  from: string;
  to: string;
  body: string;
  messageSid?: string | null;
}

/**
 * A text to the shop: STOP and START update who may be texted, 1 and 2 answer the latest call-in
 * outreach, and anything else lands in the shop inbox, unread, for staff.
 */
export async function handleInboundSms(i: InboundSms, now = new Date()) {
  const shop = await shopByLine(i.to);
  if (!shop) return { twiml: EMPTY_RESPONSE, threadId: null as string | null, handled: "unknown_line" as const };
  const phone = normalizePhone(i.from) ?? i.from;
  const isOut = await optedOut(phone, "sms");
  const reply = parseReply(i.body, { optedOut: isOut });
  const outreach = reply === "accept" || reply === "decline" ? await openOutreachFor(phone, shop.id) : null;
  const thread = await threadFor(shop.id, phone);
  await logMessage(thread.id, { direction: "in", body: i.body.slice(0, 1600), providerMessageId: i.messageSid ?? null, unread: reply === "message" || ((reply === "accept" || reply === "decline") && !outreach) }, db, now);
  // Carriers and Twilio answer STOP, START and HELP themselves; the shop only records them.
  if (reply === "stop") {
    const ids = await recordOptOut(phone, "sms", "reply");
    await logMessage(thread.id, { direction: "note", body: "Replied STOP: texts to this number are off until it replies START.", auto: true }, db, now);
    await audit(SYSTEM, "sms.opt_out", "message_thread", thread.id, { customers: ids.length }, shop.id);
    return { twiml: EMPTY_RESPONSE, threadId: thread.id, handled: reply };
  }
  if (reply === "start") {
    const ids = await recordOptIn(phone);
    await logMessage(thread.id, { direction: "note", body: "Replied START: texts are back on.", auto: true }, db, now);
    await audit(SYSTEM, "sms.opt_in", "message_thread", thread.id, { customers: ids.length }, shop.id);
    return { twiml: EMPTY_RESPONSE, threadId: thread.id, handled: reply };
  }
  if (outreach && (reply === "accept" || reply === "decline")) {
    const a = await answerByText(outreach, reply, now);
    await noteInThread(shop.id, phone, a.note, db, now);
    if (a.reply) {
      const jobId = await queueShopText({ shopId: shop.id, to: phone, body: a.reply, kind: "shop_reply", customerId: outreach.customerId, outreachId: outreach.id, auto: true }, db, now);
      await sendDue([jobId]);
    }
    return { twiml: EMPTY_RESPONSE, threadId: thread.id, handled: reply };
  }
  return { twiml: EMPTY_RESPONSE, threadId: thread.id, handled: "message" as const };
}

/** Twilio's delivery report for a text: delivered marks the job and the outreach; failed records why. */
export async function handleSmsStatus(i: { messageSid: string; status: string; errorCode?: string | null }, now = new Date()) {
  const job = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.providerMessageId, i.messageSid) });
  if (!job) return;
  if (i.status === "delivered") {
    await db.update(notificationJobs).set({ deliveredAt: now }).where(eq(notificationJobs.id, job.id));
    if (job.outreachId) await markDelivered(job.outreachId, now);
  } else if (i.status === "failed" || i.status === "undelivered") {
    await db.update(notificationJobs).set({ status: "failed", lastError: `Not delivered${i.errorCode ? ` (Twilio ${i.errorCode})` : ""}` }).where(eq(notificationJobs.id, job.id));
  }
}

async function markDelivered(outreachId: string, now: Date) {
  const row = await db.query.appointmentOutreach.findFirst({ where: eq(appointmentOutreach.id, outreachId) });
  const next = row && advance(row.status, "delivered");
  if (next) await db.update(appointmentOutreach).set({ status: next, updatedAt: now }).where(eq(appointmentOutreach.id, outreachId));
}

// ───────────────────────────── Calls in ─────────────────────────────

async function isOpenNow(shopId: string, now: Date) {
  const [hours, closed] = await Promise.all([
    db.select().from(shopHours).where(eq(shopHours.shopId, shopId)),
    db.select({ date: shopClosures.date }).from(shopClosures).where(and(eq(shopClosures.shopId, shopId), eq(shopClosures.date, localDateOf(now)))),
  ]);
  return shopOpenAt(hours, closed.map((c) => c.date), now);
}

/** One missed-call text per number per shop every 12 hours, so repeat calls don't become repeat texts. */
const MISSED_TEXT_EVERY_MS = 12 * 3_600_000;

/**
 * After a missed or after-hours call: a text with the rebook link when the caller has a call-in
 * appointment waiting, else the booking link. Not to numbers that replied STOP, and not to a client
 * on file who hasn't agreed to texts; a caller the shop doesn't know gets the one reply to their call.
 */
async function autoText(shop: typeof shops.$inferSelect, phone: string, afterHours: boolean, now: Date) {
  if (await optedOut(phone, "sms")) return false;
  const people = await db.select({ smsOptIn: customers.smsOptIn }).from(customers).where(eq(customers.phone, phone));
  if (people.length && !people.some((p) => p.smsOptIn)) return false;
  const recent = await db
    .select({ id: notificationJobs.id })
    .from(notificationJobs)
    .where(and(eq(notificationJobs.shopId, shop.id), eq(notificationJobs.to, phone), eq(notificationJobs.kind, "missed_call"), gte(notificationJobs.createdAt, new Date(now.getTime() - MISSED_TEXT_EVERY_MS))))
    .limit(1);
  if (recent.length) return false;
  const open = await openOutreachFor(phone, shop.id);
  let link = `${appBaseUrl()}/book/${shop.slug}`;
  let rebook = false;
  if (open) {
    const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, open.newAppointmentId ?? open.appointmentId) });
    if (appt && reachable(appt.status)) {
      link = (await issueLink({ outreachId: open.id, appointmentId: appt.id }, await loadOutreachRules(), db, now)).url;
      rebook = true;
    }
  }
  const jobId = await queueShopText(
    { shopId: shop.id, to: phone, body: missedCallText({ shop: `Ray'z ${shop.name}`, afterHours, link, rebook }), kind: "missed_call", customerId: open?.customerId ?? null, outreachId: open?.id ?? null, auto: true },
    db,
    now,
  );
  await sendDue([jobId]);
  return true;
}

/**
 * A call to the shop's number. Open: it rings the shop phone, showing the shop's own number, so staff
 * never see the caller's. Closed, or no shop phone: the after-hours message and the auto-text.
 */
export async function handleIncomingCall(i: { from: string; to: string; callSid: string }, now = new Date()) {
  const shop = await shopByLine(i.to);
  if (!shop) return response(say("Sorry, this number isn't in service."), hangup());
  const phone = normalizePhone(i.from) ?? i.from;
  const open = shop.phone ? await isOpenNow(shop.id, now) : false;
  if (!open) {
    await logCall({ shopId: shop.id, phone, direction: "in", kind: "inbound", status: "after_hours", providerCallId: i.callSid }, db, now);
    const texted = await autoText(shop, phone, true, now);
    if (texted) await updateCall(i.callSid, { autoTextSent: true, endedAt: now });
    return response(say(`Thanks for calling ${spokenShop(shop.name)}. We're closed right now.${texted ? " We've texted you a link to book." : " Please call back during opening hours, or book online."}`), hangup());
  }
  await logCall({ shopId: shop.id, phone, direction: "in", kind: "inbound", status: "ringing", providerCallId: i.callSid }, db, now);
  return response(dial({ callerId: shop.twilioNumber, timeout: 20, action: webhookUrl("voice/dial") }, shop.phone!));
}

/** How the forwarded call ended. Not answered: a missed call, and the auto-text. */
export async function handleDialResult(i: { callSid: string; dialStatus: string; duration?: number | null }, now = new Date()) {
  if (i.dialStatus === "completed" || i.dialStatus === "answered") {
    await updateCall(i.callSid, { status: "answered", durationSec: i.duration ?? null, endedAt: now });
    return response(hangup());
  }
  const call = await updateCall(i.callSid, { status: "missed", endedAt: now });
  const shop = call?.shopId ? await db.query.shops.findFirst({ where: eq(shops.id, call.shopId) }) : null;
  const texted = shop && call ? await autoText(shop, call.phone, false, now) : false;
  if (texted) await updateCall(i.callSid, { autoTextSent: true });
  return response(say(`Sorry we missed you.${texted ? " We've texted you a link to book." : " Please try again in a few minutes."}`), hangup());
}

// ───────────────────────────── Automated call-in calls ─────────────────────────────

async function outreachContext(outreachId: string) {
  const row = await db.query.appointmentOutreach.findFirst({ where: eq(appointmentOutreach.id, outreachId) });
  if (!row) return null;
  const [ci, shop, absent, customer, appt] = await Promise.all([
    db.query.callIns.findFirst({ where: eq(callIns.id, row.callInId) }),
    db.query.shops.findFirst({ where: eq(shops.id, row.shopId) }),
    db.query.staff.findFirst({ where: eq(staff.id, row.originalStaffId), columns: { displayLabel: true } }),
    row.customerId ? db.query.customers.findFirst({ where: eq(customers.id, row.customerId) }) : null,
    db.query.appointments.findFirst({ where: eq(appointments.id, row.newAppointmentId ?? row.appointmentId) }),
  ]);
  if (!shop || !appt) return null;
  const script = voiceScript({
    shop: `Ray'z ${shop.name}`,
    firstName: customer?.firstName ?? null,
    barber: absent?.displayLabel ?? "your barber",
    when: `${formatDate(row.originalStartsAt, "EEEE, MMMM d")} at ${formatTime(row.originalStartsAt)}`,
    shopPhone: shop.phone,
  });
  return { row, live: !ci?.cancelledAt && isOpen(row.status) && reachable(appt.status), shop, customer, appt, script };
}

const GONE = response(say("Sorry, this call is no longer needed. Goodbye."), hangup());

/**
 * The client picked up (or voicemail did). A person hears the message and the keypad menu; an
 * answering machine gets the voicemail, and a text with the link when they take texts.
 */
export async function voiceOutreachAnswer(i: { outreachId: string; callSid: string; answeredBy?: string | null; to?: string | null }, now = new Date()) {
  const c = await outreachContext(i.outreachId);
  if (!c || !c.live) return GONE;
  const machine = /^(machine|fax)/.test(i.answeredBy ?? "");
  await logCall({ shopId: c.row.shopId, phone: c.customer?.phone ?? normalizePhone(i.to) ?? "unknown", direction: "out", kind: "outreach", status: machine ? "voicemail" : "answered", providerCallId: i.callSid, outreachId: c.row.id, customerId: c.row.customerId }, db, now);
  await updateCall(i.callSid, { status: machine ? "voicemail" : "answered" });
  await markDelivered(c.row.id, now);
  if (machine) {
    if (c.customer?.phone && c.customer.smsOptIn) await textLink(c, now);
    return response(pause(1), say(c.script.voicemail), hangup());
  }
  return response(gather({ action: webhookUrl("voice/outreach/gather", { o: c.row.id }) }, say(c.script.human), say(c.script.menu)), say(c.script.noInput), hangup());
}

async function textLink(c: NonNullable<Awaited<ReturnType<typeof outreachContext>>>, now: Date) {
  if (!c.customer?.phone || (await optedOut(c.customer.phone, "sms"))) return false;
  const link = await issueLink({ outreachId: c.row.id, appointmentId: c.appt.id }, await loadOutreachRules(), db, now);
  const jobId = await queueShopText(
    {
      shopId: c.row.shopId,
      to: c.customer.phone,
      body: `Ray'z ${c.shop.name}: Pick a new time with any barber, same services: ${link.url} Reply STOP to opt out.`,
      kind: "callin_link",
      customerId: c.customer.id,
      appointmentId: c.appt.id,
      outreachId: c.row.id,
      auto: true,
    },
    db,
    now,
  );
  await sendDue([jobId]);
  return true;
}

/** A key on the automated call: 1 texts the rebook link, 2 connects to the shop, 9 stops these calls. */
export async function voiceOutreachGather(i: { outreachId: string; callSid: string; digits: string; retry?: boolean }, now = new Date()) {
  const c = await outreachContext(i.outreachId);
  if (!c || !c.live) return GONE;
  await updateCall(i.callSid, { digits: i.digits });
  if (i.digits === "1") {
    // They asked for it on the call: one text, even without "OK to text" on file. STOP still wins.
    const sent = await textLink(c, now);
    await audit(SYSTEM, "callin.keypad", "appointment", c.row.appointmentId, { outreachId: c.row.id, digits: "1", texted: sent }, c.row.shopId);
    return response(say(sent ? c.script.texted : c.script.cantText), hangup());
  }
  if (i.digits === "2") {
    await audit(SYSTEM, "callin.keypad", "appointment", c.row.appointmentId, { outreachId: c.row.id, digits: "2" }, c.row.shopId);
    if (!c.shop.phone) return response(say("Please call the shop. Goodbye."), hangup());
    return response(say(c.script.connecting), dial({ callerId: c.shop.twilioNumber, timeout: 25 }, c.shop.phone));
  }
  if (i.digits === "9") {
    if (c.customer?.phone) await recordOptOut(c.customer.phone, "voice", "keypad");
    await audit(SYSTEM, "callin.keypad", "appointment", c.row.appointmentId, { outreachId: c.row.id, digits: "9" }, c.row.shopId);
    return response(say(c.script.optedOut), hangup());
  }
  return response(gather({ action: webhookUrl("voice/outreach/gather", { o: c.row.id }) }, say(c.script.menu)), say(c.script.noInput), hangup());
}

/** Twilio's final report on any call: how long, and whether anyone picked up. */
export async function handleCallStatus(i: { callSid: string; callStatus: string; duration?: number | null }, now = new Date()) {
  const map: Record<string, "completed" | "no_answer" | "busy" | "failed"> = { completed: "completed", "no-answer": "no_answer", busy: "busy", failed: "failed", canceled: "failed" };
  const status = map[i.callStatus];
  if (!status) return;
  const existing = await db.query.callLogs.findFirst({ where: eq(callLogs.providerCallId, i.callSid) });
  if (existing) {
    const keep = existing.status === "answered" || existing.status === "voicemail" || existing.status === "missed" || existing.status === "after_hours";
    await updateCall(i.callSid, { status: keep && status === "completed" ? existing.status : status, durationSec: i.duration ?? null, endedAt: now });
    return;
  }
  const job = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.providerMessageId, i.callSid) });
  if (job?.kind === "callin_voice") {
    await logCall({ shopId: job.shopId, phone: job.to, direction: "out", kind: "outreach", status, providerCallId: i.callSid, outreachId: job.outreachId, customerId: job.customerId }, db, now);
  }
}

/** Click-to-call: the shop answered, now connect the client from the job, so the number never travels in a URL. */
export async function voiceBridge(jobId: string) {
  const job = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.id, jobId) });
  if (!job || job.channel !== "voice" || job.kind !== "staff_call") return GONE;
  const shop = job.shopId ? await db.query.shops.findFirst({ where: eq(shops.id, job.shopId) }) : null;
  return response(say("Connecting you to the client."), dial({ callerId: shop?.twilioNumber ?? null, timeout: 25 }, job.to));
}

/** Recent automated calls placed through the simulator, for the simulator page. */
export async function simulatedCalls(limit = 15) {
  return db
    .select({ j: notificationJobs, shopName: shops.name })
    .from(notificationJobs)
    .leftJoin(shops, eq(shops.id, notificationJobs.shopId))
    .where(and(eq(notificationJobs.channel, "voice"), eq(notificationJobs.provider, "simulator")))
    .orderBy(desc(notificationJobs.createdAt))
    .limit(limit);
}
