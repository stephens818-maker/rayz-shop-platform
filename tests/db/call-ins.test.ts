/**
 * Call-ins against a real database: marking one writes the time off and lists every appointment in
 * it; outreach moves clients to a free barber or sends a rebook link, by text, email or automated
 * call, only on channels the client allows; rebook links are single-use, expire and only the latest
 * works; "1" and "2" by text answer; STOP, START and 9 are honoured; the follow-up retries once and
 * then flags; missed calls get one auto-text; staff reply from the inbox without seeing the number.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSettings } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";
import { open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

process.env.NOTIFICATIONS_SMS_PROVIDER = "simulator";
process.env.NOTIFICATIONS_VOICE_PROVIDER = "simulator";

let m: Mods;
let ci: typeof import("@/server/call-ins");
let line: typeof import("@/server/shop-line");
let links: typeof import("@/server/rebook-links");
let msg: typeof import("@/server/messaging");
let acts: typeof import("@/app/admin/call-ins/actions");
let inbox: typeof import("@/app/admin/inbox/actions");
let pub: typeof import("@/app/(public)/r/[token]/actions");

beforeAll(async () => {
  m = await loadModules();
  ci = await import("@/server/call-ins");
  line = await import("@/server/shop-line");
  links = await import("@/server/rebook-links");
  msg = await import("@/server/messaging");
  acts = await import("@/app/admin/call-ins/actions");
  inbox = await import("@/app/admin/inbox/actions");
  pub = await import("@/app/(public)/r/[token]/actions");
  closed = new Set((await m.db.db.select().from(m.schema.shopClosures)).map((c) => c.date));
  await brandSettings({ outreach: { quietStartMin: 0, quietEndMin: 0 } });
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);
const staffBy = async (where: { email?: string; label?: string }) =>
  (await m.db.db.query.staff.findFirst({ where: where.email ? eq(m.schema.staff.email, where.email) : eq(m.schema.staff.displayLabel, where.label!) }))!;
const as = async (email: string) => signInAs((await staffBy({ email })).id);
const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, slug) }))!;

let closed = new Set<string>();
const used = new Set<string>();
/** The next `weekday` (0 = Sunday) at least `ahead` days out that no shop is closed for and no other test has used. */
const dayOn = (weekday: number, ahead: number) => {
  let d = m.time.addDays(m.time.todayLocal(), ahead);
  while (m.time.weekdayOf(d) !== weekday || closed.has(d) || used.has(d)) d = m.time.addDays(d, 1);
  used.add(d);
  return d;
};
const at = (date: string, min: number) => m.time.zonedWallTime(date, min).toJSDate();
const HOUR = 3_600_000;
/** TwiML with the XML escapes undone, to read what the caller hears. */
const said = (xml: string) => xml.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function cut(shopSlug: string) {
  return (await m.public.publicServices(shopSlug)).services.find((s) => s.kind === "service")!;
}

/** The barber's start nearest `near` (local minutes) that day, booked by the desk. */
async function slotNear(shopSlug: string, staffId: string, date: string, near: number) {
  const svc = await cut(shopSlug);
  const a = await m.booking.getAvailability({ shopRef: shopSlug, date, serviceId: svc.id, barberRef: staffId, staffOverride: true });
  const slot = [...a.slots].sort((x, y) => Math.abs(m.time.localMinutesOf(new Date(x.startsAt)) - near) - Math.abs(m.time.localMinutesOf(new Date(y.startsAt)) - near))[0];
  if (!slot) throw new Error(`no slots for ${date}`);
  return new Date(slot.startsAt);
}

let phone = 3195558000;
type Who = { firstName?: string; phone?: string | null; email?: string | null; smsOptIn?: boolean; emailOptIn?: boolean };
async function bookAt(shopSlug: string, staffId: string, startsAt: Date, who: Who = {}) {
  const svc = await cut(shopSlug);
  const p = who.phone === undefined ? `+1${phone++}` : who.phone;
  const made = await m.booking.createAppointment({
    shopRef: shopSlug,
    serviceId: svc.id,
    barberRef: staffId,
    startsAt: startsAt.toISOString(),
    customer: { firstName: who.firstName ?? "Callin", phone: p, email: who.email ?? null, smsOptIn: who.smsOptIn ?? true, emailOptIn: who.emailOptIn ?? false },
    source: "staff",
    actor,
  });
  return appt(made.id);
}
const book = async (shopSlug: string, staffId: string, date: string, near: number, who: Who = {}) => bookAt(shopSlug, staffId, await slotNear(shopSlug, staffId, date, near), who);

const appt = async (id: string) => (await m.db.db.query.appointments.findFirst({ where: eq(m.schema.appointments.id, id) }))!;
const customer = async (id: string) => (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, id) }))!;
const rowFor = async (callInId: string, appointmentId: string) =>
  (await m.db.db.query.appointmentOutreach.findFirst({ where: and(eq(m.schema.appointmentOutreach.callInId, callInId), eq(m.schema.appointmentOutreach.appointmentId, appointmentId)) }))!;
