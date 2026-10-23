import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { csvCells, parseTimeCsv } from "@/domain/payroll/time-csv";

const staff = [
  { id: "s1", label: "Jamie", first: "Jamie", last: "Lee", number: "910100", isolvedName: "LEE, JAMIE" },
  { id: "s2", label: "Taylor R.", first: "Taylor", last: null, number: null, isolvedName: null },
];
const shops = [
  { id: "m", name: "Moline", slug: "moline" },
  { id: "lc", name: "Le Claire", slug: "le-claire" },
];
const local = (d: Date) => DateTime.fromJSDate(d, { zone: "America/Chicago" }).toFormat("yyyy-MM-dd HH:mm");

describe("shift CSV import", () => {
  it("matches people by employee number, iSolved name or app name, and shops by name or slug", () => {
    const r = parseTimeCsv(
      [
        "Employee,Shop,Date,Start,End,Kind,Note",
        "910100,Moline,2026-10-19,9:00,17:30,,",
        '"LEE, JAMIE",le-claire,10/20/2026,7:00 AM,8:45 AM,training,New-hire training',
        "Taylor R.,LeClaire,10/21/26,10:00 PM,2:00 AM,worked,",
        "Taylor R.,Moline,2026-10-22,9:00,17:00,pto,",
      ].join("\n"),
      { staff, shops },
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.staffId, x.shopId, x.kind, local(x.startsAt), local(x.endsAt), x.note])).toEqual([
      ["s1", "m", "worked", "2026-10-19 09:00", "2026-10-19 17:30", null],
      ["s1", "lc", "training", "2026-10-20 07:00", "2026-10-20 08:45", "New-hire training"],
      ["s2", "lc", "worked", "2026-10-21 22:00", "2026-10-22 02:00", null],
      ["s2", "m", "pto", "2026-10-22 09:00", "2026-10-22 17:00", null],
    ]);
  });

  it("reports every bad line and the missing columns", () => {
    expect(parseTimeCsv("name,date\nx,y", { staff, shops }).errors[0]).toMatch(/missing: shop, start, end/);
    const r = parseTimeCsv("employee,shop,date,start,end,kind\nnobody,Moline,2026-10-19,9:00,17:00,\n910100,Nowhere,2026-13-40,25:00,17:00,nap", { staff, shops });
    expect(r.errors).toEqual(['Line 2: no employee "nobody".', 'Line 3: no shop "Nowhere", bad date, bad time, unknown kind "nap".']);
  });

  it("splits quoted cells", () => {
    expect(csvCells('a,"b, c","d ""e"""')).toEqual(["a", "b, c", 'd "e"']);
  });
});
