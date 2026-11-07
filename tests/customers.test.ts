import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MatchCandidate, firstNamesCompatible, lastNamesCompatible, pickMatch, samePerson } from "@/domain/customers";
import { errorsCsv } from "@/lib/import-errors";
import { splitRunStats, statLines } from "@/lib/import-stats";
import { mapHeaders, mapStatus, parseSquireDateTime } from "@/server/importer";
import { makeSquireFixture } from "../scripts/squire-fixture";

describe("who is the same person", () => {
  it("accepts nicknames and name prefixes, not different names", () => {
    expect(firstNamesCompatible("Mike", "Michael")).toBe(true);
    expect(firstNamesCompatible("Bill", "william")).toBe(true);
    expect(firstNamesCompatible("Alex", "Alexandra")).toBe(true);
    expect(firstNamesCompatible("Chris", "Christopher")).toBe(true);
    expect(firstNamesCompatible("Jo", "Joanna")).toBe(false);
    expect(firstNamesCompatible("Mike", "Mia")).toBe(false);
    expect(firstNamesCompatible("Kevin", "Tyler")).toBe(false);
    expect(firstNamesCompatible("José", "jose")).toBe(true);
    expect(firstNamesCompatible("", "Sam")).toBe(false);
  });

  it("last names only have to not contradict", () => {
    expect(lastNamesCompatible("Smith", null)).toBe(true);
    expect(lastNamesCompatible("Smith", "S")).toBe(true);
    expect(lastNamesCompatible("Garcia-Lopez", "Lopez")).toBe(true);
    expect(lastNamesCompatible("Smith", "Jones")).toBe(false);
    expect(samePerson({ firstName: "Mike", lastName: "Hansen" }, { firstName: "Michael", lastName: "Hansen" })).toBe(true);
    expect(samePerson({ firstName: "Mike", lastName: "Hansen" }, { firstName: "Michael", lastName: "Jones" })).toBe(false);
  });

  const c = (id: string, firstName: string, lastName: string | null, phone: string | null, email: string | null, day: number): MatchCandidate => ({
    id,
    firstName,
    lastName,
    phone,
    email,
    createdAt: new Date(2026, 0, day),
  });

  it("a shared family phone picks the person by first name, and never guesses without one", () => {
    const family = [c("dad", "Kevin", "Brandt", "+13195550001", "kevin@x.test", 1), c("kid", "Tyler", "Brandt", "+13195550001", null, 2)];
    expect(pickMatch({ firstName: "Tyler", phone: "+13195550001" }, family)).toEqual({ id: "kid", via: "phone" });
    expect(pickMatch({ firstName: "Kev", phone: "+13195550001" }, family)).toEqual({ id: "dad", via: "phone" });
    expect(pickMatch({ firstName: "Mason", phone: "+13195550001" }, family)).toBeNull();
    expect(pickMatch({ firstName: null, phone: "+13195550001" }, family)).toBeNull();
    expect(pickMatch({ firstName: null, email: "kevin@x.test" }, family)).toEqual({ id: "dad", via: "contact" });
  });

  it("email beats phone, and ties go to the exact first name, then the last name, then the oldest record", () => {
    const list = [c("a", "Michael", "Hansen", "+13195550002", null, 3), c("b", "Mike", "Hansen", "+13195550002", null, 1), c("e", "Mike", "Hansen", null, "mike@x.test", 5)];
    expect(pickMatch({ firstName: "Mike", lastName: "Hansen", phone: "+13195550002", email: "mike@x.test" }, list)).toEqual({ id: "e", via: "email" });
    expect(pickMatch({ firstName: "Mike", phone: "+13195550002" }, list)).toEqual({ id: "b", via: "phone" });
    expect(pickMatch({ firstName: "Michael", phone: "+13195550002" }, list)).toEqual({ id: "a", via: "phone" });
  });
});

