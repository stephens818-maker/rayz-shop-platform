import { formatLongDate } from "@rayz/api";
import { describe, expect, it } from "vitest";
import { displayDate } from "./civil-date";

describe("Chicago dates", () => {
  it("shows the Chicago day when the UTC date is already the next day", () => {
    const instant = "2026-10-20T03:30:00.000Z";
    expect(displayDate(instant)).toBe(formatLongDate("2026-10-19", "en-US"));
    expect(displayDate(instant)).not.toBe(formatLongDate(instant.slice(0, 10), "en-US"));
  });
});
