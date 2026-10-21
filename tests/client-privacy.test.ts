import { describe, expect, it } from "vitest";
import {
  BUILTIN_FIELDS,
  DEFAULT_LIMITS,
  FieldRule,
  cleanLimits,
  customFieldKey,
  defaultLevel,
  fieldRuleChangeDenied,
  formatBirthday,
  maskAddress,
  maskBirthday,
  maskEmail,
  maskPhone,
  maskValue,
  minLevel,
  resolveLevel,
} from "@/domain/client-privacy";

describe("masking", () => {
  it("keeps only what staff need to recognise a client", () => {
    expect(maskPhone("+13195554321")).toBe("***-***-4321");
    expect(maskPhone(null)).toBeNull();
    expect(maskEmail("jordan@gmail.com")).toBe("j***@gmail.com");
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskAddress("1701 2nd Street, Moline, IL 61265")).toBe("***, Moline, IL 61265");
    expect(maskAddress("1701 2nd Street")).toBe("***");
    expect(maskBirthday("1988-07-14")).toBe("Jul **");
    expect(formatBirthday("1988-07-14")).toBe("Jul 14, 1988");
    expect(maskValue("notes", "Allergic to talc")).toBe("On file");
    expect(maskValue("notes", "  ")).toBeNull();
    expect(maskValue(customFieldKey("0b0c2f9e-0000-4000-8000-000000000000"), "@jordandemo")).toBe("@***");
  });

  it("no masked form contains the full value", () => {
    const values = {
      phone: "+13195554321",
      email: "jordan.demo@gmail.com",
      address: "1701 2nd Street, Moline, IL 61265",
      birthday: "1988-07-14",
      notes: "Skin fade, #2 on top",
      preferred_barber: "Terrell",
    };
    for (const [f, v] of Object.entries(values)) {
      const m = maskValue(f as keyof typeof values, v)!;
      expect(m, f).not.toContain(v);
      expect(m, f).not.toContain(v.replace(/\D/g, "").slice(0, 7) || "\u0000");
    }
    expect(maskValue("birthday", "1988-07-14")).not.toMatch(/14|1988/);
  });
});

describe("brand defaults", () => {
  it("barbers never see contact details in full; managers see them masked; brand admins in full", () => {
    expect(defaultLevel("barber", "phone")).toBe("masked");
    expect(defaultLevel("barber", "email")).toBe("hidden");
    expect(defaultLevel("barber", "address")).toBe("hidden");
    expect(defaultLevel("barber", "notes")).toBe("full");
    expect(defaultLevel("front_desk", "phone")).toBe("masked");
    expect(defaultLevel("shop_manager", "email")).toBe("masked");
    expect(defaultLevel("brand_admin", "phone")).toBe("full");
    expect(defaultLevel("brand_owner", "address")).toBe("full");
  });

  it("custom roles start locked down, and custom fields follow the role's custom default", () => {
    expect(defaultLevel(null, "phone")).toBe("masked");
    expect(defaultLevel(null, "email")).toBe("masked");
    expect(defaultLevel("barber", customFieldKey("x"))).toBe("hidden");
    expect(defaultLevel("front_desk", customFieldKey("x"))).toBe("masked");
  });

  it("every built-in field has a default for every role", () => {
    for (const role of ["brand_owner", "brand_admin", "regional_manager", "shop_manager", "front_desk", "barber", null])
      for (const f of BUILTIN_FIELDS) expect(["hidden", "masked", "full"]).toContain(defaultLevel(role, f.key));
  });
});

