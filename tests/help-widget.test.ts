import { describe, expect, it } from "vitest";
import { HANDBOOK, handbookFor } from "@/domain/handbook";
import { handbookAnswer, helpWidgetConfig } from "@/domain/help-widget";
import type { Permission } from "@/domain/permissions";
import { publicBarberName, isTestBarberLabel } from "@/domain/public-barber";
import { clientListName, staffChatBody } from "@/domain/staff-chat";

describe("Nov 3 staff how-to and public names", () => {
  it("stays off until the switch is on, and the spend cap defaults to zero", () => {
    expect(helpWidgetConfig({}).on).toBe(false);
    expect(helpWidgetConfig({ HELP_WIDGET: "on" }).capCents).toBe(0);
    expect(helpWidgetConfig({ HELP_WIDGET: "on", HELP_WIDGET_MONTHLY_CAP_CENTS: "2500" }).capCents).toBe(2500);
    expect(helpWidgetConfig({ HELP_WIDGET: "off", HELP_WIDGET_MONTHLY_CAP_CENTS: "2500" }).on).toBe(false);
  });

  it("answers only from handbook topics the person can open", () => {
    const barber = handbookFor(new Set<Permission>(["timeclock.punch"]));
    expect(barber.some((t) => t.slug === "booking-links")).toBe(false);
    const answer = handbookAnswer(barber, "booking link");
    expect(answer).not.toContain("Open Booking links");
    expect(handbookAnswer(barber, "zzqxv clawback")).toContain("handbook topics you can open");
    const manager = handbookFor(new Set<Permission>(["calendar.manage"]));
    expect(handbookAnswer(manager, "booking link")).toContain("Open Booking links");
    expect(handbookAnswer(barber, "staff chat message")).toContain("Staff chat");
    expect(HANDBOOK.some((t) => t.slug === "staff-chat")).toBe(true);
  });

  it("shows a public barber as a first name and hides a test barber", () => {
    expect(publicBarberName("Olivia A.")).toBe("Olivia");
    expect(publicBarberName("Taylor A.")).toBe("Taylor");
    expect(isTestBarberLabel("Barber 2 (test)")).toBe(true);
    expect(publicBarberName("Barber 2 (test)")).toBe("Barber");
  });

  it("shows a real last name in search and strips phones from staff chat", () => {
    expect(clientListName({ firstName: "Consent", lastName: "Zzcanary", short: "Consent Z." })).toBe("Consent Zzcanary");
    expect(clientListName({ firstName: "Consent", lastName: "Z.", short: "Consent Z." })).toBe("Consent Z.");
    expect(staffChatBody("Call Consent at +1 (319) 555-0100 or a@b.co")).not.toMatch(/555/);
    expect(staffChatBody("Call Consent at +1 (319) 555-0100 or a@b.co")).not.toContain("@");
  });
});
