import { describe, expect, it } from "vitest";
import { LocationError, locationLabel, locationTokens, resolveLocations } from "@/domain/locations";
import { BarberError, barberLabel, resolveBarbers } from "@/domain/barbers";
import {
  Column,
  Metric,
  TOTAL,
  ViewCtx,
  csvTable,
  listTable,
  metricSplitTable,
  metricTable,
  parseReportView,
  parseView,
  segKey,
  splitTable,
  totalLabel,
  viewOf,
} from "@/domain/report-views";

const A = { id: "a", name: "Coralville" };
const B = { id: "b", name: "Moline" };
const C = { id: "c", name: "Silvis" };
const v = (view: "combined" | "shops", shops = [A, B, C], label = "Total (3 shops)"): ViewCtx => ({ view, shops, totalLabel: label });

const at = (byShop: Record<string, number | null>, total?: number) => ({ ...Object.fromEntries(Object.entries(byShop).map(([k, x]) => [segKey(k, null), x])), ...(total !== undefined ? { [TOTAL]: total } : {}) });

describe("metric tables", () => {
  const metrics: Metric[] = [
    { label: "Net sales", kind: "money", at: at({ a: 1000, b: 250, c: 0 }) },
    { label: "Attach rate", kind: "pct", at: at({ a: 0.5, b: 0.25, c: null }, 0.4) },
  ];
  it("by location: a column per shop and a total column; rates use the given total", () => {
    const t = metricTable(v("shops"), { id: "x", title: "X", metrics });
    expect(t.columns.map((c) => c.label)).toEqual(["Metric", "Coralville", "Moline", "Silvis", "Total (3 shops)"]);
    expect(t.rows).toEqual([
      ["Net sales", 1000, 250, 0, 1250],
      ["Attach rate", 0.5, 0.25, null, 0.4],
    ]);
    expect(t.totalColumn).toBe(true);
    expect(t.rowKinds).toEqual(["money", "pct"]);
  });
  it("combined: one value column, named for the shop when there's only one", () => {
    expect(metricTable(v("combined"), { id: "x", title: "X", metrics }).rows).toEqual([
      ["Net sales", 1250],
      ["Attach rate", 0.4],
    ]);
    expect(metricTable(v("combined", [A], "Total"), { id: "x", title: "X", metrics }).columns[1].label).toBe("Coralville");
  });
  it("downloads by location with a Location column: a row per shop, then the total", () => {
    const c = csvTable(metricTable(v("shops"), { id: "x", title: "X", metrics }));
    expect(c.headers).toEqual(["Location", "Net sales", "Attach rate"]);
    expect(c.rows).toEqual([
      ["Coralville", "10.00", "50.0%"],
      ["Moline", "2.50", "25.0%"],
      ["Silvis", "0.00", null],
      ["Total (3 shops)", "12.50", "40.0%"],
    ]);
  });
});

