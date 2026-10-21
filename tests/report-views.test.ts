import { describe, expect, it } from "vitest";
import { LocationError, locationLabel, locationTokens, resolveLocations } from "@/domain/locations";
import { Column, ViewCtx, csvTable, listTable, metricTable, parseView, splitTable, totalLabel } from "@/domain/report-views";

const A = { id: "a", name: "Coralville" };
const B = { id: "b", name: "Moline" };
const C = { id: "c", name: "Silvis" };
const v = (view: "combined" | "shops", shops = [A, B, C], label = "Total (3 shops)"): ViewCtx => ({ view, shops, totalLabel: label });

describe("metric tables", () => {
  const metrics = [
    { label: "Net sales", kind: "money" as const, byShop: { a: 1000, b: 250, c: 0 } },
    { label: "Attach rate", kind: "pct" as const, byShop: { a: 0.5, b: 0.25, c: null }, total: 0.4 },
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

describe("labels and views", () => {
  it("names the total for what's selected", () => {
    expect(totalLabel(8, true)).toBe("Brand total");
    expect(totalLabel(3, false)).toBe("Total (3 shops)");
    expect(totalLabel(1, true)).toBe("Total");
    expect(parseView("shops")).toBe("shops");
    expect(parseView("anything")).toBe("combined");
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
