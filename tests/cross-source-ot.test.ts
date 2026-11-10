import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { crossSourceOt, type BlockView } from "@/server/payroll/run";

/** A payroll block with one person's hours. Only the fields the cross-shop check reads. */
function block(shop: string, source: "platform" | "squire", hours: number): BlockView {
  return {
    locked: null,
    shop,
    shopId: shop,
    source,
    lines: [{ staffId: "barber-1", name: "Alex", input: { workedHours: hours } }],
  } as unknown as BlockView;
}

describe("overtime across a Clinton week and a Squire shop", () => {
  const sameEmployer = () => "rayz";

  it("flags a person who worked at Clinton and a Squire shop in the same period", () => {
    const flagged = crossSourceOt([block("Clinton", "platform", 20), block("Moline", "squire", 25)], sameEmployer);
    expect(flagged).toEqual([
      expect.objectContaining({
        kind: "cross_source_ot",
        staffId: "barber-1",
        message: expect.stringMatching(/Clinton.*Moline/),
      }),
    ]);
  });

  it("does not flag two platform shops, or hours at only one source", () => {
    expect(crossSourceOt([block("Clinton", "platform", 20), block("Coralville", "platform", 25)], sameEmployer)).toEqual([]);
    expect(crossSourceOt([block("Moline", "squire", 40)], sameEmployer)).toEqual([]);
  });
});
