import { describe, expect, it } from "vitest";
import { labelContainsSurname } from "@/lib/ids";
import { staffAtShopDenied, staffProfileChangeDenied, timeBlockChangeDenied } from "@/server/auth/policy";

const CORALVILLE = "11111111-1111-1111-1111-111111111111";
const IOWA_CITY = "22222222-2222-2222-2222-222222222222";
const manager = { staffId: "mgr", isAdmin: false, shopIds: [CORALVILLE] };
const admin = { staffId: "own", isAdmin: true, shopIds: [CORALVILLE, IOWA_CITY] };

describe("review P0#4: managers can't escalate roles", () => {
  const self = { role: "shop_manager" as const, managerShopId: CORALVILLE, shopIds: [CORALVILLE] };

  it("denies a manager promoting their own record to brand admin", () => {
    expect(staffProfileChangeDenied(manager, self, { ...self, role: "brand_admin", managerShopId: null })).toMatch(/brand admin/);
  });

  it("denies a manager moving their own managed shop", () => {
    expect(staffProfileChangeDenied(manager, self, { ...self, managerShopId: IOWA_CITY })).not.toBeNull();
  });

  it("denies promoting a barber to manager or creating managers", () => {
    const barber = { role: "barber" as const, managerShopId: null, shopIds: [CORALVILLE] };
    expect(staffProfileChangeDenied(manager, barber, { ...barber, role: "shop_manager", managerShopId: CORALVILLE })).not.toBeNull();
    expect(staffProfileChangeDenied(manager, null, { role: "shop_manager", managerShopId: CORALVILLE, shopIds: [CORALVILLE] })).not.toBeNull();
    expect(staffProfileChangeDenied(manager, null, { role: "brand_admin", managerShopId: null, shopIds: [CORALVILLE] })).not.toBeNull();
  });

  it("denies editing a brand admin and adding people to another shop", () => {
    const owner = { role: "brand_admin" as const, managerShopId: null, shopIds: [CORALVILLE] };
    expect(staffProfileChangeDenied(manager, owner, owner)).not.toBeNull();
    const barber = { role: "barber" as const, managerShopId: null, shopIds: [CORALVILLE] };
    expect(staffProfileChangeDenied(manager, barber, { ...barber, shopIds: [CORALVILLE, IOWA_CITY] })).not.toBeNull();
  });

  it("allows ordinary edits, including barbers who also work at a shop the manager can't see", () => {
    const shared = { role: "barber" as const, managerShopId: null, shopIds: [CORALVILLE, IOWA_CITY] };
    expect(staffProfileChangeDenied(manager, shared, shared)).toBeNull();
    expect(staffProfileChangeDenied(manager, self, self)).toBeNull();
    expect(staffProfileChangeDenied(manager, null, { role: "barber", managerShopId: null, shopIds: [CORALVILLE] })).toBeNull();
  });

  it("lets the brand admin do anything", () => {
    expect(staffProfileChangeDenied(admin, self, { ...self, role: "brand_admin", managerShopId: null })).toBeNull();
  });
});

describe("review P1#12: time blocks and sale barbers stay in scope", () => {
  const shared = "barber-2-shops";
  const local = "barber-coralville-only";
  it("an all-shops block on a barber who also works elsewhere is brand-admin only", () => {
    expect(timeBlockChangeDenied(manager, { staffId: shared, shopId: null }, [CORALVILLE, IOWA_CITY])).not.toBeNull();
    expect(timeBlockChangeDenied(admin, { staffId: shared, shopId: null }, [CORALVILLE, IOWA_CITY])).toBeNull();
  });
  it("an all-shops block is fine for your own time or a barber who only works at your shops (review P2#23)", () => {
    expect(timeBlockChangeDenied({ ...manager, staffId: shared }, { staffId: shared, shopId: null }, [CORALVILLE, IOWA_CITY])).toBeNull();
    expect(timeBlockChangeDenied(manager, { staffId: local, shopId: null }, [CORALVILLE])).toBeNull();
  });
  it("managers block time only at their shops, for barbers who work there", () => {
    expect(timeBlockChangeDenied(manager, { staffId: shared, shopId: IOWA_CITY }, [CORALVILLE, IOWA_CITY])).not.toBeNull();
    expect(timeBlockChangeDenied(manager, { staffId: "elsewhere", shopId: CORALVILLE }, [IOWA_CITY])).not.toBeNull();
    expect(timeBlockChangeDenied(manager, { staffId: shared, shopId: CORALVILLE }, [CORALVILLE, IOWA_CITY])).toBeNull();
  });
  it("a barber must work at the shop", () => {
    expect(staffAtShopDenied([CORALVILLE], IOWA_CITY)).not.toBeNull();
    expect(staffAtShopDenied([CORALVILLE, IOWA_CITY], IOWA_CITY)).toBeNull();
  });
});

describe("review P3: display labels never include the surname", () => {
  it("flags labels containing the last name", () => {
    expect(labelContainsSurname("Taylor Robinson", "Robinson")).toBe(true);
    expect(labelContainsSurname("T-Robinson", "Robinson")).toBe(true);
  });
  it("allows first name + initial", () => {
    expect(labelContainsSurname("Taylor R.", "Robinson")).toBe(false);
    expect(labelContainsSurname("Jack J.", "Jackson")).toBe(false);
    expect(labelContainsSurname("Jack", null)).toBe(false);
  });
});
