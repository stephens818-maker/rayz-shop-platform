import { describe, expect, it } from "vitest";
import { cleanList, listProblem, resolveLookups } from "@/domain/lookups";
import { SAMPLE, TEMPLATE_DEFS, cutoffText, fill, templateFor, templateProblem } from "@/domain/message-templates";

describe("client message templates", () => {
  it("fills merge fields and tidies what an empty one leaves behind", () => {
    expect(fill("{shop}: booked with {barber} on {when} at {address}. Link: {link}", { ...SAMPLE, address: "" })).toBe(
      "Ray'z Moline: booked with Marcus T. on Fri, Oct 23, 2:30 PM. Link: https://rayz.example/a/AB12CD",
    );
  });

  it("a saved template replaces the default; a blank part falls back", () => {
    expect(templateFor("reminder_24h", {}).body).toBe(TEMPLATE_DEFS.reminder_24h.body);
    const t = templateFor("reminder_24h", { reminder_24h: { body: "{shop}: tomorrow at {when}. {link}", subject: " " } });
    expect(t).toMatchObject({ custom: true, subject: TEMPLATE_DEFS.reminder_24h.subject, body: "{shop}: tomorrow at {when}. {link}" });
  });

  it("refuses unknown fields, dropped links, and marketing texts without an opt-out", () => {
    expect(templateProblem("reminder_24h", { body: "Hi {name} {link}" })).toMatch(/\{name\} isn't a merge field/);
    expect(templateProblem("reminder_24h", { body: "See you {when}" })).toMatch(/Keep \{link\}/);
    expect(templateProblem("fill_offer", { body: "Openings today: {book_link}" })).toMatch(/opt out/);
    expect(templateProblem("running_late", { body: "{barber} is {delay} behind" })).toBeNull();
    expect(templateProblem("confirmation", { body: "Booked {when" })).toMatch(/isn't closed/);
    for (const [k, d] of Object.entries(TEMPLATE_DEFS)) expect(templateProblem(k as keyof typeof TEMPLATE_DEFS, d), k).toBeNull();
  });

  it("says the shop's own cutoff", () => {
    expect(cutoffText(30)).toBe("30 min");
    expect(cutoffText(120)).toBe("2 hr");
  });
});

describe("picklists", () => {
  it("cleans, dedupes case-insensitively and keeps order", () => {
    expect(cleanList(["  Beard ", "beard", "", "Kids  cuts", "Haircuts"])).toEqual(["Beard", "Kids cuts", "Haircuts"]);
    expect(listProblem(["", " "])).toMatch(/at least one/);
    expect(listProblem(["x".repeat(60)])).toMatch(/too long/);
  });

  it("uses defaults for lists never saved", () => {
    const l = resolveLookups({ refundReasons: ["Wrong item"] });
    expect(l.refundReasons).toEqual(["Wrong item"]);
    expect(l.discountReasons).toContain("Military");
  });
});
