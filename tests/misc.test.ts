import { describe, expect, it } from "vitest";
import { slugContainsSurname, staffPublicSlug } from "@/lib/ids";
import { normalizePhone } from "@/lib/phone";
import { mapHeaders, parseSquireDateTime } from "@/server/importer";
import { openApiDocument } from "@/server/openapi";

describe("booking URLs never contain surnames", () => {
  it("barber slugs are first name + random suffix", () => {
    const slug = staffPublicSlug("Taylor");
    expect(slug).toMatch(/^taylor-[a-z0-9]{4}$/);
    expect(slugContainsSurname(slug, "Robinson")).toBe(false);
    expect(slugContainsSurname("taylor-robinson", "Robinson")).toBe(true);
  });
});

describe("Squire import helpers", () => {
  it("maps varied header spellings", () => {
    expect(mapHeaders(["First Name", "LAST_NAME", "Mobile Phone", "Email Address", "Location"])).toEqual({
      firstName: "First Name",
      lastName: "LAST_NAME",
      phone: "Mobile Phone",
      email: "Email Address",
      shop: "Location",
    });
  });

  it("parses Squire date/time formats in Chicago time", () => {
    expect(parseSquireDateTime("9/14/2026", "10:00 AM")!.toISOString()).toBe("2026-09-14T15:00:00.000Z");
    expect(parseSquireDateTime("12/1/2026", "9:00 am")!.toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect(parseSquireDateTime(undefined, undefined, "2026-11-02 09:00")!.toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(parseSquireDateTime("not a date", "9:00 AM")).toBeNull();
    expect(parseSquireDateTime(undefined, undefined, "2026-11-02T09:00")!.toISOString()).toBe("2026-11-02T15:00:00.000Z");
  });

  it("normalizes US phone numbers to E.164", () => {
    expect(normalizePhone("(319) 519-6700")).toBe("+13195196700");
    expect(normalizePhone("1-563-386-8505")).toBe("+15633868505");
    expect(normalizePhone("555-1234")).toBeNull();
  });
});

describe("OpenAPI", () => {
  it("documents every mobile-facing endpoint with bearer auth", () => {
    const doc = openApiDocument("https://example.test");
    expect(doc.openapi).toBe("3.1.0");
    for (const p of [
      "/shops",
      "/shops/{shop}/services",
      "/shops/{shop}/barbers",
      "/shops/{shop}/availability",
      "/appointments",
      "/appointments/{code}/cancel",
      "/appointments/{code}/reschedule",
      "/auth/otp/start",
      "/auth/otp/verify",
      "/auth/refresh",
      "/me/loyalty",
    ]) {
      expect(doc.paths).toHaveProperty([p]);
    }
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    expect(JSON.stringify(doc.components.schemas.Barber)).not.toMatch(/lastName/);
  });
});
