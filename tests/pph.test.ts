import { describe, expect, it } from "vitest";
import { moneyAxisTop, numberAxisTop } from "@/components/trend-chart";
import { DEFAULT_PAYROLL_SETTINGS, EXPORT_COLUMNS, assemble, computeLine, exportHeaders, type LineInput } from "@/domain/payroll/calc";
import {
  CLIENTS_LABEL,
  NA,
  PPH_RANKS,
  RANK_LABEL,
  addUp,
  clientKey,
  clientsText,
  linePph,
  linesPph,
  parsePphRank,
  parsePphOrder,
  parsePphTrend,
  pph,
  pphCents,
  pphOf,
  pphSort,
  pphText,
  rankPph,
  trendBuckets,
  workedHoursOf,
} from "@/domain/pph";
import { withoutMoney } from "@/domain/report-money";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

describe("PPH", () => {
  it("is sales before tax and tips over worked hours, for services, products and both", () => {
    expect(pph({ service: 842, product: 100, clients: 25, hours: 10 })).toEqual({ service: 842, product: 100, clients: 25, hours: 10, servicePph: 84.2, productPph: 10, totalPph: 94.2, clientsPerHour: 2.5 });
    expect(pphCents(84_200, 10_000, 1_000)).toMatchObject({ servicePph: 8_420, productPph: 1_000, totalPph: 9_420, hours: 10, clients: 0, clientsPerHour: 0 });
    expect(pphCents(1, 0, 3).servicePph).toBe(33);
  });

  it("puts clients per hour, completed service tickets over the same hours, alongside, to the hundredth", () => {
    expect(pphCents(84_200, 0, 1_000, 23).clientsPerHour).toBe(2.3);
    expect(pphCents(0, 0, 300, 7).clientsPerHour).toBe(2.33);
    expect(pphCents(0, 0, 0, 7).clientsPerHour).toBeNull();
    expect(clientsText(2.3)).toBe("2.30");
    expect(clientsText(null)).toBe(NA);
  });

  it("is N/A without worked hours, never $0 or infinite", () => {
    expect(pph({ service: 500, product: 20, clients: 4, hours: 0 })).toMatchObject({ servicePph: null, productPph: null, totalPph: null, clientsPerHour: null });
    expect(pphCents(0, 0, 0).totalPph).toBeNull();
    expect(pphText(null, money)).toBe(NA);
    expect(pphText(8_420, money)).toBe("$84.20");
    expect(pph({ service: 0, product: 0, clients: 0, hours: 8 })).toMatchObject({ servicePph: 0, clientsPerHour: 0 });
  });

  it("adds sales and hours up for a shop or the brand instead of averaging PPHs", () => {
    const shop = pph(addUp([
      { service: 100, product: 0, clients: 2, hours: 1 },
      { service: 900, product: 60, clients: 6, hours: 3 },
      { service: 400, product: 0, clients: 2, hours: 0 },
    ]));
    expect(shop).toMatchObject({ service: 1_400, product: 60, clients: 10, hours: 4, servicePph: 350, productPph: 15, totalPph: 365, clientsPerHour: 2.5 });
    expect(pph(addUp([])).servicePph).toBeNull();
  });

  it("picks a measure, service PPH by default, and reads the order and measure from the address", () => {
    const p = pph({ service: 300, product: 30, clients: 6, hours: 3 });
    expect([pphOf(p, "service"), pphOf(p, "clients"), pphOf(p, "product"), pphOf(p, "total")]).toEqual([100, 2, 10, 110]);
    expect([parsePphRank("clients"), parsePphRank("product"), parsePphRank("total"), parsePphRank("nope"), parsePphRank(undefined)]).toEqual(["clients", "product", "total", "service", "service"]);
    expect(PPH_RANKS[0]).toBe("service");
    expect(PPH_RANKS.map((k) => RANK_LABEL[k])).toEqual(["Service PPH", CLIENTS_LABEL, "Product PPH", "Total PPH"]);
    expect([parsePphOrder("low"), parsePphOrder("high"), parsePphOrder(1)]).toEqual(["low", "high", "high"]);
  });
});

