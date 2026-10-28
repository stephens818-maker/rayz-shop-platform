/**
 * Squire's Commissions report as the payroll input for a shop whose payroll still comes from Squire
 * during the rollout: hours worked, service and product sales (each block's Total), tips and sales
 * tax per person, matched to the people here. Any problem stops the whole import.
 */
import { describe, expect, it } from "vitest";
import { parseSquireCommissions, squireCentiHours, squireCents, type SquireStaff } from "@/domain/payroll/squire-commissions";

const staff: SquireStaff[] = [
  { id: "a", label: "Alex", first: "Alex", last: "Barber", squireName: "Alexander B", atShop: true },
  { id: "b", label: "Blake", first: "Blake", last: "Cutter", squireName: null, atShop: true },
  { id: "c", label: "Casey", first: "Casey", last: "Fade", squireName: null, atShop: false },
  { id: "d", label: "Drew S", first: "Drew", last: "Shears", squireName: null, atShop: true },
  { id: "e", label: "Drew T", first: "Drew", last: "Trim", squireName: null, atShop: true },
];

const HEAD = "Name,Hours Worked,Personnel ID,Card,Cash,GC Used,GC Bought,Card Fees (on Total),Commission Splits Fee,Total,Commission %,Due to Barbers,Squire Tips,POS Tips,Gift Card Tips,Tips,Total to Barber,Tax,Due to Shop";
const row = (name: string, hours: string, total: string, tips: string, tax: string) => `${name},${hours},,0,0,0,0,0,0,"${total}",0%,0,0,0,0,"${tips}",0,"${tax}",0`;

const report = [
  "Commissions report",
  HEAD,
  row("Alexander B", "69.53", "$3,665.23", "$955.00", "$109.96"),
  row("Blake Cutter", "41.25", "1,200.00", "120.50", "36.00"),
  row("Morgan Gone", "0", "0", "0", "0"),
  row("Casey", "0", "0", "0", "0"),
  "Totals,110.78,,,,,,,,4865.23,,,,,,1075.50,,145.96,",
  "",
  "Products",
  HEAD,
  row("Alexander B", "69.53", "70.98", "0", "7.10"),
  row("Unassigned sales", "0", "45.00", "0", "4.50"),
].join("\n");

