import { describe, expect, it } from "vitest";
import { acaMonths, acaRows, fteByMonth, measurementMonths, monthLastDay, serviceCenti } from "@/domain/payroll/aca";

const day = (staffId: string, date: string, worked: number, o: { training?: number; overlap?: number; pto?: number } = {}) => ({
  staffId,
  shopId: "s",
  date,
  worked: worked * 100,
  training: (o.training ?? 0) * 100,
  trainingOverlap: (o.overlap ?? 0) * 100,
  pto: (o.pto ?? 0) * 100,
});

describe("ACA measurement period", () => {
  it("ends with the last full month on or before the end date", () => {
    expect(measurementMonths("2028-03-31", 3)).toEqual(["2028-01", "2028-02", "2028-03"]);
    expect(measurementMonths("2028-03-30", 3)).toEqual(["2027-12", "2028-01", "2028-02"]);
    expect(measurementMonths("2028-01-15", 2)).toEqual(["2027-11", "2027-12"]);
    expect(measurementMonths("2028-02-29", 1)).toEqual(["2028-02"]);
    expect(measurementMonths("2027-12-31", 12)).toHaveLength(12);
    expect(measurementMonths("2027-12-31", 12)[0]).toBe("2027-01");
  });

  it("takes 3, 6 or 12 months, 12 otherwise", () => {
    expect([acaMonths("3"), acaMonths("6"), acaMonths("12"), acaMonths("7"), acaMonths(undefined)]).toEqual([3, 6, 12, 12, 12]);
    expect([monthLastDay("2028-02"), monthLastDay("2027-02"), monthLastDay("2027-04")]).toEqual(["2028-02-29", "2027-02-28", "2027-04-30"]);
  });
});

describe("ACA hours of service", () => {
  it("counts worked, PTO and training outside clocked time, once", () => {
    expect(serviceCenti(day("a", "2028-01-03", 7, { training: 2, overlap: 2, pto: 1 }))).toBe(800);
    expect(serviceCenti(day("a", "2028-01-03", 7, { training: 2, overlap: 0.5 }))).toBe(850);
  });

  it("is full time at an average of 130 a month or more, 130 included", () => {
    const months = ["2028-01", "2028-02"];
    const rows = acaRows([day("a", "2028-01-10", 130), day("a", "2028-02-10", 130), day("b", "2028-01-10", 160), day("b", "2028-02-10", 100)], ["a", "b", "c"], months);
    expect(rows.map((r) => [r.staffId, r.average, r.status, r.monthsAt130])).toEqual([
      ["a", 130, "full_time", 2],
      ["b", 130, "full_time", 1],
      ["c", 0, "part_time", 0],
    ]);
    const [under] = acaRows([day("b", "2028-01-10", 160), day("b", "2028-02-10", 99.99)], ["b"], months);
    expect([under.average, under.status]).toEqual([129.99, "part_time"]);
  });

  it("measures someone hired during the period from their hire month", () => {
    const months = ["2028-01", "2028-02", "2028-03"];
    const [r] = acaRows([day("n", "2028-02-10", 140), day("n", "2028-03-10", 130)], ["n"], months, new Map([["n", "2028-02"]]));
    expect(r.monthly).toEqual([null, 140, 130]);
    expect([r.counted, r.average, r.status]).toEqual([2, 135, "full_time"]);
  });

  it("counts full-time equivalents with part-time hours capped at 120 each", () => {
    const months = ["2028-01"];
    const rows = acaRows([day("a", "2028-01-10", 140), day("b", "2028-01-10", 125), day("c", "2028-01-10", 60), day("d", "2028-01-10", 30)], ["a", "b", "c", "d", "e"], months);
    expect(fteByMonth(rows, months)).toEqual([{ month: "2028-01", fullTime: 1, fte: 1.75, total: 2.75 }]);
  });
});