describe("list tables", () => {
  const columns: Column[] = [{ label: "Barber" }, { label: "Tickets", kind: "int" }, { label: "Net", kind: "money" }, { label: "Avg", kind: "money", sum: false }];
  const derive = (c: (string | number | boolean | null)[]) => [...c.slice(0, 3), Number(c[1]) ? Math.round(Number(c[2]) / Number(c[1])) : 0];
  const rows = [
    { shopId: "a", key: "sam", cells: ["Sam", 2, 4000, 2000] },
    { shopId: "b", key: "sam", cells: ["Sam", 1, 1000, 1000] },
    { shopId: "a", key: "jo", cells: ["Jo", 1, 3000, 3000] },
  ];

  it("by location: rows under their shop, a subtotal per shop (empty shops too), and the total", () => {
    const t = listTable(v("shops"), { id: "x", title: "X", columns, rows, derive });
    expect(t.columns[0].label).toBe("Location");
    expect(t.rows).toEqual([
      ["Coralville", "Sam", 2, 4000, 2000],
      ["Coralville", "Jo", 1, 3000, 3000],
      ["Coralville", "Subtotal", 3, 7000, 2333],
      ["Moline", "Sam", 1, 1000, 1000],
      ["Moline", "Subtotal", 1, 1000, 1000],
      ["Silvis", "Subtotal", 0, 0, 0],
      ["Total (3 shops)", null, 4, 8000, 2000],
    ]);
    expect(t.rowStyles).toEqual([undefined, undefined, "subtotal", undefined, "subtotal", "subtotal", "total"]);
  });

  it("combined: one row per key with where it came from, and the total", () => {
    const t = listTable(v("combined"), { id: "x", title: "X", columns, rows, derive, merge: true, shopsColumnAt: 1 });
    expect(t.columns.map((c) => c.label)).toEqual(["Barber", "Locations", "Tickets", "Net", "Avg"]);
    expect(t.rows).toEqual([
      ["Sam", "Coralville, Moline", 3, 5000, 1667],
      ["Jo", "Coralville", 1, 3000, 3000],
      ["Total (3 shops)", null, 4, 8000, 2000],
    ]);
  });

  it("combined logs keep a Location column; columns marked not to sum stay blank in totals", () => {
    const t = listTable(v("combined"), { id: "x", title: "X", columns: [{ label: "Ticket", kind: "int", sum: false }, { label: "Amount", kind: "money" }], rows: [{ shopId: "b", cells: [17, 500] }, { shopId: "a", cells: [9, 250] }], keepShop: true });
    expect(t.rows).toEqual([
      ["Moline", 17, 500],
      ["Coralville", 9, 250],
      ["Total (3 shops)", null, 750],
    ]);
  });

  it("puts the subtotal label in the chosen column and keeps text the rows agree on", () => {
    const cols: Column[] = [{ label: "Period" }, { label: "Barber" }, { label: "Tips", kind: "money" }];
    const t = listTable(v("shops", [A]), { id: "p", title: "P", columns: cols, rows: [{ shopId: "a", cells: ["2027-04-05", "Sam", 300] }, { shopId: "a", cells: ["2027-04-05", "Jo", 200] }], labelAt: 1 });
    expect(t.rows.slice(-2)).toEqual([
      ["Coralville", "2027-04-05", "Subtotal", 500],
      ["Total (3 shops)", "2027-04-05", null, 500],
    ]);
  });

  it("splits out things at more than one shop, with the combined total under the shops", () => {
    const t = splitTable(v("combined"), { id: "s", title: "S", columns, rows, derive })!;
    expect(t.rows).toEqual([
      ["Sam", "Coralville", 2, 4000, 2000],
      ["Sam", "Moline", 1, 1000, 1000],
      ["Sam", "All 2 shops", 3, 5000, 1667],
    ]);
    expect(t.rowStyles).toEqual([undefined, undefined, "subtotal"]);
    expect(splitTable(v("combined"), { id: "s", title: "S", columns, rows: rows.filter((r) => r.key === "jo") })).toBeNull();
  });

  it("CSV keeps the shape, money in dollars", () => {
    const c = csvTable(listTable(v("shops", [A]), { id: "x", title: "X", columns, rows: rows.filter((r) => r.shopId === "a"), derive }));
    expect(c.headers).toEqual(["Location", "Barber", "Tickets", "Net", "Avg"]);
    expect(c.rows.at(-1)).toEqual(["Total (3 shops)", null, 3, "70.00", "23.33"]);
  });
});