describe("Squire Commissions report import", () => {
  it("reads dollars and hours the way Squire prints them", () => {
    expect(squireCents("$1,234.56")).toBe(123456);
    expect(squireCents("(12.00)")).toBe(-1200);
    expect(squireCents("-")).toBe(0);
    expect(squireCents("")).toBe(0);
    expect(squireCents("abc")).toBeNull();
    expect(squireCentiHours("69.53")).toBe(6953);
    expect(squireCentiHours("69:30")).toBe(6950);
    expect(squireCentiHours("x")).toBeNull();
  });

  it("takes hours (OT included) from B, service and product $ from each block's Total, tips from the service block, and sales tax from both", () => {
    const r = parseSquireCommissions(report, { staff });
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { staffId: "a", squireName: "Alexander B", workedCenti: 6953, otCenti: 0, ptoCenti: 0, trainingCenti: 0, serviceCents: 366523, productCents: 7098, tipsCents: 95500, salesTaxCents: 11706 },
      { staffId: "b", squireName: "Blake Cutter", workedCenti: 4125, otCenti: 0, ptoCenti: 0, trainingCenti: 0, serviceCents: 120000, productCents: 0, tipsCents: 12050, salesTaxCents: 3600 },
    ]);
    expect(r.totals).toEqual({ workedCenti: 11078, serviceCents: 486523, productCents: 7098, tipsCents: 107550, salesTaxCents: 15306, unassignedServiceCents: 0, unassignedProductCents: 4500 });
    expect(r.notes).toEqual(["Morgan Gone: no figures on the service report, and no match here; left out."]);
  });

  it("matches Squire's name for the person first, then the name here, then a first name only one person at the shop has", () => {
    const r = parseSquireCommissions([HEAD, row("Alex Barber", "10", "100", "0", "0"), row("blake", "5", "50", "0", "0")].join("\n"), { staff });
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.staffId)).toEqual(["a", "b"]);
    const amb = parseSquireCommissions([HEAD, row("Drew", "10", "100", "0", "0")].join("\n"), { staff });
    expect(amb.errors).toEqual([expect.stringMatching(/Line 2: "Drew" matches more than one person by first name at this shop \(Drew S, Drew T\)/)]);
    expect(parseSquireCommissions([HEAD, row("Morgan Gone", "10", "100", "0", "0")].join("\n"), { staff }).errors).toEqual([expect.stringMatching(/no one here matches "Morgan Gone"/)]);
  });

  it("imports nothing when any line has a problem, and says which", () => {
    const r = parseSquireCommissions([HEAD, row("Alexander B", "ten", "100", "0", "0"), row("Nobody Here", "5", "50", "0", "0"), row("Blake Cutter", "5", "oops", "0", "0")].join("\n"), { staff });
    expect(r.errors).toEqual([
      'Line 2 (Alexander B): Hours Worked "ten" isn\'t a number of hours.',
      'Line 3: no one here matches "Nobody Here". Set their Squire name under Staff, then import again.',
      'Line 4 (Blake Cutter): Total "oops" isn\'t an amount.',
    ]);
    expect(parseSquireCommissions("", { staff }).errors).toEqual(["The file is empty."]);
    expect(parseSquireCommissions("a,b\n1,2", { staff }).errors[0]).toMatch(/No header row with Name and Total/);
    expect(parseSquireCommissions([HEAD, row("Alexander B", "1", "1", "0", "0"), row("Alex Barber", "1", "1", "0", "0")].join("\n"), { staff }).errors).toEqual([
      'Line 3: Alex is on the service report twice (as "Alexander B" and "Alex Barber").',
    ]);
  });

  it("reads OT, PTO and training hours from columns someone added, and refuses more OT than hours worked", () => {
    const head = "Name,Hours Worked,Total,Tips,Tax,OT Hours,PTO,Training Hours";
    const r = parseSquireCommissions([head, "Alexander B,84.00,2000,100,60,4.00,8,2.5"].join("\n"), { staff });
    expect(r.rows[0]).toMatchObject({ workedCenti: 8400, otCenti: 400, ptoCenti: 800, trainingCenti: 250 });
    expect(parseSquireCommissions([head, "Alexander B,3.00,2000,100,60,4.00,0,0"].join("\n"), { staff }).errors).toEqual([expect.stringMatching(/4.00 OT hours is more than their 3.00 hours worked/)]);
  });

  it("adds up Squire, POS and Gift Card Tips when there's no Tips column, and reads a copy-paste with tabs", () => {
    const head = ["Name", "Hours Worked", "Total", "Squire Tips", "POS Tips", "Gift Card Tips", "Tax"].join("\t");
    const r = parseSquireCommissions([head, ["Alexander B", "10", "$500.00", "$10.00", "$20.00", "$5.00", "$15.00"].join("\t")].join("\n"), { staff });
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ serviceCents: 50000, tipsCents: 3500, salesTaxCents: 1500 });
  });

  it("keeps only the shop's rows when the file has a Shop column", () => {
    const head = "Location,Name,Hours Worked,Total,Tips,Tax";
    const r = parseSquireCommissions([head, "Moline,Alexander B,10,500,0,0", "Silvis,Blake Cutter,10,500,0,0"].join("\n"), { staff, shop: { name: "Moline", slug: "moline" } });
    expect(r.rows.map((x) => x.staffId)).toEqual(["a"]);
    expect(r.notes).toEqual(["1 row for other shops left out."]);
  });

  it("notes product-report tips and hours that differ, rather than counting them twice", () => {
    const r = parseSquireCommissions([HEAD, row("Alexander B", "10", "100", "5", "0"), HEAD, row("Alexander B", "12", "20", "3", "0")].join("\n"), { staff });
    expect(r.rows[0]).toMatchObject({ workedCenti: 1000, serviceCents: 10000, productCents: 2000, tipsCents: 500 });
    expect(r.notes).toEqual([
      "Alexander B: $3.00 of tips on the product report aren't counted; tips come from the service report, as in the workbook.",
      "Alexander B: the product report has 12.00 hours, the service report 10.00; the service report's are used.",
    ]);
  });
});
