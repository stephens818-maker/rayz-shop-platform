import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_FIELDS,
  CONTACT_FIELDS,
  DEFAULT_LIMITS,
  FieldRule,
  cleanLimits,
  contactCeiling,
  customFieldKey,
  defaultEntry,
  defaultLevel,
  entryDenied,
  fieldRuleChangeDenied,
  formatBirthday,
  maskAddress,
  maskBirthday,
  maskEmail,
  maskPhone,
  maskValue,
  minLevel,
  resolveEntry,
  resolveLevel,
  validRule,
} from "@/domain/client-privacy";

vi.mock("server-only", () => ({}));

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
  const base = { field: "birthday" as const, roleId: "barber-role", roleKey: "barber", staffId: null, shopId: null, level: "full" as const };

  it("a brand admin can set a barber's level, but not their own or their role's, nor the owner's", () => {
    expect(fieldRuleChangeDenied(admin, base)).toBeNull();
    expect(fieldRuleChangeDenied(admin, { ...base, roleId: "admin-role", roleKey: "brand_admin" })).toMatch(/Brand Admins always/);
    expect(fieldRuleChangeDenied(admin, { ...base, roleId: "admin-role", roleKey: "brand_admin", setting: "edit", level: "deny" })).toMatch(/what you see yourself/);
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

  it("phone, email and address are never set to full for a shop or staff role or person, not even by the Brand Owner", () => {
    const owner = { ...admin, isOwner: true };
    for (const field of CONTACT_FIELDS) {
      for (const caller of [admin, owner]) {
        expect(fieldRuleChangeDenied(caller, { ...base, field }), field).toMatch(/never shown in full/);
        expect(fieldRuleChangeDenied(caller, { ...base, field, roleId: null, roleKey: "shop_manager", staffId: "michelle" }), field).toMatch(/never shown in full/);
        expect(fieldRuleChangeDenied(caller, { ...base, field, level: "masked" }), field).toBeNull();
      }
      expect(fieldRuleChangeDenied(owner, { ...base, field, setting: "edit", level: "allow" }), field).toBeNull();
      expect(fieldRuleChangeDenied(owner, { ...base, field, roleId: "auditor", roleKey: null, fullContact: true }), field).toBeNull();
    }
    expect(fieldRuleChangeDenied(admin, { ...base, field: "birthday" })).toBeNull();
  });

  it("the owner can change anyone's entry rights, but Brand Admins always see every detail", () => {
    const owner = { ...admin, isOwner: true, levelAt: () => "full" as const };
    expect(fieldRuleChangeDenied(owner, { ...base, roleId: "admin-role", roleKey: "brand_admin", setting: "edit", level: "deny" })).toBeNull();
    expect(fieldRuleChangeDenied(owner, { ...base, roleId: "admin-role", roleKey: "brand_admin", level: "masked" })).toMatch(/Brand Admins always/);
  });
});