describe("barber views", () => {
  const names = { sam: "Sam", jo: "Jo", kim: "Kim" };
  const TL = "Total (2 barbers, 2 shops)";
  const bv = (view: "combined" | "shops", barbers = [{ id: "sam", name: "Sam" }, { id: "jo", name: "Jo" }]): ViewCtx => ({ view, byBarber: true, shops: [A, B], barbers, staffNames: names, totalLabel: TL });
  // Sam at both shops, Jo at Coralville, a retail-only ticket with no barber at Moline.
  // Tickets has no total given, so it adds up; the average ticket is given at every grain.
  const k = segKey;
  const metrics: Metric[] = [
    { label: "Tickets", kind: "int", at: { [k("a", "sam")]: 2, [k("b", "sam")]: 1, [k("a", "jo")]: 1, [k("b", "none")]: 1, [k(null, "sam")]: 3, [k(null, "jo")]: 1, [k(null, "none")]: 1, [k("a", null)]: 3, [k("b", null)]: 2 } },
    {
      label: "Avg ticket",
      kind: "money",
      additive: false,
      at: { [k("a", "sam")]: 2000, [k("b", "sam")]: 1000, [k("a", "jo")]: 3000, [k("b", "none")]: 500, [k(null, "sam")]: 1667, [k(null, "jo")]: 3000, [k(null, "none")]: 500, [k("a", null)]: 2333, [k("b", null)]: 750, [TOTAL]: 1700 },
    },
  ];

  it("by barber: a row per barber (the selection first, then no barber) and a total row", () => {
    const t = metricTable(bv("combined"), { id: "x", title: "X", metrics });
    expect(t.columns.map((c) => c.label)).toEqual(["Barber", "Tickets", "Avg ticket"]);
    expect(t.rows).toEqual([
      ["Sam", 3, 1667],
      ["Jo", 1, 3000],
      ["No barber", 1, 500],
      [TL, 5, 1700],
    ]);
    expect(t.rowStyles).toEqual([undefined, undefined, undefined, "total"]);
  });

  it("by barber: a selected barber with nothing still shows, with zero counts and no average", () => {
    const t = metricTable(bv("combined", [{ id: "sam", name: "Sam" }, { id: "lee", name: "Lee" }]), { id: "x", title: "X", metrics });
    expect(t.rows.find((r) => r[0] === "Lee")).toEqual(["Lee", 0, null]);
  });

  it("by location and barber: the barbers at each shop, a subtotal per shop, and the total", () => {
    const t = metricTable(bv("shops"), { id: "x", title: "X", metrics });
    expect(t.columns.map((c) => c.label)).toEqual(["Location", "Barber", "Tickets", "Avg ticket"]);
    expect(t.rows).toEqual([
      ["Coralville", "Sam", 2, 2000],
      ["Coralville", "Jo", 1, 3000],
      ["Coralville", "Subtotal", 3, 2333],
      ["Moline", "Sam", 1, 1000],
      ["Moline", "No barber", 1, 500],
      ["Moline", "Subtotal", 2, 750],
      [TL, null, 5, 1700],
    ]);
    expect(t.rowStyles).toEqual([undefined, undefined, "subtotal", undefined, undefined, "subtotal", "total"]);
  });

  it("downloads with the same Location and Barber columns and rows as on screen", () => {
    const t = metricTable(bv("shops"), { id: "x", title: "X", metrics });
    const c = csvTable(t);
    expect(c.headers).toEqual(t.columns.map((x) => x.label));
    expect(c.rows.map((r) => r.slice(0, 2))).toEqual(t.rows.map((r) => r.slice(0, 2)));
    expect(c.rows.at(-1)).toEqual([TL, null, 5, "17.00"]);
  });

  it("splits out barbers at more than one shop, with their combined row from the barber grain", () => {
    const t = metricSplitTable(bv("combined"), { id: "s", title: "S", metrics })!;
    expect(t.columns.map((c) => c.label)).toEqual(["Barber", "Location", "Tickets", "Avg ticket"]);
    expect(t.rows).toEqual([
      ["Sam", "Coralville", 2, 2000],
      ["Sam", "Moline", 1, 1000],
      ["Sam", "All 2 shops", 3, 1667],
    ]);
    expect(metricSplitTable({ ...bv("combined"), shops: [A] }, { id: "s", title: "S", metrics })).toBeNull();
  });

  const columns: Column[] = [{ label: "Date" }, { label: "Tickets", kind: "int" }, { label: "Net", kind: "money" }];
  const rows = [
    { shopId: "a", staffId: "sam", key: "d1", cells: ["d1", 1, 2000] },
    { shopId: "b", staffId: "sam", key: "d1", cells: ["d1", 1, 1000] },
    { shopId: "a", staffId: "sam", key: "d2", cells: ["d2", 1, 2000] },
    { shopId: "a", staffId: "jo", key: "d1", cells: ["d1", 1, 3000] },
    { shopId: "b", staffId: null, key: "d2", cells: ["d2", 1, 500] },
  ];
  const byDay = (x: (string | number | boolean | null)[], y: (string | number | boolean | null)[]) => String(x[0]).localeCompare(String(y[0]));

  it("lists by barber: each barber's rows merged across shops, a subtotal per barber, and the total", () => {
    const t = listTable(bv("combined"), { id: "x", title: "X", columns, rows, merge: true, sort: byDay });
    expect(t.columns.map((c) => c.label)).toEqual(["Barber", "Date", "Tickets", "Net"]);
    expect(t.rows).toEqual([
      ["Sam", "d1", 2, 3000],
      ["Sam", "d2", 1, 2000],
      ["Sam", "Subtotal", 3, 5000],
      ["Jo", "d1", 1, 3000],
      ["Jo", "Subtotal", 1, 3000],
      ["No barber", "d2", 1, 500],
      ["No barber", "Subtotal", 1, 500],
      [TL, null, 5, 8500],
    ]);
  });

  it("lists by location and barber: each barber at each shop, all barbers per shop, and the total", () => {
    const t = listTable(bv("shops"), { id: "x", title: "X", columns, rows, merge: true, sort: byDay });
    expect(t.columns.map((c) => c.label)).toEqual(["Location", "Barber", "Date", "Tickets", "Net"]);
    expect(t.rows).toEqual([
      ["Coralville", "Sam", "d1", 1, 2000],
      ["Coralville", "Sam", "d2", 1, 2000],
      ["Coralville", "Sam", "Subtotal", 2, 4000],
      ["Coralville", "Jo", "d1", 1, 3000],
      ["Coralville", "Jo", "Subtotal", 1, 3000],
      ["Coralville", "All barbers", "Subtotal", 3, 7000],
      ["Moline", "Sam", "d1", 1, 1000],
      ["Moline", "Sam", "Subtotal", 1, 1000],
      ["Moline", "No barber", "d2", 1, 500],
      ["Moline", "No barber", "Subtotal", 1, 500],
      ["Moline", "All barbers", "Subtotal", 2, 1500],
      [TL, null, null, 5, 8500],
    ]);
    expect(styledRows(t, "subtotal").map((r) => r.slice(0, 2))).toEqual([
      ["Coralville", "Sam"],
      ["Coralville", "Jo"],
      ["Coralville", "All barbers"],
      ["Moline", "Sam"],
      ["Moline", "No barber"],
      ["Moline", "All barbers"],
    ]);
  });
});

