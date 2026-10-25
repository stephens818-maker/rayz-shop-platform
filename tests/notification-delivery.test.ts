import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calendarLinks,
  clientEmailHtml,
  deliveryState,
  OPT_OUT_REASON,
  placeReminder,
  postmarkEvent,
  reminderTimes,
  resendEvent,
  withUnsubscribe,
} from "@/domain/notification-delivery";
import { DEFAULT_OUTREACH_RULES } from "@/domain/outreach";
import { zonedWallTime } from "@/lib/time";
import { readSignedId, signedId, verifyBasicAuth, verifySvix } from "@/lib/webhook-auth";
import { PostmarkEmail, ResendEmail } from "@/server/notifications/providers";

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedWallTime(date, h * 60 + m).toJSDate();
};
const quiet = DEFAULT_OUTREACH_RULES; // 9 PM to 8 AM

describe("delivery state", () => {
  it("tells delivered from sent, and an opt-out from a channel that's off", () => {
    expect(deliveryState({ status: "pending", deliveredAt: null, lastError: null })).toBe("queued");
    expect(deliveryState({ status: "sent", deliveredAt: null, lastError: null })).toBe("sent");
    expect(deliveryState({ status: "sent", deliveredAt: new Date(), lastError: null })).toBe("delivered");
    expect(deliveryState({ status: "failed", deliveredAt: null, lastError: "x" })).toBe("failed");
    expect(deliveryState({ status: "suppressed", deliveredAt: null, lastError: OPT_OUT_REASON.stop })).toBe("opted_out");
    expect(deliveryState({ status: "suppressed", deliveredAt: null, lastError: OPT_OUT_REASON.bounce })).toBe("opted_out");
    expect(deliveryState({ status: "suppressed", deliveredAt: null, lastError: null })).toBe("not_sent");
    expect(deliveryState({ status: "cancelled", deliveredAt: null, lastError: null })).toBe("cancelled");
  });
});

describe("add to calendar links", () => {
  it("builds Google and Outlook links with UTC times, the place and the details", () => {
    const l = calendarLinks({ title: "Ray'z Coralville: Fade with Olivia A.", start: new Date("2026-11-03T15:00:00Z"), end: new Date("2026-11-03T15:30:00Z"), location: "Ray'z Coralville, 1 Main St", details: "Manage: https://x/a/ABC123" });
    const g = new URL(l.google);
    expect(g.host).toBe("calendar.google.com");
    expect(g.searchParams.get("dates")).toBe("20261103T150000Z/20261103T153000Z");
    expect(g.searchParams.get("location")).toBe("Ray'z Coralville, 1 Main St");
    const o = new URL(l.outlook);
    expect(o.searchParams.get("startdt")).toBe("2026-11-03T15:00:00.000Z");
    expect(o.searchParams.get("subject")).toContain("Fade with Olivia A.");
    expect(o.searchParams.get("body")).toContain("/a/ABC123");
  });
});