const jobsFor = async (outreachId: string) =>
  m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.outreachId, outreachId)).orderBy(m.schema.notificationJobs.createdAt);
const linksFor = async (outreachId: string) => m.db.db.select().from(m.schema.rebookLinks).where(eq(m.schema.rebookLinks.outreachId, outreachId)).orderBy(m.schema.rebookLinks.createdAt);
const tokenIn = (body: string) => /\/r\/([A-Za-z0-9_-]{43})/.exec(body)?.[1] ?? null;
const lastToken = async (outreachId: string) => {
  const js = (await jobsFor(outreachId)).filter((j) => j.channel !== "voice");
  return tokenIn(js[js.length - 1].body)!;
};
const starts = async (shopSlug: string, staffId: string, date: string) => {
  const svc = await cut(shopSlug);
  return (await m.booking.getAvailability({ shopRef: shopSlug, date, serviceId: svc.id, barberRef: staffId })).slots.length;
};

function ok<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error!);

const whole = (d: string, to = d) => ({ fromDate: d, toDate: to, allDay: true, startMin: 0, endMin: 0 });
async function mark(staffId: string, shopId: string | null, range: ReturnType<typeof whole>, kind: "sick" | "emergency" | "other" = "sick") {
  return acts.markCallInAction({ staffId, shopId, kind, ...range });
}
const send = (callInId: string, choices: { appointmentId: string; option: "reassign" | "rebook" | "voice" }[]) => acts.sendOutreachAction(callInId, choices);

describe("marking a call-in", () => {
  it("writes the time off with the reason and lists every booked appointment in it; others' appointments and other days aren't touched", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const jessica = await staffBy({ label: "Jessica" });
    const cv = await shop("coralville");
    const tue = dayOn(2, 21);
    const hit = [await book("coralville", makenna.id, tue, 600), await book("coralville", makenna.id, tue, 720), await book("coralville", makenna.id, tue, 900)];
    const other = await book("coralville", jessica.id, tue, 600);
    const nextDay = await book("coralville", makenna.id, m.time.addDays(tue, 1), 600);
    expect(await starts("coralville", makenna.id, tue)).toBeGreaterThan(0);

    await as("makenna@rayz.test");
    expect(err(await mark(makenna.id, cv.id, whole(tue)))).toMatch(/can't mark/i);

    await as("michelle@rayz.test");
    const r = ok(await mark(makenna.id, cv.id, whole(tue)));
    expect(r.affected).toBe(3);
    const c = (await m.db.db.query.callIns.findFirst({ where: eq(m.schema.callIns.id, r.callInId) }))!;
    expect([c.kind, c.reason, c.staffId, c.shopId]).toEqual(["sick", "Sick", makenna.id, cv.id]);
    const block = (await m.db.db.query.timeBlocks.findFirst({ where: eq(m.schema.timeBlocks.id, c.blockId!) }))!;
    expect([block.category, block.reason, block.kind, block.staffId]).toEqual(["time_off", "Sick", "day_off", makenna.id]);
    expect(await starts("coralville", makenna.id, tue)).toBe(0);

    const rows = await m.db.db.select().from(m.schema.appointmentOutreach).where(eq(m.schema.appointmentOutreach.callInId, c.id));
    expect(rows.map((o) => o.appointmentId).sort()).toEqual(hit.map((a) => a.id).sort());
    expect(new Set(rows.map((o) => o.status))).toEqual(new Set(["pending"]));
    expect(rows.every((o) => o.option === null && o.attempts === 0)).toBe(true);
    expect(rows.map((o) => o.appointmentId)).not.toContain(other.id);
    expect(rows.map((o) => o.appointmentId)).not.toContain(nextDay.id);
    // Marking sends nothing.
    for (const o of rows) expect(await jobsFor(o.id)).toEqual([]);

    expect(err(await acts.markCallInAction({ staffId: makenna.id, shopId: cv.id, kind: "emergency", fromDate: tue, toDate: tue, allDay: false, startMin: 780, endMin: 840 }))).toMatch(/already marked/i);

    const detail = await ci.callInDetail(c.id, { staffId: null, seesPrivate: true }, { shopIds: [cv.id], checkFree: true });
    expect(detail.outreach).toHaveLength(3);
    expect(detail.outreach.every((v) => v.suggested === "reassign" && v.freeBarber)).toBe(true);
  });

  it("part of a day only lists the appointments in those hours; cancelling gives the time back and closes the rows", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const wed = dayOn(3, 21);
    const morning = await book("coralville", makenna.id, wed, 600);
    const afternoon = await book("coralville", makenna.id, wed, 840);
    await as("michelle@rayz.test");
    const r = ok(await acts.markCallInAction({ staffId: makenna.id, shopId: cv.id, kind: "emergency", fromDate: wed, toDate: wed, allDay: false, startMin: 780, endMin: 960 }));
    expect(r.affected).toBe(1);
    const row = await rowFor(r.callInId, afternoon.id);
    expect(row.status).toBe("pending");
    expect(await rowFor(r.callInId, morning.id)).toBeUndefined();

    ok(await acts.cancelCallInAction(r.callInId));
    const c = (await m.db.db.query.callIns.findFirst({ where: eq(m.schema.callIns.id, r.callInId) }))!;
    expect(c.cancelledAt).not.toBeNull();
    expect(await m.db.db.query.timeBlocks.findFirst({ where: eq(m.schema.timeBlocks.id, c.blockId!) })).toBeUndefined();
    expect((await rowFor(r.callInId, afternoon.id)).status).toBe("cancelled");
    expect(err(await send(r.callInId, [{ appointmentId: afternoon.id, option: "rebook" }]))).toMatch(/cancelled/i);
  });

  it("a range of days lists appointments on each of them", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const thu = dayOn(4, 50);
    const fri = m.time.addDays(thu, 1);
    const a = await book("coralville", makenna.id, thu, 660);
    const b = await book("coralville", makenna.id, fri, 660);
    await as("michelle@rayz.test");
    const r = ok(await mark(makenna.id, null, whole(thu, fri), "sick"));
    expect(r.affected).toBe(2);
    expect((await rowFor(r.callInId, a.id)).status).toBe("pending");
    expect((await rowFor(r.callInId, b.id)).status).toBe("pending");
    ok(await acts.cancelCallInAction(r.callInId));
  });
});