describe("entering details", () => {
  const who = { staffId: "jilane", roleId: "barber-role", roleKey: "barber" };
  const rule = (o: Partial<FieldRule>): FieldRule => ({ field: "phone", setting: "add", level: "deny", roleId: null, staffId: null, shopId: null, ...o });

  it("by default everyone can add any detail; the desk and managers can edit them, barbers and custom roles only notes", () => {
    for (const role of ["brand_admin", "regional_manager", "shop_manager", "front_desk", "barber", null])
      for (const f of ["phone", "email", "address", "birthday", "notes", "preferred_barber", customFieldKey("x")] as const)
        expect(defaultEntry(role, f, "add"), `${role} ${f}`).toBe(true);
    for (const role of ["brand_admin", "regional_manager", "shop_manager", "front_desk"]) expect(defaultEntry(role, "phone", "edit")).toBe(true);
    for (const role of ["barber", null]) {
      expect(defaultEntry(role, "phone", "edit")).toBe(false);
      expect(defaultEntry(role, customFieldKey("x"), "edit")).toBe(false);
      expect(defaultEntry(role, "notes", "edit")).toBe(true);
    }
    expect(defaultEntry("front_desk", "ratings", "add")).toBe(false);
  });

  it("add and edit rules resolve like view rules, each on its own", () => {
    const rules = [
      rule({ roleId: "barber-role", level: "deny" }),
      rule({ roleId: "barber-role", shopId: "moline", level: "allow" }),
      rule({ staffId: "jilane", shopId: "silvis", level: "allow" }),
      rule({ setting: "view", roleId: "barber-role", level: "hidden" }),
      rule({ setting: "edit", roleId: "barber-role", level: "allow" }),
    ];
    expect(resolveEntry(rules, who, "moline", "phone", "add")).toBe(true);
    expect(resolveEntry(rules, who, "silvis", "phone", "add")).toBe(true);
    expect(resolveEntry(rules, who, "utica", "phone", "add")).toBe(false);
    expect(resolveEntry(rules, who, "utica", "phone", "edit")).toBe(true);
    expect(resolveEntry(rules, who, "utica", "email", "add")).toBe(true);
    expect(resolveLevel(rules, who, "utica", "phone")).toBe("hidden");
    expect(resolveEntry([rule({ roleId: "owner" })], { staffId: "o", roleId: "owner", roleKey: "brand_owner" }, null, "phone", "add")).toBe(true);
    expect(resolveEntry([], { staffId: "o", roleId: "owner", roleKey: "brand_owner" }, null, "ratings", "add")).toBe(false);
  });

  it("a rule's value must fit its setting", () => {
    expect(validRule(rule({ level: "allow" }))).toBe(true);
    expect(validRule(rule({ level: "masked" }))).toBe(false);
    expect(validRule(rule({ setting: "view", level: "allow" }))).toBe(false);
    expect(validRule(rule({ setting: undefined, level: "full" }))).toBe(true);
  });

  it("filling an empty field needs add; changing one on file needs edit, even to the same value, unless it's seen in full", () => {
    const e = (level: "hidden" | "masked" | "full", canAdd: boolean, canEdit: boolean) => ({ level, canAdd, canEdit });
    expect(entryDenied(e("hidden", false, false), "+13195551234", undefined)).toBeNull();
    expect(entryDenied(e("hidden", false, true), null, "+13195551234")).toBe("add");
    expect(entryDenied(e("hidden", true, false), null, "+13195551234")).toBeNull();
    expect(entryDenied(e("hidden", false, false), null, "")).toBeNull();
    expect(entryDenied(e("masked", true, false), "+13195551234", "+13195551234")).toBe("edit");
    expect(entryDenied(e("hidden", true, false), "+13195551234", "+13195559999")).toBe("edit");
    expect(entryDenied(e("masked", true, false), "+13195551234", "")).toBe("edit");
    expect(entryDenied(e("masked", false, true), "+13195551234", "+13195559999")).toBeNull();
    expect(entryDenied(e("full", false, false), "+13195551234", "+13195551234")).toBeNull();
    expect(entryDenied(e("full", false, false), "+13195551234", "+13195559999")).toBe("edit");
  });

  it("nobody grants an add or edit right they don't have, and ratings aren't entered on client forms", () => {
    const admin = { staffId: "admin", roleId: "admin-role", isOwner: false, levelAt: () => "full" as const, entryAt: () => false };
    const base = { field: "phone" as const, setting: "add" as const, roleId: "barber-role", roleKey: "barber", staffId: null, shopId: null, level: "allow" };
    expect(fieldRuleChangeDenied(admin, base)).toBe("You can't let anyone add a detail you can't add yourself");
    expect(fieldRuleChangeDenied(admin, { ...base, setting: "edit" })).toBe("You can't let anyone edit a detail you can't edit yourself");
    expect(fieldRuleChangeDenied(admin, { ...base, level: "deny" })).toBeNull();
    expect(fieldRuleChangeDenied({ ...admin, entryAt: () => true }, base)).toBeNull();
    expect(fieldRuleChangeDenied(admin, { ...base, level: "masked" })).toBe("Pick a level");
    expect(fieldRuleChangeDenied(admin, { ...base, setting: "view" })).toBe("Pick a level");
    expect(fieldRuleChangeDenied({ ...admin, isOwner: true }, { ...base, field: "ratings" })).toMatch(/rating tools/);
  });

  it("what a form saves, and what the answer shows: never more than the person's level", async () => {
    const { entered, makePolicy, shownField } = await import("@/server/client-privacy");
    const levels = new Map([["phone", "masked"] as const, ["address", "hidden"] as const]);
    const entries = new Map([
      ["add:phone", true],
      ["edit:phone", false],
      ["add:address", true],
      ["edit:address", true],
    ]);
    const p = makePolicy({ staffId: "d", isOwner: false, canReveal: false, custom: [], levels, entries });
    expect(entered(p, "phone", null, "+13195551234")).toBe("+13195551234");
    expect(() => entered(p, "phone", "+13195550000", "+13195551234")).toThrow("You can't change a client's phone once it's on file");
    expect(entered(p, "phone", "+13195550000", undefined)).toBe("+13195550000");
    expect(entered(p, "address", "1 Old Road, Moline, IL", "2 New Road, Moline, IL")).toBe("2 New Road, Moline, IL");
    expect(shownField(p, "phone", "+13195551234")).toEqual({ key: "phone", label: "Phone", level: "masked", value: "***-***-1234", saved: true, canAdd: true, canEdit: false });
    expect(shownField(p, "address", "2 New Road, Moline, IL")).toEqual({
      key: "address",
      label: "Address",
      level: "hidden",
      value: null,
      saved: true,
      canAdd: true,
      canEdit: true,
    });
    expect(shownField(p, "email", null)).toMatchObject({ level: "hidden", saved: false, canAdd: false });
  });
});