const styledRows = (t: ReturnType<typeof listTable>, s: "subtotal" | "total") => t.rows.filter((_, i) => t.rowStyles?.[i] === s);

describe("barber selection", () => {
  const u = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
  const [sam, jo, kim, outside] = [u(1), u(2), u(3), u(9)];
  const visible = [
    { id: sam, name: "Sam", shopIds: ["a"] },
    { id: jo, name: "Jo", shopIds: ["a", "b"] },
    { id: kim, name: "Kim", shopIds: ["b"] },
  ];
  const groups = [
    { id: "g1", name: "Floaters", staffIds: [jo, sam, outside] },
    { id: "g2", name: "Elsewhere", staffIds: [outside] },
  ];
  const r = (raw: string | string[] | null, self: string | null = null) => resolveBarbers(raw, { visible, groups, self });
  const names = (id: string) => visible.find((b) => b.id === id)?.name ?? "?";

  it("all barbers (no filter, so tickets without a barber count), one, or any set in the list's order", () => {
    expect(r(null)).toEqual({ kind: "all", staffIds: null, param: null });
    expect(r("all")).toMatchObject({ kind: "all", staffIds: null });
    expect(r(jo)).toEqual({ kind: "one", staffIds: [jo], param: jo });
    expect(r(`${kim},${sam}`)).toEqual({ kind: "custom", staffIds: [sam, kim], param: `${sam},${kim}` });
    expect(r([kim, sam, sam])).toMatchObject({ kind: "custom", staffIds: [sam, kim] });
  });
  it("a saved group is cut down to the barbers the viewer can see", () => {
    expect(r("group:g1")).toMatchObject({ kind: "group", staffIds: [sam, jo], param: "group:g1", group: { name: "Floaters", hidden: 1 } });
    expect(() => r("group:g2")).toThrow("None of the barbers in Elsewhere work at your shops");
    expect(() => r("group:nope")).toThrow(BarberError);
  });
  it("refuses barbers outside the viewer's shops and mixed selections", () => {
    expect(() => r(outside)).toThrow("That barber isn't at your shops");
    expect(() => r(`${sam},${outside}`)).toThrow("isn't at your shops");
    expect(() => r("not-a-uuid")).toThrow("isn't at your shops");
    expect(() => r(`all,${sam}`)).toThrow("not a mix");
    expect(() => r(["group:g1", sam])).toThrow("not a mix");
  });
  it("someone who may only see their own numbers always gets themselves", () => {
    expect(r(null, kim)).toEqual({ kind: "self", staffIds: [kim], param: null });
    expect(r("all", kim)).toMatchObject({ kind: "self", staffIds: [kim] });
    expect(r(kim, kim)).toMatchObject({ kind: "self", staffIds: [kim] });
    expect(() => r(sam, kim)).toThrow("You can only see your own numbers");
    expect(() => r(`${sam},${kim}`, kim)).toThrow("You can only see your own numbers");
    expect(() => r("group:g1", kim)).toThrow("You can only see your own numbers");
  });
  it("labels the selection by display name", () => {
    expect(barberLabel(r(null), names)).toBe("All barbers");
    expect(barberLabel(r("group:g1"), names)).toBe("Floaters: Sam, Jo");
    expect(barberLabel(r(`${kim},${sam}`), names)).toBe("Sam, Kim");
  });
});

