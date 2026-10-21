import { describe, expect, it } from "vitest";
import { hoursProblem } from "@/domain/hours";
import { labelContainsSurname } from "@/lib/ids";
import { staffAtShopDenied, timeBlockChangeDenied } from "@/server/auth/policy";

const CORALVILLE = "11111111-1111-1111-1111-111111111111";
const IOWA_CITY = "22222222-2222-2222-2222-222222222222";
const manager = { staffId: "mgr", brandWide: false, shopIds: [CORALVILLE] };
const admin = { staffId: "own", brandWide: true, shopIds: [CORALVILLE, IOWA_CITY] };

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

describe("review P1#19: cron and sign-in codes fail closed", () => {
  it("cron needs a configured secret and the exact bearer token", async () => {
    const { cronAuthorized } = await import("@/server/notifications/cron");
    expect(cronAuthorized(null, undefined)).toBe(false);
    expect(cronAuthorized("Bearer anything", "")).toBe(false);
    expect(cronAuthorized("Bearer wrong", "s3cret")).toBe(false);
    expect(cronAuthorized("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("dev codes are never on in a production build", async () => {
    const { devCodesEnabled } = await import("@/server/auth/customer");
    const env = process.env as Record<string, string | undefined>;
    const prev = { node: env.NODE_ENV, dev: env.AUTH_DEV_CODES, vercel: env.VERCEL_ENV };
    try {
      env.AUTH_DEV_CODES = "true";
      env.VERCEL_ENV = "preview";
      env.NODE_ENV = "production";
      expect(devCodesEnabled()).toBe(false);
      env.NODE_ENV = "development";
      expect(devCodesEnabled()).toBe(true);
    } finally {
      env.NODE_ENV = prev.node;
      env.AUTH_DEV_CODES = prev.dev;
      env.VERCEL_ENV = prev.vercel;
    }
  });
});

describe("review P2#21: Sunday hours are a brand-level setting (settings.brand)", () => {
  const week = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, openMin: 540, closeMin: 1080 }));
  const sunday = { weekday: 0, openMin: 600, closeMin: 900 };

  it("refuses a manager opening Sunday, and lets a brand admin do it", () => {
    expect(hoursProblem([...week, sunday], { canSetSunday: false, currentSunday: null })).toMatchObject({ code: "forbidden" });
    expect(hoursProblem([...week, sunday], { canSetSunday: true, currentSunday: null })).toBeNull();
  });

  it("lets a manager keep or close the Sunday an admin set, but not change it", () => {
    const current = { openMin: 600, closeMin: 900 };
    expect(hoursProblem([...week, sunday], { canSetSunday: false, currentSunday: current })).toBeNull();
    expect(hoursProblem(week, { canSetSunday: false, currentSunday: current })).toBeNull();
    expect(hoursProblem([...week, { ...sunday, closeMin: 960 }], { canSetSunday: false, currentSunday: current })).toMatchObject({ code: "forbidden" });
  });

  it("rejects malformed rows for everyone", () => {
    const who = { canSetSunday: true, currentSunday: null };
    expect(hoursProblem([{ weekday: 7, openMin: 540, closeMin: 600 }], who)?.code).toBe("bad_request");
    expect(hoursProblem([{ weekday: 1, openMin: 600, closeMin: 540 }], who)?.code).toBe("bad_request");
    expect(hoursProblem([{ weekday: 1, openMin: 540, closeMin: 1500 }], who)?.code).toBe("bad_request");
    expect(hoursProblem([week[0], week[0]], who)?.code).toBe("bad_request");
  });
});