describe("reassign or rebook", () => {
  it("reassign moves the client to a free barber at the same time and texts them; with nobody free it sends a rebook link instead", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const jessica = await staffBy({ label: "Jessica" });
    const michelle = await staffBy({ email: "michelle@rayz.test" });
    const cv = await shop("coralville");
    const thu = dayOn(4, 28);
    const free = await book("coralville", makenna.id, thu, 600, { firstName: "Freeslot" });
    const busy = await book("coralville", makenna.id, thu, 840, { firstName: "Busyslot" });
    // Everyone else at the shop is booked at the second appointment's time.
    await bookAt("coralville", jessica.id, busy.startsAt);
    await bookAt("coralville", michelle.id, busy.startsAt);

    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(thu)));
    const res = ok(
      await send(callInId, [
        { appointmentId: free.id, option: "reassign" },
        { appointmentId: busy.id, option: "reassign" },
      ]),
    );
    expect(res.every((x) => x.ok)).toBe(true);

    const moved = await appt(free.id);
    expect([jessica.id, michelle.id]).toContain(moved.staffId);
    expect(moved.startsAt.getTime()).toBe(free.startsAt.getTime());
    const fr = await rowFor(callInId, free.id);
    expect([fr.option, fr.status, fr.reassignedStaffId, fr.attempts]).toEqual(["reassign", "notified", moved.staffId, 1]);
    expect(fr.nextActionAt).toBeNull();
    const [text] = await jobsFor(fr.id);
    expect([text.channel, text.kind, text.status]).toEqual(["sms", "callin_reassign", "sent"]);
    expect(text.body).toMatch(/We've booked you with (Jessica|Michelle) at the same time\. Reply 1 to keep it, 2 to cancel/);
    expect(text.body).not.toMatch(/sick/i);
    expect(tokenIn(text.body)).not.toBeNull();
    expect(res.find((x) => x.appointmentId === free.id)!.message).toMatch(/^Moved to (Jessica|Michelle)\. Text sent/);

    const stayed = await appt(busy.id);
    expect(stayed.staffId).toBe(makenna.id);
    const br = await rowFor(callInId, busy.id);
    expect([br.option, br.status, br.reassignedStaffId]).toEqual(["rebook", "notified", null]);
    expect(br.nextActionAt).not.toBeNull();
    expect(res.find((x) => x.appointmentId === busy.id)!.message).toMatch(/^No barber is free then, so a rebook link went instead/);
    const [link] = await jobsFor(br.id);
    expect([link.kind, link.channel]).toEqual(["callin_rebook", "sms"]);
    expect(link.body).toMatch(/any time with any barber, same services/);

    // Already moved: can't be moved again.
    expect(ok(await send(callInId, [{ appointmentId: free.id, option: "reassign" }]))[0]).toMatchObject({ ok: false, message: "Already moved to another barber" });
  });

  it("moves to another shop only when the client allows it, booking the same services there", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const jessica = await staffBy({ label: "Jessica" });
    const michelle = await staffBy({ email: "michelle@rayz.test" });
    const cv = await shop("coralville");
    const tue = dayOn(2, 35);
    const a = await book("coralville", makenna.id, tue, 660, { firstName: "Traveller" });
    await bookAt("coralville", jessica.id, a.startsAt);
    await bookAt("coralville", michelle.id, a.startsAt);
    await m.db.db.update(m.schema.customers).set({ allowOtherShop: true }).where(eq(m.schema.customers.id, a.customerId!));

    await as("owner@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(tue)));
    const [r] = ok(await send(callInId, [{ appointmentId: a.id, option: "reassign" }]));
    expect(r.ok).toBe(true);
    const row = await rowFor(callInId, a.id);
    expect(row.reassignedShopId).not.toBe(cv.id);
    expect(row.newAppointmentId).not.toBeNull();
    expect((await appt(a.id)).status).toBe("cancelled");
    const now = await appt(row.newAppointmentId!);
    expect([now.shopId, now.startsAt.getTime(), now.customerId, now.status]).toEqual([row.reassignedShopId, a.startsAt.getTime(), a.customerId, "booked"]);
    const [text] = await jobsFor(row.id);
    expect(text.body).toMatch(/at the same time/);
    expect(text.body).toMatch(/ at Ray'z /);
  });

  it("only sends on channels the client allows; automated calls need their own permission", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const fri = dayOn(5, 28);
    const noOptIn = await book("coralville", makenna.id, fri, 600, { firstName: "Quiet", smsOptIn: false });
    const emailOnly = await book("coralville", makenna.id, fri, 720, { firstName: "Mailer", smsOptIn: false, email: "mailer@example.test", emailOptIn: true });
    const caller = await book("coralville", makenna.id, fri, 840, { firstName: "Ringer", smsOptIn: false });

    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(fri)));

    await as("frontdesk@rayz.test");
    const [noVoice] = ok(await send(callInId, [{ appointmentId: caller.id, option: "voice" }]));
    expect(noVoice).toMatchObject({ ok: false, message: "You can't place automated calls" });

    await as("michelle@rayz.test");
    const res = ok(
      await send(callInId, [
        { appointmentId: noOptIn.id, option: "rebook" },
        { appointmentId: emailOnly.id, option: "rebook" },
        { appointmentId: caller.id, option: "voice" },
      ]),
    );
    expect(res[0]).toMatchObject({ ok: false, message: expect.stringMatching(/hasn't agreed to texts or emails/) });
    expect((await rowFor(callInId, noOptIn.id)).status).toBe("pending");
    expect(await jobsFor((await rowFor(callInId, noOptIn.id)).id)).toEqual([]);

    expect(res[1].ok).toBe(true);
    const mail = await jobsFor((await rowFor(callInId, emailOnly.id)).id);
    expect(mail.map((j) => j.channel)).toEqual(["email"]);
    expect(mail[0].subject).toMatch(/please pick a new time/);

    expect(res[2]).toMatchObject({ ok: true, message: "Call sent" });
    const vr = await rowFor(callInId, caller.id);
    const [call] = await jobsFor(vr.id);
    expect([call.channel, call.kind, call.status, call.provider]).toEqual(["voice", "callin_voice", "sent", "simulator"]);
    expect(call.body).toMatch(/Press 1 .* Press 2 .* Press 9/);
    expect(call.providerMessageId).toMatch(/^CAsim/);
    expect(await linksFor(vr.id)).toEqual([]);

    // Voicemail: the message is left, and a text with the link only goes to a client who takes texts.
    const vm = said(await line.voiceOutreachAnswer({ outreachId: vr.id, callSid: call.providerMessageId!, answeredBy: "machine_end_beep" }));
    expect(vm).toMatch(/<Say[^>]*>Hi Ringer, this is Rays Coralville\. We're sorry, Makenna can't make your appointment/);
    expect(vm).not.toMatch(/<Gather/);
    expect((await jobsFor(vr.id)).filter((j) => j.channel === "sms")).toEqual([]);
    expect((await rowFor(callInId, caller.id)).status).toBe("delivered");
    const log = (await m.db.db.query.callLogs.findFirst({ where: eq(m.schema.callLogs.providerCallId, call.providerMessageId!) }))!;
    expect([log.kind, log.status, log.customerId]).toEqual(["outreach", "voicemail", caller.customerId]);

    // Press 1: one text with the link, even without "OK to text", because they asked on the call.
    const human = said(await line.voiceOutreachAnswer({ outreachId: vr.id, callSid: "CAsim-second", answeredBy: "human" }));
    expect(human).toMatch(/<Gather[^>]*>.*Press 1/);
    expect(said(await line.voiceOutreachGather({ outreachId: vr.id, callSid: "CAsim-second", digits: "1" }))).toMatch(/We've texted you a link/);
    const texted = (await jobsFor(vr.id)).filter((j) => j.channel === "sms");
    expect(texted).toHaveLength(1);
    expect(tokenIn(texted[0].body)).not.toBeNull();
    // Press 2: through to the shop phone.
    expect(said(await line.voiceOutreachGather({ outreachId: vr.id, callSid: "CAsim-second", digits: "2" }))).toMatch(/<Dial[^>]*callerId="\+13195550900"[^>]*>\+13195196700<\/Dial>/);
  });
});

