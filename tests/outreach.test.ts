/**
 * Call-in outreach, the pure parts: which appointments a call-in hits, which option each client is
 * offered, quiet hours, the one retry before a flag, rebook link states, how a text reply is read,
 * the opt-outs, what clients are told, and the Twilio signature and TwiML.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTREACH_RULES,
  MAX_ATTEMPTS,
  advance,
  affectedAppointments,
  channelsFor,
  followUpDue,
  inQuietHours,
  linkState,
  missedCallText,
  nextFollowUpAt,
  optionProblem,
  outreachEmail,
  outreachRules,
  outreachRulesProblem,
  outreachSms,
  parseReply,
  redactLinks,
  sendTime,
  shopOpenAt,
  spokenPhone,
  suggestOption,
  tooLateToSend,
  voiceScript,
} from "@/domain/outreach";
import { TOKEN_SHAPE, hashToken, newRebookToken } from "@/domain/rebook-token";
import { dial, gather, response, say } from "@/domain/twiml";
import { zonedWallTime } from "@/lib/time";
import { twilioSignature, validTwilioSignature } from "@/server/twilio/signature";

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedWallTime(date, h * 60 + m).toJSDate();
};
const H = 3_600_000;
const DAY = "2026-10-23";

describe("affected appointment detection", () => {
  const callIn = { staffId: "makenna", shopId: "coralville", startsAt: at(DAY, "12:00"), endsAt: at(DAY, "17:00") };
  const appt = (id: string, from: string, to: string, o: Partial<{ staffId: string; shopId: string; status: string }> = {}) => ({
    id,
    staffId: o.staffId ?? "makenna",
    shopId: o.shopId ?? "coralville",
    status: o.status ?? "booked",
    startsAt: at(DAY, from),
    endsAt: at(DAY, to),
  });
  const now = at(DAY, "11:00");

  it("lists the barber's booked appointments that overlap the time, in order", () => {
    const list = [appt("late", "16:30", "17:15"), appt("in", "13:00", "13:30"), appt("edge", "11:30", "12:15"), appt("after", "17:00", "17:30"), appt("before", "11:00", "12:00")];
    expect(affectedAppointments(callIn, list, now).map((a) => a.id)).toEqual(["edge", "in", "late"]);
  });

  it("skips other barbers, other shops, and appointments already cancelled, finished or missed", () => {
    const list = [
      appt("other-barber", "13:00", "13:30", { staffId: "delaney" }),
      appt("other-shop", "13:00", "13:30", { shopId: "moline" }),
      appt("cancelled", "13:00", "13:30", { status: "cancelled" }),
      appt("done", "13:00", "13:30", { status: "completed" }),
      appt("no-show", "13:00", "13:30", { status: "no_show" }),
      appt("confirmed", "14:00", "14:30", { status: "confirmed" }),
      appt("in-chair", "12:00", "12:45", { status: "in_service" }),
    ];
    expect(affectedAppointments(callIn, list, at(DAY, "12:10")).map((a) => a.id)).toEqual(["in-chair", "confirmed"]);
  });

  it("covers every shop when the call-in is for all of them, and drops what has already ended", () => {
    const all = { ...callIn, shopId: null };
    const list = [appt("moline", "13:00", "13:30", { shopId: "moline" }), appt("over", "12:00", "12:30")];
    expect(affectedAppointments(all, list, at(DAY, "12:45")).map((a) => a.id)).toEqual(["moline"]);
  });
});

describe("reassign versus rebook", () => {
  const can = { phone: "+13195550123", email: "a@example.test", smsOptIn: true, emailOptIn: true, smsOptedOut: false, voiceOptedOut: false };

  it("offers a free barber first, then a rebook link, then a call", () => {
    expect(suggestOption({ reachable: true, freeBarber: true, channels: channelsFor(can) })).toBe("reassign");
    expect(suggestOption({ reachable: true, freeBarber: false, channels: channelsFor(can) })).toBe("rebook");
    expect(suggestOption({ reachable: true, freeBarber: false, channels: channelsFor({ ...can, smsOptIn: false, emailOptIn: false }) })).toBe("voice");
  });

  it("offers nothing to a client already in the shop, or one who can't be reached at all", () => {
    expect(suggestOption({ reachable: false, freeBarber: true, channels: channelsFor(can) })).toBeNull();
    expect(suggestOption({ reachable: true, freeBarber: true, channels: channelsFor({ ...can, phone: null, email: null }) })).toBeNull();
  });

  it("won't send a rebook link without texts or emails, or call someone who pressed 9", () => {
    expect(optionProblem("rebook", channelsFor({ ...can, smsOptIn: false, emailOptIn: false }))).toMatch(/texts or emails/);
    expect(optionProblem("rebook", channelsFor({ ...can, emailOptIn: false }))).toBeNull();
    expect(optionProblem("voice", channelsFor({ ...can, voiceOptedOut: true }))).toMatch(/automated calls/);
    expect(optionProblem("reassign", channelsFor(can))).toBeNull();
  });

  it("a moved client hears who and where, with 1 to keep and 2 to cancel; a rebook offers the next opening", () => {
    const t = { shop: "Ray'z Coralville", firstName: "Sam", barber: "Makenna", when: "Fri, Oct 23 at 1:00 PM", link: "https://x/r/abc" };
    const moved = outreachSms("reassign", { ...t, moved: { barber: "Delaney", shop: "Ray'z Kimberly", address: "1 Main St" } });
    expect(moved).toMatch(/booked you with Delaney at Ray'z Kimberly \(1 Main St\) at the same time\. Reply 1 to keep it, 2 to cancel/);
    const rebook = outreachSms("rebook", { ...t, suggestion: { when: "Sat, Oct 24 at 10:00 AM", barber: "Skylar" } });
    expect(rebook).toMatch(/Reply 1 for Sat, Oct 24 at 10:00 AM with Skylar, or pick any time with any barber, same services: https:\/\/x\/r\/abc Reply 2 to cancel/);
    expect(outreachEmail("rebook", t).body).toMatch(/services and add-ons stay the same/);
  });

  it("never tells the client why the barber is out", () => {
    const t = { shop: "Ray'z Coralville", firstName: null, barber: "Makenna", when: "Fri", link: "L", shopPhone: "+13195550100" };
    const all = [outreachSms("rebook", t), outreachEmail("rebook", t).body, outreachEmail("rebook", t).subject, ...Object.values(voiceScript(t))].join(" ");
    expect(all).not.toMatch(/sick|emergency|ill\b|hospital/i);
    expect(all).toMatch(/can't make your/);
  });
});

describe("quiet hours", () => {
  const r = DEFAULT_OUTREACH_RULES;

  it("wraps past midnight", () => {
    expect(inQuietHours(22 * 60, r)).toBe(true);
    expect(inQuietHours(7 * 60 + 59, r)).toBe(true);
    expect(inQuietHours(8 * 60, r)).toBe(false);
    expect(inQuietHours(20 * 60 + 59, r)).toBe(false);
    expect(inQuietHours(3 * 60, { quietStartMin: 0, quietEndMin: 0 })).toBe(false);
  });

  it("holds a message until quiet hours end, the next morning when it's late evening", () => {
    expect(sendTime(at(DAY, "12:00"), r)).toEqual(at(DAY, "12:00"));
    expect(sendTime(at(DAY, "22:30"), r)).toEqual(at("2026-10-24", "08:00"));
    expect(sendTime(at("2026-10-24", "06:15"), r)).toEqual(at("2026-10-24", "08:00"));
  });

  it("is too late when the held message would land under an hour before the appointment", () => {
    expect(tooLateToSend(at(DAY, "08:00"), at(DAY, "08:45"))).toBe(true);
    expect(tooLateToSend(at(DAY, "08:00"), at(DAY, "09:00"))).toBe(false);
  });

  it("rules are checked and fall back to the defaults", () => {
    expect(outreachRules({ retryAfterHours: 6, quietStartMin: "x" })).toEqual({ ...DEFAULT_OUTREACH_RULES, retryAfterHours: 6 });
    expect(outreachRulesProblem({ retryAfterHours: 0 })).toMatch(/1 to 48/);
    expect(outreachRulesProblem({ linkTtlHours: 24 * 15 })).toMatch(/14 days/);
    expect(outreachRulesProblem({ quietStartMin: 25 * 60 })).toMatch(/times of day/);
    expect(outreachRulesProblem({ retryAfterHours: 4, linkTtlHours: 24 })).toBeNull();
  });
});

describe("follow-ups: one retry, then a flag for staff", () => {
  const startsAt = at("2026-10-24", "15:00");
  const row = { option: "rebook" as const, status: "notified" as const, attempts: 1, nextActionAt: at(DAY, "15:00"), startsAt };

  it("waits the set hours, but follows up no later than an hour before the appointment and no sooner than 30 minutes", () => {
    expect(nextFollowUpAt(at(DAY, "12:00"), startsAt, { retryAfterHours: 3 })).toEqual(at(DAY, "15:00"));
    expect(nextFollowUpAt(at(DAY, "12:00"), at(DAY, "14:00"), { retryAfterHours: 3 })).toEqual(at(DAY, "13:00"));
    expect(nextFollowUpAt(at(DAY, "12:00"), at(DAY, "12:45"), { retryAfterHours: 3 })).toEqual(at(DAY, "12:30"));
  });

  it("does nothing before it's due", () => {
    expect(followUpDue(row, at(DAY, "14:59"))).toBeNull();
  });

  it("retries once, then flags", () => {
    expect(MAX_ATTEMPTS).toBe(2);
    expect(followUpDue(row, at(DAY, "15:00"))).toEqual({ action: "retry" });
    expect(followUpDue({ ...row, attempts: 2 }, at(DAY, "18:00"))).toEqual({ action: "flag", reason: "No answer after 2 tries" });
  });

  it("flags as soon as the appointment time comes, even before the retry", () => {
    expect(followUpDue({ ...row, nextActionAt: at("2026-10-24", "16:00") }, startsAt)).toEqual({ action: "flag", reason: "The appointment time came with no answer" });
  });

  it("delivered counts as waiting too; answered, moved and not-yet-sent rows are left alone", () => {
    expect(followUpDue({ ...row, status: "delivered" }, at(DAY, "15:00"))).toEqual({ action: "retry" });
    expect(followUpDue({ ...row, option: "voice" }, at(DAY, "15:00"))).toEqual({ action: "retry" });
    for (const status of ["rebooked", "declined", "cancelled", "pending", "no_response"] as const) expect(followUpDue({ ...row, status }, at(DAY, "20:00"))).toBeNull();
    expect(followUpDue({ ...row, option: "reassign" }, at(DAY, "20:00"))).toBeNull();
  });

  it("status moves forward only, and an answer is final", () => {
    expect(advance("pending", "sent")).toBe("notified");
    expect(advance("notified", "sent")).toBeNull();
    expect(advance("notified", "delivered")).toBe("delivered");
    expect(advance("delivered", "delivered")).toBeNull();
    expect(advance("delivered", "no_response")).toBe("no_response");
    expect(advance("no_response", "sent")).toBe("notified");
    expect(advance("rebooked", "sent")).toBeNull();
    expect(advance("declined", "rebooked")).toBeNull();
    expect(advance("cancelled", "delivered")).toBeNull();
  });
});

describe("rebook link security and expiry", () => {
  const now = at(DAY, "12:00");
  const link = { expiresAt: new Date(now.getTime() + H), usedAt: null, revokedAt: null };

  it("tokens are 256-bit, URL-safe and stored only as a hash", () => {
    const a = newRebookToken();
    const b = newRebookToken();
    expect(a).toMatch(TOKEN_SHAPE);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
    expect(TOKEN_SHAPE.test(`${a.slice(0, -1)}!`)).toBe(false);
    expect(TOKEN_SHAPE.test(a.slice(1))).toBe(false);
  });

  it("works until it expires, is used, is replaced or the appointment is closed", () => {
    expect(linkState(link, "booked", now)).toBe("ok");
    expect(linkState(link, "confirmed", now)).toBe("ok");
    expect(linkState(link, "booked", link.expiresAt)).toBe("expired");
    expect(linkState({ ...link, usedAt: now }, "booked", now)).toBe("used");
    expect(linkState({ ...link, revokedAt: now }, "booked", now)).toBe("revoked");
    for (const s of ["cancelled", "checked_in", "completed", "no_show"]) expect(linkState(link, s, now)).toBe("closed");
  });

  it("the token is cut out of messages on staff screens", () => {
    const token = newRebookToken();
    expect(redactLinks(`Pick a time: https://rayz.test/r/${token} Reply STOP`)).toBe("Pick a time: https://rayz.test/r/••• Reply STOP");
  });
});

describe("the inbound text reply", () => {
  it("1 and YES accept, 2 and NO decline", () => {
    for (const w of ["1", " 1 ", "yes", "Yes!", "Y", "ok."]) expect(parseReply(w)).toBe("accept");
    for (const w of ["2", "no", "N"]) expect(parseReply(w)).toBe("decline");
  });

  it("anything else is a message for the inbox", () => {
    for (const w of ["1 please but later", "Can I come at 3?", "12", ""]) expect(parseReply(w)).toBe("message");
  });

  it("STOP words opt out; START, UNSTOP and YES after a STOP opt back in; HELP is help", () => {
    for (const w of ["STOP", "stop", "Unsubscribe", "CANCEL", "end", "QUIT", "STOPALL", "optout", "revoke"]) expect(parseReply(w)).toBe("stop");
    for (const w of ["START", "unstop"]) expect(parseReply(w)).toBe("start");
    expect(parseReply("YES", { optedOut: true })).toBe("start");
    expect(parseReply("1", { optedOut: true })).toBe("accept");
    expect(parseReply("help")).toBe("help");
  });
});

describe("opt-out handling", () => {
  const base = { phone: "+13195550123", email: "a@example.test", smsOptIn: true, emailOptIn: true, smsOptedOut: false, voiceOptedOut: false };

  it("STOP turns off texts but not email or calls; pressing 9 turns off calls only", () => {
    expect(channelsFor({ ...base, smsOptedOut: true })).toEqual({ sms: false, email: true, voice: true });
    expect(channelsFor({ ...base, voiceOptedOut: true })).toEqual({ sms: true, email: true, voice: false });
  });

  it("texts and emails need the client's yes; calls don't", () => {
    expect(channelsFor({ ...base, smsOptIn: false, emailOptIn: false })).toEqual({ sms: false, email: false, voice: true });
    expect(channelsFor({ ...base, phone: null })).toEqual({ sms: false, email: true, voice: false });
  });

  it("every automated text says how to opt out, and the call offers 9", () => {
    const t = { shop: "Ray'z Coralville", firstName: "Sam", barber: "Makenna", when: "Fri", link: "L" };
    expect(outreachSms("rebook", t)).toMatch(/Reply STOP to opt out\.$/);
    expect(outreachSms("reassign", { ...t, moved: { barber: "Delaney", shop: null, address: null } })).toMatch(/Reply STOP to opt out\.$/);
    expect(voiceScript(t).menu).toMatch(/Press 9 to stop these calls/);
  });
});

describe("the shop line", () => {
  const hours = [{ weekday: 5, openMin: 9 * 60, closeMin: 19 * 60 }];

  it("is open in the shop's hours, not on a closed date", () => {
    expect(shopOpenAt(hours, [], at(DAY, "10:00"))).toBe(true);
    expect(shopOpenAt(hours, [], at(DAY, "19:00"))).toBe(false);
    expect(shopOpenAt(hours, [DAY], at(DAY, "10:00"))).toBe(false);
  });

  it("the missed-call text sends a rebook link to a client waiting on one, else the booking page", () => {
    expect(missedCallText({ shop: "Ray'z Coralville", afterHours: true, link: "B", rebook: false })).toBe("Ray'z Coralville: Thanks for calling. We're closed right now. Book online anytime: B Or text us here.");
    expect(missedCallText({ shop: "Ray'z Coralville", afterHours: false, link: "R", rebook: true })).toMatch(/Sorry we missed your call\. Pick a new time for your appointment here: R$/);
  });

  it("reads numbers digit by digit", () => {
    expect(spokenPhone("+13195550100")).toBe("3 1 9, 5 5 5, 0 1 0 0");
  });
});

describe("Twilio webhooks", () => {
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };

  it("signs like Twilio's documented example", () => {
    expect(twilioSignature("12345", url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("rejects a missing token or signature, a changed parameter or a different URL", () => {
    const sig = twilioSignature("12345", url, params);
    expect(validTwilioSignature("12345", sig, url, params)).toBe(true);
    expect(validTwilioSignature(undefined, sig, url, params)).toBe(false);
    expect(validTwilioSignature("12345", null, url, params)).toBe(false);
    expect(validTwilioSignature("12345", sig, url, { ...params, Digits: "1" })).toBe(false);
    expect(validTwilioSignature("12345", sig, "https://evil.test/myapp.php?foo=1&bar=2", params)).toBe(false);
    expect(validTwilioSignature("other", sig, url, params)).toBe(false);
  });

  it("TwiML escapes what it says and dials", () => {
    expect(response(say(`Ray'z <b> & "co"`))).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Ray&apos;z &lt;b&gt; &amp; &quot;co&quot;</Say></Response>`);
    expect(gather({ action: "https://x/a?o=1&b=2" }, say("hi"))).toBe(`<Gather action="https://x/a?o=1&amp;b=2" method="POST" numDigits="1" timeout="6"><Say voice="Polly.Joanna">hi</Say></Gather>`);
    expect(dial({ callerId: "+13195550900", timeout: 20 }, "+13195550100")).toBe(`<Dial callerId="+13195550900" timeout="20">+13195550100</Dial>`);
  });
});
