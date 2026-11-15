import { describe, expect, it } from "vitest";
import { publicBarberLabels, publicBarberName } from "@/domain/public-barber";

describe("public barber names", () => {
  it("keeps a unique first name and uses the display label when that name is shared", () => {
    expect(publicBarberName("Taylor A.")).toBe("Taylor");
    expect(publicBarberName("Olivia B.")).toBe("Olivia");
    expect(publicBarberLabels(["Taylor A.", "Garrett", "Taylor B."])).toEqual(["Taylor A.", "Garrett", "Taylor B."]);
    expect(publicBarberLabels(["Michelle"])).toEqual(["Michelle"]);
    expect(publicBarberLabels(["Taylor A.", "Taylor B."]).every((n) => !n.toLowerCase().includes("fade"))).toBe(true);
  });
});
