import { describe, expect, it } from "vitest";
import { type CardRow, CARD_PERIODS, SPARK_DAYS, cardTotal, parseCardPeriod, perClientCard, perClientTotal, pphCard, sparkPoints } from "@/domain/pph-card";

const row = (staffId: string, shopId: string, centi: number, serviceCents: number, productCents = 0, clients = 0, served: string[] = []): CardRow => ({ staffId, shopId, centi, serviceCents, productCents, clients, served: new Set(served) });
const shops = [
  { id: "cv", name: "Coralville" },
  { id: "ml", name: "Moline" },
];
const names = new Map([
  ["a", "Avery"],
  ["b", "Blake"],
  ["c", "Casey"],
]);
const period = [row("a", "cv", 2400, 96_000, 5_000, 6), row("a", "ml", 400, 24_000, 0, 2), row("b", "cv", 400, 16_000, 0, 1), row("c", "cv", 0, 10_000, 0, 1)];
const today = [row("a", "cv", 800, 24_000, 0, 2), row("b", "cv", 400, 20_000, 0, 1)];
const input = (o: Partial<Parameters<typeof pphCard>[0]> = {}) => ({
  rows: { today, yesterday: [], period },
  days: [
    { date: "2029-08-13", rows: [] },
    { date: "2029-08-14", rows: today },
  ],
  shops,
  names,
  rankBy: "period" as const,
  money: true,
  ...o,
});

describe("the dashboard's PPH card", () => {
  it("totals each period as sales over hours added up, N/A with no hours", () => {
    const c = pphCard(input());
    expect(c.total.period).toMatchObject({ hours: 32, service: 146_000, servicePph: 4_563, clientsPerHour: 0.31, totalPph: 4_719 });
    expect(c.total.today).toMatchObject({ servicePph: 3_667, clientsPerHour: 0.25 });
    expect(c.total.yesterday).toMatchObject({ hours: 0, servicePph: null, clientsPerHour: null, totalPph: null });
    expect(cardTotal([])).toMatchObject({ servicePph: null });
  });

  it("ranks barbers across their shops by service PPH, listing their locations, no hours last", () => {
    const c = pphCard(input());
    expect(c.rank).toBe("service");
    expect(c.barbers.map((x) => [x.rank, x.item.name, x.item.detail, x.item.p.servicePph])).toEqual([
      [1, "Avery", "Coralville, Moline", 4_286],
      [2, "Blake", "Coralville", 4_000],
      [null, "Casey", "Coralville", null],
    ]);
  });

  it("ranks locations, and none with one shop", () => {
    const c = pphCard(input());
    expect(c.shops.map((x) => [x.rank, x.item.name, x.item.p.servicePph])).toEqual([
      [1, "Moline", 6_000],
      [2, "Coralville", 4_357],
    ]);
    const one = pphCard(input({ shops: [shops[0]] }));
    expect(one.shops).toEqual([]);
    expect(one.barbers[0].item.detail).toBeNull();
  });

  it("ranks the period picked, ties sharing a rank", () => {
    const c = pphCard(input({ rankBy: "today" }));
    expect(c.rankBy).toBe("today");
    expect(c.barbers.map((x) => [x.rank, x.item.name, x.item.p.servicePph])).toEqual([
      [1, "Blake", 5_000],
      [2, "Avery", 3_000],
    ]);
    const tie = pphCard(input({ rows: { today: [row("a", "cv", 100, 4_000), row("b", "cv", 200, 8_000)], yesterday: [], period: [] }, rankBy: "today" }));
    expect(tie.barbers.map((x) => x.rank)).toEqual([1, 1]);
    expect(pphCard(input({ rankBy: "yesterday" })).barbers).toEqual([]);
  });

  it("without money, ranks and charts clients per hour", () => {
    const c = pphCard(input({ money: false }));
    expect(c.rank).toBe("clients");
    expect(c.barbers.map((x) => [x.item.name, x.item.p.clientsPerHour])).toEqual([
      ["Avery", 0.29],
      ["Blake", 0.25],
      ["Casey", null],
    ]);
    expect(c.spark.map((s) => s.value)).toEqual([null, 0.25]);
  });

  it("the sparkline is each day on its own, N/A where nobody worked", () => {
    const c = pphCard(input());
    expect(c.spark).toEqual([
      { date: "2029-08-13", value: null },
      { date: "2029-08-14", value: 3_667 },
    ]);
    expect(SPARK_DAYS).toBe(14);
  });

  it("leaderboards rank the period to date unless another period is picked", () => {
    expect(CARD_PERIODS).toEqual(["today", "yesterday", "period"]);
    expect(parseCardPeriod(undefined)).toBe("period");
    expect(parseCardPeriod("today")).toBe("today");
    expect(parseCardPeriod("week")).toBe("period");
  });

  it("places sparkline points from 0 at the bottom to the highest at the top, skipping gaps", () => {
    expect(sparkPoints([0, null, 10, 5], 100, 20, 0)).toEqual([
      { i: 0, x: 0, y: 20 },
      { i: 2, x: 66.66666666666667, y: 0 },
      { i: 3, x: 100, y: 10 },
    ]);
    expect(sparkPoints([7], 100, 20, 0)).toEqual([{ i: 0, x: 50, y: 0 }]);
    expect(sparkPoints([null, 0], 100, 20, 2)).toEqual([{ i: 1, x: 98, y: 18 }]);
  });
});

