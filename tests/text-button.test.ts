import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { textButtonState } from "@/domain/text-client";

const cases = [
  { name: "booked, phone, opted in", customerId: "c", hasPhone: true, smsOptIn: true, canMessage: true, enabled: true, reason: null },
  { name: "walk-in, no opt-in", customerId: "c", hasPhone: true, smsOptIn: false, canMessage: true, enabled: false, reason: "This client has not opted in to texts" },
  { name: "checked in, no phone", customerId: "c", hasPhone: false, smsOptIn: true, canMessage: true, enabled: false, reason: "No phone number on file" },
  { name: "cancelled, no client", customerId: null, hasPhone: false, smsOptIn: false, canMessage: true, enabled: false, reason: "No client on this appointment" },
  { name: "no-show, login cannot text", customerId: "c", hasPhone: true, smsOptIn: true, canMessage: false, enabled: false, reason: "You can't text clients from this login" },
] as const;

describe("text button", () => {
  it.each(cases)("stays available for $name", (c) => {
    expect(textButtonState(c)).toEqual({ enabled: c.enabled, reason: c.reason });
  });

  it("is rendered in the calendar panel and the client card, and is not hidden when opt-in is off", () => {
    const panel = readFileSync("src/app/admin/calendar/day-calendar.tsx", "utf8");
    const card = readFileSync("src/app/admin/customers/privacy.tsx", "utf8");
    expect(panel).toContain("<ContactClient");
    expect(panel).not.toMatch(/hasPhone && canManage\.message/);
    expect(card).toContain('aria-label="Text"');
    expect(card).not.toMatch(/\{canText && \(/);
  });
});
