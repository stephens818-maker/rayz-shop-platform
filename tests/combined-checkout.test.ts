import { describe, expect, it } from "vitest";
import {
  cleanPayerLabel,
  evenSplit,
  groupByPerson,
  mergeProblem,
  perBarberTipProblem,
  planSplitTenders,
  readiness,
  splitTenderProblem,
  type MergeTicket,
} from "@/domain/combined-checkout";
import { splitCents, tipWeights } from "@/domain/handoff";

const FEE = { enabled: true, rate: 0.03, appliesToTip: false };

describe("split payment", () => {
  it("needs two or more payments that add up to what's due", () => {
    expect(splitTenderProblem(10_000, [{ key: "a", method: "cash", amountCents: 10_000 }])).toMatch(/at least two/);
    expect(splitTenderProblem(10_000, [{ key: "a", method: "cash", amountCents: 6_000 }, { key: "b", method: "card", amountCents: 3_000 }])).toBe("The payments are $10.00 short of the $100.00 due");
    expect(splitTenderProblem(10_000, [{ key: "a", method: "cash", amountCents: 6_000 }, { key: "b", method: "card", amountCents: 5_000 }])).toBe("The payments are $10.00 over the $100.00 due");
    expect(splitTenderProblem(10_000, [{ key: "a", method: "cash", amountCents: 10_000 }, { key: "b", method: "card", amountCents: 0 }])).toMatch(/more than \$0/);
    expect(splitTenderProblem(10_000, [{ key: "a", method: "cash", amountCents: 5_000 }, { key: "a", method: "card", amountCents: 5_000 }])).toMatch(/different/);
    expect(splitTenderProblem(10_000, [{ key: "a", method: "cash", amountCents: 4_000 }, { key: "b", method: "card", amountCents: 6_000 }])).toBeNull();
  });

  it("puts the tip on as few payments as it can, largest first", () => {
    const p = planSplitTenders({
      tipCents: 1_500,
      cardFee: { ...FEE, enabled: false },
      tenders: [
        { key: "cash", method: "cash", amountCents: 3_000 },
        { key: "visa", method: "card", amountCents: 5_000, funding: "debit" },
        { key: "amex", method: "card", amountCents: 2_000, funding: "debit" },
      ],
    });
    expect(p.parts.map((x) => [x.key, x.tipCents])).toEqual([
      ["cash", 0],
      ["visa", 1_500],
      ["amex", 0],
    ]);
    expect(p.chargeCents).toBe(10_000);
  });

  it("spills a tip bigger than the largest payment onto the next", () => {
    const p = planSplitTenders({ tipCents: 7_000, cardFee: FEE, tenders: [{ key: "a", method: "cash", amountCents: 4_000 }, { key: "b", method: "cash", amountCents: 5_000 }] });
    expect(p.parts.map((x) => x.tipCents)).toEqual([2_000, 5_000]);
  });

  it("surcharges each credit card on its own part, never the tip when the shop doesn't", () => {
    const p = planSplitTenders({
      tipCents: 1_000,
      cardFee: FEE,
      tenders: [
        { key: "credit", method: "card", amountCents: 6_000, funding: "credit" },
        { key: "debit", method: "card", amountCents: 3_000, funding: "debit" },
        { key: "cash", method: "cash", amountCents: 1_000 },
      ],
    });
    const credit = p.parts.find((x) => x.key === "credit")!;
    expect(credit.tipCents).toBe(1_000);
    expect(credit.feeCents).toBe(150); // 3% of $50 (the $60 less the $10 tip)
    expect(p.parts.find((x) => x.key === "debit")!.feeCents).toBe(0);
    expect(p.cardFeeCents).toBe(150);
    expect(p.chargeCents).toBe(10_150);
  });

  it("splits evenly with the odd cents on the first payers", () => {
    expect(evenSplit(10_001, 3)).toEqual([3_334, 3_334, 3_333]);
    expect(evenSplit(9_000, 2)).toEqual([4_500, 4_500]);
    expect(evenSplit(100, 0)).toEqual([]);
  });

  it("keeps payer labels short and free of anything like a card number", () => {
    expect(cleanPayerLabel("  Grandma  ")).toBe("Grandma");
    expect(cleanPayerLabel("Dad 4242 4242 4242 4242")).toBe("Dad");
    expect(cleanPayerLabel("x".repeat(60))).toHaveLength(40);
    expect(cleanPayerLabel("   ")).toBeNull();
    expect(cleanPayerLabel(null)).toBeNull();
  });
});