describe("the dashboard's product sales per client card", () => {
  // A client with a profile is c:<id>; a walk-in is t:<ticket>, so each walk-in ticket is its own client.
  const pc = (staffId: string, shopId: string, productCents: number, served: string[]) => row(staffId, shopId, 0, 0, productCents, 0, served);
  const pcPeriod = [pc("a", "cv", 5_000, ["c:1", "c:2", "t:1"]), pc("a", "ml", 0, ["c:1", "t:2"]), pc("b", "cv", 3_000, ["c:1", "c:3"]), pc("c", "cv", 2_000, [])];
  const pcToday = [pc("a", "cv", 1_000, ["c:1"]), pc("b", "cv", 1_000, ["c:1", "t:9"])];
  const pcInput = (o: Partial<Parameters<typeof perClientCard>[0]> = {}) => ({
    rows: { today: pcToday, yesterday: [], period: pcPeriod },
    days: [
      { date: "2029-08-13", rows: [] },
      { date: "2029-08-14", rows: pcToday },
    ],
    shops,
    names,
    rankBy: "period" as const,
    ...o,
  });

  it("is product sales over the unique clients across the rows: a client two barbers saw is one, N/A with none", () => {
    const c = perClientCard(pcInput());
    expect(c.total.period).toEqual({ productCents: 10_000, clients: 5, perClient: 2_000 });
    expect(c.total.today).toEqual({ productCents: 2_000, clients: 2, perClient: 1_000 });
    expect(c.total.yesterday).toEqual({ productCents: 0, clients: 0, perClient: null });
    expect(perClientTotal([pc("a", "cv", 1_000, ["t:1"]), pc("a", "cv", 0, ["t:2"])]).clients).toBe(2);
  });

  it("ranks barbers across their shops and locations, no clients (N/A) last", () => {
    const c = perClientCard(pcInput());
    expect(c.barbers.map((x) => [x.rank, x.item.name, x.item.detail, x.item.f.perClient, x.item.f.clients])).toEqual([
      [1, "Blake", "Coralville", 1_500, 2],
      [2, "Avery", "Coralville, Moline", 1_250, 4],
      [null, "Casey", "Coralville", null, 0],
    ]);
    expect(c.shops.map((x) => [x.rank, x.item.name, x.item.f.perClient])).toEqual([
      [1, "Coralville", 2_500],
      [2, "Moline", 0],
    ]);
    expect(perClientCard(pcInput({ shops: [shops[0]] })).shops).toEqual([]);
  });

  it("ranks the period picked and charts each day on its own", () => {
    const c = perClientCard(pcInput({ rankBy: "today" }));
    expect(c.barbers.map((x) => [x.rank, x.item.name, x.item.f.perClient])).toEqual([
      [1, "Avery", 1_000],
      [2, "Blake", 500],
    ]);
    expect(c.spark).toEqual([
      { date: "2029-08-13", value: null },
      { date: "2029-08-14", value: 1_000 },
    ]);
  });
});