describe("rebook links", () => {
  it("only the hash is stored; tampered, expired, superseded and used links don't work; the link keeps the services", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const sat = dayOn(6, 28);
    const a = await book("coralville", makenna.id, sat, 600, { firstName: "Linky" });
    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(sat)));
    ok(await send(callInId, [{ appointmentId: a.id, option: "rebook" }]));
    const row = await rowFor(callInId, a.id);
    const token = await lastToken(row.id);
    const [stored] = await linksFor(row.id);
    expect(stored.tokenHash).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.appointmentId).toBe(a.id);

    expect((await links.resolveLink(token)).state).toBe("ok");
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect((await links.resolveLink(tampered)).state).toBe("unknown");
    expect((await links.resolveLink("not-a-token")).state).toBe("unknown");
    expect((await links.resolveLink(token, new Date(stored.expiresAt.getTime() + 1000))).state).toBe("expired");
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(72 * HOUR);
    expect(err(await pub.rebookAction(tampered, new Date(Date.now() + 86_400_000).toISOString(), "any"))).toMatch(/not found/i);

    // Sending again (or the follow-up) issues a new link; the old one stops working.
    ok(await send(callInId, [{ appointmentId: a.id, option: "rebook" }]));
    const fresh = await lastToken(row.id);
    expect(fresh).not.toBe(token);
    expect((await links.resolveLink(token)).state).toBe("revoked");
    expect((await links.resolveLink(fresh)).state).toBe("ok");

    // The client picks a new time with any barber: same services, the row is rebooked, the link is spent.
    const svc = await cut("coralville");
    const next = m.time.addDays(sat, 7);
    const avail = await m.booking.getAvailability({ shopRef: "coralville", date: next, serviceId: svc.id, barberRef: "any" });
    const pick = avail.slots[0];
    const before = await m.db.db.select().from(m.schema.appointmentItems).where(eq(m.schema.appointmentItems.appointmentId, a.id));
    expect(ok(await pub.rebookAction(fresh, pick.startsAt, "any")).code).toBe(a.code);
    const after = await appt(a.id);
    expect(after.startsAt.toISOString()).toBe(new Date(pick.startsAt).toISOString());
    const items = await m.db.db.select().from(m.schema.appointmentItems).where(eq(m.schema.appointmentItems.appointmentId, a.id));
    expect(items.map((i) => i.serviceId).sort()).toEqual(before.map((i) => i.serviceId).sort());
    expect(await rowFor(callInId, a.id)).toMatchObject({ status: "rebooked", nextActionAt: null });
    expect((await links.resolveLink(fresh)).state).toBe("used");
    expect(err(await pub.declineAction(fresh))).toMatch(/already used/);
  });

  it("declining from the link cancels the appointment; a link for a cancelled appointment is closed", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const tue = dayOn(2, 42);
    const a = await book("coralville", makenna.id, tue, 600, { firstName: "Nope" });
    const b = await book("coralville", makenna.id, tue, 720, { firstName: "Gone" });
    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(tue)));
    ok(await send(callInId, [{ appointmentId: a.id, option: "rebook" }, { appointmentId: b.id, option: "rebook" }]));
    ok(await pub.declineAction(await lastToken((await rowFor(callInId, a.id)).id)));
    expect((await appt(a.id)).status).toBe("cancelled");
    expect((await rowFor(callInId, a.id)).status).toBe("declined");

    const tb = await lastToken((await rowFor(callInId, b.id)).id);
    await m.booking.cancelAppointment(b.code, { actor, byCustomer: false, reason: "test" });
    expect((await links.resolveLink(tb)).state).toBe("closed");
  });
});

