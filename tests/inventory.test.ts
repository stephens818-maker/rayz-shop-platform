import { describe, expect, it } from "vitest";
import {
  Position,
  countAdjustments,
  effectiveLevels,
  levelsProblem,
  needsApproval,
  pickVendor,
  planReceipt,
  poActionProblem,
  roundToCase,
  suggestOrders,
  suggestQty,
  weightedCostCents,
} from "@/domain/inventory";
import { PoDocument, poCsv, poPdf } from "@/domain/po-document";

const at = (onHand: number, o: Partial<Position> = {}): Position => ({ onHand, committed: 0, onOrder: 0, inTransit: 0, ...o });

describe("levels", () => {
  it("a shop override wins; otherwise the brand default; par never sits below the reorder point", () => {
    const brand = { lowStockThreshold: 3, parLevel: 8 };
    expect(effectiveLevels(brand)).toEqual({ reorderPoint: 3, par: 8 });
    expect(effectiveLevels(brand, { lowStockThreshold: 5, parLevel: 14 })).toEqual({ reorderPoint: 5, par: 14 });
    expect(effectiveLevels(brand, { lowStockThreshold: 5, parLevel: null })).toEqual({ reorderPoint: 5, par: 8 });
    expect(effectiveLevels(brand, { lowStockThreshold: 10, parLevel: null })).toEqual({ reorderPoint: 10, par: 10 });
    expect(levelsProblem(6, 4)).toMatch(/below the reorder point/);
    expect(levelsProblem(-1, 4)).toMatch(/whole numbers/);
    expect(levelsProblem(4, 4)).toBeNull();
  });
});

describe("suggested quantities (par, reorder point, case pack)", () => {
  const l = { reorderPoint: 3, par: 8 };
  it("orders nothing while projected stock is above the reorder point", () => {
    expect(suggestQty(at(4), l)).toBe(0);
    expect(suggestQty(at(2, { onOrder: 6 }), l)).toBe(0);
    expect(suggestQty(at(1, { inTransit: 3 }), l)).toBe(0);
  });
  it("at or below the reorder point, orders up to par", () => {
    expect(suggestQty(at(3), l)).toBe(5);
    expect(suggestQty(at(0), l)).toBe(8);
    expect(suggestQty(at(1, { onOrder: 1 }), l)).toBe(6);
  });
  it("committed stock (open tickets, picked transfers) isn't available, so it counts against the shelf", () => {
    expect(suggestQty(at(5, { committed: 2 }), l)).toBe(5);
  });
  it("negative stock is made up too", () => {
    expect(suggestQty(at(-2), l)).toBe(10);
  });
  it("rounds up to whole cases", () => {
    expect(roundToCase(5, 6)).toBe(6);
    expect(roundToCase(7, 6)).toBe(12);
    expect(roundToCase(12, 6)).toBe(12);
    expect(roundToCase(5, 0)).toBe(5);
    expect(suggestQty(at(3), l, 6)).toBe(6);
    expect(suggestQty(at(0), l, 6)).toBe(12);
    expect(suggestQty(at(2), { reorderPoint: 2, par: 2 }, 1)).toBe(1);
  });
});

describe("suggested orders", () => {
  const offer = (vendorId: string, o: Partial<{ casePack: number; costCents: number; preferred: boolean }> = {}) => ({ vendorId, vendorName: vendorId.toUpperCase(), vendorSku: `${vendorId}-sku`, casePack: 1, costCents: 1000, preferred: false, ...o });
  it("the preferred vendor wins, else the cheapest", () => {
    expect(pickVendor([offer("a", { costCents: 900 }), offer("b", { preferred: true, costCents: 1200 })])!.vendorId).toBe("b");
    expect(pickVendor([offer("a", { costCents: 900 }), offer("b", { costCents: 800 })])!.vendorId).toBe("b");
    expect(pickVendor([])).toBeNull();
  });
  it("groups lines by vendor, uses that vendor's case pack and cost, and flags orders under the minimum", () => {
    const levels = { reorderPoint: 3, par: 8 };
    const { orders, noVendor } = suggestOrders(
      [
        { productId: "p1", sku: "P1", name: "Pomade", position: at(2), levels, offers: [offer("a", { casePack: 6, costCents: 1100, preferred: true }), offer("b")] },
        { productId: "p2", sku: "P2", name: "Clay", position: at(0), levels, offers: [offer("a", { costCents: 500 })] },
        { productId: "p3", sku: "P3", name: "Fiber", position: at(9), levels, offers: [offer("a")] },
        { productId: "p4", sku: "P4", name: "Comb", position: at(1), levels, offers: [] },
        { productId: "p5", sku: "P5", name: "Spray", position: at(0), levels, offers: [offer("b", { casePack: 4 })] },
      ],
      { a: 5000, b: 20000 },
    );
    expect(orders.map((o) => [o.vendorId, o.lines.map((x) => [x.sku, x.qty, x.cases, x.unitCostCents]), o.totalCents, o.belowMinimum])).toEqual([
      [
        "a",
        [
          ["P2", 8, 8, 500],
          ["P1", 6, 1, 1100],
        ],
        8 * 500 + 6 * 1100,
        false,
      ],
      ["b", [["P5", 8, 2, 1000]], 8000, true],
    ]);
    expect(noVendor.map((n) => [n.sku, n.qty])).toEqual([["P4", 7]]);
  });
});