describe("PPH on the Payroll Report", () => {
  it("counts regular and overtime hours, not overtime that came from training", () => {
    expect(workedHoursOf({ hours: 40, otHours: 5, otFromTraining: 2 })).toBe(43);
    expect(workedHoursOf({ hours: 12.5, otHours: 0 })).toBe(12.5);
    const a = { staffId: "a", shopId: "s", service: 860, product: 43, hours: 40, otHours: 3 };
    const b = { staffId: "b", shopId: "s", service: 50, product: 0, hours: 0, otHours: 0 };
    const tickets = new Map([[clientKey("a", "s"), 86], [clientKey("b", "s"), 2], [clientKey("a", "elsewhere"), 99]]);
    expect(linePph(a)).toMatchObject({ servicePph: 20, productPph: 1, totalPph: 21, clients: 0, clientsPerHour: 0 });
    expect(linePph(a, tickets)).toMatchObject({ clients: 86, clientsPerHour: 2 });
    expect(linePph(b, tickets)).toMatchObject({ servicePph: null, clientsPerHour: null });
    expect(linesPph([a, b]).servicePph).toBeCloseTo(910 / 43, 10);
    expect(linesPph([a, b], tickets)).toMatchObject({ clients: 88, hours: 43 });
  });

  const input = (o: Partial<LineInput> = {}): LineInput => ({
    staffId: "x",
    name: "X",
    shopId: "s",
    employeeNumber: "12",
    keyIsText: false,
    isolvedName: "X",
    hourlyRate: 10,
    servicePct: 0.4,
    productPct: 0.1,
    trainingRate: null,
    workedHours: 40,
    otHours: 2,
    ptoHours: 4,
    trainingHours: 0,
    serviceSales: 840,
    productSales: 84,
    tips: 30,
    ...o,
  });

  it("uses a computed line's Service$ and Product$ over all its worked hours (overtime included), leaving PTO out", () => {
    const l = computeLine(input(), DEFAULT_PAYROLL_SETTINGS);
    expect([l.hours, l.otHours, workedHoursOf(l)]).toEqual([38, 2, 40]);
    expect(linePph(l)).toMatchObject({ servicePph: 21, productPph: 2.1, totalPph: 23.1 });
    const trained = computeLine(input({ workedHours: 40, otHours: 3, trainingHours: 5 }), DEFAULT_PAYROLL_SETTINGS);
    expect(workedHoursOf(trained)).toBe(40);
  });

  it("never puts PPH in the iSolved export", () => {
    const r = assemble([{ shopId: "s", shop: "S", inputs: [input(), input({ staffId: "y", name: "Y", workedHours: 0, otHours: 0 })] }], DEFAULT_PAYROLL_SETTINGS, { guaranteeHeader: "G" });
    const b = r.blocks[0];
    expect(b.exportHeaders).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    expect(exportHeaders(b.lines, DEFAULT_PAYROLL_SETTINGS).join("|")).not.toMatch(/pph|per hour|\/hr/i);
    for (const row of b.exportRows ?? []) expect(row.values).toHaveLength(b.exportHeaders!.length);
  });
});

describe("PPH ranking", () => {
  const people = [
    { n: "Ava", v: 100 },
    { n: "Ben", v: null },
    { n: "Cal", v: 120 },
    { n: "Dee", v: 100.004 },
    { n: "Eli", v: 90 },
    { n: "Al", v: null },
  ];
  const ranks = (order?: "high" | "low") => rankPph(people, (p) => p.v, (p) => p.n, order).map((r) => [r.item.n, r.rank]);

  it("ranks highest first, ties sharing a rank and the next one skipping, N/A last and unranked", () => {
    expect(ranks()).toEqual([["Cal", 1], ["Ava", 2], ["Dee", 2], ["Eli", 4], ["Al", null], ["Ben", null]]);
  });

  it("ranks lowest first when asked, still with N/A last", () => {
    expect(ranks("low")).toEqual([["Eli", 1], ["Ava", 2], ["Dee", 2], ["Cal", 4], ["Al", null], ["Ben", null]]);
  });

  it("keeps the value with each row", () => {
    expect(rankPph(people, (p) => p.v, (p) => p.n)[0]).toEqual({ item: people[2], rank: 1, value: 120 });
    expect(rankPph([], () => 1, () => "")).toEqual([]);
  });
});

