/**
 * The location profile without a database: addresses and phones as clients see them, social links,
 * amenities and the tax jurisdiction, the profile form, open now in the shop's zone, distance, deep
 * links and the widget snippet, the HairSalon JSON-LD, calendar invites, the new message fields, and
 * the static wiring of the widget and embed pages.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { icsCalendar, icsText, foldLine, locationDescription } from "@/domain/ics";
import { LocationDraft, draftDefaults } from "@/domain/location-draft";
import {
  LOCATIONS_OPENAPI,
  LocationProfileInput,
  LocationQuerySchema,
  cityLine,
  cleanAmenities,
  deepLinks,
  directionsUrl,
  e164,
  fullAddress,
  haversineMiles,
  jsonLdScript,
  localBusinessJsonLd,
  mapsUrl,
  openStatus,
  osmEmbedUrl,
  phoneView,
  shopPhotoProblem,
  socialLink,
  socialLinks,
  streetLine,
  taxJurisdiction,
  taxJurisdictionLabel,
  validLatLng,
  weeklyHours,
  widgetSnippet,
} from "@/domain/location-profile";
import { MERGE_FIELDS, SAMPLE, SMS_MAX, TEMPLATE_DEFS, TEMPLATE_KINDS, fill, templateProblem } from "@/domain/message-templates";

const CHI = "America/Chicago";
const MON_SAT = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, openMin: 9 * 60, closeMin: 19 * 60 }));
const LE_CLAIRE = { address: "123 Cody Rd", address2: "Suite 2", city: "Le Claire", state: "IA", zip: "52753" };

describe("address and phone", () => {
  it("joins the address lines the same way everywhere", () => {
    expect(streetLine(LE_CLAIRE)).toBe("123 Cody Rd, Suite 2");
    expect(cityLine(LE_CLAIRE)).toBe("Le Claire, IA 52753");
    expect(fullAddress(LE_CLAIRE)).toBe("123 Cody Rd, Suite 2, Le Claire, IA 52753");
    expect(fullAddress({ ...LE_CLAIRE, address2: "" })).toBe("123 Cody Rd, Le Claire, IA 52753");
    expect(fullAddress({ address: "", city: "", state: "", zip: "" })).toBe("");
  });

  it("keeps phones as E.164 with tel: and sms: links", () => {
    expect(e164("(563) 555-0100")).toBe("+15635550100");
    expect(e164("563.555.0100")).toBe("+15635550100");
    expect(e164("555-0100")).toBeNull();
    expect(phoneView("5635550100")).toEqual({ e164: "+15635550100", display: "(563) 555-0100", href: "tel:+15635550100" });
    expect(phoneView("+15635550100", "sms")?.href).toBe("sms:+15635550100");
    expect(phoneView("")).toBeNull();
  });

  it("links maps to the Place when it's known, and pins without an address", () => {
    const shop = { ...LE_CLAIRE, name: "Le Claire", googlePlaceId: "ChIJN1t_tDeuEmsRUsoyG83frY4" };
    expect(mapsUrl(shop)).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Ray%27z\+Le\+Claire%2C\+123\+Cody/);
    expect(mapsUrl(shop)).toContain("query_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4");
    expect(directionsUrl(shop)).toContain("destination_place_id=ChIJN1t_tDeuEmsRUsoyG83frY4");
    expect(mapsUrl({ address: "", city: "", state: "", zip: "", name: "X", latitude: 41.6, longitude: -90.3 })).toContain("query=41.6%2C-90.3");
    expect(osmEmbedUrl({ lat: 41.6, lng: -90.34 })).toContain("marker=41.600000,-90.340000");
  });

  it("measures distance in miles and rejects impossible pins", () => {
    const leClaire = { lat: 41.5967, lng: -90.3435 };
    const moline = { lat: 41.5067, lng: -90.5151 };
    expect(haversineMiles(leClaire, moline)).toBeGreaterThan(10);
    expect(haversineMiles(leClaire, moline)).toBeLessThan(12);
    expect(haversineMiles(leClaire, leClaire)).toBe(0);
    expect(validLatLng({ lat: 0, lng: 0 })).toBe(false);
    expect(validLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(validLatLng({ lat: null, lng: -90 })).toBe(false);
    expect(validLatLng(leClaire)).toBe(true);
  });
});

describe("social links, amenities and the tax jurisdiction", () => {
  it("takes a handle or a link on the right network, rebuilt without tracking", () => {
    expect(socialLink("instagram", "@rayzbarbershop")).toEqual({ ok: true, url: "https://www.instagram.com/rayzbarbershop" });
    expect(socialLink("instagram", "https://instagram.com/rayz.cuts/?utm_source=ig")).toEqual({ ok: true, url: "https://www.instagram.com/rayz.cuts" });
    expect(socialLink("tiktok", "rayz")).toEqual({ ok: true, url: "https://www.tiktok.com/@rayz" });
    expect(socialLink("x", "twitter.com/rayz")).toEqual({ ok: true, url: "https://x.com/rayz" });
    expect(socialLink("facebook", "https://m.facebook.com/profile.php?id=1234&ref=share")).toEqual({ ok: true, url: "https://www.facebook.com/profile.php?id=1234" });
    expect(socialLink("yelp", "yelp.com/biz/rayz-le-claire")).toEqual({ ok: true, url: "https://www.yelp.com/biz/rayz-le-claire" });
    expect(socialLink("website", "rayz.example/le-claire")).toEqual({ ok: true, url: "https://rayz.example/le-claire" });
    expect(socialLink("website", "")).toEqual({ ok: true, url: null });
  });

  it("refuses other sites, scripts and credentials", () => {
    for (const [k, v] of [
      ["instagram", "https://evil.example/rayz"],
      ["instagram", "javascript:alert(1)"],
      ["website", "javascript:alert(1)"],
      ["website", "https://user:pw@rayz.example"],
      ["yelp", "yelp.com/user/abc"],
      ["website", "localhost"],
    ] as const)
      expect(socialLink(k, v).ok, `${k} ${v}`).toBe(false);
    expect(socialLinks({ instagram: "@rayz", website: "javascript:alert(1)", myspace: "x" })).toEqual({ instagram: "https://www.instagram.com/rayz" });
  });

  it("keeps known amenities once each, in catalog order", () => {
    expect(cleanAmenities(["wifi", "free_parking", "wifi", "hot_tub", 3])).toEqual(["free_parking", "wifi"]);
    expect(cleanAmenities("wifi")).toEqual([]);
  });

  it("reads the tax jurisdiction defensively and labels it", () => {
    expect(taxJurisdiction(null)).toEqual({ county: null, city: null, district: null, code: null });
    expect(taxJurisdiction({ county: " Scott ", code: "82-001", extra: 1 })).toEqual({ county: "Scott", city: null, district: null, code: "82-001" });
    expect(taxJurisdiction({ code: "<script>" })).toEqual({ county: null, city: null, district: null, code: null });
    expect(taxJurisdictionLabel("IA", { county: "Scott", city: "Le Claire", district: null, code: "82-001" })).toBe("IA · Scott County · Le Claire (82-001)");
  });

  it("takes photos as small JPEG, PNG or WebP data URLs only", () => {
    expect(shopPhotoProblem("data:image/jpeg;base64,/9j/4AAQ")).toBeNull();
    expect(shopPhotoProblem("data:image/svg+xml;base64,PHN2Zz4=")).toMatch(/JPEG, PNG or WebP/);
    expect(shopPhotoProblem("https://example.com/a.jpg")).not.toBeNull();
    expect(shopPhotoProblem(`data:image/png;base64,${"A".repeat(1_600_000)}`)).not.toBeNull();
  });
});

describe("the profile form", () => {
  const base = { address: "123 Cody Rd", city: "Le Claire", state: "ia", zip: "52753" };

  it("normalizes the phone, email, state, Place ID, review link and socials", () => {
    const v = LocationProfileInput.parse({
      ...base,
      phone: "(563) 555-0100",
      email: "LeClaire@Rayz.Example ",
      googlePlaceId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
      reviewUrl: "ChIJN1t_tDeuEmsRUsoyG83frY4",
      social: { instagram: "@rayz", unknown: "x" },
      amenities: ["wifi", "nope"],
      directions: "  ",
    });
    expect(v).toMatchObject({ state: "IA", phone: "+15635550100", email: "leclaire@rayz.example", googlePlaceId: "ChIJN1t_tDeuEmsRUsoyG83frY4", social: { instagram: "https://www.instagram.com/rayz" }, amenities: ["wifi"], directions: null, address2: "" });
    expect(v.reviewUrl).toMatch(/writereview\?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4/);
    expect(v.taxJurisdiction).toBeUndefined();
  });

  it("refuses a bad phone, ZIP, Place ID, social link or half a pin", () => {
    const bad = (o: object) => LocationProfileInput.safeParse({ ...base, ...o }).error?.issues.map((i) => i.message).join("; ");
    expect(bad({ phone: "555-0100" })).toMatch(/US number/);
    expect(bad({ zip: "5275" })).toMatch(/ZIP/);
    expect(bad({ googlePlaceId: "not a place" })).toMatch(/Place ID/);
    expect(bad({ social: { instagram: "https://evil.example/x" } })).toMatch(/Instagram/);
    expect(bad({ latitude: 41.6 })).toMatch(/both the latitude and the longitude/);
    expect(bad({ reviewUrl: "https://evil.example" })).toMatch(/Google review link/);
    expect(bad({ address: "" })).toMatch(/street address/);
  });

  it("the wizard's draft takes the same profile, with E.164 phones", () => {
    const d = LocationDraft.parse(draftDefaults({ name: "Le Claire", slug: "le-claire", address: "123 Cody Rd", city: "Le Claire", state: "IA", zip: "52753", phone: "563-555-0100", social: { tiktok: "@rayz" }, amenities: ["kids", "x"] }));
    expect(d).toMatchObject({ phone: "+15635550100", social: { tiktok: "https://www.tiktok.com/@rayz" }, amenities: ["kids"], address2: "", latitude: null, taxJurisdiction: { county: null } });
    expect(LocationDraft.safeParse(draftDefaults({ name: "Le Claire", slug: "le-claire", address: "1 A St", city: "X", state: "IA", zip: "52753", phone: "555" })).success).toBe(false);
    expect(LocationDraft.safeParse(draftDefaults({ name: "Le Claire", slug: "le-claire", address: "1 A St", city: "X", state: "IA", zip: "52753", longitude: -90 })).success).toBe(false);
  });

  it("the public query takes near as lat,lng or a ZIP", () => {
    expect(LocationQuerySchema.parse({ near: "41.6,-90.34", radius: "25" })).toEqual({ near: "41.6,-90.34", radius: 25 });
    expect(LocationQuerySchema.safeParse({ near: "Le Claire" }).success).toBe(false);
    expect(LocationQuerySchema.safeParse({ zip: "5275" }).success).toBe(false);
  });
});

describe("open now, in the shop's time zone", () => {
  const at = (iso: string, closures: { date: string; reason: string | null }[] = [], closedThrough?: string | "indefinite" | null) => openStatus({ hours: MON_SAT, closures, now: new Date(iso), timezone: CHI, closedThrough });

  it("is open during hours and says until when", () => {
    const s = at("2026-10-23T15:00:00Z");
    expect(s).toMatchObject({ openNow: true, closesAt: "2026-10-24T00:00:00.000Z", label: "Open now · until 7 PM", today: [{ open: "09:00", close: "19:00" }] });
  });

  it("after closing says when it next opens; Sunday is skipped", () => {
    expect(at("2026-10-24T01:00:00Z")).toMatchObject({ openNow: false, nextOpenAt: "2026-10-24T14:00:00.000Z", label: "Closed · opens tomorrow 9 AM" });
    expect(at("2026-10-25T01:00:00Z")).toMatchObject({ openNow: false, nextOpenAt: "2026-10-26T14:00:00.000Z", label: "Closed · opens Mon 9 AM" });
    expect(at("2026-10-23T12:00:00Z").label).toBe("Closed · opens 9 AM");
  });

  it("follows the clocks across the end of daylight saving", () => {
    expect(at("2026-11-01T01:00:00Z").nextOpenAt).toBe("2026-11-02T15:00:00.000Z");
  });

  it("a holiday closure or a temporary closing keeps it closed", () => {
    expect(at("2026-10-23T15:00:00Z", [{ date: "2026-10-23", reason: "Staff training" }])).toMatchObject({ openNow: false, today: [], label: "Closed today: Staff training · opens tomorrow 9 AM" });
    expect(at("2026-10-23T15:00:00Z", [], "indefinite")).toMatchObject({ openNow: false, nextOpenAt: null, label: "Temporarily closed" });
    expect(at("2026-10-23T15:00:00Z", [], "2026-10-26").nextOpenAt).toBe("2026-10-27T14:00:00.000Z");
  });

  it("lists the week Monday first, with Sunday closed", () => {
    const w = weeklyHours(MON_SAT);
    expect(w.map((d) => d.day)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(w[0].label).toBe("9 AM – 7 PM");
    expect(w[6]).toMatchObject({ label: "Closed", ranges: [] });
  });
});

describe("deep links, the widget and JSON-LD", () => {
  const BASE = "https://rayz.example";

  it("has one link format for the web, the app and the embed", () => {
    expect(deepLinks(BASE, "le-claire", { service: "fade", barber: "marcus", coupon: null })).toEqual({
      booking: "https://rayz.example/book/le-claire?service=fade&barber=marcus",
      app: "rayz://book/le-claire?service=fade&barber=marcus",
      embed: "https://rayz.example/embed/book/le-claire?service=fade&barber=marcus",
      location: "https://rayz.example/locations/le-claire",
    });
    expect(deepLinks(BASE, "le-claire").booking).toBe("https://rayz.example/book/le-claire");
  });

  it("the snippet is a frame or a button plus the script", () => {
    expect(widgetSnippet(BASE, "le-claire")).toBe('<div data-rayz-booking data-location="le-claire"></div>\n<script src="https://rayz.example/widget.js" async></script>');
    expect(widgetSnippet(BASE, null, "button")).toMatch(/^<button type="button" data-rayz-book>Book now<\/button>/);
  });

  const shop = {
    ...LE_CLAIRE,
    slug: "le-claire",
    name: "Le Claire",
    description: "</script><script>alert(1)</script>",
    phone: "5635550100",
    email: "leclaire@rayz.example",
    latitude: 41.5967,
    longitude: -90.3435,
    googlePlaceId: null,
    hours: MON_SAT,
    closures: [{ date: "2026-11-26", reason: "Thanksgiving" }],
    social: { instagram: "https://www.instagram.com/rayz" },
    amenities: ["wifi"],
    photos: [`${BASE}/locations/le-claire/photos/1`],
    logo: null,
    bookingEnabled: true,
  };

  it("describes the shop as a HairSalon with its address, pin, hours, closures and booking", () => {
    const j = localBusinessJsonLd(BASE, shop);
    expect(j).toMatchObject({
      "@context": "https://schema.org",
      "@type": "HairSalon",
      name: "Ray'z Le Claire",
      url: `${BASE}/locations/le-claire`,
      telephone: "+15635550100",
      address: { "@type": "PostalAddress", streetAddress: "123 Cody Rd, Suite 2", addressLocality: "Le Claire", addressRegion: "IA", postalCode: "52753", addressCountry: "US" },
      geo: { "@type": "GeoCoordinates", latitude: 41.5967, longitude: -90.3435 },
      sameAs: ["https://www.instagram.com/rayz"],
      amenityFeature: [{ name: "Free Wi-Fi", value: true }],
      potentialAction: { "@type": "ReserveAction", target: { urlTemplate: `${BASE}/book/le-claire` } },
    });
    expect(j.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d) => `https://schema.org/${d}`), opens: "09:00", closes: "19:00" },
    ]);
    expect(j.specialOpeningHoursSpecification).toEqual([{ "@type": "OpeningHoursSpecification", validFrom: "2026-11-26", validThrough: "2026-11-26", opens: "00:00", closes: "00:00" }]);
    expect(localBusinessJsonLd(BASE, { ...shop, bookingEnabled: false, latitude: null, longitude: null })).not.toHaveProperty("potentialAction");
  });

  it("can't close its script tag, whatever the shop's text says", () => {
    const out = jsonLdScript(localBusinessJsonLd(BASE, shop));
    expect(out).not.toMatch(/<|>/);
    expect(JSON.parse(out).description).toBe(shop.description);
    expect(jsonLdScript({ a: "\u2028&" })).toBe('{"a":"\\u2028\\u0026"}');
  });

  it("the OpenAPI fragment covers the list and the detail", () => {
    expect(Object.keys(LOCATIONS_OPENAPI.paths)).toEqual(["/locations", "/locations/{slug}"]);
    expect(Object.keys(LOCATIONS_OPENAPI.components)).toEqual(["Location", "LocationList"]);
  });
});

describe("calendar invites", () => {
  it("escapes text and folds long lines at 75 octets without splitting characters", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const long = `LOCATION:${"é".repeat(60)}`;
    const folded = foldLine(long);
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(foldLine("short")).toBe("short");
  });

  it("puts the address in LOCATION, the pin in GEO and an alarm on upcoming visits", () => {
    const ics = icsCalendar(
      [
        {
          uid: "abc@rayz",
          start: new Date("2026-10-30T19:30:00Z"),
          end: new Date("2026-10-30T20:00:00Z"),
          summary: "Haircut at Ray'z Le Claire",
          location: "Ray'z Le Claire, 123 Cody Rd, Suite 2, Le Claire, IA 52753",
          geo: { lat: 41.5967, lng: -90.3435 },
          description: locationDescription({ phone: "(563) 555-0100", directions: "Park behind", manageUrl: "https://rayz.example/a/X", mapUrl: "https://maps.example" }),
          url: "https://rayz.example/a/X",
          sequence: 3,
          now: new Date("2026-10-24T12:00:00Z"),
        },
      ],
      { name: "Ray'z" },
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("LOCATION:Ray'z Le Claire\\, 123 Cody Rd\\, Suite 2\\, Le Claire\\, IA 52753");
    expect(unfolded).toContain("GEO:41.596700;-90.343500");
    expect(unfolded).toContain("DTSTART:20261030T193000Z");
    expect(unfolded).toContain("SEQUENCE:3");
    expect(unfolded).toContain("DESCRIPTION:Shop phone: (563) 555-0100\\nParking and directions: Park behind\\nMap: https://maps.example\\nView\\, change or cancel: https://rayz.example/a/X");
    expect(unfolded).toContain("TRIGGER:-PT1H");
    const past = icsCalendar([{ uid: "p", start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-01T01:00:00Z"), summary: "x", status: "CANCELLED", now: new Date("2026-10-24T00:00:00Z") }]);
    expect(past).toContain("STATUS:CANCELLED");
    expect(past).not.toContain("VALARM");
  });
});

describe("messages carry the address", () => {
  it("offers the full address, map link and calendar link as merge fields", () => {
    for (const f of ["full_address", "map_link", "calendar_link"]) expect(MERGE_FIELDS).toHaveProperty(f);
    expect(templateProblem("confirmation", { body: "{shop}: booked at {full_address}. Map: {map_link} Add to calendar: {calendar_link} Change: {link}" })).toBeNull();
  });

  it("every appointment default says where, passes its own rules and fits two texts", () => {
    for (const k of ["confirmation", "reschedule", "reminder_24h", "reminder_2h"] as const) expect(TEMPLATE_DEFS[k].body, k).toContain("{address}");
    expect(TEMPLATE_DEFS.reminder_2h.body).toContain("{map_link}");
    for (const k of TEMPLATE_KINDS) {
      const d = TEMPLATE_DEFS[k];
      expect(templateProblem(k, { subject: d.subject, body: d.body }), k).toBeNull();
      expect(fill(d.body, SAMPLE).length, k).toBeLessThanOrEqual(SMS_MAX);
    }
  });
});

describe("the widget and embed wiring", () => {
  const widget = readFileSync("src/app/widget.js/route.ts", "utf8");

  it("the widget checks where messages come from and never passes the client's details", () => {
    expect(widget).toMatch(/e\.origin !== BASE/);
    expect(widget).toMatch(/rayz:booked/);
    expect(widget).toMatch(/data-rayz-booking/);
    expect(widget).toMatch(/data-rayz-book\b/);
    const frame = readFileSync("src/app/embed/frame.tsx", "utf8");
    expect(frame).not.toMatch(/code|phone|email|firstName/i);
  });

  it("only /embed may be framed by other sites", async () => {
    const cfg = readFileSync("next.config.ts", "utf8");
    expect(cfg).toMatch(/source: "\/embed\/:path\*", headers: \[\{ key: "Content-Security-Policy", value: "frame-ancestors \*" \}\]/);
  });
});
