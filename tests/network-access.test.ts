/**
 * Sign-in restrictions, the pure parts: which shops a request can reach under each location's rule,
 * which allowed-IP entries are accepted, reading the client IP only from a trusted proxy, and the
 * permission defaults ("Can access remotely" for the Brand Owner and Brand Admin only).
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NetworkRuleSchema, blockedWhy, brandNetworkSettings, networkEntryProblem, networkVerdict, ruleAllows, shopNetworkRule, splitNetworks, type ShopNetworkRule } from "@/domain/network-access";
import { LocationDraft, draftDefaults } from "@/domain/location-draft";
import { PAGE_ACCESS } from "@/domain/navigation";
import { BRAND_ONLY, ROLE_TEMPLATES, effectiveAccess, templateFor } from "@/domain/permissions";
import { clientIp } from "@/lib/client-ip";

const on = (require: ShopNetworkRule["require"], allowedIps: string[] = ["203.0.113.0/24"]): ShopNetworkRule => ({ enabled: true, require, allowedIps });
const none = { ip: null, deviceShopIds: [] };

describe("a location's rule", () => {
  it("lets a request in by IP, by approved device, by either or by both, as chosen", () => {
    const shop = "a";
    const cases: [ShopNetworkRule["require"], string | null, boolean, boolean][] = [
      ["ip", "203.0.113.9", false, true],
      ["ip", "198.51.100.1", true, false],
      ["device", "203.0.113.9", false, false],
      ["device", null, true, true],
      ["either", "198.51.100.1", true, true],
      ["either", "203.0.113.9", false, true],
      ["either", "198.51.100.1", false, false],
      ["both", "203.0.113.9", false, false],
      ["both", "198.51.100.1", true, false],
      ["both", "203.0.113.9", true, true],
    ];
    for (const [require, ip, device, ok] of cases) expect(ruleAllows(on(require), shop, { ip, deviceShopIds: device ? [shop] : [] }).ok, `${require} ${ip} ${device}`).toBe(ok);
    expect(ruleAllows(on("device"), "a", { ip: null, deviceShopIds: ["b"] }).ok).toBe(false);
    expect(ruleAllows({ ...on("ip"), enabled: false }, "a", none).ok).toBe(true);
  });

  it("blocks only shops with a rule that isn't met and that the person isn't exempt at; all of them is a full block", () => {
    const shops = [
      { shopId: "a", rule: on("ip"), exempt: false },
      { shopId: "b", rule: on("ip"), exempt: true },
      { shopId: "c", rule: { ...on("ip"), enabled: false }, exempt: false },
    ];
    const away = networkVerdict(shops, { ip: "198.51.100.1", deviceShopIds: [] });
    expect(away.blocked.map((b) => b.shopId)).toEqual(["a"]);
    expect(away.full).toBe(false);
    expect(networkVerdict([shops[0]], { ip: "198.51.100.1", deviceShopIds: [] }).full).toBe(true);
    expect(networkVerdict([shops[0]], { ip: "203.0.113.200", deviceShopIds: [] }).full).toBe(false);
    expect(networkVerdict([], none).full).toBe(false);
  });

  it("says what was missing", () => {
    expect(blockedWhy({ require: "ip", ipOk: false, deviceOk: false })).toBe("not on the shop's network");
    expect(blockedWhy({ require: "either", ipOk: false, deviceOk: false })).toBe("not on the shop's network or an approved device");
    expect(blockedWhy({ require: "both", ipOk: true, deviceOk: false })).toBe("not an approved device");
    expect(blockedWhy({ require: "both", ipOk: false, deviceOk: false })).toBe("not on the shop's network and not an approved device");
  });

  it("accepts single IPs and CIDR ranges, IPv4 and IPv6, and refuses junk and ranges that cover too much", () => {
    for (const ok of ["203.0.113.7", "203.0.113.0/24", "198.51.0.0/16", "2001:db8::1", "2001:db8:42::/48", "::ffff:203.0.113.7"]) expect(networkEntryProblem(ok), ok).toBeNull();
    for (const bad of ["not-an-ip", "203.0.113.300", "203.0.113.0/33", "10.0.0.0/8", "0.0.0.0/0", "2001::/16", "::/0"]) expect(networkEntryProblem(bad), bad).not.toBeNull();
    expect(splitNetworks("203.0.113.7\n 198.51.100.0/24, 203.0.113.7;2001:db8::/48")).toEqual(["203.0.113.7", "198.51.100.0/24", "2001:db8::/48"]);
    expect(NetworkRuleSchema.safeParse(on("ip", [])).success).toBe(false);
    expect(NetworkRuleSchema.safeParse(on("both", [])).success).toBe(false);
    expect(NetworkRuleSchema.safeParse(on("device", [])).success).toBe(true);
    expect(NetworkRuleSchema.safeParse({ ...on("ip", []), enabled: false }).success).toBe(true);
  });

  it("reads stored rules leniently, and a rule left on with no usable addresses lets nobody in by IP", () => {
    expect(shopNetworkRule({})).toEqual({ enabled: false, require: "ip", allowedIps: [] });
    expect(shopNetworkRule(null)).toEqual({ enabled: false, require: "ip", allowedIps: [] });
    const broken = shopNetworkRule({ enabled: true, require: "nonsense", allowedIps: ["junk", 7, "0.0.0.0/0"] });
    expect(broken).toEqual({ enabled: true, require: "ip", allowedIps: [] });
    expect(networkVerdict([{ shopId: "a", rule: broken, exempt: false }], { ip: "203.0.113.7", deviceShopIds: [] }).full).toBe(true);
    expect(brandNetworkSettings({})).toEqual({ alertOnBlock: true });
    expect(brandNetworkSettings({ alertOnBlock: false })).toEqual({ alertOnBlock: false });
  });

  it("is part of the location wizard's draft, off by default", () => {
    const d = LocationDraft.parse(draftDefaults({ name: "Test", slug: "test", address: "1 Main", city: "X", state: "IA", zip: "52801" }));
    expect(d.networkAccess).toEqual({ enabled: false, require: "ip", allowedIps: [] });
    expect(LocationDraft.safeParse(draftDefaults({ name: "Test", slug: "test", address: "1 Main", city: "X", state: "IA", zip: "52801", networkAccess: on("ip", ["nope"]) })).success).toBe(false);
  });
});

describe("the client IP", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it("on Vercel comes from the headers its edge sets, which a client can't supply", () => {
    const env = { VERCEL: "1" };
    expect(clientIp(h({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" }), env)).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.8, 10.0.0.1" }), env)).toBe("203.0.113.8");
    expect(clientIp(h({ "x-real-ip": "junk" }), env)).toBeNull();
  });

  it("self-hosted is the entry the trusted proxies added, so a spoofed X-Forwarded-For is ignored", () => {
    const spoofed = h({ "x-forwarded-for": "203.0.113.7, 198.51.100.1" });
    expect(clientIp(spoofed, { TRUSTED_PROXY_HOPS: "1" })).toBe("198.51.100.1");
    expect(clientIp(spoofed, { TRUSTED_PROXY_HOPS: "2" })).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.1" }), { TRUSTED_PROXY_HOPS: "2" })).toBeNull();
  });

  it("is unknown without a trusted proxy, whatever the request says", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7" }), {})).toBeNull();
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), { TRUSTED_PROXY_HOPS: "0" })).toBeNull();
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7" }), { TRUSTED_PROXY_HOPS: "yes" })).toBeNull();
  });

  it("is read through the one helper everywhere: no other code reads the forwarding headers", () => {
    const hits = execSync("grep -rln 'x-forwarded-for\\|x-real-ip' src || true", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    expect(hits).toEqual(["src/lib/client-ip.ts"]);
  });
});

describe("permissions", () => {
  it("gives Can access remotely to the Brand Owner and Brand Admin only, and device approval to managers", () => {
    const holders = ROLE_TEMPLATES.filter((t) => effectiveAccess(t).permissions.has("access.remote")).map((t) => t.key);
    expect(holders).toEqual(["brand_owner", "brand_admin"]);
    const approvers = ROLE_TEMPLATES.filter((t) => effectiveAccess(t).permissions.has("devices.approve")).map((t) => t.key);
    expect(approvers).toEqual(["brand_owner", "brand_admin", "franchisee_owner", "franchisee_manager", "regional_manager", "shop_manager"]);
    expect(BRAND_ONLY.has("network.settings")).toBe(true);
    expect(effectiveAccess(templateFor("brand_admin")!, {}, null, "selected").permissions.has("network.settings")).toBe(false);
    expect(PAGE_ACCESS["/admin/sign-in-security"]).toEqual(["network.settings", "devices.approve"]);
  });

  it("checks every admin request in the Node.js middleware, so it can read the database", () => {
    const src = readFileSync("src/middleware.ts", "utf8");
    // Every page runs through it (for the customer-screen lock); the sign-in rules gate everything under /admin.
    expect(src).toMatch(/matcher: \["\/\(\(\?!_next\/\|api\/\|\.\*\\\\\.\.\*\)\.\*\)"\]/);
    expect(src).toMatch(/if \(!path\.startsWith\("\/admin"\)\) return NextResponse\.next\(\);/);
    expect(src).toMatch(/runtime: "nodejs"/);
    expect(src).toMatch(/gateRequest\(/);
  });
});