describe("PPH trend", () => {
  it("picks daily up to a month, weekly up to half a year, monthly beyond", () => {
    expect(parsePphTrend(undefined, "2026-10-01", "2026-10-31")).toEqual({ grain: "day", coarsened: false });
    expect(parsePphTrend(undefined, "2026-10-01", "2026-11-01")).toEqual({ grain: "week", coarsened: false });
    expect(parsePphTrend("bogus", "2026-01-01", "2026-07-01")).toEqual({ grain: "week", coarsened: false });
    expect(parsePphTrend(undefined, "2026-01-01", "2026-07-02")).toEqual({ grain: "month", coarsened: false });
  });

  it("takes the grain asked for, moving up one when it's too fine for the range", () => {
    expect(parsePphTrend("day", "2026-01-01", "2026-03-03")).toEqual({ grain: "day", coarsened: false });
    expect(parsePphTrend("day", "2026-01-01", "2026-03-04")).toEqual({ grain: "week", coarsened: true });
    expect(parsePphTrend("week", "2024-01-01", "2026-12-31")).toEqual({ grain: "month", coarsened: true });
    expect(parsePphTrend("month", "2026-10-01", "2026-10-07")).toEqual({ grain: "month", coarsened: false });
    expect(parsePphTrend("period", "2024-01-01", "2026-12-31")).toEqual({ grain: "period", coarsened: false });
  });

  it("cuts days, Sunday weeks and months to the range", () => {
    const days = trendBuckets("2026-10-01", "2026-10-14", "day");
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ start: "2026-10-01", end: "2026-10-01", label: "Thu Oct 1" });
    expect(trendBuckets("2026-10-01", "2026-10-14", "week")).toEqual([
      { start: "2026-10-01", end: "2026-10-03", label: "Week of Sep 27" },
      { start: "2026-10-04", end: "2026-10-10", label: "Week of Oct 4" },
      { start: "2026-10-11", end: "2026-10-14", label: "Week of Oct 11" },
    ]);
    expect(trendBuckets("2026-11-15", "2027-01-02", "month")).toEqual([
      { start: "2026-11-15", end: "2026-11-30", label: "Nov 2026" },
      { start: "2026-12-01", end: "2026-12-31", label: "Dec 2026" },
      { start: "2027-01-01", end: "2027-01-02", label: "Jan 2027" },
    ]);
  });

  it("follows the pay periods given, in order, cut to the range", () => {
    const periods = [
      { start: "2026-10-12", end: "2026-10-25" },
      { start: "2026-09-28", end: "2026-10-11" },
      { start: "2026-09-14", end: "2026-09-27" },
    ];
    expect(trendBuckets("2026-10-01", "2026-10-14", "period", periods)).toEqual([
      { start: "2026-10-01", end: "2026-10-11", label: "Sep 28 – Oct 11" },
      { start: "2026-10-12", end: "2026-10-14", label: "Oct 12 – 25" },
    ]);
  });
});

describe("PPH sorting", () => {
  it("re-ranks by a PPH or clients per hour heading, highest first, and flips the order on the one ranked by", () => {
    const s = pphSort(2, "service", "high");
    expect(s.sorted).toEqual({ column: 6, dir: "desc" });
    expect(s.sortBy).toEqual([null, null, null, null, null, null, { rank: "service", order: "low" }, { rank: "clients", order: "high" }, { rank: "product", order: "high" }, { rank: "total", order: "high" }]);
    expect(pphSort(3, "total", "low")).toMatchObject({ sorted: { column: 10, dir: "asc" }, sortBy: expect.arrayContaining([{ rank: "total", order: "high" }]) });
    expect(pphSort(3, "clients", "high")).toMatchObject({ sorted: { column: 8, dir: "desc" } });
    expect(pphSort(3, "clients", "high").sortBy[8]).toEqual({ rank: "clients", order: "low" });
  });
});

describe("PPH chart and money visibility", () => {
  it("scales a dollar chart to a round top", () => {
    expect([moneyAxisTop(0), moneyAxisTop(8_420), moneyAxisTop(12_000), moneyAxisTop(2_400), moneyAxisTop(5_000)]).toEqual([100, 10_000, 20_000, 2_500, 5_000]);
  });

  it("scales a clients per hour chart to a round top", () => {
    expect([numberAxisTop(0), numberAxisTop(2.35), numberAxisTop(1), numberAxisTop(0.8)]).toEqual([1, 2.5, 1, 1]);
  });

  it("drops dollar charts and PPH figures for someone who can't see dollar amounts, keeping hours, clients per hour and N/A", () => {
    const d = withoutMoney({
      stats: [{ label: "Service PPH", value: "$84.20" }],
      tables: [
        {
          id: "barbers",
          title: "Barber leaderboard: Service PPH",
          columns: [{ label: "Barber" }, { label: "Worked hours", kind: "pay_hours" }, { label: "Service PPH", kind: "money", sum: false }, { label: CLIENTS_LABEL, kind: "decimal", sum: false }],
          rows: [
            ["Ava", 40, 8_420, 2.3],
            ["Ben", 0, NA, NA],
          ],
        },
      ],
      charts: [{ kind: "money" }, { kind: "pct" }, { kind: "number" }, {}],
    });
    expect(d.charts).toEqual([{ kind: "pct" }, { kind: "number" }, {}]);
    expect(d.stats[0].value).toBe("$—");
    expect(d.tables[0].rows).toEqual([
      ["Ava", 40, null, 2.3],
      ["Ben", 0, null, NA],
    ]);
  });
});