describe("text replies", () => {
  it("1 takes the time offered; 1 keeps the new barber; 2 cancels; anything else waits in the inbox, unread", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const wed = dayOn(3, 28);
    const offered = await book("coralville", makenna.id, wed, 600, { firstName: "Taker" });
    const moved = await book("coralville", makenna.id, wed, 720, { firstName: "Keeper" });
    const cancels = await book("coralville", makenna.id, wed, 840, { firstName: "Canceller" });
    const chatty = await book("coralville", makenna.id, wed, 960, { firstName: "Chatty" });
    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(wed)));
    ok(
      await send(callInId, [
        { appointmentId: offered.id, option: "rebook" },
        { appointmentId: moved.id, option: "reassign" },
        { appointmentId: cancels.id, option: "rebook" },
        { appointmentId: chatty.id, option: "rebook" },
      ]),
    );
    const sms = (from: string, body: string) => line.handleInboundSms({ from, to: cv.twilioNumber!, body, messageSid: `SM${Math.random().toString(36).slice(2)}` });
    const phoneOf = async (a: { customerId: string | null }) => (await customer(a.customerId!)).phone!;

    const or = await rowFor(callInId, offered.id);
    expect(or.suggestedStartsAt).not.toBeNull();
    expect((await jobsFor(or.id))[0].body).toMatch(/Reply 1 for .* with /);
    expect((await sms(await phoneOf(offered), " 1 ")).handled).toBe("accept");
    const took = await appt(offered.id);
    expect(took.startsAt.getTime()).toBe(or.suggestedStartsAt!.getTime());
    expect(took.staffId).toBe(or.suggestedStaffId);
    expect(await rowFor(callInId, offered.id)).toMatchObject({ status: "rebooked", nextActionAt: null });
    expect((await links.resolveLink(await lastToken(or.id))).state).toBe("used");

    const mr = await rowFor(callInId, moved.id);
    await sms(await phoneOf(moved), "1");
    expect((await rowFor(callInId, moved.id)).status).toBe("rebooked");
    expect((await appt(moved.id)).staffId).toBe(mr.reassignedStaffId);
    const kept = (await jobsFor(mr.id)).filter((j) => j.kind === "shop_reply");
    expect(kept[0].body).toMatch(/You're all set with/);

    await sms(await phoneOf(cancels), "2");
    expect((await appt(cancels.id)).status).toBe("cancelled");
    expect((await rowFor(callInId, cancels.id)).status).toBe("declined");

    const r = await sms(await phoneOf(chatty), "Can I come Thursday instead?");
    expect(r.handled).toBe("message");
    expect((await rowFor(callInId, chatty.id)).status).toBe("notified");
    const thread = (await m.db.db.query.messageThreads.findFirst({ where: eq(m.schema.messageThreads.id, r.threadId!) }))!;
    expect([thread.unread, thread.customerId]).toEqual([1, chatty.customerId]);
    expect(await msg.unreadCount([cv.id])).toBeGreaterThanOrEqual(1);
    // A "1" with nothing waiting is just a message for staff.
    const stray = await sms("+13195559999", "1");
    expect((await m.db.db.query.messageThreads.findFirst({ where: eq(m.schema.messageThreads.id, stray.threadId!) }))!.unread).toBe(1);

    // Staff answer from the inbox: the front desk sees the masked number only, and the reply goes from the shop's line.
    await as("frontdesk@rayz.test");
    const raw = await phoneOf(chatty);
    const page = await open("/admin/inbox/[id]", { id: thread.id });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain(`***-***-${raw.slice(-4)}`);
    expect(page.text).not.toContain(raw);
    expect(page.text).not.toContain(raw.slice(2));
    expect(page.text).toContain("Can I come Thursday instead?");
    expect(page.text).not.toMatch(/\/r\/[A-Za-z0-9_-]{43}/);
    const list = await open("/admin/inbox");
    expect(list.kind).toBe("ok");
    expect(list.text).not.toContain(raw);
    expect(ok(await inbox.replyAction(thread.id, "Thursday at 2 works, see you then"))).toEqual({ status: "sent" });
    const desk = await staffBy({ email: "frontdesk@rayz.test" });
    const out = await m.db.db.select().from(m.schema.messages).where(and(eq(m.schema.messages.threadId, thread.id), eq(m.schema.messages.direction, "out")));
    expect(out.filter((x) => x.staffId === desk.id).map((x) => [x.body, x.auto])).toEqual([["Ray'z Coralville: Thursday at 2 works, see you then", false]]);
    expect((await m.db.db.query.messageThreads.findFirst({ where: eq(m.schema.messageThreads.id, thread.id) }))!.unread).toBe(0);
    await as("makenna@rayz.test");
    expect(err(await inbox.replyAction(thread.id, "hi"))).not.toBeNull();
  });
});