describe("the contact ceiling", () => {
  it("caps phone, email and address at masked for anyone who isn't brand-level, and leaves other fields alone", () => {
    for (const f of CONTACT_FIELDS) {
      expect(contactCeiling(f, "full", false), f).toBe("masked");
      expect(contactCeiling(f, "masked", false), f).toBe("masked");
      expect(contactCeiling(f, "hidden", false), f).toBe("hidden");
      expect(contactCeiling(f, "full", true), f).toBe("full");
    }
    for (const f of ["birthday", "notes", "preferred_barber", customFieldKey("x")] as const) expect(contactCeiling(f, "full", false), f).toBe("full");
  });

  it("a policy shows contact details masked and won't reveal them unless brand-level, whatever its levels say", async () => {
    const { makePolicy } = await import("@/server/client-privacy");
    const levels = new Map([...BUILTIN_FIELDS.map((f) => [f.key, "full"] as const), ["birthday", "masked"] as const]);
    const shop = makePolicy({ staffId: "m", isOwner: false, canReveal: true, custom: [], levels });
    expect(shop.fullContact).toBe(false);
    expect(shop.level("phone")).toBe("masked");
    expect(shop.show("phone", "+13195554321")).toBe("***-***-4321");
    expect(shop.show("email", "jordan@gmail.com")).toBe("j***@gmail.com");
    expect(shop.show("notes", "Likes a 2 guard")).toBe("Likes a 2 guard");
    for (const f of CONTACT_FIELDS) expect(shop.mayReveal(f), f).toBe(false);
    expect(shop.mayReveal("birthday")).toBe(true);
    const brand = makePolicy({ staffId: "a", isOwner: false, fullContact: true, canReveal: true, custom: [], levels: new Map([...levels, ["phone", "masked"]]) });
    expect(brand.level("email")).toBe("full");
    expect(brand.mayReveal("phone")).toBe(true);
  });
});

describe("lookup limits", () => {
  it("bad or missing values fall back to the defaults, and the pause level is never below the alert level", () => {
    expect(cleanLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(cleanLimits({ windowMinutes: -1, alertProfiles: "x" })).toEqual(DEFAULT_LIMITS);
    expect(cleanLimits({ alertProfiles: 80, blockProfiles: 40 })).toMatchObject({ alertProfiles: 80, blockProfiles: 80 });
  });
});