describe("Squire export parsing", () => {
  it("maps a bare ID column by file type and keeps 'Services' a list in appointments, an amount in tickets", () => {
    expect(mapHeaders(["ID", "Name"], "clients").squireId).toBe("ID");
    expect(mapHeaders(["ID", "Date"], "transactions").transactionId).toBe("ID");
    expect(mapHeaders(["ID", "Date"], "appointments").appointmentId).toBe("ID");
    const appt = mapHeaders(["Services", "Price"], "appointments");
    expect(appt.service).toBe("Services");
    expect(appt.serviceTotal).toBeUndefined();
    const tx = mapHeaders(["Services", "Products", "Total"], "transactions");
    expect(tx.serviceTotal).toBe("Services");
    expect(tx.productTotal).toBe("Products");
    expect(tx.service).toBeUndefined();
  });

  it("reads booked-at stamps with a time and treats a future 'completed' as still booked", () => {
    expect(parseSquireDateTime(undefined, undefined, "4/4/2025 9:00 AM")?.toISOString()).toBe("2025-04-04T14:00:00.000Z");
    expect(mapStatus("Checked Out", true)).toBe("booked");
    expect(mapStatus("No Show", false)).toBe("no_show");
    expect(mapStatus("Cancelled by client", false)).toBe("cancelled");
  });

  it("the error file puts the reason first and keeps the original columns, quoted safely", () => {
    const out = errorsCsv([
      { row: 3, reason: "Unknown shop", message: 'Unknown shop "Clinton"', data: { "Client ID": "SQ-1", Notes: "a, b" } },
      { row: 9, reason: "Bad date", message: "Couldn't read the date/time", data: { "Client ID": "SQ-2", Date: "TBD" } },
    ]);
    expect(out.split("\n")[0]).toBe("Import row,Skip reason,Details,Client ID,Notes,Date");
    expect(out).toContain('3,Unknown shop,"Unknown shop ""Clinton""",SQ-1,"a, b",');
    expect(out).toContain("9,Bad date,Couldn't read the date/time,SQ-2,,TBD");
  });

  it("saved run stats split into counters and skip reasons", () => {
    const { stats, skipped } = splitRunStats({ clientsCreated: 4, duplicatesMerged: 1, "skipped:Missing name": 2 });
    expect(skipped).toEqual({ "Missing name": 2 });
    expect(statLines("clients", stats)).toEqual(
      expect.arrayContaining([
        ["Clients created", "4"],
        ["Duplicates merged into one client", "1"],
      ]),
    );
  });
});

describe("realistic Squire sample", () => {
  it("the committed sample in samples/squire/realistic matches the generator", () => {
    const fx = makeSquireFixture({ exportDate: "2026-10-13" });
    for (const [kind, text] of Object.entries(fx.files)) expect(readFileSync(`samples/squire/realistic/${kind}.csv`, "utf8"), kind).toBe(text);
    expect(JSON.parse(readFileSync("samples/squire/realistic/expected.json", "utf8"))).toEqual({ exportDate: "2026-10-13", ...fx.expected });
  });

  it("is a few hundred messy clients with the cases the importer has to get right", () => {
    const fx = makeSquireFixture();
    expect(fx.expected.clients.rows).toBeGreaterThan(150);
    expect(fx.expected.appointments.rows).toBeGreaterThan(400);
    const clients = fx.files.clients;
    expect(clients).toMatch(/\(\d{3}\) 555-\d{4}/);
    expect(clients).toMatch(/\d{3}\.555\.\d{4}/);
    expect(clients).toMatch(/\+1 \d{3} 555 \d{4}/);
    expect(fx.people.filter((p) => p.records.length === 2)).toHaveLength(12);
    expect(fx.people.filter((p) => !p.email).length).toBeGreaterThan(50);
    expect(new Set(fx.people.filter((p) => p.kind === "family").map((p) => p.phone)).size).toBe(6);
  });
});
