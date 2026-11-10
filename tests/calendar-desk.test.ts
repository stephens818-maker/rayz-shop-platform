import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shownBookingStatus } from "@/domain/booking-status";
import { SERVICE_TIME_TOAST, canDragAppointment, resizeEndMin } from "@/domain/calendar-desk";
import { STATUS_LABEL } from "@/components/ui";

describe("calendar and panel status", () => {
  it("says Finished on both once the service is finished, and In chair while it is running", () => {
    expect(STATUS_LABEL[shownBookingStatus("in_service", false)]).toBe("In chair");
    expect(STATUS_LABEL[shownBookingStatus("in_service", true)]).toBe("Finished");
    expect(shownBookingStatus("completed", true)).toBe("completed");
    expect(shownBookingStatus("booked", false)).toBe("booked");
    const calendar = readFileSync("src/app/admin/calendar/day-calendar.tsx", "utf8");
    expect(calendar).toContain("shownBookingStatus(a.status, !!a.times?.finished)");
    expect(calendar).toContain("shownBookingStatus(s, !!appt.times?.finished)");
    expect(calendar).toContain("<StatusBadge status={shown} />");
  });
});

describe("desk actions the canary booking is for", () => {
  it("snaps a drag-to-resize to 15 minutes and keeps at least 15", () => {
    expect(canDragAppointment("booked")).toBe(true);
    expect(canDragAppointment("confirmed")).toBe(true);
    expect(canDragAppointment("in_service")).toBe(false);
    expect(canDragAppointment("finished")).toBe(false);
    expect(resizeEndMin(600, 630, 8, 1.25)).toBe(630);
    expect(resizeEndMin(600, 630, 40, 2)).toBe(645);
    expect(resizeEndMin(600, 630, -80, 2)).toBe(615);
  });

  it("toasts Started and Finished from the Start and Finish buttons", () => {
    expect(SERVICE_TIME_TOAST.start).toBe("Started");
    expect(SERVICE_TIME_TOAST.finish).toBe("Finished");
    const panel = readFileSync("src/app/admin/calendar/service-times-panel.tsx", "utf8");
    expect(panel).toContain("toast(SERVICE_TIME_TOAST.start)");
    expect(panel).toContain("toast(SERVICE_TIME_TOAST.finish)");
    const calendar = readFileSync("src/app/admin/calendar/day-calendar.tsx", "utf8");
    expect(calendar).toContain("resizeEndMin(");
    expect(calendar).toContain("ends[a.id] ?? a.endMin");
    expect(calendar).toContain('addEventListener("pointermove", move)');
  });
});

describe("canary booking seed", () => {
  it("refuses to run unless someone opts in, and the demo seed does not call it", () => {
    const seed = readFileSync("scripts/seed.ts", "utf8");
    expect(seed).not.toContain("seed-canary-booking");
    expect(seed).not.toContain("FUTNO0TIP");
    let code = 0;
    try {
      execFileSync("npx", ["tsx", "scripts/seed-canary-booking.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    expect(code).toBe(1);
  });
});