describe("opt-outs", () => {
  it("STOP turns texts off for the number (queued texts are suppressed), START turns them back on; 9 on a call stops automated calls", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const thu = dayOn(4, 35);
    const a = await book("coralville", makenna.id, thu, 600, { firstName: "Stopper" });
    const c = await customer(a.customerId!);
    expect(c.smsOptIn).toBe(true);

    await line.handleInboundSms({ from: c.phone!, to: cv.twilioNumber!, body: "STOP" });
    expect((await customer(c.id)).smsOptIn).toBe(false);
    expect(await msg.optedOut(c.phone!, "sms")).toBe(true);
    // A text queued anyway (a reply from the inbox, say) is held back at send time.
    const jobId = await msg.queueShopText({ shopId: cv.id, to: c.phone!, body: "test", kind: "shop_reply", auto: true });
    await m.queue.processDueJobs({ ids: [jobId] });
    const held = (await m.db.db.query.notificationJobs.findFirst({ where: eq(m.schema.notificationJobs.id, jobId) }))!;
    expect([held.status, held.lastError]).toEqual(["suppressed", "The number replied STOP"]);

    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(thu)));
    const [r] = ok(await send(callInId, [{ appointmentId: a.id, option: "rebook" }]));
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/hasn't agreed/) });
    const detail = await ci.callInDetail(callInId, { staffId: null, seesPrivate: true }, { shopIds: [cv.id] });
    expect(detail.outreach[0].channels).toEqual({ sms: false, email: false, voice: true });

    await line.handleInboundSms({ from: c.phone!, to: cv.twilioNumber!, body: "START" });
    expect((await customer(c.id)).smsOptIn).toBe(true);
    expect(await msg.optedOut(c.phone!, "sms")).toBe(false);

    // A voice call, then 9: no more automated calls, but texts still work.
    const [v] = ok(await send(callInId, [{ appointmentId: a.id, option: "voice" }]));
    expect(v.ok).toBe(true);
    const row = await rowFor(callInId, a.id);
    expect(said(await line.voiceOutreachGather({ outreachId: row.id, callSid: "CAsim-nine", digits: "9" }))).toMatch(/won't get these calls again/);
    expect(await msg.optedOut(c.phone!, "voice")).toBe(true);
    const [again] = ok(await send(callInId, [{ appointmentId: a.id, option: "voice" }]));
    expect(again).toMatchObject({ ok: false, message: expect.stringMatching(/asked not to get automated calls/) });
    const [text] = ok(await send(callInId, [{ appointmentId: a.id, option: "rebook" }]));
    expect(text.ok).toBe(true);
  });
});