describe("resolving rules", () => {
  const who = { staffId: "jilane", roleId: "barber-role", roleKey: "barber" };
  const rule = (o: Partial<FieldRule>): FieldRule => ({ field: "phone", level: "hidden", roleId: null, staffId: null, shopId: null, ...o });

  it("the most specific rule wins: person at the shop, person, role at the shop, role, built-in", () => {
    const rules = [
      rule({ roleId: "barber-role", level: "hidden" }),
      rule({ roleId: "barber-role", shopId: "moline", level: "full" }),
      rule({ staffId: "jilane", level: "masked" }),
      rule({ staffId: "jilane", shopId: "silvis", level: "full" }),
    ];
    expect(resolveLevel(rules, who, "silvis", "phone")).toBe("full");
    expect(resolveLevel(rules, who, "moline", "phone")).toBe("masked");
    expect(resolveLevel(rules.slice(0, 2), who, "moline", "phone")).toBe("full");
    expect(resolveLevel(rules.slice(0, 2), who, "silvis", "phone")).toBe("hidden");
    expect(resolveLevel([], who, "moline", "phone")).toBe("masked");
    expect(resolveLevel(rules, who, "moline", "email")).toBe("hidden");
  });

  it("someone else's rule or another role's never applies", () => {
    const rules = [rule({ staffId: "kat", level: "full" }), rule({ roleId: "manager-role", level: "full" })];
    expect(resolveLevel(rules, who, null, "phone")).toBe("masked");
  });

  it("the Brand Owner always sees everything", () => {
    expect(resolveLevel([rule({ roleId: "owner", level: "hidden" })], { staffId: "o", roleId: "owner", roleKey: "brand_owner" }, null, "phone")).toBe("full");
  });

  it("working across shops at once takes the strictest level", () => {
    expect(minLevel("full", "masked", "full")).toBe("masked");
    expect(minLevel("full", "hidden")).toBe("hidden");
    expect(minLevel()).toBe("full");
  });
});

describe("who may change a rule", () => {
  const admin = { staffId: "admin", roleId: "admin-role", isOwner: false, levelAt: () => "full" as const };
  const base = { field: "phone" as const, roleId: "barber-role", roleKey: "barber", staffId: null, shopId: null, level: "full" as const };

  it("a brand admin can set a barber's level, but not their own or their role's, nor the owner's", () => {
    expect(fieldRuleChangeDenied(admin, base)).toBeNull();
    expect(fieldRuleChangeDenied(admin, { ...base, roleId: "admin-role", roleKey: "brand_admin" })).toMatch(/what you see yourself/);
    expect(fieldRuleChangeDenied(admin, { ...base, roleId: null, staffId: "admin" })).toMatch(/what you see yourself/);
    expect(fieldRuleChangeDenied(admin, { ...base, roleId: "owner", roleKey: "brand_owner" })).toMatch(/Brand Owner/);
  });

  it("nobody gives more than they see, and a rule is for exactly one role or one person", () => {
    expect(fieldRuleChangeDenied({ ...admin, levelAt: () => "masked" }, base)).toMatch(/more than you see/);
    expect(fieldRuleChangeDenied({ ...admin, levelAt: () => "masked" }, { ...base, level: "masked" })).toBeNull();
    expect(fieldRuleChangeDenied({ ...admin, levelAt: () => "masked" }, { ...base, level: null })).toBeNull();
    expect(fieldRuleChangeDenied(admin, { ...base, staffId: "jilane" })).toMatch(/role or a person/);
    expect(fieldRuleChangeDenied(admin, { ...base, roleId: null })).toMatch(/role or a person/);
  });

  it("the owner can change anyone's, including their own role's rules for others", () => {
    expect(fieldRuleChangeDenied({ ...admin, isOwner: true, levelAt: () => "full" }, { ...base, roleId: "admin-role", roleKey: "brand_admin" })).toBeNull();
  });
});

describe("lookup limits", () => {
  it("bad or missing values fall back to the defaults, and the pause level is never below the alert level", () => {
    expect(cleanLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(cleanLimits({ windowMinutes: -1, alertProfiles: "x" })).toEqual(DEFAULT_LIMITS);
    expect(cleanLimits({ alertProfiles: 80, blockProfiles: 40 })).toMatchObject({ alertProfiles: 80, blockProfiles: 80 });
  });
});
