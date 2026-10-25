/**
 * Customer messages after they're queued, against the seeded brand: one set of reminders after a
 * reschedule, the cancelled calendar event, emails sent in the brand layout with a stop link through
 * a real provider client, bounce and complaint webhooks that stop an address and turn off "OK to
 * email", the stop link itself, and delivered events.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let E: typeof import("@/server/notifications/email-events");
const tag = Date.now().toString(36);
const customerIds: string[] = [];
const jobIds: string[] = [];
const emails: string[] = [];
let apptId = "";
let shopId = "";
const env = { provider: process.env.NOTIFICATIONS_EMAIL_PROVIDER, key: process.env.RESEND_API_KEY };

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const jobs = (ids: string[]) => m.db.db.select().from(m.schema.notificationJobs).where(m.drizzle.inArray(m.schema.notificationJobs.id, ids));

async function client(label: string) {
  const email = `nd-${label}-${tag}@rayz.example`;
  emails.push(email);
  const [c] = await m.db.db.insert(m.schema.customers).values({ firstName: "Riley", lastName: "Delivery", email, emailOptIn: true }).returning({ id: m.schema.customers.id });
  customerIds.push(c.id);
  return { id: c.id, email };
}

async function emailJob(to: string, kind = "confirmation", customerId: string | null = null) {
  const [j] = await m.db.db
    .insert(m.schema.notificationJobs)
    .values({ kind, channel: "email", to, subject: "You're booked", body: "Hi Riley, see or change it: https://rayzbs.com/a/ABC123\n\n—\nRay'z Coralville\n1 Main St", customerId, shopId, runAt: new Date(Date.now() - 1000) })
    .returning({ id: m.schema.notificationJobs.id });
  jobIds.push(j.id);
  return j.id;
}

beforeAll(async () => {
  m = await loadModules();
  E = await import("@/server/notifications/email-events");
  const [a] = await m.db.db
    .select({ id: m.schema.appointments.id, shopId: m.schema.appointments.shopId })
    .from(m.schema.appointments)
    .where(m.drizzle.and(m.drizzle.gt(m.schema.appointments.startsAt, new Date(Date.now() + 3 * 86_400_000)), eq(m.schema.appointments.status, "booked")))
    .limit(1);
  apptId = a.id;
  shopId = a.shopId;
}, 180_000);

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.NOTIFICATIONS_EMAIL_PROVIDER = env.provider;
  process.env.RESEND_API_KEY = env.key;
  if (env.provider === undefined) delete process.env.NOTIFICATIONS_EMAIL_PROVIDER;
  if (env.key === undefined) delete process.env.RESEND_API_KEY;
});

afterAll(async () => {
  if (!m) return;
  if (jobIds.length) await m.db.db.delete(m.schema.notificationJobs).where(m.drizzle.inArray(m.schema.notificationJobs.id, jobIds));
  await m.db.db.delete(m.schema.notificationJobs).where(m.drizzle.inArray(m.schema.notificationJobs.to, emails));
  await m.db.db.delete(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.appointmentId, apptId));
  if (emails.length) {
    await m.db.db.delete(m.schema.emailSuppressions).where(m.drizzle.inArray(m.schema.emailSuppressions.email, emails));
    await m.db.db.delete(m.schema.marketingUnsubscribes).where(m.drizzle.inArray(m.schema.marketingUnsubscribes.email, emails));
  }
  if (customerIds.length) await m.db.db.delete(m.schema.customers).where(m.drizzle.inArray(m.schema.customers.id, customerIds));
});

describe("reminders and calendar invites", () => {
  it("a reschedule leaves exactly one set of reminders, at the new time", async () => {
    const base = { ...(await m.booking.messageContext(apptId)), email: `nd-move-${tag}@rayz.example`, emailOptIn: true, phone: null, smsOptIn: false };
    emails.push(base.email);
    const now = new Date();
    await m.queue.scheduleAppointmentNotifications("created", base, undefined, now);
    const later = new Date(base.startsAt.getTime() + 86_400_000);
    await m.queue.scheduleAppointmentNotifications("rescheduled", { ...base, startsAt: later, endsAt: new Date(later.getTime() + 30 * 60_000) }, undefined, now);
    const all = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.appointmentId, apptId));
    const pending = all.filter((j) => j.status === "pending" && j.kind.startsWith("reminder_"));
    expect(pending.map((j) => j.kind).sort()).toEqual(["reminder_24h", "reminder_2h"].slice(0, pending.length));
    expect(pending.length).toBeGreaterThanOrEqual(1);
    for (const j of pending) expect(j.runAt.getTime()).toBeGreaterThan(base.startsAt.getTime() - 3 * 3_600_000);
    expect(all.filter((j) => j.kind.startsWith("reminder_") && j.status === "cancelled").length).toBeGreaterThanOrEqual(1);
    const moved = all.find((j) => j.kind === "reschedule")!;
    const ics = Buffer.from(moved.attachments![0].content, "base64").toString("utf8");
    expect(ics).toContain(`UID:${base.code}@rayzbs.com`);
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  it("a cancel email carries the same event, cancelled", async () => {
    const c = { ...(await m.booking.messageContext(apptId)), email: `nd-move-${tag}@rayz.example`, emailOptIn: true, phone: null, smsOptIn: false };
    const [id] = await m.queue.queueAppointmentMessage("cancellation", c);
    jobIds.push(id);
    const [j] = await jobs([id]);
    const ics = Buffer.from(j.attachments![0].content, "base64").toString("utf8");
    expect(ics).toContain(`UID:${c.code}@rayzbs.com`);
    expect(ics).toContain("STATUS:CANCELLED");
    expect(Number(/SEQUENCE:(\d+)/.exec(ics)![1])).toBeGreaterThan(0);
  });
});

describe("sending email", () => {
  it("sends a client email through Resend in the brand layout, with the stop link and one-click headers", async () => {
    process.env.NOTIFICATIONS_EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: `re_${tag}` }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await client("send");
    const id = await emailJob(c.email, "confirmation", c.id);
    expect(await m.queue.processDueJobs({ ids: [id] })).toMatchObject({ sent: 1 });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.html).toContain("View or change your booking");
    expect(sent.html).toContain("/u/e/");
    expect(sent.text).toMatch(/Stop them: \S+\/u\/e\/\S+$/);
    expect(sent.headers["List-Unsubscribe"]).toMatch(/\/api\/email\/unsubscribe\//);
    const [j] = await jobs([id]);
    expect(j).toMatchObject({ status: "sent", provider: "resend", providerMessageId: `re_${tag}` });
  });

  it("without a key, Resend is off: nothing leaves and the outbox says so", async () => {
    process.env.NOTIFICATIONS_EMAIL_PROVIDER = "resend";
    delete process.env.RESEND_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const id = await emailJob(`nd-off-${tag}@rayz.example`);
    emails.push(`nd-off-${tag}@rayz.example`);
    expect(await m.queue.processDueJobs({ ids: [id] })).toMatchObject({ suppressed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("staff emails get no stop link", async () => {
    expect(E.takesUnsubscribe("purchase_order")).toBe(false);
    expect(E.takesUnsubscribe("marketing")).toBe(false);
    expect(E.takesUnsubscribe("reminder_24h")).toBe(true);
  });
});

describe("bounces, complaints and the stop link", () => {
  it("a hard bounce stops the address, turns off OK to email, and later emails are held back", async () => {
    process.env.NOTIFICATIONS_EMAIL_PROVIDER = "console";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const c = await client("bounce");
    const id = await emailJob(c.email, "confirmation", c.id);
    await m.db.db.update(m.schema.notificationJobs).set({ status: "sent", providerMessageId: `pm-${tag}` }).where(eq(m.schema.notificationJobs.id, id));
    const r = await E.handleEmailEvent({ kind: "bounced", messageId: `pm-${tag}`, email: null, permanent: true }, "postmark");
    expect(r).toEqual({ job: id, suppressed: true });
    const [j] = await jobs([id]);
    expect(j.status).toBe("failed");
    const cust = await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, c.id) });
    expect(cust!.emailOptIn).toBe(false);
    const sup = await m.db.db.query.emailSuppressions.findFirst({ where: eq(m.schema.emailSuppressions.email, c.email) });
    expect(sup).toMatchObject({ reason: "bounce", provider: "postmark", customerIds: [c.id] });
    const audit = await m.db.db.query.auditLog.findFirst({ where: m.drizzle.and(eq(m.schema.auditLog.action, "email.suppressed"), eq(m.schema.auditLog.entityId, sup!.id)) });
    expect(audit?.details).toMatchObject({ reason: "bounce", customersTurnedOff: 1 });
    expect(JSON.stringify(audit?.details)).not.toContain(c.email);
    const next = await emailJob(c.email.toUpperCase(), "reminder_24h", c.id);
    expect(await m.queue.processDueJobs({ ids: [next] })).toMatchObject({ suppressed: 1 });
    const [held] = await jobs([next]);
    expect(held.lastError).toMatch(/bounced/);
    const D = await import("@/domain/notification-delivery");
    expect(D.deliveryState(held)).toBe("opted_out");
  });

  it("a soft bounce fails the one email but doesn't stop the address", async () => {
    const c = await client("soft");
    const id = await emailJob(c.email, "confirmation", c.id);
    await m.db.db.update(m.schema.notificationJobs).set({ status: "sent", providerMessageId: `soft-${tag}` }).where(eq(m.schema.notificationJobs.id, id));
    expect(await E.handleEmailEvent({ kind: "bounced", messageId: `soft-${tag}`, email: c.email, permanent: false }, "resend")).toEqual({ job: id, suppressed: false });
    expect((await E.suppressedEmails([c.email])).size).toBe(0);
    expect((await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, c.id) }))!.emailOptIn).toBe(true);
  });

  it("a spam complaint stops the address, and Campaign Center leaves it out", async () => {
    const c = await client("spam");
    await E.handleEmailEvent({ kind: "complained", messageId: null, email: c.email, permanent: true }, "resend");
    expect((await E.suppressedEmails([c.email])).get(c.email)).toBe("complaint");
    const u = await m.db.db.query.marketingUnsubscribes.findFirst({ where: eq(m.schema.marketingUnsubscribes.email, c.email) });
    expect(u).toMatchObject({ channel: "email", customerId: c.id });
  });

  it("delivered events mark the email delivered", async () => {
    const id = await emailJob(`nd-dlv-${tag}@rayz.example`);
    emails.push(`nd-dlv-${tag}@rayz.example`);
    await m.db.db.update(m.schema.notificationJobs).set({ status: "sent", providerMessageId: `dlv-${tag}` }).where(eq(m.schema.notificationJobs.id, id));
    await E.handleEmailEvent({ kind: "delivered", messageId: `dlv-${tag}`, email: null, permanent: false }, "resend");
    const [j] = await jobs([id]);
    expect(j.deliveredAt).not.toBeNull();
  });

  it("the stop link in an email stops that address once; a changed link does nothing", async () => {
    const c = await client("unsub");
    const id = await emailJob(c.email, "reminder_24h", c.id);
    const token = E.unsubscribeUrl(id).split("/u/e/")[1];
    expect(await E.unsubscribeTarget(token)).toEqual({ jobId: id, email: c.email, stopped: false });
    expect(await E.unsubscribeByEmailLink(token)).toBe(true);
    expect(await E.unsubscribeByEmailLink(token)).toBe(true);
    expect((await E.unsubscribeTarget(token))!.stopped).toBe(true);
    expect((await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, c.id) }))!.emailOptIn).toBe(false);
    const rows = await m.db.db.select().from(m.schema.emailSuppressions).where(eq(m.schema.emailSuppressions.email, c.email));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("unsubscribe");
    expect(await E.unsubscribeByEmailLink(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBe(false);
    expect(await E.unsubscribeTarget("not-a-token")).toBeNull();
  });
});