describe("follow-ups", () => {
  it("no answer: one retry with a fresh link after the wait, then flagged for staff; answered rows are left alone", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const fri = dayOn(5, 35);
    const silent = await book("coralville", makenna.id, fri, 600, { firstName: "Silent" });
    const moved = await book("coralville", makenna.id, fri, 720, { firstName: "Moved" });
    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(fri)));
    ok(await send(callInId, [{ appointmentId: silent.id, option: "rebook" }, { appointmentId: moved.id, option: "reassign" }]));
    const first = await rowFor(callInId, silent.id);
    expect(first.attempts).toBe(1);
    const due = first.nextActionAt!;
    expect(due.getTime() - first.lastAttemptAt!.getTime()).toBe(3 * HOUR);
    const firstToken = await lastToken(first.id);

    expect((await ci.runFollowUps(new Date(due.getTime() - 60_000))).retried).toBe(0);
    expect((await rowFor(callInId, silent.id)).attempts).toBe(1);

    const t1 = new Date(due.getTime() + 60_000);
    await ci.runFollowUps(t1);
    const second = await rowFor(callInId, silent.id);
    expect([second.attempts, second.status, second.flaggedAt]).toEqual([2, "notified", null]);
    expect(second.nextActionAt!.getTime()).toBe(t1.getTime() + 3 * HOUR);
    expect((await links.resolveLink(firstToken, t1)).state).toBe("revoked");
    const retry = (await jobsFor(first.id)).filter((j) => j.channel === "sms");
    expect(retry).toHaveLength(2);
    expect(retry[1].runAt.getTime()).toBe(t1.getTime());

    const t2 = new Date(second.nextActionAt!.getTime() + 60_000);
    await ci.runFollowUps(t2);
    const flagged = await rowFor(callInId, silent.id);
    expect([flagged.status, flagged.attempts, flagged.flagReason, flagged.nextActionAt]).toEqual(["no_response", 2, "No answer after 2 tries", null]);
    expect(flagged.flaggedAt!.getTime()).toBe(t2.getTime());
    expect((await jobsFor(first.id)).filter((j) => j.channel === "sms")).toHaveLength(2);
    expect(await ci.flaggedCount([cv.id])).toBeGreaterThanOrEqual(1);

    // Moved to a new barber: they keep it if they never answer; no retry and no flag.
    expect(await rowFor(callInId, moved.id)).toMatchObject({ status: "notified", attempts: 1, flaggedAt: null });

    // The shop phones and sorts it out: the flag clears.
    ok(await acts.closeOutreachAction(flagged.id, { status: "rebooked", note: "Phoned, moved to next week" }));
    expect(await rowFor(callInId, silent.id)).toMatchObject({ status: "rebooked", flaggedAt: null, resolution: "Phoned, moved to next week" });
  });
});