describe("per-barber tips", () => {
  const lines = [
    { kind: "service", staffId: "b1", netCents: 3_000 },
    { kind: "service", staffId: "b2", netCents: 2_000 },
    { kind: "addon", staffId: "b2", netCents: 500 },
    { kind: "product", staffId: null, netCents: 2_000 },
  ];

  it("must name barbers on the ticket and add up to the tip", () => {
    expect(perBarberTipProblem([{ staffId: "b1", cents: 700 }, { staffId: "b2", cents: 300 }], ["b1", "b2"], 1_000)).toBeNull();
    expect(perBarberTipProblem([{ staffId: "b1", cents: 700 }], ["b1", "b2"], 1_000)).toMatch(/add up to \$7.00, not the \$10.00/);
    expect(perBarberTipProblem([{ staffId: "zz", cents: 1_000 }], ["b1", "b2"], 1_000)).toMatch(/isn't on this ticket/);
    expect(perBarberTipProblem([{ staffId: "b1", cents: 500 }, { staffId: "b1", cents: 500 }], ["b1", "b2"], 1_000)).toMatch(/once/);
    expect(perBarberTipProblem([{ staffId: "b1", cents: 10.5 }], ["b1"], 10.5)).toMatch(/whole cents/);
  });

  it("weights by the cents typed, so the split gives each barber exactly that", () => {
    const w = tipWeights(lines, "per_barber", [{ staffId: "b2", cents: 333 }, { staffId: "b1", cents: 1_001 }]);
    expect(w).toEqual([{ staffId: "b1", weight: 1_001 }, { staffId: "b2", weight: 333 }]);
    const shares = splitCents(1_334, w.map((x) => ({ id: x.staffId, weight: x.weight })));
    expect(Object.fromEntries(shares)).toEqual({ b1: 1_001, b2: 333 });
  });

  it("leaves out a barber tipped nothing, and falls back to services when nothing was typed", () => {
    expect(tipWeights(lines, "per_barber", [{ staffId: "b1", cents: 0 }, { staffId: "b2", cents: 800 }])).toEqual([{ staffId: "b2", weight: 800 }]);
    expect(tipWeights(lines, "per_barber", [])).toEqual([{ staffId: "b1", weight: 3_000 }, { staffId: "b2", weight: 2_500 }]);
    expect(tipWeights(lines, "services")).toEqual([{ staffId: "b1", weight: 3_000 }, { staffId: "b2", weight: 2_500 }]);
  });
});

describe("itemized by person", () => {
  const people = [
    { appointmentId: "mom", name: "Dana Reyes" },
    { appointmentId: "kid", name: "Leo Reyes" },
  ];
  const lines = [
    { id: 1, kind: "service", appointmentId: "kid", staffId: "b2" },
    { id: 2, kind: "product", appointmentId: null, staffId: null },
    { id: 3, kind: "service", appointmentId: null, staffId: "b1" },
    { id: 4, kind: "addon", appointmentId: "kid", staffId: "b3" },
    { id: 5, kind: "gift_card", appointmentId: null, staffId: null },
  ];

  it("groups by person in ticket order, then barber; retail last", () => {
    const g = groupByPerson(lines, people, { leadAppointmentId: "mom" });
    expect(g.map((x) => [x.appointmentId, x.name, x.lines.map((l) => l.id)])).toEqual([
      ["mom", "Dana Reyes", [3]],
      ["kid", "Leo Reyes", [1, 4]],
      [null, "Retail and other", [2, 5]],
    ]);
    expect(g[1].barbers.map((b) => [b.staffId, b.lines.length])).toEqual([
      ["b2", 1],
      ["b3", 1],
    ]);
  });

  it("drops people with nothing on the ticket", () => {
    expect(groupByPerson([lines[0]], people, { leadAppointmentId: "mom" }).map((g) => g.appointmentId)).toEqual(["kid"]);
  });

  it("counts who's been sent to checkout", () => {
    expect(readiness([{ readyAt: new Date() }, { readyAt: null }, { readyAt: "2026-10-24T15:00:00Z" }])).toEqual({ ready: 2, total: 3, all: false });
    expect(readiness([{ readyAt: new Date() }])).toEqual({ ready: 1, total: 1, all: true });
    expect(readiness([]).all).toBe(false);
  });
});

describe("combining tickets", () => {
  const t = (id: string, o: Partial<MergeTicket> = {}): MergeTicket => ({ id, shopId: "s1", status: "open", payments: 0, withClient: false, ...o });

  it("takes any open tickets at the shop, family or not", () => {
    expect(mergeProblem(t("a"), [t("b"), t("c")])).toBeNull();
  });

  it("refuses closed, paid-into, handed-off, other-shop and repeated tickets", () => {
    expect(mergeProblem(t("a"), [])).toMatch(/Pick/);
    expect(mergeProblem(t("a"), [t("b", { status: "paid" })])).toMatch(/open tickets/);
    expect(mergeProblem(t("a", { payments: 1 }), [t("b")])).toMatch(/taken a payment/);
    expect(mergeProblem(t("a"), [t("b", { withClient: true })])).toMatch(/customer screen/);
    expect(mergeProblem(t("a"), [t("b", { shopId: "s2" })])).toMatch(/different shops/);
    expect(mergeProblem(t("a"), [t("a")])).toMatch(/itself/);
    expect(mergeProblem(t("a"), [t("b"), t("b")])).toMatch(/once/);
  });
});