describe("reminders and quiet hours (America/Chicago)", () => {
  const now = at("2026-10-20", "12:00");

  it("leaves reminders outside quiet hours alone", () => {
    const starts = at("2026-10-23", "14:00");
    const t = reminderTimes(starts, now, { firstHours: 24, secondHours: 2 }, quiet);
    expect(t.first).toEqual(at("2026-10-22", "14:00"));
    expect(t.second).toEqual(at("2026-10-23", "12:00"));
  });

  it("waits for quiet hours to end when that's still 30 minutes before the appointment", () => {
    const starts = at("2026-10-23", "09:00");
    expect(placeReminder(at("2026-10-23", "07:00"), starts, now, quiet)).toEqual(at("2026-10-23", "08:00"));
  });

  it("otherwise sends it the minute before quiet hours began, and drops it when that's past", () => {
    const starts = at("2026-10-23", "08:15");
    expect(placeReminder(at("2026-10-23", "06:15"), starts, now, quiet)).toEqual(at("2026-10-22", "20:59"));
    expect(placeReminder(at("2026-10-23", "06:15"), starts, at("2026-10-22", "22:00"), quiet)).toBeNull();
  });

  it("drops the second reminder when quiet hours push it next to the first", () => {
    const starts = at("2026-10-23", "08:15");
    const t = reminderTimes(starts, now, { firstHours: 12, secondHours: 2 }, quiet);
    expect(t.first).toEqual(at("2026-10-22", "20:15"));
    expect(t.second).toBeNull();
  });

  it("is right across the fall DST change (Nov 1, 2026)", () => {
    const starts = at("2026-11-01", "09:00");
    const t = reminderTimes(starts, at("2026-10-30", "12:00"), { firstHours: 24, secondHours: 2 }, quiet);
    expect(t.first?.getTime()).toBe(starts.getTime() - 24 * 3_600_000);
    expect(t.first).toEqual(at("2026-10-31", "10:00"));
    expect(t.second).toEqual(at("2026-11-01", "08:00"));
  });

  it("is right across the spring DST change (Mar 8, 2026)", () => {
    const starts = at("2026-03-08", "10:00");
    const t = reminderTimes(starts, at("2026-03-06", "12:00"), { firstHours: 24, secondHours: 2 }, quiet);
    expect(t.first).toEqual(at("2026-03-07", "09:00"));
    expect(t.second).toEqual(at("2026-03-08", "08:00"));
  });

  it("does nothing special with no quiet hours", () => {
    const starts = at("2026-10-23", "08:15");
    const none = { ...quiet, quietStartMin: 0, quietEndMin: 0 };
    expect(placeReminder(at("2026-10-23", "06:15"), starts, now, none)).toEqual(at("2026-10-23", "06:15"));
  });
});

describe("email provider events", () => {
  it("reads Resend's delivered, bounced and complained events", () => {
    expect(resendEvent({ type: "email.delivered", data: { email_id: "e1", to: ["a@x.com"] } })).toEqual({ kind: "delivered", messageId: "e1", email: "a@x.com", permanent: false });
    expect(resendEvent({ type: "email.bounced", data: { email_id: "e2", to: ["a@x.com"], bounce: { type: "Permanent" } } })?.permanent).toBe(true);
    expect(resendEvent({ type: "email.bounced", data: { email_id: "e2", to: ["a@x.com"], bounce: { type: "Transient" } } })?.permanent).toBe(false);
    expect(resendEvent({ type: "email.complained", data: { email_id: "e3", to: "a@x.com" } })?.kind).toBe("complained");
    expect(resendEvent({ type: "email.opened", data: {} })).toBeNull();
  });

  it("reads Postmark's delivery, bounce and spam complaint records", () => {
    expect(postmarkEvent({ RecordType: "Delivery", MessageID: "p1", Recipient: "a@x.com" })).toEqual({ kind: "delivered", messageId: "p1", email: "a@x.com", permanent: false });
    expect(postmarkEvent({ RecordType: "Bounce", Type: "HardBounce", MessageID: "p2", Email: "a@x.com" })?.permanent).toBe(true);
    expect(postmarkEvent({ RecordType: "Bounce", Type: "SoftBounce", MessageID: "p2", Email: "a@x.com" })?.permanent).toBe(false);
    expect(postmarkEvent({ RecordType: "SpamComplaint", MessageID: "p3", Email: "a@x.com" })?.kind).toBe("complained");
    expect(postmarkEvent({ RecordType: "Open" })).toBeNull();
  });
});