describe("purchase order states", () => {
  it("each action is allowed only from the right status", () => {
    expect(poActionProblem("draft", "edit")).toBeNull();
    expect(poActionProblem("approved", "edit")).toBeNull();
    expect(poActionProblem("sent", "edit")).toMatch(/can't be edited/);
    expect(poActionProblem("draft", "approve")).toBeNull();
    expect(poActionProblem("draft", "approve", { lines: 0, overLimit: false })).toMatch(/at least one line/);
    expect(poActionProblem("approved", "approve")).toMatch(/Only drafts/);
    expect(poActionProblem("draft", "send")).toBeNull();
    expect(poActionProblem("draft", "send", { lines: 2, overLimit: true })).toMatch(/needs approval/);
    expect(poActionProblem("approved", "send", { lines: 2, overLimit: true })).toBeNull();
    expect(poActionProblem("sent", "send")).toMatch(/already sent/);
    expect(poActionProblem("draft", "receive")).toMatch(/Send the order/);
    expect(poActionProblem("sent", "receive")).toBeNull();
    expect(poActionProblem("partially_received", "receive")).toBeNull();
    expect(poActionProblem("received", "receive")).toMatch(/has been received/);
    expect(poActionProblem("sent", "cancel")).toBeNull();
    expect(poActionProblem("partially_received", "cancel")).toMatch(/Close it instead/);
    expect(poActionProblem("partially_received", "close")).toBeNull();
    expect(poActionProblem("sent", "close")).toMatch(/Only partially received/);
  });
  it("approval is needed only strictly above a set limit", () => {
    expect(needsApproval(50_001, 50_000)).toBe(true);
    expect(needsApproval(50_000, 50_000)).toBe(false);
    expect(needsApproval(9_999_999, null)).toBe(false);
  });
});

describe("receiving (partial deliveries and cost changes)", () => {
  const lines = [
    { id: "l1", productId: "p1", name: "Pomade", qtyOrdered: 12, qtyReceived: 0, unitCostCents: 1100 },
    { id: "l2", productId: "p2", name: "Clay", qtyOrdered: 6, qtyReceived: 4, unitCostCents: 900 },
  ];
  it("part of what's due leaves the order partially received", () => {
    const r = planReceipt(lines, [{ lineId: "l1", qty: 6 }]);
    expect(r).toEqual({ status: "partially_received", lines: [{ lineId: "l1", productId: "p1", name: "Pomade", qty: 6, unitCostCents: 1100, orderedCostCents: 1100 }] });
  });
  it("everything still due completes it, at the invoiced cost where it changed", () => {
    const r = planReceipt(lines, [
      { lineId: "l1", qty: 12, unitCostCents: 1150 },
      { lineId: "l2", qty: 2 },
    ]);
    expect(r.status).toBe("received");
    expect(r.lines.map((l) => [l.lineId, l.qty, l.unitCostCents, l.orderedCostCents])).toEqual([
      ["l1", 12, 1150, 1100],
      ["l2", 2, 900, 900],
    ]);
  });
  it("refuses more than is due (also across two entries for one line), unknown lines, and an empty delivery", () => {
    expect(() => planReceipt(lines, [{ lineId: "l2", qty: 3 }])).toThrow(/only 2 are still due/);
    expect(() =>
      planReceipt(lines, [
        { lineId: "l1", qty: 8 },
        { lineId: "l1", qty: 8 },
      ]),
    ).toThrow(/only 4 are still due/);
    expect(() => planReceipt(lines, [{ lineId: "nope", qty: 1 }])).toThrow(/isn't on this purchase order/);
    expect(() => planReceipt(lines, [{ lineId: "l1", qty: 0 }])).toThrow(/Enter what arrived/);
    expect(() => planReceipt(lines, [{ lineId: "l1", qty: 1.5 }])).toThrow(/whole units/);
  });
  it("shelf cost moves to the weighted average; negative stock carries no cost", () => {
    expect(weightedCostCents(4, 1000, 4, 1200)).toBe(1100);
    expect(weightedCostCents(0, 1000, 6, 1200)).toBe(1200);
    expect(weightedCostCents(-3, 1000, 6, 1200)).toBe(1200);
    expect(weightedCostCents(2, 1000, 1, 1001)).toBe(1000);
  });
});

describe("counts", () => {
  const onHand = { a: 5, b: 3, c: 2 };
  it("a cycle count only touches what was counted", () => {
    expect(
      countAdjustments(
        "cycle",
        [
          { productId: "a", counted: 4 },
          { productId: "b", counted: null },
          { productId: "c", counted: 2 },
        ],
        onHand,
      ),
    ).toEqual([
      { productId: "a", counted: 4, onHand: 5, variance: -1 },
      { productId: "c", counted: 2, onHand: 2, variance: 0 },
    ]);
  });
  it("a full stocktake treats anything not counted as zero", () => {
    expect(countAdjustments("full", [{ productId: "a", counted: 7 }, { productId: "b", counted: null }], onHand).map((x) => x.variance)).toEqual([2, -3]);
  });
});

describe("purchase order documents", () => {
  const doc: PoDocument = {
    number: 1042,
    date: "2026-10-21",
    expectedOn: "2026-10-28",
    notes: "Deliver to the back door",
    brand: "Ray'z Barber Shop",
    shop: { name: "Coralville", address: "1 Main St", city: "Coralville", state: "IA", zip: "52241", phone: "3195550100", email: "coralville@rayz.test" },
    vendor: { name: "Barber Supply Co.", contactName: "Dana", email: "orders@bsc.test", phone: null, address: "9 Depot Rd", accountNumber: "RAYZ-77", paymentTerms: "Net 30", minimumOrderCents: 15000 },
    lines: [
      { vendorSku: "BSC-RB-4", sku: "RZ-BLUE", name: "Reuzel Blue Pomade, 4 oz", casePack: 6, qtyOrdered: 12, unitCostCents: 1100 },
      { vendorSku: null, sku: "LY-CLAY", name: 'Layrite "Cement" Clay', casePack: 1, qtyOrdered: 3, unitCostCents: 950 },
    ],
  };
  it("CSV has one row per line with cases, units and totals, quoting where needed", () => {
    const rows = poCsv(doc).trim().split("\n");
    expect(rows[0]).toBe("po_number,date,ship_to,vendor,account_number,vendor_sku,sku,product,case_pack,cases,units,unit_cost,line_total");
    expect(rows[1]).toBe('PO-1042,2026-10-21,Ray\'z Barber Shop Coralville,Barber Supply Co.,RAYZ-77,BSC-RB-4,RZ-BLUE,"Reuzel Blue Pomade, 4 oz",6,2,12,11.00,132.00');
    expect(rows[2]).toBe('PO-1042,2026-10-21,Ray\'z Barber Shop Coralville,Barber Supply Co.,RAYZ-77,,LY-CLAY,"Layrite ""Cement"" Clay",1,,3,9.50,28.50');
  });
  it("PDF is a valid document with the order on it", () => {
    const bytes = poPdf(doc);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("PO-1042");
    expect(text).toContain("BSC-RB-4");
    expect(text).toContain("160.50");
  });
  it("PDF runs onto more pages for long orders", () => {
    const long = { ...doc, lines: Array.from({ length: 90 }, (_, i) => ({ ...doc.lines[0], sku: `SKU-${i}` })) };
    const text = Buffer.from(poPdf(long)).toString("latin1");
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});