describe("calls to the shop line", () => {
  it("a missed call is logged on the client and gets one auto-text; a repeat call that night gets none", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const mon = dayOn(1, 21);
    const tue = m.time.addDays(mon, 1);
    const a = await book("coralville", makenna.id, dayOn(6, 28), 600, { firstName: "Ringback" });
    const c = await customer(a.customerId!);

    const ring = await line.handleIncomingCall({ from: c.phone!, to: cv.twilioNumber!, callSid: "CA-missed-1" }, at(mon, 600));
    expect(ring).toMatch(/<Dial[^>]*callerId="\+13195550900"[^>]*>\+13195196700<\/Dial>/);
    expect(ring).not.toContain(c.phone!);
    expect(said(await line.handleDialResult({ callSid: "CA-missed-1", dialStatus: "no-answer" }, at(mon, 601)))).toMatch(/We've texted you a link to book/);
    const log = (await m.db.db.query.callLogs.findFirst({ where: eq(m.schema.callLogs.providerCallId, "CA-missed-1") }))!;
    expect([log.kind, log.status, log.customerId, log.autoTextSent]).toEqual(["inbound", "missed", c.id, true]);
    const texts = () => m.db.db.select().from(m.schema.notificationJobs).where(and(eq(m.schema.notificationJobs.to, c.phone!), eq(m.schema.notificationJobs.kind, "missed_call")));
    expect(await texts()).toHaveLength(1);
    expect((await texts())[0].body).toContain("/book/coralville");

    const late = said(await line.handleIncomingCall({ from: c.phone!, to: cv.twilioNumber!, callSid: "CA-missed-2" }, at(mon, 22 * 60)));
    expect(late).toMatch(/We're closed right now\. Please call back/);
    expect((await m.db.db.query.callLogs.findFirst({ where: eq(m.schema.callLogs.providerCallId, "CA-missed-2") }))!.status).toBe("after_hours");
    expect(await texts()).toHaveLength(1);

    // The next morning, after hours again: a new text.
    expect(said(await line.handleIncomingCall({ from: c.phone!, to: cv.twilioNumber!, callSid: "CA-missed-3" }, at(tue, 7 * 60)))).toMatch(/We've texted you a link/);
    expect(await texts()).toHaveLength(2);

    // A caller who opted out gets no text.
    await msg.recordOptOut(c.phone!, "sms", "staff");
    await line.handleIncomingCall({ from: c.phone!, to: cv.twilioNumber!, callSid: "CA-missed-4" }, at(m.time.addDays(mon, 7), 7 * 60));
    expect(await texts()).toHaveLength(2);
    await msg.recordOptIn(c.phone!);
  });

  it("a missed call from a client with a call-in appointment waiting texts the rebook link instead", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const sat = dayOn(6, 35);
    const a = await book("coralville", makenna.id, sat, 600, { firstName: "Callback" });
    const c = await customer(a.customerId!);
    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(sat)));
    ok(await send(callInId, [{ appointmentId: a.id, option: "rebook" }]));
    const row = await rowFor(callInId, a.id);
    const sent = await lastToken(row.id);
    const before = m.time.addDays(sat, -1);
    await line.handleIncomingCall({ from: c.phone!, to: cv.twilioNumber!, callSid: "CA-rebook-1" }, at(before, 22 * 60));
    const [text] = await m.db.db.select().from(m.schema.notificationJobs).where(and(eq(m.schema.notificationJobs.to, c.phone!), eq(m.schema.notificationJobs.kind, "missed_call")));
    const t = tokenIn(text.body)!;
    expect(t).not.toBeNull();
    expect(text.outreachId).toBe(row.id);
    expect((await links.resolveLink(sent)).state).toBe("revoked");
    expect((await links.resolveLink(t)).state).toBe("ok");
  });
});

describe("call-in report", () => {
  it("counts call-ins and how their appointments ended, by barber; private reasons only for those who may see them", async () => {
    const makenna = await staffBy({ email: "makenna@rayz.test" });
    const cv = await shop("coralville");
    const tue = dayOn(2, 49);
    const mon = m.time.addDays(tue, -1);
    const a = await book("coralville", makenna.id, tue, 600, { firstName: "Reportee" });
    const b = await book("coralville", makenna.id, tue, 720, { firstName: "Reportee", smsOptIn: false });
    await as("michelle@rayz.test");
    const { callInId } = ok(await mark(makenna.id, cv.id, whole(tue)));
    ok(await send(callInId, [{ appointmentId: a.id, option: "rebook" }]));
    ok(await pub.declineAction(await lastToken((await rowFor(callInId, a.id)).id)));
    expect((await rowFor(callInId, b.id)).status).toBe("pending");

    const S = await import("@/app/admin/reports/scope");
    const L = await import("@/server/report-data");
    const auth = await import("@/server/auth/staff");
    const ctx = (await auth.getStaffContext())!;
    const scope = await S.resolveScope(ctx, { from: mon, to: m.time.addDays(mon, 6) }, "call_ins");
    const load = (reasons?: ReturnType<typeof auth.reasonViewer>) => L.REPORT_LOADERS.call_ins({ scope, loc: scope.loc, viewer: ctx, reasons, params: {} });
    const d = await load(auth.reasonViewer(ctx));
    const stat = (label: string) => d.stats.find((s) => s.label === label)!.value;
    expect([stat("Call-ins"), stat("Appointments hit"), stat("Kept or rebooked")]).toEqual(["1", "2", "0"]);
    expect(d.stats[0].hint).toBe("1 barber");
    const barbers = d.tables.find((t) => t.id === "barbers")!;
    const row = barbers.rows.find((r) => r[0] === "Makenna")!;
    expect(row.slice(1)).toEqual([1, 2, 0, 0, 1, 0, 1, 0]);
    const entries = (x: typeof d) => x.tables.find((t) => t.id === "call_ins")!.rows.filter((r) => r[0] !== "Total");
    expect(entries(d)).toEqual([[tue, "Makenna", "Sick", "Sick", m.time.formatDate(tue), 2, 0, 1, 0, 1, 0]]);
    // Sick is a private reason: without "blocks.private" it reads "Time off".
    expect(auth.reasonViewer(ctx).seesPrivate).toBe(true);
    expect(entries(await load()).map((r) => r.slice(2, 4))).toEqual([["Time off", "Time off"]]);
  });
});