describe("webhook signatures", () => {
  const secret = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
  const sign = (id: string, ts: number, body: string) =>
    `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;

  it("accepts a good Svix signature and refuses a bad, tampered or stale one", () => {
    const body = '{"type":"email.delivered"}';
    const ts = 1_800_000_000;
    expect(verifySvix(secret, { id: "msg_1", timestamp: String(ts), signature: `v1,bad ${sign("msg_1", ts, body)}` }, body, ts)).toBe(true);
    expect(verifySvix(secret, { id: "msg_1", timestamp: String(ts), signature: sign("msg_1", ts, body) }, body.replace("delivered", "bounced"), ts)).toBe(false);
    expect(verifySvix(secret, { id: "msg_1", timestamp: String(ts), signature: sign("msg_1", ts, body) }, body, ts + 600)).toBe(false);
    expect(verifySvix(secret, { id: null, timestamp: String(ts), signature: sign("msg_1", ts, body) }, body, ts)).toBe(false);
  });

  it("checks Postmark's basic credentials", () => {
    const h = `Basic ${Buffer.from("rayz:s3cret").toString("base64")}`;
    expect(verifyBasicAuth(h, "rayz:s3cret")).toBe(true);
    expect(verifyBasicAuth(h, "rayz:other")).toBe(false);
    expect(verifyBasicAuth(null, "rayz:s3cret")).toBe(false);
  });

  it("signs stop links by job id and refuses a changed one", () => {
    const id = "6f1c1d1e-2a3b-4c5d-8e9f-001122334455";
    const t = signedId("email-unsub", id);
    expect(readSignedId("email-unsub", t)).toBe(id);
    expect(readSignedId("other", t)).toBeNull();
    expect(readSignedId("email-unsub", t.replace(id, "6f1c1d1e-2a3b-4c5d-8e9f-001122334456"))).toBeNull();
    expect(readSignedId("email-unsub", "nope")).toBeNull();
  });
});

describe("the client email", () => {
  const body = "Hi Riley, you're booked at Ray'z Coralville with Olivia A. on Tue, Nov 3, 9:00 AM.\nSee or change it: https://rayzbs.com/a/ABC123\n\n—\nRay'z Coralville\n1 Main St, Coralville, IA 52241\nAdd to calendar: https://rayzbs.com/a/ABC123/calendar.ics";

  it("uses the brand layout with a booking button, the shop footer and the stop link", () => {
    const html = clientEmailHtml({ subject: "You're booked", body, unsubscribeUrl: "https://rayzbs.com/u/e/tok" });
    expect(html).toContain("View or change your booking");
    expect(html).toContain('href="https://rayzbs.com/a/ABC123"');
    expect(html).toContain("1 Main St, Coralville");
    expect(html).toContain("https://rayzbs.com/u/e/tok");
    expect(html).not.toContain("<script");
    expect(withUnsubscribe(body, "https://rayzbs.com/u/e/tok")).toMatch(/Stop them: https:\/\/rayzbs.com\/u\/e\/tok$/);
    expect(withUnsubscribe(body, null)).toBe(body);
  });
});

describe("email providers", () => {
  afterEach(() => vi.unstubAllGlobals());
  const attachment = { filename: "rayz-ABC123.ics", contentType: "text/calendar", content: "QkVHSU4=" };

  it("Resend: posts the text, HTML, invite and one-click stop headers, and returns its id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await new ResendEmail("re_key", "Rayz <a@rayzbs.com>").sendEmail("riley@x.com", "Booked", "text", [attachment], "<p>hi</p>", { listUnsubscribe: "https://rayzbs.com/api/email/unsubscribe/t" });
    expect(r.providerMessageId).toBe("re_1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ from: "Rayz <a@rayzbs.com>", to: ["riley@x.com"], subject: "Booked", text: "text", html: "<p>hi</p>" });
    expect(sent.attachments[0]).toEqual({ filename: "rayz-ABC123.ics", content: "QkVHSU4=", content_type: "text/calendar" });
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("Resend: a refusal throws so the queue retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 })));
    await expect(new ResendEmail("k").sendEmail("a@x.com", "s", "b")).rejects.toThrow(/403: domain not verified/);
  });

  it("Postmark: uses the broadcast stream for Campaign Center and reports its error codes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ MessageID: "pm_1", ErrorCode: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await new PostmarkEmail("pm_token", "Rayz <a@rayzbs.com>").sendEmail("riley@x.com", "Offer", "text", [], null, { stream: "broadcast" });
    expect(r.providerMessageId).toBe("pm_1");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("pm_token");
    expect(JSON.parse(String(init.body))).toMatchObject({ To: "riley@x.com", MessageStream: "broadcast", TextBody: "text" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 406, Message: "Inactive recipient" }), { status: 422 })));
    await expect(new PostmarkEmail("t").sendEmail("a@x.com", "s", "b")).rejects.toThrow(/error 406: Inactive recipient/);
  });
});
