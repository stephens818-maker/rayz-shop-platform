import { describe, expect, it } from "vitest";
import { Grantor, effectiveAccess, templateFor } from "@/domain/permissions";
import { AccountTarget, accountChangeDenied, accountStatus, passwordProblem } from "@/domain/users";
import { open, seal } from "@/lib/secret-box";
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUri, totpCode, verifyTotp } from "@/lib/totp";

// RFC 6238 appendix B, SHA-1: the ASCII key "12345678901234567890".
const RFC_KEY = base32Encode(Buffer.from("12345678901234567890"));

describe("authenticator codes", () => {
  it("match the RFC 6238 test vectors", () => {
    expect(RFC_KEY).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    for (const [t, code] of [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ] as const)
      expect(totpCode(RFC_KEY, t * 1000), String(t)).toBe(code);
    expect(hotp(RFC_KEY, 0)).toBe("755224");
  });

  it("base32 round-trips, and new secrets are 160 bits", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(base32Encode(base32Decode("jbsw y3dp ehpk 3pxp"))).toBe("JBSWY3DPEHPK3PXP");
    expect(() => base32Decode("not base32!")).toThrow();
  });

  it("accept one step of drift either way, and never the same code twice", () => {
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, now), { now })).toBe(step);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, now - 30_000), { now })).toBe(step - 1);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, now + 30_000), { now })).toBe(step + 1);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, now - 90_000), { now })).toBeNull();
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, now), { now, afterStep: step })).toBeNull();
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, now - 30_000), { now, afterStep: step - 1 })).toBeNull();
    const c = totpCode(RFC_KEY, now);
    expect(verifyTotp(RFC_KEY, `${c.slice(0, 3)} ${c.slice(3)}`, { now })).toBe(step);
    for (const bad of ["", "12345", "1234567", "abcdef"]) expect(verifyTotp(RFC_KEY, bad, { now }), bad).toBeNull();
  });

  it("the setup link names the account and the issuer", () => {
    expect(otpauthUri("JBSWY3DPEHPK3PXP", "dana@rayz.test")).toBe(
      "otpauth://totp/Ray'z%20Barber%20Shop%3Adana%40rayz.test?secret=JBSWY3DPEHPK3PXP&issuer=Ray'z%20Barber%20Shop&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("secrets kept in the database", () => {
  it("are encrypted, differently each time, and tampering is caught", () => {
    const a = seal("JBSWY3DPEHPK3PXP");
    const b = seal("JBSWY3DPEHPK3PXP");
    expect(a).not.toBe(b);
    expect(a).not.toContain("JBSWY3DP");
    expect(open(a)).toBe("JBSWY3DPEHPK3PXP");
    const parts = a.split(".");
    const flipped = [...parts.slice(0, 3), (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1)].join(".");
    expect(open(flipped)).toBeNull();
    expect(open("v2.x.y.z")).toBeNull();
    expect(open("garbage")).toBeNull();
  });
});

describe("account status and sign-in steps", () => {
  it("invited until they set a password; removed beats everything", () => {
    const at = new Date();
    expect(accountStatus({ active: true, hasPassword: false, invitedAt: at, removedAt: null })).toBe("invited");
    expect(accountStatus({ active: true, hasPassword: true, invitedAt: at, removedAt: null })).toBe("active");
    expect(accountStatus({ active: false, hasPassword: true, invitedAt: null, removedAt: null })).toBe("deactivated");
    expect(accountStatus({ active: false, hasPassword: false, invitedAt: at, removedAt: at })).toBe("removed");
  });

  it("passwords are long enough and not the email", () => {
    expect(passwordProblem("short", null)).toMatch(/at least 10/);
    expect(passwordProblem("aaaaaaaaaaaa", null)).toMatch(/less predictable/);
    expect(passwordProblem("dana.rivers-2026", "dana.rivers@rayz.test")).toMatch(/email/);
    expect(passwordProblem("correct horse battery", "dana@rayz.test")).toBeNull();
  });
});

describe("who may change whose account", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const grantor = (key: string, staffId: string, scope: "all" | "selected" = "all", shopIds: string[] = []): Grantor => {
    const a = effectiveAccess(templateFor(key)!, {}, null, scope);
    return { staffId, isOwner: a.isOwner, permissions: a.permissions, maxDiscountPct: a.maxDiscountPct, scope, shopIds };
  };
  const target = (key: string, staffId: string, over: Partial<AccountTarget> = {}): AccountTarget => {
    const scope = over.scope ?? (key === "brand_owner" || key === "brand_admin" ? "all" : "selected");
    const a = effectiveAccess(templateFor(key)!, {}, null, scope);
    return { staffId, isOwner: a.isOwner, permissions: a.permissions, maxDiscountPct: a.maxDiscountPct, scope, shopIds: scope === "all" ? [] : [A], kind: "person", status: "active", workShopIds: [], ...over };
  };
  const owner = grantor("brand_owner", "owner");
  const admin = grantor("brand_admin", "admin");
  const one = { activeOwners: 1 };

  it("nobody deactivates or removes the last Brand Owner who can sign in, not even themselves", () => {
    const me = target("brand_owner", "owner");
    for (const c of ["deactivate", "remove"] as const) {
      expect(accountChangeDenied(owner, me, c, one), c).toMatch(/yourself/);
      expect(accountChangeDenied(grantor("brand_owner", "owner2"), me, c, one), c).toMatch(/only Brand Owner/);
      expect(accountChangeDenied(grantor("brand_owner", "owner2"), me, c, { activeOwners: 2 }), c).toBeNull();
      expect(accountChangeDenied(admin, me, c, { activeOwners: 2 }), c).toMatch(/Only the Brand Owner/);
    }
    // An invited owner who never signed up can be cancelled.
    expect(accountChangeDenied(owner, target("brand_owner", "new-owner", { status: "invited" }), "remove", one)).toBeNull();
  });

  it("nobody turns off their own safeguards", () => {
    const me = target("brand_admin", "admin");
    expect(accountChangeDenied(admin, me, "drop_2fa", one)).toMatch(/yourself/);
    expect(accountChangeDenied(admin, me, "reset_2fa", one)).toMatch(/your own/);
    expect(accountChangeDenied(admin, me, "require_2fa", one)).toBeNull();
    expect(accountChangeDenied(admin, me, "profile", one)).toBeNull();
  });

  it("nobody acts on someone holding access they don't have, or outside their locations", () => {
    const manager = grantor("shop_manager", "michelle", "selected", [A]);
    const withManage = { ...manager, permissions: new Set([...manager.permissions, "permissions.manage" as const]) };
    expect(accountChangeDenied(manager, target("barber", "makenna"), "deactivate", one)).toMatch(/can't manage users/);
    expect(accountChangeDenied(withManage, target("barber", "makenna"), "deactivate", one)).toBeNull();
    expect(accountChangeDenied(withManage, target("barber", "elsewhere", { shopIds: [B] }), "deactivate", one)).toMatch(/isn't on your shops' team/);
    expect(accountChangeDenied(withManage, target("regional_manager", "reggie", { shopIds: [A, B] }), "remove", one)).toMatch(/access you don't/);
    expect(accountChangeDenied(admin, target("brand_owner", "owner"), "require_2fa", { activeOwners: 2 })).toMatch(/Only the Brand Owner/);
  });

  it("states have to make sense, and people with bookings are offboarded first", () => {
    expect(accountChangeDenied(admin, target("barber", "m", { status: "deactivated" }), "deactivate", one)).toMatch(/already/);
    expect(accountChangeDenied(admin, target("barber", "m"), "reactivate", one)).toMatch(/not deactivated/);
    expect(accountChangeDenied(admin, target("barber", "m"), "invite", one)).toMatch(/already signed up/);
    expect(accountChangeDenied(admin, target("barber", "m", { status: "removed" }), "reactivate", one)).toMatch(/removed/);
    expect(accountChangeDenied(admin, target("barber", "m", { kind: "shop" }), "deactivate", one)).toMatch(/Shop logins/);
    expect(accountChangeDenied(admin, target("barber", "m"), "deactivate", { activeOwners: 1, upcomingBookings: 3 })).toMatch(/3 upcoming appointments/);
  });
});
