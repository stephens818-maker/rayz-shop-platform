import { describe, expect, it } from "vitest";
import { monthCells } from "./month";

describe("month grid", () => {
  it("starts October 2026 on Thursday and includes the 23rd", () => {
    const cells = monthCells(2026, 10);
    expect(cells[0].date).toBeNull();
    expect(cells[4].date).toBe("2026-10-01");
    expect(cells.some((cell) => cell.date === "2026-10-23")).toBe(true);
    expect(cells.filter((cell) => cell.date).length).toBe(31);
  });
});