describe("labels and views", () => {
  it("names the total for what's selected", () => {
    expect(totalLabel(8, true)).toBe("Brand total");
    expect(totalLabel(3, false)).toBe("Total (3 shops)");
    expect(totalLabel(1, true)).toBe("Total");
    expect(totalLabel(2, true, 3)).toBe("Total (3 barbers, 2 shops)");
    expect(totalLabel(1, false, 2)).toBe("Total (2 barbers)");
    expect(totalLabel(8, true, 1)).toBe("Total (8 shops)");
  });
  it("parses the four views", () => {
    expect(parseView("shops")).toBe("shops");
    expect(parseView("shops_barbers")).toBe("shops");
    expect(parseView("anything")).toBe("combined");
    expect(parseReportView("shops_barbers")).toBe("shops_barbers");
    expect(parseReportView("nope")).toBeNull();
    expect(viewOf({ view: "shops", byBarber: true })).toBe("shops_barbers");
    expect(viewOf({ view: "combined", byBarber: true })).toBe("barbers");
    expect(viewOf({ view: "combined" })).toBe("combined");
  });
});

describe("location selection", () => {
  const access = ["a", "b", "c"].map((x) => `00000000-0000-4000-8000-00000000000${x}`);
  const [a, b, c] = access;
  const outside = "00000000-0000-4000-8000-00000000000d";
  const groups = [
    { id: "g1", name: "Quad Cities", shopIds: [c, b, outside] },
    { id: "g2", name: "Elsewhere", shopIds: [outside] },
  ];
  const r = (raw: string | string[] | null, current: string | null = a) => resolveLocations(raw, { accessShopIds: access, currentShopId: current, groups });

  it("defaults to the current shop, or every shop when none is picked", () => {
    expect(r(null)).toMatchObject({ kind: "current", shopIds: [a], param: null });
    expect(r(null, null)).toMatchObject({ kind: "current", shopIds: access });
  });
  it("one shop, several in any order (comma-separated or repeated), or all", () => {
    expect(r(b)).toMatchObject({ kind: "one", shopIds: [b], param: b });
    expect(r(`${c},${a}`)).toMatchObject({ kind: "custom", shopIds: [a, c], param: `${a},${c}` });
    expect(r([c, a, a])).toMatchObject({ kind: "custom", shopIds: [a, c] });
    expect(r("all")).toMatchObject({ kind: "all", shopIds: access, param: "all" });
    expect(locationTokens(["x, y", "y"])).toEqual(["x", "y"]);
  });
  it("a group is cut down to the viewer's shops and says how many were left out", () => {
    expect(r("group:g1")).toMatchObject({ kind: "group", shopIds: [b, c], param: "group:g1", group: { name: "Quad Cities", hidden: 1 } });
    expect(() => r("group:g2")).toThrow("None of the shops in Elsewhere are in your access");
    expect(() => r("group:nope")).toThrow(LocationError);
  });
  it("refuses shops outside access and mixed selections", () => {
    expect(() => r(outside)).toThrow("That shop is outside your access");
    expect(() => r(`${a},${outside}`)).toThrow("outside your access");
    expect(() => r("not-a-uuid")).toThrow("outside your access");
    expect(() => r(`all,${a}`)).toThrow("not a mix");
    expect(() => r(["group:g1", a])).toThrow("not a mix");
  });
  it("labels the selection", () => {
    const shops = access.map((id, i) => ({ id, name: ["Coralville", "Moline", "Silvis"][i] }));
    expect(locationLabel(r("group:g1"), shops, true)).toBe("Quad Cities: Moline, Silvis");
    expect(locationLabel(r("all"), shops, true)).toBe("All shops");
    expect(locationLabel(r("all"), shops, false)).toBe("All my shops");
    expect(locationLabel(r(`${a},${b}`), shops, true)).toBe("Coralville, Moline");
  });
});
