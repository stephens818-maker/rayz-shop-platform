import { describe, expect, it } from "vitest";
import { publicBarberHints, publicBarberName } from "@/domain/public-barber";

describe("public barber names", () => {
  it("keeps the first name and adds a specialty only when that name is shared", () => {
    expect(publicBarberName("Taylor A.")).toBe("Taylor");
    expect(publicBarberName("Olivia B.")).toBe("Olivia");
    const names = ["Taylor", "Garrett", "Taylor"];
    expect(publicBarberHints(names, ["Skin fades", null, "Scissor cuts"])).toEqual(["Skin fades", null, "Scissor cuts"]);
    expect(publicBarberHints(["Michelle"], ["Skin fades"])).toEqual([null]);
    expect(publicBarberHints(["Taylor", "Taylor"], [null, "  "])).toEqual([null, null]);
  });
});
